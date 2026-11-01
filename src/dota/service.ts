/**
 * Dota2 服务 — 缓存 / 单飞 / 本地限流闸门 / 文案渲染
 * ─────────────────────────────────────────────────────────────
 * 为什么要这一层：
 *   - OpenDota 一分钟只给 60 次，而**一个账号一次请求**（recentMatches、profile、wl 各一次），
 *     群里连问三个人就能吃掉 6 次。没有缓存和闸门，一次热闹的聊天就能把当天额度打穿。
 *   - 渲染要随 limit 变化，所以缓存必须存**原始 RawMatch 数组**，不能存渲染结果。
 *     存渲染结果的话，"先查 5 局再查 20 局"就要重新打一次 API。
 *
 * 缓存分层：
 *   recentMatches  cacheTtlSec（默认 180s）—— 存 maxLimit 条，任意 limit 都从里面切
 *   profile        同 TTL —— 昵称/段位不打紧，但不缓存就等于把请求数翻倍
 *   失败不缓存 —— 网络抖动不该让用户 3 分钟内都看不到数据
 *
 * 本地闸门是**保守**的：只按 HTTP 请求数计，429 内部重试那次不额外计数。
 * 宁可少算（真实用量略高于本地计数），也不要把一次请求算两次导致误伤。
 */
import type { Logger } from '../types.ts';
import { heroName } from './heroes.ts';
import {
  OpenDotaApi,
  OpenDotaError,
  isWin,
  type DotaQuota,
  type PlayerProfile,
  type RawMatch,
  type RawMatchDetail,
  type RawMatchPlayer,
  type RawObjective,
} from './opendota.ts';

/** Dota2 集成配置（Schema 在 src/config.ts 里定义，这里只描述形状） */
export interface DotaConfig {
  /** 总开关（关 = 不注册工具、service 直接拒绝查询） */
  enabled: boolean;
  /** 最近比赛缓存秒数（默认 180） */
  cacheTtlSec: number;
  /** 单次 OpenDota 请求超时(ms) */
  timeoutMs: number;
  /** 默认查几局（默认 5） */
  defaultLimit: number;
  /** 上限（默认 20；OpenDota 自己默认给 20 条） */
  maxLimit: number;
  /** 本地滑动窗口闸门：每分钟最多发多少次请求（默认 50，给远端 60 留余量） */
  rateLimitPerMin: number;
  /** 是否额外查生涯总胜负（多一次请求） */
  includeWinLoss: boolean;
}

/** 同一账号的 recentMatches 缓存 */
interface CacheEntry<T> {
  at: number;
  value: T;
}

/** 一条给人看的战绩 */
export interface DotaMatchSummary {
  matchId: number;
  heroId: number;
  heroName: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  /** (kills+assists)/max(1,deaths)，保留 2 位 */
  kdaRatio: number;
  durationSec: number;
  durationText: string;
  /** ISO 时间（可序列化） */
  startedAt: string;
  /** 「2 小时前」这种相对时间 */
  startedAtText: string;
  gameMode: number;
  gameModeText: string;
  lobbyType: number;
  lobbyTypeText: string;
  isRanked: boolean;
}

export interface DotaForm {
  accountId: number;
  /** 拿不到 profile 时为空字符串（不是 'unknown'，上层好判断） */
  displayName: string;
  rankTier: number | null;
  rankText: string | null;
  /** 只有 includeWinLoss 开启且拿到了才有 */
  totalWin?: number;
  totalLose?: number;
  matches: DotaMatchSummary[];
  /** 本批次（最近 N 局）内的胜场数 */
  wins: number;
  losses: number;
  /** 胜率，整数百分比 */
  winRate: number;
  /** 平均 KDA，保留 2 位 */
  avgKda: number;
  /** 正数=连胜局数，负数=连败局数 */
  streak: number;
  /** KDA 最高的一局（matches >= 2 时给） */
  bestMatch?: DotaMatchSummary;
  /** KDA 最低的一局 */
  worstMatch?: DotaMatchSummary;
  /** 一条空数据（没打过 / 未公开），文案要按"查不到"处理，不要断言隐私 */
  empty: boolean;
  /** 面向模型/群友的补充说明 */
  note?: string;
  /** 直接可发群的整段中文 */
  summaryText: string;
}

export type DotaFormOutcome =
  | { ok: true; form: DotaForm }
  | { ok: false; accountId: number; errorKind: string; message: string };

/** 单场详细解析（比 recentForm 细：经济/输出/对位/目标/曲线/团战/阵容） */
export interface MatchDetailForm {
  matchId: number;
  startTimeSec: number;
  startText: string;
  durationSec: number;
  durationText: string;
  gameMode: number;
  gameModeText: string;
  lobbyType: number;
  lobbyTypeText: string;
  isRanked: boolean;
  radiantWin: boolean;
  player: {
    accountId: number;
    heroId: number;
    heroName: string;
    isRadiant: boolean;
    win: boolean;
    kills: number;
    deaths: number;
    assists: number;
    kdaRatio: number;
    gpm: number;
    xpm: number;
    lastHits: number;
    denies: number;
    heroDamage: number;
    towerDamage: number;
    heroHealing: number;
    netWorth: number;
    level: number;
    items: string[];
    backpack: string[];
  };
  /** 队内排名（1 = 最好，按净资产 / 英雄伤害） */
  teamRank: { netWorth: number; heroDamage: number; teamSize: number };
  /** 对位（同 lane_role 的敌方玩家）对比，找不到为 null */
  laneOpponent: { heroName: string; gpmDiff: number; damageDiff: number } | null;
  objectives: {
    firstBlood: 'radiant' | 'dire' | null;
    roshan: { radiant: number; dire: number };
    towers: { radiant: number; dire: number };
  };
  /** 经济曲线（玩家视角）：最大领先 / 最大落后 + 对应分钟；未解析为 null */
  goldSwing: { maxLead: number; maxDeficit: number; leadMinute: number; deficitMinute: number } | null;
  /** 团战次数与参与次数；未解析为 null */
  teamfights: { count: number; participated: number } | null;
  lineup: { radiant: string[]; dire: string[] };
  notes: string[];
  /** 直接可发群的整段中文 */
  summaryText: string;
}

/** 多人查询之间的间隔：OpenDota 没有批量端点，连续打容易踩到 429 */
const MULTI_QUERY_DELAY_MS = 250;

/** 滑动窗口长度 */
const RATE_WINDOW_MS = 60_000;

export class DotaService {
  private readonly config: DotaConfig;
  private readonly logger: Logger;
  private readonly api: OpenDotaApi;

  /** 原始比赛数组（不是渲染结果） */
  private readonly recentCache = new Map<number, CacheEntry<RawMatch[]>>();
  private readonly profileCache = new Map<number, CacheEntry<PlayerProfile | null>>();
  /** 同一账号的并发请求合并 */
  private readonly inFlight = new Map<number, Promise<RawMatch[]>>();
  /** 单场详情缓存（key = matchId，TTL 同上） */
  private readonly detailCache = new Map<number, CacheEntry<RawMatchDetail>>();
  /** 单场详情并发合并 */
  private readonly detailInFlight = new Map<number, Promise<RawMatchDetail>>();
  /** 滑动窗口内的请求时间戳 */
  private readonly requestLog: number[] = [];

  constructor({ config, logger }: { config: DotaConfig; logger: Logger }) {
    this.config = config;
    this.logger = logger;
    this.api = new OpenDotaApi({ timeoutMs: config.timeoutMs });
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** 工具描述要跟着配置走，否则改了 defaultLimit 描述还在说 5 */
  get limits(): { defaultLimit: number; maxLimit: number } {
    return { defaultLimit: this.config.defaultLimit, maxLimit: this.config.maxLimit };
  }

  /** 最近一次响应的 OpenDota 剩余额度（日志/降级判断用） */
  get quota(): DotaQuota | undefined {
    return this.api.quota;
  }

  // ── 本地限流闸门 ────────────────────────────────────────────

  /**
   * 发请求前的闸门。超限时**不发请求**直接抛 rate-limit：
   * 让远端 429 打过来再处理，等于把额度浪费在一眼就能算出来的事情上。
   */
  private gate(): void {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;
    while (this.requestLog.length > 0 && (this.requestLog[0] ?? Number.POSITIVE_INFINITY) <= windowStart) {
      this.requestLog.shift();
    }
    const limit = Math.max(1, Math.floor(this.config.rateLimitPerMin));
    if (this.requestLog.length >= limit) {
      throw new OpenDotaError(
        'rate-limit',
        `本地限流保护：最近 60 秒内已发出 ${this.requestLog.length} 次 OpenDota 请求（上限 ${limit} 次），过一会儿再查`,
      );
    }
    this.requestLog.push(now);
  }

  private fresh<T>(entry: CacheEntry<T> | undefined, ttlMs: number): T | undefined {
    if (entry === undefined) return undefined;
    return Date.now() - entry.at < ttlMs ? entry.value : undefined;
  }

  // ── 取数 ────────────────────────────────────────────────────

  /**
   * 取原始比赛数组（带缓存 + 单飞）。
   * 一次就拉满 maxLimit 条，之后任何更小的 limit 都从缓存切片 —— 这也是
   * "缓存原始数组而不是渲染结果"的目的。
   */
  private async matches(accountId: number, limit: number): Promise<RawMatch[]> {
    const ttl = this.config.cacheTtlSec * 1000;
    const cached = this.fresh(this.recentCache.get(accountId), ttl);
    if (cached !== undefined) return cached;

    const running = this.inFlight.get(accountId);
    if (running !== undefined) return running;

    const task = (async (): Promise<RawMatch[]> => {
      this.gate();
      const full = await this.api.recentMatches(accountId, Math.max(limit, this.config.maxLimit));
      this.recentCache.set(accountId, { at: Date.now(), value: full });
      return full;
    })().finally(() => {
      this.inFlight.delete(accountId);
    });

    this.inFlight.set(accountId, task);
    return task;
  }

  /** profile 失败不该毁掉整条战绩：返回 null 由调用方降级 */
  private async profile(accountId: number): Promise<PlayerProfile | null> {
    const ttl = this.config.cacheTtlSec * 1000;
    const cached = this.profileCache.get(accountId);
    if (cached !== undefined && Date.now() - cached.at < ttl) return cached.value;

    this.gate();
    const value = await this.api.playerProfile(accountId);
    this.profileCache.set(accountId, { at: Date.now(), value });
    return value;
  }

  // ── 主流程 ──────────────────────────────────────────────────

  /**
   * 最近 N 局战绩。
   * 错误策略：recentMatches 失败 → 抛（没有核心数据，报错比给空结果诚实）；
   *          profile / wl 失败 → 降级（昵称段位缺了也能聊战绩）。
   */
  async recentForm(accountId: number, limit?: number): Promise<DotaForm> {
    if (!this.config.enabled) {
      throw new OpenDotaError('bad-request', 'Dota2 战绩功能未启用（config.dota.enabled=false）');
    }
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new OpenDotaError('bad-request', `account_id 必须是正整数，收到 ${String(accountId)}`);
    }

    const capped = clampLimit(limit, this.config.defaultLimit, this.config.maxLimit);
    const raw = await this.matches(accountId, capped);
    const picked = raw.slice(0, capped);
    const matches = picked.map(toSummary);

    const notes: string[] = [];
    let profile: PlayerProfile | null = null;
    try {
      profile = await this.profile(accountId);
    } catch (err) {
      // 限流/网络问题都只降级：战绩已经在手上了，没必要整条丢掉
      notes.push(`资料（昵称/段位）没取到：${err instanceof Error ? err.message : String(err)}`);
    }

    let totalWin: number | undefined;
    let totalLose: number | undefined;
    if (this.config.includeWinLoss && matches.length > 0) {
      try {
        this.gate();
        const wl = await this.api.winLoss(accountId);
        if (wl !== null) {
          totalWin = wl.win;
          totalLose = wl.lose;
        }
      } catch (err) {
        notes.push(`总胜负没取到：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (this.api.quota !== undefined) {
      const q = this.api.quota;
      this.logger.debug(`dota: quota minute=${String(q.minute)} day=${String(q.day)}`);
    }

    const form = buildForm({
      accountId,
      profile,
      matches,
      ...(totalWin !== undefined && totalLose !== undefined ? { totalWin, totalLose } : {}),
      notes,
    });
    this.logger.info(
      `dota: ${accountId} ${form.displayName || '(无昵称)'} → ${matches.length} 局 ${form.wins}W/${form.losses}L`,
    );
    return form;
  }

  /**
   * 单场详细解析。
   * matchId 必填；accountId 用来定位"这局里的哪个人"（不传就没法算队内排名/对位）。
   */
  async matchDetail(matchId: number, accountId: number): Promise<MatchDetailForm> {
    if (!this.config.enabled) {
      throw new OpenDotaError('bad-request', 'Dota2 战绩功能未启用（config.dota.enabled=false）');
    }
    if (!Number.isSafeInteger(matchId) || matchId <= 0) {
      throw new OpenDotaError('bad-request', `match_id 必须是正整数，收到 ${String(matchId)}`);
    }
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new OpenDotaError('bad-request', `account_id 必须是正整数，收到 ${String(accountId)}`);
    }

    const raw = await this.matchRaw(matchId);
    const itemName = await this.itemNameResolver();
    const form = buildMatchDetailForm(raw, accountId, itemName);
    this.logger.info(
      `dota: 单场 ${matchId} → ${form.player.heroName} `
      + `${form.player.kills}/${form.player.deaths}/${form.player.assists}（${form.player.win ? '胜' : '负'}）`,
    );
    return form;
  }

  /** 取单场原始数据（缓存 + 单飞 + 本地闸门） */
  private async matchRaw(matchId: number): Promise<RawMatchDetail> {
    const ttl = this.config.cacheTtlSec * 1000;
    const cached = this.fresh(this.detailCache.get(matchId), ttl);
    if (cached !== undefined) return cached;

    const running = this.detailInFlight.get(matchId);
    if (running !== undefined) return running;

    const task = (async (): Promise<RawMatchDetail> => {
      this.gate();
      const raw = await this.api.matchDetails(matchId);
      this.detailCache.set(matchId, { at: Date.now(), value: raw });
      return raw;
    })().finally(() => {
      this.detailInFlight.delete(matchId);
    });

    this.detailInFlight.set(matchId, task);
    return task;
  }

  /** 物品 id → 名称；拉一次常量后进程内永久缓存，失败降级为「#id」 */
  private async itemNameResolver(): Promise<(id: number) => string> {
    try {
      const map = await this.api.itemNames();
      return (id: number) => map.get(id) ?? `#${id}`;
    } catch {
      return (id: number) => `#${id}`;
    }
  }

  /**
   * 多人查询。OpenDota 不支持批量，所以串行 + 间隔；
   * 单人失败不中断整批（群里问 5 个人，不该因为 1 个人 ID 填错就全查不到）。
   */
  async recentFormMulti(accountIds: number[], limit?: number): Promise<DotaFormOutcome[]> {
    const unique = [...new Set(accountIds)];
    const out: DotaFormOutcome[] = [];
    for (let i = 0; i < unique.length; i += 1) {
      const accountId = unique[i];
      if (accountId === undefined) continue;
      if (i > 0) await delay(MULTI_QUERY_DELAY_MS);
      try {
        out.push({ ok: true, form: await this.recentForm(accountId, limit) });
      } catch (err) {
        const errorKind = err instanceof OpenDotaError ? err.kind : 'unknown';
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`dota: ${accountId} 查询失败 kind=${errorKind} ${message}`);
        out.push({ ok: false, accountId, errorKind, message });
        // 远端限流时后面几个必然也失败，继续打只会更糟
        if (errorKind === 'rate-limit') {
          for (const rest of unique.slice(i + 1)) {
            out.push({ ok: false, accountId: rest, errorKind, message });
          }
          break;
        }
      }
    }
    return out;
  }

  /** 清掉某个账号的缓存（想强制刷新时用） */
  invalidate(accountId: number): void {
    this.recentCache.delete(accountId);
    this.profileCache.delete(accountId);
  }
}

// ── 渲染 ────────────────────────────────────────────────────

/** 游戏模式 → 中文（只列群聊里真的会遇到的，其余用编号兜底） */
const GAME_MODE_TEXT: Record<number, string> = {
  0: '未知模式',
  1: '全阵营选择',
  2: '队长模式',
  3: '随机征召',
  4: '单一征召',
  5: '全随机',
  11: '中路单挑',
  12: '最少选用',
  16: '队长征召',
  18: '技能征召',
  19: '活动模式',
  20: '全随机死亡竞赛',
  21: '中路 1v1',
  22: '全英雄选择',
  23: '加速模式',
};

/** 房间类型 → 中文 */
const LOBBY_TYPE_TEXT: Record<number, string> = {
  0: '普通匹配',
  1: '练习房',
  2: '锦标赛',
  4: '人机',
  5: '团队匹配',
  6: '单人匹配',
  7: '天梯',
  8: '1v1',
  9: '战斗杯',
};

/** 天梯 lobby_type */
const RANKED_LOBBY = 7;

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  const base = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(Math.max(1, Math.floor(max)), base));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function kdaOf(m: Pick<RawMatch, 'kills' | 'deaths' | 'assists'>): number {
  // 零死亡按 1 计：否则 10/0/5 会变成 Infinity，JS 里 JSON 序列化直接 null
  return round2((m.kills + m.assists) / Math.max(1, m.deaths));
}

function toSummary(m: RawMatch): DotaMatchSummary {
  const durationSec = Math.max(0, m.duration);
  return {
    matchId: m.match_id,
    heroId: m.hero_id,
    heroName: heroName(m.hero_id),
    win: isWin(m),
    kills: m.kills,
    deaths: m.deaths,
    assists: m.assists,
    kdaRatio: kdaOf(m),
    durationSec,
    durationText: `${Math.max(1, Math.round(durationSec / 60))} 分钟`,
    startedAt: new Date(m.start_time * 1000).toISOString(),
    startedAtText: formatRelative(m.start_time),
    gameMode: m.game_mode,
    gameModeText: GAME_MODE_TEXT[m.game_mode] ?? `模式 ${m.game_mode}`,
    lobbyType: m.lobby_type,
    lobbyTypeText: LOBBY_TYPE_TEXT[m.lobby_type] ?? `房间 ${m.lobby_type}`,
    isRanked: m.lobby_type === RANKED_LOBBY,
  };
}

/** unix 秒 → 相对时间 */
function formatRelative(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '时间未知';
  const diffMs = Date.now() - unixSeconds * 1000;
  if (diffMs < 0) return '刚刚';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

interface BuildInput {
  accountId: number;
  profile: PlayerProfile | null;
  /** 已按时间倒序、已裁剪到 limit */
  matches: DotaMatchSummary[];
  totalWin?: number;
  totalLose?: number;
  notes: string[];
}

function buildForm(input: BuildInput): DotaForm {
  const { accountId, profile, matches, totalWin, totalLose } = input;
  const notes = [...input.notes];

  const wins = matches.filter((m) => m.win).length;
  const losses = matches.length - wins;
  const winRate = matches.length === 0 ? 0 : Math.round((wins / matches.length) * 100);
  const avgKda = matches.length === 0 ? 0 : round2(matches.reduce((s, m) => s + m.kdaRatio, 0) / matches.length);

  // 连击：从最近一局往回数，遇到不同结果就停
  let streak = 0;
  const first = matches[0];
  if (first !== undefined) {
    let n = 0;
    for (const m of matches) {
      if (m.win !== first.win) break;
      n += 1;
    }
    streak = first.win ? n : -n;
  }

  let bestMatch: DotaMatchSummary | undefined;
  let worstMatch: DotaMatchSummary | undefined;
  if (matches.length >= 2) {
    for (const m of matches) {
      if (bestMatch === undefined || m.kdaRatio > bestMatch.kdaRatio) bestMatch = m;
      if (worstMatch === undefined || m.kdaRatio < worstMatch.kdaRatio) worstMatch = m;
    }
  }

  const empty = matches.length === 0;
  if (empty) {
    notes.push(
      'OpenDota 上这个账号没有任何最近比赛记录 —— 可能是没打过 Dota2，也可能是对方在设置里关掉了「公开比赛数据」；'
      + '这两种情况在 OpenDota 看来完全一样，没法区分，别替对方下结论。',
    );
  }

  const base: Omit<DotaForm, 'summaryText'> = {
    accountId,
    displayName: profile?.personaName ?? '',
    rankTier: profile?.rankTier ?? null,
    rankText: profile?.rankText ?? null,
    ...(totalWin !== undefined && totalLose !== undefined ? { totalWin, totalLose } : {}),
    matches,
    wins,
    losses,
    winRate,
    avgKda,
    streak,
    ...(bestMatch !== undefined ? { bestMatch } : {}),
    ...(worstMatch !== undefined ? { worstMatch } : {}),
    empty,
    ...(notes.length > 0 ? { note: notes.join('；') } : {}),
  };

  return { ...base, summaryText: renderSummary(base) };
}

/**
 * 渲染成"像人说的话"。
 * 原则：先给结论（几胜几负、连胜连败），再逐条战绩，最后一句对比。
 * 每行只有"英雄 KDA 时长"，模式/房间类型放结构化数据里 —— 文案里塞满字段就没人看了。
 */
function renderSummary(form: Omit<DotaForm, 'summaryText'>): string {
  const who = form.displayName !== '' ? form.displayName : `账号 ${form.accountId}`;

  if (form.empty) {
    return `${who}：在 OpenDota 上查不到最近的比赛记录。`
      + '可能是这个账号没打过 Dota2，也可能是在设置里把「公开比赛数据」关掉了 —— 两种情况从公开数据上完全分不出来。';
  }

  const head: string[] = [];
  head.push(`最近 ${form.matches.length} 局 ${form.wins} 胜 ${form.losses} 负（胜率 ${form.winRate}%）`);
  if (form.streak >= 2) head.push(`当前 ${form.streak} 连胜`);
  else if (form.streak <= -2) head.push(`当前 ${-form.streak} 连败`);

  const meta: string[] = [];
  if (form.rankText !== null) meta.push(form.rankText);
  const rankedCount = form.matches.filter((m) => m.isRanked).length;
  if (rankedCount > 0) meta.push(`${rankedCount}/${form.matches.length} 局天梯`);
  if (form.totalWin !== undefined && form.totalLose !== undefined) {
    const total = form.totalWin + form.totalLose;
    const rate = total === 0 ? 0 : Math.round((form.totalWin / total) * 100);
    meta.push(`生涯 ${form.totalWin} 胜 ${form.totalLose} 负（${rate}%）`);
  }

  const lines: string[] = [];
  lines.push(`${who}｜${head.join('，')}`);
  if (meta.length > 0) lines.push(meta.join(' · '));

  for (const m of form.matches) {
    const mark = m.win ? '✅' : '❌';
    const tease = teaseLine(m);
    const tail = tease === '' ? '' : `｜${tease}`;
    lines.push(`${mark} ${m.heroName} ${m.kills}/${m.deaths}/${m.assists}（KDA ${m.kdaRatio.toFixed(2)} · ${m.durationText}）${tail}`);
  }

  const best = form.bestMatch;
  const worst = form.worstMatch;
  if (best !== undefined && worst !== undefined && best.matchId !== worst.matchId) {
    const gap = best.kdaRatio - worst.kdaRatio;
    // 只有差距明显时才点出来，否则每局都差不多还硬凹对比很假
    if (gap >= 1) {
      const contrast = `最猛的是${best.heroName}（KDA ${best.kdaRatio.toFixed(2)}），`
        + `最差的是${worst.heroName}（KDA ${worst.kdaRatio.toFixed(2)}）`;
      const jibe = jibeOf(worst);
      lines.push(jibe === '' ? contrast : `${contrast}，${jibe}`);
    }
  }

  return lines.join('\n');
}

/** 单局短评：只在明显好/明显糟时给，中间的留白 */
function teaseLine(m: DotaMatchSummary): string {
  if (m.win) {
    if (m.kdaRatio >= 5) return '这局带飞';
    if (m.kdaRatio >= 3) return '打得挺稳';
    // 赢了就不埋汰 —— "躺赢" 这类词在群里容易被当真
    return '';
  }
  if (m.kdaRatio < 0.8) return '这局有点送';
  if (m.kdaRatio < 1.5) return '这局有点划水';
  return '';
}

/**
 * 给"最差那局"配一句话。
 * 只对**输局**开口：赢了还说人家掉链子，读起来像找茬。
 */
function jibeOf(m: DotaMatchSummary): string {
  if (m.win) return '';
  if (m.kdaRatio < 0.8) return '那局基本被按着打';
  if (m.kdaRatio < 1.5) return '那局有点划水';
  if (m.deaths >= 10) return '死得有点多';
  return '';
}

// ── 单场详细解析 ────────────────────────────────────────────

/** 事件属于哪方：优先 team，其次 player_slot（OpenDota 常只给后者） */
function objectiveTeam(o: RawObjective): number | null {
  if (o.team === 2 || o.team === 3) return o.team;
  if (o.playerSlot !== null) return o.playerSlot < 128 ? 2 : 3;
  return null;
}

/**
 * 推塔归属：`badguys_*` 是夜魇的建筑（被天辉拆）→ 2；
 * `goodguys_*` 是天辉的建筑（被夜魇拆）→ 3。
 */
function towerTeam(key: string | null): number | null {
  if (key === null) return null;
  if (key.includes('badguys')) return 2;
  if (key.includes('goodguys')) return 3;
  return null;
}

export function buildMatchDetailForm(
  raw: RawMatchDetail,
  accountId: number,
  itemName: (id: number) => string,
): MatchDetailForm {
  const player = raw.players.find((p) => p.account_id === accountId);
  if (player === undefined) {
    throw new OpenDotaError(
      'bad-request',
      `这场对局里没有 account_id=${accountId} 的玩家（可能没参与，或该场数据未收录）`,
    );
  }

  const isRadiant = player.player_slot < 128;
  const playerIndex = raw.players.indexOf(player);
  const win = isRadiant === raw.radiantWin;
  const teamPlayers = raw.players.filter((p) => (p.player_slot < 128) === isRadiant);

  // 净资产缺失时用 GPM × 分钟估算，保证排名不因缺字段全变 0
  const minutes = Math.max(1, Math.round(raw.durationSec / 60));
  const worthOf = (p: RawMatchPlayer): number => p.net_worth ?? p.gold_per_min * minutes;
  const dmgOf = (p: RawMatchPlayer): number => p.hero_damage ?? 0;

  const rankBy = (list: RawMatchPlayer[], get: (p: RawMatchPlayer) => number): number => {
    const sorted = [...list].sort((a, b) => get(b) - get(a));
    return sorted.indexOf(player) + 1;
  };

  // 对位：同 lane_role 的敌方玩家（多人则取经济最高的那个）
  let laneOpponent: MatchDetailForm['laneOpponent'] = null;
  if (player.lane_role !== null) {
    const foes = raw.players
      .filter((p) => (p.player_slot < 128) !== isRadiant && p.lane_role === player.lane_role)
      .sort((a, b) => worthOf(b) - worthOf(a));
    const opp = foes[0];
    if (opp !== undefined) {
      laneOpponent = {
        heroName: heroName(opp.hero_id),
        gpmDiff: player.gold_per_min - opp.gold_per_min,
        damageDiff: dmgOf(player) - dmgOf(opp),
      };
    }
  }

  // 目标事件：首血 / 肉山 / 推塔
  // 注意 OpenDota 的坑：building_kill 没有 team，首血也常常没有 —— 要按 key / player_slot 推，
  // 直接读 o.team 会得到全场 0（第一版就踩了这个）。
  let firstBlood: 'radiant' | 'dire' | null = null;
  let roshanRadiant = 0;
  let roshanDire = 0;
  let towersRadiant = 0;
  let towersDire = 0;
  for (const o of raw.objectives) {
    if (o.type === 'CHAT_MESSAGE_FIRSTBLOOD') {
      const team = objectiveTeam(o);
      if (team === 2) firstBlood = 'radiant';
      else if (team === 3) firstBlood = 'dire';
    } else if (o.type.includes('ROSHAN_KILL')) {
      const team = objectiveTeam(o);
      if (team === 2) roshanRadiant += 1;
      else if (team === 3) roshanDire += 1;
    } else if (o.type === 'building_kill' && (o.key ?? '').includes('tower')) {
      // team 2 = 天辉拆的，team 3 = 夜魇拆的
      const team = towerTeam(o.key);
      if (team === 2) towersRadiant += 1;
      else if (team === 3) towersDire += 1;
    }
  }

  // 经济曲线（玩家视角：领先为正，落后为负）
  let goldSwing: MatchDetailForm['goldSwing'] = null;
  if (raw.radiantGoldAdv !== null && raw.radiantGoldAdv.length > 0) {
    let maxLead = 0;
    let maxDeficit = 0;
    let leadMinute = 0;
    let deficitMinute = 0;
    raw.radiantGoldAdv.forEach((adv, index) => {
      const lead = isRadiant ? adv : -adv;
      if (lead > maxLead) {
        maxLead = lead;
        leadMinute = index;
      }
      if (lead < maxDeficit) {
        maxDeficit = lead;
        deficitMinute = index;
      }
    });
    goldSwing = { maxLead, maxDeficit: Math.abs(maxDeficit), leadMinute, deficitMinute };
  }

  // 团战参与：该玩家在这段团战里造成过伤害或治疗即算参与。
  // OpenDota 的 teamfights.players 没有 player_slot，是按 players 数组顺序排的，
  // 所以优先按 slot 找（有的版本带），找不到就按下标取。
  let teamfights: MatchDetailForm['teamfights'] = null;
  if (raw.teamfights !== null) {
    let participated = 0;
    for (const fight of raw.teamfights) {
      const entries = fight.players ?? [];
      const entry = entries.find((p) => p.player_slot === player.player_slot) ?? entries[playerIndex];
      if (entry !== undefined && (Number(entry.damage ?? 0) > 0 || Number(entry.healing ?? 0) > 0)) {
        participated += 1;
      }
    }
    teamfights = { count: raw.teamfights.length, participated };
  }

  const items = [player.item_0, player.item_1, player.item_2, player.item_3, player.item_4, player.item_5]
    .filter((id) => id > 0)
    .map((id) => itemName(id));
  const backpack = [player.backpack_0, player.backpack_1, player.backpack_2]
    .filter((id): id is number => id !== null && id > 0)
    .map((id) => itemName(id));

  const base: Omit<MatchDetailForm, 'summaryText'> = {
    matchId: raw.matchId,
    startTimeSec: raw.startTime,
    startText: formatRelative(raw.startTime),
    durationSec: raw.durationSec,
    durationText: `${minutes} 分钟`,
    gameMode: raw.gameMode,
    gameModeText: GAME_MODE_TEXT[raw.gameMode] ?? `模式 ${raw.gameMode}`,
    lobbyType: raw.lobbyType,
    lobbyTypeText: LOBBY_TYPE_TEXT[raw.lobbyType] ?? `房间 ${raw.lobbyType}`,
    isRanked: raw.lobbyType === RANKED_LOBBY,
    radiantWin: raw.radiantWin,
    player: {
      accountId,
      heroId: player.hero_id,
      heroName: heroName(player.hero_id),
      isRadiant,
      win,
      kills: player.kills,
      deaths: player.deaths,
      assists: player.assists,
      kdaRatio: kdaOf(player),
      gpm: player.gold_per_min,
      xpm: player.xp_per_min,
      lastHits: player.last_hits,
      denies: player.denies,
      heroDamage: dmgOf(player),
      towerDamage: player.tower_damage ?? 0,
      heroHealing: player.hero_healing ?? 0,
      netWorth: worthOf(player),
      level: player.level ?? 0,
      items,
      backpack,
    },
    teamRank: {
      netWorth: rankBy(teamPlayers, worthOf),
      heroDamage: rankBy(teamPlayers, dmgOf),
      teamSize: teamPlayers.length,
    },
    laneOpponent,
    objectives: {
      firstBlood,
      roshan: { radiant: roshanRadiant, dire: roshanDire },
      towers: { radiant: towersRadiant, dire: towersDire },
    },
    goldSwing,
    teamfights,
    lineup: {
      radiant: raw.players.filter((p) => p.player_slot < 128).map((p) => heroName(p.hero_id)),
      dire: raw.players.filter((p) => p.player_slot >= 128).map((p) => heroName(p.hero_id)),
    },
    notes: [],
  };

  const notes = buildMatchNotes(base);
  const withNotes: Omit<MatchDetailForm, 'summaryText'> = { ...base, notes };
  return { ...withNotes, summaryText: renderMatchSummary(withNotes) };
}

/** 2 条以内的点评：只在数据明显偏某一边时开口，避免每局都硬凹 */
function buildMatchNotes(form: Omit<MatchDetailForm, 'summaryText'>): string[] {
  const p = form.player;
  const notes: string[] = [];

  if (p.win) {
    if (form.teamRank.netWorth === 1 && form.teamRank.heroDamage === 1) notes.push('队内经济和输出双第一，这局你带的');
    else if (form.teamRank.netWorth === 1) notes.push('队内经济第一，肥得很');
    else if (form.teamRank.heroDamage === 1) notes.push('队内输出第一');
  } else if (p.kdaRatio < 0.8) {
    notes.push('这局有点送');
  } else if (p.kdaRatio < 1.5) {
    notes.push('这局有点划水');
  }

  if (p.deaths >= 8) notes.push(`死了 ${p.deaths} 次，有点多`);
  if (p.gpm >= 600) notes.push(`GPM ${p.gpm}，经济很肥`);
  if (form.teamfights !== null && form.teamfights.count > 0) {
    const rate = form.teamfights.participated / form.teamfights.count;
    if (rate < 0.5) notes.push(`团战只赶上 ${form.teamfights.participated}/${form.teamfights.count}，参团偏少`);
  }

  // 同一件事不重复说（比如"送"和"死得多"）
  return [...new Set(notes)].slice(0, 2);
}

function renderMatchSummary(form: Omit<MatchDetailForm, 'summaryText'>): string {
  const p = form.player;
  const lines: string[] = [];
  const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

  lines.push(
    `${p.heroName}（${p.isRadiant ? '天辉' : '夜魇'}）${p.win ? '胜' : '负'} · ${form.gameModeText}`
    + `${form.isRanked ? ' · 天梯' : ` · ${form.lobbyTypeText}`} · ${form.durationText} · ${form.startText}`,
  );
  lines.push(
    `KDA ${p.kills}/${p.deaths}/${p.assists}（${p.kdaRatio.toFixed(2)}）· GPM ${p.gpm} · XPM ${p.xpm}`
    + ` · 正补 ${p.lastHits}/${p.denies} · ${p.level} 级`,
  );
  lines.push(
    `伤害 ${p.heroDamage}${form.teamRank.heroDamage > 0 ? `（队内第 ${form.teamRank.heroDamage}）` : ''}`
    + ` · 建筑 ${p.towerDamage} · 治疗 ${p.heroHealing}`
    + ` · 净资产 ${p.netWorth}${form.teamRank.netWorth > 0 ? `（队内第 ${form.teamRank.netWorth}）` : ''}`,
  );
  if (p.items.length > 0) lines.push(`装备：${p.items.join('、')}`);
  if (form.laneOpponent !== null) {
    const o = form.laneOpponent;
    lines.push(`对位 ${o.heroName}：经济 ${sign(o.gpmDiff)} GPM · 输出 ${sign(o.damageDiff)}`);
  }

  const ob = form.objectives;
  const fb = ob.firstBlood === null ? '未知' : ob.firstBlood === 'radiant' ? '天辉' : '夜魇';
  lines.push(`首血 ${fb} · 肉山 天辉 ${ob.roshan.radiant} / 夜魇 ${ob.roshan.dire} · 推塔 天辉 ${ob.towers.radiant} / 夜魇 ${ob.towers.dire}`);

  if (form.goldSwing !== null) {
    const g = form.goldSwing;
    lines.push(`经济曲线：最多领先 ${g.maxLead}（约第 ${g.leadMinute} 分）· 最多落后 ${g.maxDeficit}（约第 ${g.deficitMinute} 分）`);
  } else {
    lines.push('这场没被解析，经济曲线和团战看不到（基础数据仍然准确）');
  }
  if (form.teamfights !== null) lines.push(`团战 ${form.teamfights.count} 次，参与 ${form.teamfights.participated} 次`);

  if (form.lineup.radiant.length > 0) {
    lines.push(`阵容｜天辉 ${form.lineup.radiant.join('、')}｜夜魇 ${form.lineup.dire.join('、')}`);
  }
  if (form.notes.length > 0) lines.push(`点评：${form.notes.join('；')}`);

  return lines.join('\n');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
