/**
 * 本地战绩库（按 match_id 存）
 * ─────────────────────────────────────────────────────────────
 * digest 每轮查询都会拿到每个人最近 N 局的原始摘要，但以前**用完就丢**：
 *   - 播报只能靠这轮的返回值，跨天/跨轮次无法复用；
 *   - 两个人是否同一场，要再请求一次 `/matches/{id}` 才知道；
 *   - 时间只能从 `startedAt` 反推，还要防时区错位。
 *
 * 这里按 match_id 落一份精简账本：
 *   - `startTime` 存 OpenDota 的原始 `start_time`（秒），时间是权威值；
 *   - `players` 只记**我们查过的人**（绑定的群友），不是全队十人 —— 不冒充全量；
 *   - 同 match_id 的多次写入按 accountId 合并，于是「这一场有哪几个群友」自然算得出来。
 *
 * 文件位置：`~/.dsh-qqbot/dota/matches.json`（与 ability-records.json 同目录，
 * 整个 dota/ 拷走即可迁移）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CachedMatchPlayer {
  accountId: number;
  /** 群里的称呼（同一账号可能多个来源，取最后一次写入的非空值） */
  alias?: string;
  heroId: number;
  heroName: string;
  kills: number;
  deaths: number;
  assists: number;
  win: boolean;
}

/** 一局里某个群友真实抽到的技能（官方中文名 + 使用/加点次数） */
export interface CachedBriefAbility {
  name: string;
  nameZh?: string;
  uses: number;
  behavior?: string;
  damageType?: string;
}

/** 一场里某个绑定群友的完整表现（不是全队十人，全队阵容在 lineup 里） */
export interface CachedBriefPlayer {
  /** 群里的称呼 */
  name: string;
  hero: string;
  kda: string;
  win: boolean;
  gpm?: number;
  xpm?: number;
  netWorth?: number;
  heroDamage?: number;
  /** 队内经济排名（1=最富） */
  teamRank?: number;
  /** 队内输出排名（1=伤害最高） */
  damageRank?: number;
  teamSize?: number;
  /**
   * 这一局的实际定位 —— 核心 / 辅助 / 看不出。
   * 2026-11-15 修：没有这个字段时模型只能看英雄名猜，
   * 把「赏金猎人 2/6/19」当成主输出骂了一场。
   */
  role?: 'core' | 'support' | 'unknown';
  /** 判定理由（客观行为，如「插了 5 个眼」），只给模型参考，别照抄进群里 */
  roleReason?: string;
  /**
   * 这一局的事实清单（维度 → 纯数据 → 优势/劣势/无异常）+ 结论候选。
   *
   * 2026-11-16 加：群里的原话是「我看他从来没有综合分析过能收集的数据吧，
   * 不都是抓一两条就开始评么」。数据其实一直在手边，只是散成字段，模型就只挑
   * KDA／伤害这两个最好念的说。把逐项对照表直接摆进去，它才没得偷懒。
   * 形状与 service.ts 的 MatchFactSheet 相同（这里重新声明一份：
   * match-cache 是落盘层，不 import service，避免 dota 内部互相抓着类型跑）。
   */
  factSheet?: {
    lines: Array<{ dim: string; fact: string; verdict: 'plus' | 'minus' | 'flat' }>;
    findings: Array<{ text: string; evidence: number[] }>;
  };
  /** 如「参团 16/16」 */
  teamfight?: string;
  abilities: CachedBriefAbility[];
  abilityMix?: string;
  /** 技能次数口径：uses=实际使用，levels=半解析时按加点数兜底 */
  abilityBasis?: 'uses' | 'levels';
}

/**
 * 一场比赛的「完整简报」——给模型判断核心/辅助用的精简投影。
 *
 * 2026-11-12：以前只给模型 1 局 × 9 个数字 + 一句 abilityMix 套话，
 * 于是「幻影刺客拿了一堆辅助团战技能」被当成核心去点评。这里把
 * 技能明细、队内经济/输出排名、全队阵容一次给全。
 *
 * parsed=false 表示 OpenDota 还没解析完（技能/团战缺席），下次查询会重拉。
 */
export interface CachedBriefSession {
  matchId: number;
  /** 「11月11日 21:08」——按 Asia/Shanghai 渲染好的开赛时间 */
  when: string;
  gameMode: string;
  durationMin: number;
  parsed: boolean;
  /**
   * 简报表结构版本。加了新字段就 +1，缓存命中时会按它失效重取 ——
   * 否则新字段永远是 undefined（2026-11-15 加 role 时踩到）。
   */
  schema?: number;
  boundPlayers: CachedBriefPlayer[];
  lineup?: { radiant: string[]; dire: string[] };
  /** 这份简报最后一次取数时间（ms） */
  fetchedAt: number;
}

export interface CachedMatch {
  matchId: number;
  /** OpenDota 原始 start_time（秒） */
  startTime: number;
  durationSec?: number;
  gameMode?: number;
  /** 已知的参与者（只含我们查过的人） */
  players: CachedMatchPlayer[];
  /** 最近一次写入时间（ms） */
  at: number;
  /** 该场的完整简报（按 matchId 只存一份，解析完成后不再重拉） */
  briefing?: CachedBriefSession;
}

interface CacheFile {
  version: number;
  matches: Record<string, CachedMatch>;
}

/** 一次 upsert 的最小输入：一个人在一场里的表现 */
export interface CachedMatchInput {
  matchId: number;
  /** 原始 start_time（秒）；<=0 视为无效，调用方应先过滤 */
  startTime: number;
  durationSec?: number;
  gameMode?: number;
  player: CachedMatchPlayer;
}

/** 最多留多少场（一天十几场，800 场≈两三个月，再老也没人翻） */
const DEFAULT_MAX_MATCHES = 800;
const FILE_VERSION = 1;

/**
 * 简报结构版本：给 CachedBriefSession 加字段时 +1。
 * briefing 构建器只复用 schema 相同的缓存，老简报自动重取一次。
 */
export const BRIEF_SCHEMA = 3;

function isFinitePositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** 可接受的 verdict 三态；别的值一律当坏数据丢掉 */
function isVerdict(v: unknown): v is 'plus' | 'minus' | 'flat' {
  return v === 'plus' || v === 'minus' || v === 'flat';
}

/**
 * factSheet 的形状兜底（2026-11-16 加）。
 *
 * 为什么要单独兜一遍而不是直接信 JSON：这份数据在**缓存命中**时会原样喂给模型，
 * 一条形式坏掉的行（verdict 拼错、evidence 指向不存在的下标）就会让模型指错行说错话。
 * 兜底口径跟 role 字段一样：坏一条丢一条，整份不因此作废。
 */
function sanitizeFactSheet(v: unknown): CachedBriefPlayer['factSheet'] {
  if (v === null || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const lines: Array<{ dim: string; fact: string; verdict: 'plus' | 'minus' | 'flat' }> = [];
  if (Array.isArray(o.lines)) {
    for (const item of o.lines) {
      if (item === null || typeof item !== 'object') continue;
      const l = item as Record<string, unknown>;
      if (typeof l.dim !== 'string' || l.dim === '') continue;
      if (typeof l.fact !== 'string' || l.fact === '') continue;
      if (!isVerdict(l.verdict)) continue;
      lines.push({ dim: l.dim, fact: l.fact, verdict: l.verdict });
    }
  }
  if (lines.length === 0) return undefined;

  const findings: Array<{ text: string; evidence: number[] }> = [];
  if (Array.isArray(o.findings)) {
    for (const item of o.findings) {
      if (item === null || typeof item !== 'object') continue;
      const f = item as Record<string, unknown>;
      if (typeof f.text !== 'string' || f.text === '') continue;
      const evidence = Array.isArray(f.evidence)
        // 下标必须落在 lines 范围内：越界的 evidence 就是「指回不存在的数据」
        ? f.evidence.filter((e): e is number => (
          typeof e === 'number' && Number.isInteger(e) && e >= 0 && e < lines.length
        ))
        : [];
      if (evidence.length === 0) continue;
      findings.push({ text: f.text, evidence });
    }
  }
  return { lines, findings };
}

/** 简报只做形状兜底：坏字段丢掉，不让整份 matches.json 作废 */
function sanitizeBriefing(v: unknown, matchId: number): CachedBriefSession | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const s = (obj: Record<string, unknown>, key: string): string | undefined => (
    typeof obj[key] === 'string' && (obj[key] as string) !== '' ? obj[key] as string : undefined
  );
  const n = (obj: Record<string, unknown>, key: string): number | undefined => (
    typeof obj[key] === 'number' && Number.isFinite(obj[key]) ? obj[key] as number : undefined
  );

  const boundPlayers: CachedBriefPlayer[] = [];
  const rawPlayers = Array.isArray(o.boundPlayers) ? o.boundPlayers : [];
  for (const p of rawPlayers) {
    if (p === null || typeof p !== 'object') continue;
    const q = p as Record<string, unknown>;
    if (s(q, 'name') === undefined) continue;
    // factSheet 兜一遍形状：缓存命中时这份数据是直接喂模型的，
    // 一条 verdict 拼错/evidence 越界的行就会让它指错行说错话（2026-11-16）。
    // 只调一次，结果放进局部变量 —— 调两次是白算（而且每次都会新建对象）。
    const factSheet = sanitizeFactSheet(q.factSheet);
    const abilities: CachedBriefAbility[] = [];
    if (Array.isArray(q.abilities)) {
      for (const a of q.abilities) {
        if (a === null || typeof a !== 'object') continue;
        const b = a as Record<string, unknown>;
        if (s(b, 'name') === undefined) continue;
        abilities.push({
          name: b.name as string,
          ...(s(b, 'nameZh') !== undefined ? { nameZh: b.nameZh as string } : {}),
          uses: n(b, 'uses') ?? 0,
          ...(s(b, 'behavior') !== undefined ? { behavior: b.behavior as string } : {}),
          ...(s(b, 'damageType') !== undefined ? { damageType: b.damageType as string } : {}),
        });
      }
    }
    boundPlayers.push({
      name: q.name as string,
      hero: s(q, 'hero') ?? '',
      kda: s(q, 'kda') ?? '',
      win: q.win === true,
      abilities,
      ...(n(q, 'gpm') !== undefined ? { gpm: n(q, 'gpm') as number } : {}),
      ...(n(q, 'xpm') !== undefined ? { xpm: n(q, 'xpm') as number } : {}),
      ...(n(q, 'netWorth') !== undefined ? { netWorth: n(q, 'netWorth') as number } : {}),
      ...(n(q, 'heroDamage') !== undefined ? { heroDamage: n(q, 'heroDamage') as number } : {}),
      ...(n(q, 'teamRank') !== undefined ? { teamRank: n(q, 'teamRank') as number } : {}),
      ...(n(q, 'damageRank') !== undefined ? { damageRank: n(q, 'damageRank') as number } : {}),
      ...(n(q, 'teamSize') !== undefined ? { teamSize: n(q, 'teamSize') as number } : {}),
      ...(s(q, 'teamfight') !== undefined ? { teamfight: q.teamfight as string } : {}),
      ...(s(q, 'abilityMix') !== undefined ? { abilityMix: q.abilityMix as string } : {}),
      ...(q.role === 'core' || q.role === 'support' || q.role === 'unknown'
        ? { role: q.role as 'core' | 'support' | 'unknown' }
        : {}),
      ...(s(q, 'roleReason') !== undefined ? { roleReason: q.roleReason as string } : {}),
      ...(q.abilityBasis === 'uses' || q.abilityBasis === 'levels'
        ? { abilityBasis: q.abilityBasis as 'uses' | 'levels' }
        : {}),
      ...(factSheet !== undefined ? { factSheet } : {}),
    });
  }
  let lineup: CachedBriefSession['lineup'];
  if (o.lineup !== null && typeof o.lineup === 'object') {
    const l = o.lineup as Record<string, unknown>;
    const arr = (key: string): string[] => (Array.isArray(l[key])
      ? (l[key] as unknown[]).filter((x): x is string => typeof x === 'string')
      : []);
    lineup = { radiant: arr('radiant'), dire: arr('dire') };
  }

  return {
    matchId,
    when: typeof o.when === 'string' ? o.when : '',
    gameMode: typeof o.gameMode === 'string' ? o.gameMode : '',
    durationMin: n(o, 'durationMin') ?? 0,
    parsed: o.parsed === true,
    ...(n(o, 'schema') !== undefined ? { schema: n(o, 'schema') as number } : {}),
    boundPlayers,
    ...(lineup !== undefined ? { lineup } : {}),
    fetchedAt: n(o, 'fetchedAt') ?? 0,
  };
}

/** 只做形状兜底：坏一条丢一条，不让整份文件作废 */
function sanitize(v: unknown): CachedMatch | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isFinitePositive(o.matchId) || !isFinitePositive(o.startTime)) return null;
  const rawPlayers = Array.isArray(o.players) ? o.players : [];
  const players: CachedMatchPlayer[] = [];
  for (const p of rawPlayers) {
    if (p === null || typeof p !== 'object') continue;
    const q = p as Record<string, unknown>;
    if (!isFinitePositive(q.accountId)) continue;
    players.push({
      accountId: q.accountId,
      ...(typeof q.alias === 'string' && q.alias !== '' ? { alias: q.alias } : {}),
      heroId: typeof q.heroId === 'number' ? q.heroId : 0,
      heroName: typeof q.heroName === 'string' ? q.heroName : '',
      kills: typeof q.kills === 'number' ? q.kills : 0,
      deaths: typeof q.deaths === 'number' ? q.deaths : 0,
      assists: typeof q.assists === 'number' ? q.assists : 0,
      win: q.win === true,
    });
  }
  const id = Math.floor(o.matchId);
  const briefing = o.briefing === undefined ? undefined : sanitizeBriefing(o.briefing, id);
  return {
    matchId: id,
    startTime: Math.floor(o.startTime),
    ...(typeof o.durationSec === 'number' ? { durationSec: o.durationSec } : {}),
    ...(typeof o.gameMode === 'number' ? { gameMode: o.gameMode } : {}),
    players,
    at: typeof o.at === 'number' ? o.at : 0,
    ...(briefing !== undefined ? { briefing } : {}),
  };
}

export class MatchCacheStore {
  private readonly file: string;
  private readonly logger: { warn(msg: string): void };
  private readonly max: number;
  private cache: CacheFile | null = null;

  constructor(dir?: string, logger?: { warn(msg: string): void }, max = DEFAULT_MAX_MATCHES) {
    const root = dir !== undefined && dir !== '' ? dir : path.join(os.homedir(), '.dsh-qqbot', 'dota');
    this.file = path.join(root, 'matches.json');
    this.logger = logger ?? { warn: () => {} };
    this.max = Math.max(50, Math.floor(max));
  }

  private load(): CacheFile {
    if (this.cache !== null) return this.cache;
    try {
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as Partial<CacheFile>;
      const out: CacheFile = { version: FILE_VERSION, matches: {} };
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.matches === 'object' && parsed.matches !== null) {
        for (const [k, v] of Object.entries(parsed.matches)) {
          const m = sanitize(v);
          if (m !== null) out.matches[k] = m;
        }
      }
      this.cache = out;
      return out;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn(`dota: 战绩库读取失败（当作空库）: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.cache = { version: FILE_VERSION, matches: {} };
      return this.cache;
    }
  }

  /** 原子写：先写 .tmp 再 rename，避免进程被杀时留下半份 JSON */
  private save(): void {
    const data = this.load();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.logger.warn(`dota: 战绩库落盘失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 淘汰最旧的，保持文件不无限长 */
  private prune(): void {
    const data = this.load();
    const keys = Object.keys(data.matches);
    if (keys.length <= this.max) return;
    const sorted = keys
      .map((k) => data.matches[k] as CachedMatch)
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, this.max);
    data.matches = {};
    for (const m of sorted) data.matches[String(m.matchId)] = m;
  }

  /**
   * 合并写入。同一 matchId 的 players 按 accountId 覆盖 —— 后写的更完整，
   * 但 alias 为空时保留旧值（不同入口拿到的名字完整度不一样）。
   */
  upsertMany(items: readonly CachedMatchInput[]): void {
    if (items.length === 0) return;
    const data = this.load();
    const now = Date.now();
    let changed = false;

    for (const it of items) {
      if (!isFinitePositive(it.matchId) || !isFinitePositive(it.startTime)) continue;
      if (!isFinitePositive(it.player.accountId)) continue;
      const key = String(it.matchId);
      const prev = data.matches[key];
      const player: CachedMatchPlayer = {
        accountId: it.player.accountId,
        ...(it.player.alias !== undefined && it.player.alias !== ''
          ? { alias: it.player.alias }
          : prev?.players.find((p) => p.accountId === it.player.accountId)?.alias !== undefined
            ? { alias: prev.players.find((p) => p.accountId === it.player.accountId)?.alias as string }
            : {}),
        heroId: it.player.heroId,
        heroName: it.player.heroName,
        kills: it.player.kills,
        deaths: it.player.deaths,
        assists: it.player.assists,
        win: it.player.win,
      };

      if (prev === undefined) {
        data.matches[key] = {
          matchId: Math.floor(it.matchId),
          startTime: Math.floor(it.startTime),
          ...(it.durationSec !== undefined ? { durationSec: it.durationSec } : {}),
          ...(it.gameMode !== undefined ? { gameMode: it.gameMode } : {}),
          players: [player],
          at: now,
        };
        changed = true;
        continue;
      }

      const idx = prev.players.findIndex((p) => p.accountId === player.accountId);
      if (idx >= 0) prev.players[idx] = player;
      else prev.players.push(player);
      // 同一场的时间以先写入的为准：后面那位可能查到了新一轮数据，
      // 但 start_time 是比赛的固有属性，不该被覆盖成别的值。
      prev.at = now;
      changed = true;
    }

    if (changed) {
      this.prune();
      this.save();
    }
  }

  /**
   * 写入该场的完整简报。按 matchId 只存一份：同一场里有 3 个群友也只写一次，
   * 不会把「谁和谁一起打」重复记三遍。
   *
   * 场次必须由 upsertMany 先建好（原始战绩里有 start_time）—— 没有原始记录
   * 就写简报会在重读时被 sanitize 丢掉，所以这里直接拒绝并告警。
   */
  putBriefing(session: CachedBriefSession): void {
    if (!isFinitePositive(session.matchId)) return;
    const data = this.load();
    const key = String(Math.floor(session.matchId));
    const prev = data.matches[key];
    if (prev === undefined) {
      this.logger.warn(`dota: 场次 ${key} 还没有原始战绩记录，跳过简报写入`);
      return;
    }
    prev.briefing = { ...session, matchId: prev.matchId, fetchedAt: Date.now() };
    this.save();
  }

  /** 已落盘的完整简报；parsed=true 的可以直接复用，不必再打 OpenDota */
  getBriefing(matchId: number): CachedBriefSession | undefined {
    return this.get(matchId)?.briefing;
  }

  get(matchId: number): CachedMatch | undefined {
    return this.load().matches[String(Math.floor(matchId))];
  }

  /** 这一场已知的参与者（只含绑定群友，按 accountId 去重） */
  participantsOf(matchId: number): CachedMatchPlayer[] {
    return this.get(matchId)?.players ?? [];
  }

  /** 最近 N 秒内的场次（按开赛时间倒序） */
  recent(sinceSec?: number): CachedMatch[] {
    const all = Object.values(this.load().matches);
    const filtered = sinceSec === undefined ? all : all.filter((m) => m.startTime >= sinceSec);
    return filtered.sort((a, b) => b.startTime - a.startTime);
  }

  /** 测试/维护用：清空内存缓存，强制下次从磁盘读 */
  resetForTest(): void {
    this.cache = null;
  }
}
