/**
 * OpenDota 客户端（零依赖，只用 fetch）
 * ─────────────────────────────────────────────────────────────
 * 为什么是 OpenDota 而不是 Valve 官方：
 *   IDOTA2Match_570 用普通 Web API Key 调会返回 403（需要特殊的比赛数据权限），
 *   群里问一句战绩没必要为它单独申请权限。OpenDota 反而是免 key 的。
 *
 * 限流（实测响应头）：
 *   X-Rate-Limit-Remaining-Minute / X-Rate-Limit-Remaining-Day
 *   匿名额度 60 次/分钟、3000 次/天。这里把剩余额度记到 lastQuota 供上层降级，
 *   但**不做**主动节流 —— 本地闸门在 service 层，客户端只管单次请求的可靠性。
 *
 * 一个账号一次请求：OpenDota 没有批量端点。多人查询的串行与延迟也归 service 层。
 */

const API_BASE = 'https://api.opendota.com/api';

/** 429 时最多等这么久（Retry-After 更大就直接放弃，别把群消息挂在那儿） */
const MAX_RETRY_WAIT_MS = 3000;

/** 429 最多重试 1 次：重试是给「瞬时抖动」留的余地，不是用来对抗真限流的 */
const MAX_RETRY_ON_429 = 1;

export type OpenDotaErrorKind =
  | 'rate-limit'    // 429，或本地闸门判定超限
  | 'not-found'     // 404：account_id 不存在
  | 'network'       // 连接失败 / DNS / TLS
  | 'timeout'       // 超过 timeoutMs
  | 'server'        // 5xx
  | 'bad-response'  // 2xx 但 body 不是预期形状
  | 'bad-request';  // 调用方传了非法参数（account_id 不是正整数）

export class OpenDotaError extends Error {
  readonly kind: OpenDotaErrorKind;
  readonly status?: number;

  constructor(kind: OpenDotaErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'OpenDotaError';
    this.kind = kind;
    this.status = status;
  }
}

/** OpenDota 剩余额度快照（拿不到 header 时为 null） */
export interface DotaQuota {
  /** 本分钟剩余次数 */
  minute: number | null;
  /** 本天剩余次数 */
  day: number | null;
  /** 这次响应的时间戳 */
  at: number;
}

/** /players/{id}/recentMatches 的一条原始记录（26 个字段，按 OpenDota 实际返回） */
export interface RawMatch {
  match_id: number;
  /** 0-4 天辉，128-132 夜魇 —— 判断胜负的关键，不要用 0/1 */
  player_slot: number;
  radiant_win: boolean;
  hero_id: number;
  /** unix 秒 */
  start_time: number;
  /** 秒 */
  duration: number;
  game_mode: number;
  lobby_type: number;
  version: number | null;
  kills: number;
  deaths: number;
  assists: number;
  /** 可为 null（不可依赖） */
  average_rank: number | null;
  xp_per_min: number;
  gold_per_min: number;
  hero_damage: number;
  tower_damage: number;
  hero_healing: number;
  last_hits: number;
  lane: number | null;
  lane_role: number | null;
  is_roaming: boolean | null;
  cluster: number | null;
  leaver_status: number;
  /** 可为 null（单人/未知） */
  party_size: number | null;
  hero_variant: number | null;
}

/** /players/{id} 的裁剪结果 */
export interface PlayerProfile {
  accountId: number;
  /** SteamID64（字符串，超出 Number 安全整数） */
  steamId: string | null;
  personaName: string | null;
  avatar: string | null;
  /** 天梯奖章：十位=等级(1-8)，个位=星级(1-5)；null 表示未定级/未公开 */
  rankTier: number | null;
  /** 奖章的中文文案，如「传奇 3 星」；未定级时为 null */
  rankText: string | null;
}

export interface OpenDotaOptions {
  timeoutMs?: number;
  userAgent?: string;
}

/** /matches/{id} 里的一个玩家（只取"详细解析"要用的字段，其余忽略） */
export interface RawMatchPlayer {
  account_id: number | null;
  player_slot: number;
  hero_id: number;
  kills: number;
  deaths: number;
  assists: number;
  gold_per_min: number;
  xp_per_min: number;
  last_hits: number;
  denies: number;
  hero_damage: number | null;
  tower_damage: number | null;
  hero_healing: number | null;
  net_worth: number | null;
  level: number | null;
  item_0: number;
  item_1: number;
  item_2: number;
  item_3: number;
  item_4: number;
  item_5: number;
  backpack_0: number | null;
  backpack_1: number | null;
  backpack_2: number | null;
  /** 1=优势路 2=中路 3=劣势路 4=打野（OpenDota 口径） */
  lane_role: number | null;
}

/** /matches/{id} 的一条目标事件（首血 / 肉山 / 推塔） */
export interface RawObjective {
  /** 秒（相对开局，可能为负 = 开局前） */
  time: number;
  type: string;
  /**
   * 2 = 天辉方做的，3 = 夜魇方做的。
   * 注意：**推塔事件（building_kill）通常没有 team**，首血也常常没有 ——
   * 这时要靠 playerSlot / key 推，别直接当 0 处理。
   */
  team: number | null;
  /** 做事的人（首血/肉山常有；推塔不一定） */
  playerSlot: number | null;
  /** 推塔时的建筑名，如 npc_dota_badguys_tower1_mid */
  key: string | null;
}

/** /matches/{id} 的裁剪结果 */
export interface RawMatchDetail {
  matchId: number;
  startTime: number;
  durationSec: number;
  gameMode: number;
  lobbyType: number;
  radiantWin: boolean;
  players: RawMatchPlayer[];
  objectives: RawObjective[];
  /** 每分钟天辉经济领先（负 = 夜魇领先）；未解析时为 null */
  radiantGoldAdv: number[] | null;
  /** 团战片段；未解析时为 null。players 按对局 players 数组顺序排列（没有 player_slot） */
  teamfights: Array<{ players?: Array<{ player_slot?: number; damage?: number; healing?: number }> }> | null;
}

/** 天梯奖章编号 → 中文。51 = 传奇 1 星（十位是等级，个位是星级） */
export function rankTierText(rankTier: number | null | undefined): string | null {
  if (typeof rankTier !== 'number' || !Number.isFinite(rankTier) || rankTier <= 0) return null;
  const tier = Math.floor(rankTier / 10);
  const star = rankTier % 10;
  const tiers = ['', '先驱', '卫士', '十字军', '执政官', '传奇', '神话', '超凡', '不朽'];
  const label = tiers[tier];
  if (label === undefined || label === '') return null;
  // 不朽段位不显示星级（顶段没有星）
  if (tier >= 8) return star > 0 ? `不朽 ${star}` : '不朽';
  return star > 0 ? `${label} ${star} 星` : label;
}

/** 胜负判定：天辉玩家（slot 0-4）赢 = radiant_win；夜魇玩家（slot >= 128）赢 = !radiant_win。
 *  recentMatches **没有** win 字段，这是唯一可靠的算法（已逐条对账验证）。
 */
export function isWin(match: Pick<RawMatch, 'player_slot' | 'radiant_win'>): boolean {
  return match.radiant_win === (match.player_slot < 128);
}

// ── SteamID64 ⇄ account_id ─────────────────────────────────
// 公式：account_id = SteamID64 - 76561197960265728
// SteamID64 远超 Number 安全整数（2^53），必须用 BigInt 中转；
// 但 account_id 本身是 32 位无符号，对外给 number 是安全的。
// 放在这个文件里是因为它们描述的是 "OpenDota 的 account_id" 这个语义，
// 也顺便避免 tools.ts ↔ index.ts 的循环依赖。

const STEAM_ID64_BASE = 76561197960265728n;

/**
 * SteamID64 → account_id。
 * 非法（不是 17 位、低于账号基址、超出安全整数）返回 null，不抛错 —— 这是用户输入。
 */
export function steamIdToAccountId(steamId: string): number | null {
  const text = String(steamId ?? '').trim();
  if (!/^\d{17}$/.test(text)) return null;
  const accountId = BigInt(text) - STEAM_ID64_BASE;
  if (accountId <= 0n || accountId > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(accountId);
}

/** account_id → SteamID64（排查"这是谁"时用） */
export function accountIdToSteamId(accountId: number): string | null {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) return null;
  return (STEAM_ID64_BASE + BigInt(accountId)).toString();
}

export class OpenDotaApi {
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  /** 最近一次响应的剩余额度（含 4xx/5xx 响应，Header 在错误响应上也有） */
  lastQuota: DotaQuota | undefined;

  /** 物品 id → 名称；/constants/items 拉一次后进程内永久缓存 */
  private itemNamesCache: Map<number, string> | null = null;

  constructor({ timeoutMs = 8000, userAgent = 'dsh-qqbot/dota' }: OpenDotaOptions = {}) {
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
  }

  // ── 底层 ──────────────────────────────────────────────────

  private assertAccountId(accountId: number): void {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new OpenDotaError('bad-request', `account_id 必须是正整数，收到 ${String(accountId)}`);
    }
  }

  private recordQuota(res: Response): void {
    const pick = (name: string): number | null => {
      const raw = res.headers.get(name);
      if (raw === null) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    this.lastQuota = {
      minute: pick('x-rate-limit-remaining-minute'),
      day: pick('x-rate-limit-remaining-day'),
      at: Date.now(),
    };
  }

  /** 单次 HTTP 往返，不重试；只负责把传输层错误翻译成 timeout / network */
  private async send(path: string): Promise<Response> {
    const url = `${API_BASE}${path}`;
    let res: Response;
    try {
      res = await globalThis.fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: 'application/json',
          'user-agent': this.userAgent,
        },
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const reason = err instanceof Error ? err.message : String(err);
      // AbortSignal.timeout 抛的是 TimeoutError；外部取消是 AbortError。对上层都是"没拿到"
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new OpenDotaError('timeout', `请求 OpenDota 超时（${this.timeoutMs}ms）: ${path}`);
      }
      throw new OpenDotaError('network', `请求 OpenDota 失败: ${reason}`);
    }
    this.recordQuota(res);
    return res;
  }

  /** 解析 Retry-After：秒数或 HTTP 日期。解析不出来返回 null（→ 不重试） */
  private static parseRetryAfter(raw: string | null): number | null {
    if (raw === null || raw.trim() === '') return null;
    const text = raw.trim();
    if (/^\d+(\.\d+)?$/.test(text)) {
      const sec = Number(text);
      return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : null;
    }
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    return Math.max(0, at - Date.now());
  }

  /**
   * GET + 错误分类。
   * 429 只在 Retry-After 明确给出且 ≤3 秒时重试 1 次；否则立刻抛 rate-limit。
   * 理由：群聊场景下让一条消息等十几秒比直接说"太频繁了"更糟。
   */
  private async get(path: string): Promise<unknown> {
    let res = await this.send(path);
    let retried = 0;

    if (res.status === 429) {
      const waitMs = OpenDotaApi.parseRetryAfter(res.headers.get('retry-after'));
      if (waitMs !== null && waitMs <= MAX_RETRY_WAIT_MS && retried < MAX_RETRY_ON_429) {
        retried += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        res = await this.send(path);
      }
    }

    if (res.status === 429) {
      // 不读 body：OpenDota 的 429 文案没有额外信息，读完只是多消耗一个 socket
      void res.body?.cancel().catch(() => {});
      throw new OpenDotaError('rate-limit', 'OpenDota 限流（HTTP 429），稍后再查', 429);
    }
    if (res.status === 404) {
      void res.body?.cancel().catch(() => {});
      throw new OpenDotaError('not-found', 'OpenDota 找不到这个 account_id（HTTP 404）', 404);
    }
    if (res.status >= 500) {
      void res.body?.cancel().catch(() => {});
      throw new OpenDotaError('server', `OpenDota 服务端错误（HTTP ${res.status}），通常是它自己在抽风`, res.status);
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw new OpenDotaError('bad-response', `OpenDota 返回 HTTP ${res.status}`, res.status);
    }

    try {
      return (await res.json()) as unknown;
    } catch {
      throw new OpenDotaError('bad-response', 'OpenDota 返回的不是合法 JSON');
    }
  }

  // ── 端点 ──────────────────────────────────────────────────

  /**
   * 最近比赛（默认 OpenDota 给 20 条，可用 limit 收窄）。
   * 空数据账号返回 `200 []`，不是 404 —— 这点很重要：调用方不能把它当错误。
   */
  async recentMatches(accountId: number, limit?: number): Promise<RawMatch[]> {
    this.assertAccountId(accountId);
    const params = new URLSearchParams();
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      params.set('limit', String(Math.max(1, Math.min(100, Math.floor(limit)))));
    }
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
    const data = await this.get(`/players/${accountId}/recentMatches${suffix}`);

    if (!Array.isArray(data)) {
      throw new OpenDotaError('bad-response', 'recentMatches 返回的不是数组');
    }
    // 逐条过滤：宁可少一条，也不要让 undefined 字段一路传到文案里
    return data.filter(isRawMatch).map(normalizeMatch);
  }

  /**
   * 玩家资料。查不到（404 或 profile 为 null）返回 null，不抛错 ——
   * 空数据账号就是 `profile: {personaname: null, ...}`，这是正常状态。
   */
  async playerProfile(accountId: number): Promise<PlayerProfile | null> {
    this.assertAccountId(accountId);
    let data: unknown;
    try {
      data = await this.get(`/players/${accountId}`);
    } catch (err) {
      if (err instanceof OpenDotaError && err.kind === 'not-found') return null;
      throw err;
    }
    if (data === null || typeof data !== 'object') return null;

    const body = data as { profile?: Record<string, unknown> | null; rank_tier?: unknown };
    const profile = body.profile;
    const rankTier = typeof body.rank_tier === 'number' && body.rank_tier > 0 ? body.rank_tier : null;
    if (profile === null || profile === undefined) {
      // 没有 profile 也可能有 rank_tier，别把整条丢掉
      return {
        accountId,
        steamId: null,
        personaName: null,
        avatar: null,
        rankTier,
        rankText: rankTierText(rankTier),
      };
    }

    const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
    return {
      accountId,
      steamId: str(profile.steamid),
      personaName: str(profile.personaname),
      avatar: str(profile.avatarfull) ?? str(profile.avatar),
      rankTier,
      rankText: rankTierText(rankTier),
    };
  }

  /** 总胜负。拿不到（404/形状不对）返回 null，让上层省略这项而不是整条失败 */
  async winLoss(accountId: number): Promise<{ win: number; lose: number } | null> {
    this.assertAccountId(accountId);
    let data: unknown;
    try {
      data = await this.get(`/players/${accountId}/wl`);
    } catch (err) {
      if (err instanceof OpenDotaError && err.kind === 'not-found') return null;
      throw err;
    }
    if (data === null || typeof data !== 'object') return null;
    const { win, lose } = data as { win?: unknown; lose?: unknown };
    if (typeof win !== 'number' || typeof lose !== 'number') {
      // 空数据账号会给 {"win":0,"lose":0}，所以数字 0 是合法的；非数字才算形状异常
      return null;
    }
    return { win, lose };
  }

  /**
   * 单场详细数据（/matches/{id}）。
   *
   * 是否"解析过"决定能不能看到经济曲线 / 团战：未解析的局只有基础 KDA，
   * 调用方要靠 `radiantGoldAdv === null` 判断，而不是硬算出一个假的曲线。
   * 找不到该场（404）抛 not-found，由上层翻译成"这场查不到/还没被收录"。
   */
  async matchDetails(matchId: number): Promise<RawMatchDetail> {
    const id = Number(matchId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new OpenDotaError('bad-request', `match_id 必须是正整数，收到 ${String(matchId)}`);
    }
    const data = await this.get(`/matches/${id}`);
    if (data === null || typeof data !== 'object') {
      throw new OpenDotaError('bad-response', 'match 详情返回的不是对象');
    }
    return normalizeMatchDetail(data as Record<string, unknown>, id);
  }

  /**
   * 物品 id → 显示名。
   * /constants/items 一次给 501 条，拉一次就永久缓存（进程内），失败由调用方降级成 `#id`。
   */
  async itemNames(): Promise<Map<number, string>> {
    if (this.itemNamesCache !== null) return this.itemNamesCache;
    const data = await this.get('/constants/items');
    const map = new Map<number, string>();
    if (data !== null && typeof data === 'object') {
      for (const value of Object.values(data as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object') continue;
        const item = value as { id?: unknown; dname?: unknown };
        const id = num(item.id, 0);
        const name = typeof item.dname === 'string' ? item.dname.trim() : '';
        if (id > 0 && name !== '') map.set(id, name);
      }
    }
    this.itemNamesCache = map;
    return map;
  }

  /** 当前剩余额度（给日志/降级用） */
  get quota(): DotaQuota | undefined {
    return this.lastQuota;
  }
}

// ── 原始数据校验 ────────────────────────────────────────────

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function isRawMatch(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  // 最低要求：没有这三个字段就没法算胜负/展示，别的都可以兜底
  return typeof m.match_id === 'number' && typeof m.player_slot === 'number' && typeof m.radiant_win === 'boolean';
}

function normalizeMatch(v: Record<string, unknown>): RawMatch {  return {
    match_id: num(v.match_id),
    player_slot: num(v.player_slot),
    radiant_win: v.radiant_win === true,
    hero_id: num(v.hero_id),
    start_time: num(v.start_time),
    duration: num(v.duration),
    game_mode: num(v.game_mode),
    lobby_type: num(v.lobby_type),
    version: numOrNull(v.version),
    kills: num(v.kills),
    deaths: num(v.deaths),
    assists: num(v.assists),
    average_rank: numOrNull(v.average_rank),
    xp_per_min: num(v.xp_per_min),
    gold_per_min: num(v.gold_per_min),
    hero_damage: num(v.hero_damage),
    tower_damage: num(v.tower_damage),
    hero_healing: num(v.hero_healing),
    last_hits: num(v.last_hits),
    lane: numOrNull(v.lane),
    lane_role: numOrNull(v.lane_role),
    is_roaming: typeof v.is_roaming === 'boolean' ? v.is_roaming : null,
    cluster: numOrNull(v.cluster),
    leaver_status: num(v.leaver_status),
    party_size: numOrNull(v.party_size),
    hero_variant: numOrNull(v.hero_variant),
  };
}

/**
 * /matches/{id} 的归一化。
 * 字段缺失一律给安全默认值，绝不让 undefined 流到文案里；
 * 未解析的局没有 radiant_gold_adv / teamfights，这两个给 null 而不是空数组 ——
 * 「没有」和「空」在分析里是两种意思。
 */
function normalizeMatchDetail(v: Record<string, unknown>, id: number): RawMatchDetail {
  const players: RawMatchPlayer[] = [];
  if (Array.isArray(v.players)) {
    for (const item of v.players) {
      if (item === null || typeof item !== 'object') continue;
      const p = item as Record<string, unknown>;
      const heroId = num(p.hero_id);
      if (heroId <= 0) continue;
      players.push({
        account_id: numOrNull(p.account_id),
        player_slot: num(p.player_slot),
        hero_id: heroId,
        kills: num(p.kills),
        deaths: num(p.deaths),
        assists: num(p.assists),
        gold_per_min: num(p.gold_per_min),
        xp_per_min: num(p.xp_per_min),
        last_hits: num(p.last_hits),
        denies: num(p.denies),
        hero_damage: numOrNull(p.hero_damage),
        tower_damage: numOrNull(p.tower_damage),
        hero_healing: numOrNull(p.hero_healing),
        net_worth: numOrNull(p.net_worth),
        level: numOrNull(p.level),
        item_0: num(p.item_0),
        item_1: num(p.item_1),
        item_2: num(p.item_2),
        item_3: num(p.item_3),
        item_4: num(p.item_4),
        item_5: num(p.item_5),
        backpack_0: numOrNull(p.backpack_0),
        backpack_1: numOrNull(p.backpack_1),
        backpack_2: numOrNull(p.backpack_2),
        lane_role: numOrNull(p.lane_role),
      });
    }
  }

  const objectives: RawObjective[] = [];
  if (Array.isArray(v.objectives)) {
    for (const item of v.objectives) {
      if (item === null || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const type = typeof o.type === 'string' ? o.type : '';
      if (type === '') continue;
      objectives.push({
        time: num(o.time),
        type,
        team: numOrNull(o.team),
        playerSlot: numOrNull(o.player_slot),
        key: typeof o.key === 'string' ? o.key : o.key === undefined ? null : String(o.key),
      });
    }
  }

  const radiantGoldAdv = Array.isArray(v.radiant_gold_adv) && v.radiant_gold_adv.length > 0
    ? v.radiant_gold_adv.map((x) => num(x))
    : null;

  const teamfights = Array.isArray(v.teamfights)
    ? (v.teamfights as Array<{ players?: Array<{ player_slot?: number; damage?: number; healing?: number }> }>)
    : null;

  return {
    matchId: id,
    startTime: num(v.start_time),
    durationSec: num(v.duration),
    gameMode: num(v.game_mode),
    lobbyType: num(v.lobby_type),
    radiantWin: v.radiant_win === true,
    players,
    objectives,
    radiantGoldAdv,
    teamfights,
  };
}
