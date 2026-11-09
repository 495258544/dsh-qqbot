/**
 * 技能记录 —— 每次解析 OMG 局就把技能组合存一份
 * ─────────────────────────────────────────────────────────────
 * 为什么要存：
 *   OpenDota 的 match 详情是一次性快照，每次查都得重新拉。
 *   而这个群几乎只打技能征召，「某人上一把拿了什么技能」「这套组合赢没赢」
 *   这类问题隔几天再问就很常见 —— 存下来才查得动，也才可能看出"他老爱拿什么"。
 *
 * 存哪：
 *   `~/.dsh-qqbot/dota/ability-records.json`（和 `steam/` 同级，整个目录拷走即可迁移）
 *
 * 为什么不放进 persona 的数据目录：
 *   这是 Dota 模块自己的东西，和人格记忆无关；混在一起以后清理会互相牵连。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeAbilityMix, isNoiseAbility, type ParsedAbility } from './abilities.ts';
import { formatAbilityName } from './ability-zh.ts';
import { heroIdByName, heroName } from './heroes.ts';

export interface AbilityRecordEntry {
  /** 展示名（英文 dname，如 Shadowraze） */
  name: string;
  /** 官方简体中文名（对照表没收录时缺省，沿用英文原名） */
  nameZh?: string;
  /** 本局使用次数 */
  uses: number;
  behavior?: string;
  damageType?: string;
}

export interface AbilityRecordPlayer {
  accountId: number;
  heroName: string;
  win: boolean;
  abilities: AbilityRecordEntry[];
  /** 一句话概括这套技能的路子 */
  mix?: string;
  /**
   * 这一条记录的次数口径。同一场里可能 A 是完整解析（uses）、B 是半解析兜底（levels），
   * 所以口径必须落在玩家身上；旧记录没有这个字段时才回退到整场的 AbilityRecord.basis。
   */
  basis?: 'uses' | 'levels';
}

export interface AbilityRecord {
  matchId: number;
  /** 记录时间（ms） */
  at: number;
  /** Dota 的 game_mode（18 = 技能征召） */
  gameMode: number;
  players: AbilityRecordPlayer[];
  /**
   * 技能次数的口径：
   *   'uses'   = 实际使用次数（OpenDota 完整解析的局）
   *   'levels' = 加点次数（OpenDota 半解析、ability_uses 缺失时的兜底）
   * 口径不同不能混着比大小 —— 「用了 126 次」和「点了 4 级」是两回事。
   */
  basis?: 'uses' | 'levels';
}

interface RecordFile {
  version: number;
  matches: Record<string, AbilityRecord>;
}

/** 最多留多少场（约等于几个月的量，再多也没人翻） */
const MAX_MATCHES = 500;

export class AbilityRecordStore {
  private readonly file: string;
  private readonly logger: { warn(msg: string): void };
  private cache: RecordFile | null = null;

  constructor(dir?: string, logger?: { warn(msg: string): void }) {
    const root = dir !== undefined && dir !== '' ? dir : path.join(os.homedir(), '.dsh-qqbot', 'dota');
    this.file = path.join(root, 'ability-records.json');
    this.logger = logger ?? { warn() {} };
  }

  /** 数据文件绝对路径（诊断用） */
  get filePath(): string {
    return this.file;
  }

  private read(): RecordFile {
    if (this.cache !== null) return this.cache;
    try {
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as Partial<RecordFile>;
      const matches = parsed.matches !== null && typeof parsed.matches === 'object' ? parsed.matches : {};
      this.cache = { version: 1, matches: matches as Record<string, AbilityRecord> };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // 坏文件不该让战绩查询挂掉，按空处理即可
        this.logger.warn(`dota: 技能记录读取失败，按空处理（${err instanceof Error ? err.message : String(err)}）`);
      }
      this.cache = { version: 1, matches: {} };
    }
    return this.cache;
  }

  private write(data: RecordFile): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // 落盘失败只记一条 warn —— 记录是附加价值，不能反过来影响查询
      this.logger.warn(`dota: 技能记录落盘失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 写入/覆盖一场（同一场重复解析就覆盖**同一个账号**，幂等）。
   *
   * 2026-11-09 修：以前是整场覆盖，于是一场比赛查了三个人，存档里只剩最后一个。
   * 现在按 accountId 合并 —— 同一个人重新解析（比如半解析 → 完整解析）覆盖自己的，
   * 其他人保留。这样"那局小周拿了啥"才不会因为后来查过别人就查不到。
   */
  put(rec: AbilityRecord): void {
    const data = this.read();
    const key = String(rec.matchId);
    const prev = data.matches[key];
    const byAccount = new Map<number, AbilityRecordPlayer>();
    for (const p of prev?.players ?? []) byAccount.set(p.accountId, p);
    for (const p of rec.players) byAccount.set(p.accountId, p);
    data.matches[key] = { ...rec, players: [...byAccount.values()] };
    // 超过上限时按时间淘汰最旧的
    const keys = Object.keys(data.matches);
    if (keys.length > MAX_MATCHES) {
      const sorted = keys.sort((a, b) => (data.matches[a]?.at ?? 0) - (data.matches[b]?.at ?? 0));
      for (const k of sorted.slice(0, keys.length - MAX_MATCHES)) delete data.matches[k];
    }
    this.write(data);
  }

  /** 取某一场的记录 */
  get(matchId: number): AbilityRecord | undefined {
    return this.read().matches[String(matchId)];
  }

  /** 最近的若干场（新的在前） */
  recent(limit = 10): AbilityRecord[] {
    const all = Object.values(this.read().matches);
    all.sort((a, b) => b.at - a.at);
    return all.slice(0, Math.max(1, Math.floor(limit)));
  }

  /** 已记录多少场 */
  size(): number {
    return Object.keys(this.read().matches).length;
  }

  /**
   * 按条件翻记录（纯本地、不联网）。筛选逻辑放在下面的纯函数里，方便单测。
   * 没给任何条件 = 列最近几场；给了 matchId = 只翻那一场。
   */
  query(q: AbilityRecordQuery = {}): AbilityRecordHit[] {
    return selectAbilityRecords(this.read().matches, q);
  }
}

// ── 查询条件与结果 ────────────────────────────────────────────

export interface AbilityRecordQuery {
  /** 精确查某一场（qq_dota_recent 返回的 matchId） */
  matchId?: number;
  /** 只看某个账号（32 位 account_id） */
  accountId?: number;
  /** 只看某个英雄，传英雄 ID（工具层用 heroIdByName 支持中文/英文/黑话） */
  heroId?: number;
  /** 最多几场，默认 5，上限 20 */
  limit?: number;
}

export interface AbilityRecordHit {
  matchId: number;
  /** 记录时间 ms（不是比赛开始时间 —— 文案里要说清，别让人误以为开打时间） */
  at: number;
  gameMode: number;
  /** 整场口径；玩家级 basis 优先，这个只给旧记录兜底 */
  basis?: 'uses' | 'levels';
  /** 过滤后的玩家（一定非空） */
  players: AbilityRecordPlayer[];
}

const DEFAULT_QUERY_LIMIT = 5;
const MAX_QUERY_LIMIT = 20;

/** 纯函数：从记录表里挑出符合条件的场，新的在前。不碰文件、不联网。 */
export function selectAbilityRecords(
  matches: Readonly<Record<string, AbilityRecord>>,
  q: AbilityRecordQuery = {},
): AbilityRecordHit[] {
  const wanted = Number(q.limit ?? DEFAULT_QUERY_LIMIT);
  const limit = Number.isFinite(wanted)
    ? Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(wanted)))
    : DEFAULT_QUERY_LIMIT;

  const all = Object.values(matches)
    .filter((r) => q.matchId === undefined || r.matchId === q.matchId)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const hits: AbilityRecordHit[] = [];
  for (const r of all) {
    const players = (r.players ?? [])
      .filter(
        (p) =>
          (q.accountId === undefined || p.accountId === q.accountId)
          && (q.heroId === undefined || heroMatches(p.heroName, q.heroId)),
      )
      .map(cleanPlayer)
      // 清洗后一条技能都不剩的记录（全是噪声条目）对翻旧账没价值，
      // 返回它反而会诱她凭英雄默认技能脑补。
      .filter((p) => p.abilities.length > 0);
    if (players.length === 0) continue;
    hits.push({
      matchId: r.matchId,
      at: r.at,
      gameMode: r.gameMode,
      ...(r.basis !== undefined ? { basis: r.basis } : {}),
      players,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * 查询时清洗一条玩家记录（**不改落盘数据**，下次解析同场会自然覆盖）：
 *  1. 旧记录里可能存着后来才判定为噪声的引擎技能。实测 9079610365 就存了
 *     `ability_capture`（bce819b 过滤修复之前写入的），翻旧账时不能又把它
 *     当"技能窃取"说出去 —— 那正是 11/08 群里翻车的原因。
 *  2. 旧 `mix` 里的技能名是纯英文（还没有中文对照表时生成的），直接展示会
 *     诱导她自己译。用带中文名的 abilities 重算一次，措辞也跟着数据更新。
 */
function cleanPlayer(p: AbilityRecordPlayer): AbilityRecordPlayer {
  const abilities = (p.abilities ?? []).filter((a) => !isNoiseAbility(a.name));
  const parsed: ParsedAbility[] = abilities.map((a) => ({
    key: a.name,
    name: a.name,
    ...(a.nameZh !== undefined ? { nameZh: a.nameZh } : {}),
    uses: a.uses,
    ...(a.behavior !== undefined ? { behavior: a.behavior } : {}),
    ...(a.damageType !== undefined ? { damageType: a.damageType } : {}),
  }));
  const mix = describeAbilityMix(parsed);
  const rest: AbilityRecordPlayer = { ...p, abilities };
  delete rest.mix;
  return mix !== '' ? { ...rest, mix } : rest;
}

/** 记录里存的是官方中文名；先归一成 ID 比对，认不出才退回精确字符串比对（不猜）。 */
function heroMatches(stored: string, heroId: number): boolean {
  const id = heroIdByName(stored);
  if (id !== undefined) return id === heroId;
  return stored.trim().toLowerCase() === heroName(heroId).trim().toLowerCase();
}

// ── 给模型看的摘要 ────────────────────────────────────────────

const MODE_LABEL: Readonly<Record<number, string>> = Object.freeze({ 18: '技能征召' });

/** 记录时间（北京时间），不是开打时间 */
function formatAt(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '时间未知';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

const COMMON_NOTE =
  '技能名按上面给的写法照抄：括号前是官方简体中文名，括号里是英文原名；'
  + '没给中文名的直接用英文原名，不要自行翻译、改名或换成别的说法。'
  + '「按加点」的数字是点了多少级，不是使用次数，不许说成「用了 N 次」。'
  + '记录里只有账号 ID，没有昵称：不确定这个 ID 对应群里谁就照实说账号 ID，不要猜人名。';

const READ_ONLY_NOTE =
  '本工具只翻本地存档，不联网也不会触发 OpenDota 解析；查不到就如实说没有记录，'
  + '不要凭英雄的招牌技能脑补（技能征召里英雄不一定有它的默认技能）。';

/**
 * 把命中结果拼成可直接进上下文的文本。工具层的 render 只吐 summary，
 * 所以技能明细必须写进 summary 里，不能只放结构化字段。
 */
export function formatAbilityRecordHits(
  hits: AbilityRecordHit[],
): { summary: string; note: string } {
  if (hits.length === 0) {
    return {
      summary: '本地还没有符合条件的技能记录。'
        + '\n想查某场：先用 qq_dota_recent 拿到 matchId，再用 qq_dota_match 解析那一场 —— '
        + '解析时会自动存一份技能记录，之后就能用本工具翻旧账。',
      note: `${READ_ONLY_NOTE} ${COMMON_NOTE}`,
    };
  }

  const lines: string[] = [`本地技能记录：${hits.length} 场（按记录时间，新的在前）`];
  for (const hit of hits) {
    const mode = MODE_LABEL[hit.gameMode] ?? `模式 ${hit.gameMode}`;
    lines.push(`──── #${hit.matchId} · 记录于 ${formatAt(hit.at)} · ${mode}`);
    for (const p of hit.players) {
      const basis = p.basis ?? hit.basis ?? 'uses';
      const label = basis === 'levels' ? '按加点' : '按使用';
      const abilities =
        p.abilities.length > 0
          ? p.abilities.map((a) => `${formatAbilityName(a.name, a.nameZh)}×${a.uses}`).join(' / ')
          : '无';
      lines.push(`  账号 ${p.accountId} · ${p.heroName} · ${p.win ? '胜' : '负'} · 技能（${label}）｜${abilities}`);
      if (p.mix !== undefined && p.mix !== '') lines.push(`    路子｜${p.mix}`);
    }
  }
  return { summary: lines.join('\n'), note: `${COMMON_NOTE} ${READ_ONLY_NOTE}` };
}
