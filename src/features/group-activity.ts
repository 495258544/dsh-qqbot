/**
 * group-activity · 群活跃度 / Dota 相关度打分
 * ─────────────────────────────────────────────────────────────
 * 解决的问题："一条 Dota 战绩播报，该发到哪个群？"
 *
 * 候选群不是凭感觉挑的，而是按「和这群人的 Dota 相关度」打分：
 *   最近聊过 Dota 关键词的群  >  群里有战绩当事人的群  >  最近活跃的群
 *
 * 隐私约束（重要）：聊天内容不留全量日志。
 * 这里只记轻量聚合指标 —— 时间戳、关键词命中次数、最近发言者 openid 集合，
 * 落一个小 JSON（<dataDir>/group-activity.json），文件大小与聊天量无关。
 *
 * 落盘策略（参考 src/steam/settings.ts）：
 *   - 构造时读回；文件不存在 / 损坏都静默降级为空，不影响机器人启动
 *   - record 不每次同步写盘，用 dirty 标记 + 顶多每 30 秒落一次
 *     （先到点直接写，没到点挂一个 unref 定时器补写，进程退出也不会被拖住）
 *   - 原子写：写 .tmp 再 rename，避免进程被杀时留下半个 JSON
 *   - 显式 persist() 留给进程退出 / 测试使用
 *
 * 容量上限 200 个群，超出按 lastAt 淘汰最久没动静的，避免文件无限增长。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 一小时的毫秒数（评分里的所有时间档都按小时算） */
const HOUR = 3600 * 1000;

/** 最多保留多少个群的记录 */
const MAX_GROUPS = 200;

/** 每个群最多保留多少个最近发言者 */
const MAX_SENDERS = 20;

/** 两次自动落盘之间的最小间隔：30 秒内只写一次盘 */
const PERSIST_INTERVAL_MS = 30 * 1000;

/** Dota 相关度的时间窗口：超过 72 小时就不算「最近聊过」 */
const DOTA_WINDOW_HOURS = 72;

/** 活跃度的时间档位（小时） */
const ACTIVE_RECENT_HOURS = 24;
const ACTIVE_WINDOW_HOURS = 72;

/** 落盘文件的固定文件名与版本号 */
const FILE_NAME = 'group-activity.json';
const FILE_VERSION = 1;

export interface GroupActivityEntry {
  groupId: string;
  /** 最近任意消息时间（ms） */
  lastAt: number;
  /** 最近命中 Dota 关键词时间（ms），0 = 从没命中 */
  lastDotaAt: number;
  /** Dota 关键词累计命中次数（用于衰减评分，可被 record 递增） */
  dotaHits: number;
  /** 最近活跃的发言者 openid（去重，最多保留最近 20 个，新的在前） */
  senders: string[];
}

/**
 * Dota 关键词表（匹配时统一转小写，大小写不敏感）。
 * 注意：这里刻意收得比较宽（"坑"/"送"/"划水" 这类黑话也算），
 * 因为目标是"这群人像不像在聊 Dota"，误判一点点的代价远小于漏判。
 */
export const DOTA_KEYWORDS: string[] = [
  'dota',
  'dota2',
  '刀塔',
  '刀圈',
  // 群里的习惯说法（用户点名要的）：「打刀」= 打 Dota
  '打刀',
  '开黑',
  '上号',
  '上分',
  '天梯',
  '硬辅',
  '大哥',
  '中单',
  '打野',
  '战绩',
  '坑',
  '送',
  '划水',
  '五黑',
  'rank',
  'mmr',
  'vp',
  'ti',
];

/**
 * 短词的边界正则（中文不是 \w，所以「打ti」这种紧贴中文的写法仍然能命中）。
 * 只有「纯 ASCII 且长度 <= 2」的关键词才需要它：`ti` 直接 includes
 * 会把 "time" / "title" 全算进来。
 */
function shortKeywordPattern(keyword: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${keyword}(?![a-z0-9])`);
}

/**
 * 判断一段文本是否像在聊 Dota（大小写不敏感）。
 *
 * 关键词表**默认**用内置的 DOTA_KEYWORDS，但允许调用方传入自定义表 ——
 * 不同群的叫法不一样（「打刀」「开黑」「上号」），写死会漏判，
 * 所以这里做成参数，由配置（persona.dotaKeywords）驱动。
 */
export function isDotaText(text: string, keywords: string[] = DOTA_KEYWORDS): boolean {
  if (typeof text !== 'string' || text === '') return false;
  const lower = text.toLowerCase();
  for (const raw of keywords) {
    const keyword = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (keyword === '') continue;
    // 纯 ASCII 短词走词边界，避免 time/title 误中；其余（含中文）直接包含判断
    const hit = /^[a-z0-9]+$/.test(keyword) && keyword.length <= 2
      ? shortKeywordPattern(keyword).test(lower)
      : lower.includes(keyword);
    if (hit) return true;
  }
  return false;
}

export interface GroupActivityOptions {
  /** 落盘目录；传空串 = 纯内存不落盘 */
  dataDir: string;
  log?: (msg: string) => void;
  /** 可注入的时钟（测试用），默认 () => Date.now() */
  now?: () => number;
  /** 自定义 Dota 关键词表；不传用内置 DOTA_KEYWORDS（配置层覆盖即可换词） */
  keywords?: string[];
}

/** 落盘 JSON 结构：{ "version": 1, "groups": GroupActivityEntry[] } */
interface GroupActivityFile {
  version: 1;
  groups: GroupActivityEntry[];
}

/** 把盘上读到的任意值收敛成合法 entry；不合法返回 null（整条丢掉） */
function normalizeEntry(input: unknown): GroupActivityEntry | null {
  if (input === null || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const groupId = typeof raw.groupId === 'string' ? raw.groupId.trim() : '';
  if (groupId === '') return null;

  const lastAt = Number(raw.lastAt);
  const lastDotaAt = Number(raw.lastDotaAt);
  const hits = Number(raw.dotaHits);

  // 发言者：只留非空字符串，去重后按盘上顺序（新在前）截断
  const senders: string[] = [];
  if (Array.isArray(raw.senders)) {
    for (const item of raw.senders) {
      if (typeof item !== 'string') continue;
      const id = item.trim();
      if (id === '' || senders.includes(id)) continue;
      senders.push(id);
      if (senders.length >= MAX_SENDERS) break;
    }
  }

  return {
    groupId,
    lastAt: Number.isFinite(lastAt) && lastAt > 0 ? lastAt : 0,
    lastDotaAt: Number.isFinite(lastDotaAt) && lastDotaAt > 0 ? lastDotaAt : 0,
    dotaHits: Number.isFinite(hits) && hits > 0 ? Math.floor(hits) : 0,
    senders,
  };
}

export class GroupActivityStore {
  private readonly dir: string;
  /** 盘上文件路径；dataDir 为空串时是空串 = 纯内存模式 */
  private readonly file: string;
  private readonly log: (msg: string) => void;
  private readonly clock: () => number;
  /** 生效的 Dota 关键词表（配置可覆盖，默认内置） */
  private readonly keywords: string[];
  /** groupId -> 记录（内存里就是权威值，盘只是快照） */
  private readonly groups = new Map<string, GroupActivityEntry>();
  /** 有未落盘的改动 */
  private dirty = false;
  /** 上次成功落盘的时间（ms），用于 30 秒节流 */
  private lastPersistAt = 0;
  /** 节流用的补写定时器（unref，不阻止进程退出） */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: GroupActivityOptions) {
    this.dir = opts.dataDir;
    this.file = opts.dataDir === '' ? '' : path.join(opts.dataDir, FILE_NAME);
    this.log = opts.log ?? ((msg: string) => console.log('[group-activity]', msg));
    this.clock = opts.now ?? (() => Date.now());
    // 关键词表：调用方传了非空表就用它（配置覆盖），否则回退内置默认表。
    // 注意「留空」的语义是"没配置"，不是"关掉识别" —— 所以空数组要回退，
    // 否则用户什么都不填反而永远不算命中。
    const custom = Array.isArray(opts.keywords)
      ? opts.keywords.filter((kw) => typeof kw === 'string' && kw.trim() !== '')
      : [];
    this.keywords = custom.length > 0 ? custom : [...DOTA_KEYWORDS];
    if (this.file !== '') this.load();
  }

  /** 构造时读回：文件不存在 / 内容损坏一律静默降级为空 */
  private load(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      // 第一次跑没文件是正常情况，不吵；其它 IO 错误提一句
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.log(`读取 ${FILE_NAME} 失败，按空记录处理: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    try {
      const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
      const groups =
        parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as GroupActivityFile).groups)
          ? (parsed as GroupActivityFile).groups
          : [];
      this.groups.clear();
      let dropped = 0;
      for (const item of groups) {
        const entry = normalizeEntry(item);
        if (!entry) {
          dropped += 1;
          continue;
        }
        this.groups.set(entry.groupId, entry);
      }
      if (dropped > 0) this.log(`${FILE_NAME} 里有 ${dropped} 条记录格式不对，已忽略`);
      this.enforceCapacity();
    } catch (err) {
      // 文件被写坏（半截 JSON / 手改出错）：不能让机器人起不来
      this.groups.clear();
      this.log(`解析 ${FILE_NAME} 失败，按空记录处理: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 收到一条群消息时调用 */
  record(groupId: string, senderId: string, text: string): void {
    const gid = typeof groupId === 'string' ? groupId.trim() : '';
    const sid = typeof senderId === 'string' ? senderId.trim() : '';
    // 空群号 / 空发言者没有意义，直接忽略，避免造出垃圾记录
    if (gid === '' || sid === '') return;

    const at = this.clock();
    let entry = this.groups.get(gid);
    if (!entry) {
      entry = { groupId: gid, lastAt: at, lastDotaAt: 0, dotaHits: 0, senders: [] };
      this.groups.set(gid, entry);
    }
    entry.lastAt = at;

    const body = typeof text === 'string' ? text : '';
    if (body === '') {
      // 空文本（图片 / 表情 / 系统消息）：只更新活跃时间，不看关键词，也不记发言者
      this.enforceCapacity();
      this.markDirty(at);
      return;
    }

    // 发言者去重且新的在前，超出 20 个丢最旧的
    entry.senders = [sid, ...entry.senders.filter((s) => s !== sid)].slice(0, MAX_SENDERS);

    if (isDotaText(body, this.keywords)) {
      entry.lastDotaAt = at;
      entry.dotaHits += 1;
    }

    this.enforceCapacity();
    this.markDirty(at);
  }

  /**
   * 给某个群打分（越高越优先）。总分 = Dota 相关度 + 成员相关度 + 活跃度。
   */
  score(groupId: string, boundOpenids: string[], now?: number): number {
    const gid = typeof groupId === 'string' ? groupId.trim() : '';
    const entry = this.groups.get(gid);
    // 群里没有任何记录：不参与竞争
    if (!entry) return 0;
    const at = typeof now === 'number' && Number.isFinite(now) ? now : this.clock();

    // ── 第一档：Dota 相关度（0~100）──────────────────────────────
    // 72 小时内聊过：100 - 距今小时数（越新鲜越高），超出 72h 直接 0。
    // 再按累计命中次数加成：每 5 次 +2，最多 +10（常聊 Dota 的群底子更好）。
    let dota = 0;
    if (entry.lastDotaAt > 0) {
      const hours = (at - entry.lastDotaAt) / HOUR;
      if (hours <= DOTA_WINDOW_HOURS) {
        const base = Math.max(0, 100 - hours);
        const bonus = Math.min(10, Math.floor(entry.dotaHits / 5) * 2);
        dota = Math.min(100, base + bonus);
      }
    }

    // ── 第二档：成员相关度（0~60）──────────────────────────────
    // boundOpenids 是"成绩当事人"（自己绑定的账号）。谁的 openid 在这个群
    // 最近说过话，就说明当事人在这个群里 —— 每人 +30，封顶 60。
    const senders = new Set(entry.senders);
    const matched = new Set<string>();
    for (const id of boundOpenids ?? []) {
      if (typeof id !== 'string') continue;
      const openid = id.trim();
      if (openid === '') continue;
      if (senders.has(openid)) matched.add(openid);
    }
    const member = Math.min(60, matched.size * 30);

    // ── 第三档：活跃度（0~20）──────────────────────────────────
    // 24 小时内有人说话给满档，72 小时内给一半，更久算死群。
    const idleHours = (at - entry.lastAt) / HOUR;
    const activity = idleHours <= ACTIVE_RECENT_HOURS ? 20 : idleHours <= ACTIVE_WINDOW_HOURS ? 10 : 0;

    return dota + member + activity;
  }

  /** 所有已记录的群（按 lastAt 倒序） */
  entries(): GroupActivityEntry[] {
    return this.snapshot();
  }

  /** 立即落盘（构造时会尝试读回；record 后不必每次同步落盘） */
  persist(): void {
    if (this.file === '') {
      // 纯内存模式：没有盘可写，清掉 dirty 免得定时器空转
      this.dirty = false;
      return;
    }
    const payload: GroupActivityFile = { version: FILE_VERSION, groups: this.snapshot() };
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      // 原子替换：要么是旧文件，要么是完整的新文件，不存在半个 JSON
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      this.lastPersistAt = this.clock();
    } catch (err) {
      this.log(`落盘 ${FILE_NAME} 失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 按 lastAt 倒序导出一份深拷贝，外部改不到内部状态 */
  private snapshot(): GroupActivityEntry[] {
    return [...this.groups.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((entry) => ({ ...entry, senders: [...entry.senders] }));
  }

  /** 超过 200 个群就按 lastAt 淘汰最久没动静的 */
  private enforceCapacity(): void {
    if (this.groups.size <= MAX_GROUPS) return;
    const ordered = [...this.groups.values()].sort((a, b) => a.lastAt - b.lastAt);
    const excess = this.groups.size - MAX_GROUPS;
    for (let i = 0; i < excess; i += 1) {
      const victim = ordered[i];
      if (!victim) break;
      this.groups.delete(victim.groupId);
    }
  }

  /**
   * 标记有改动并按 30 秒节流落盘：
   * 距上次落盘已满 30s → 立刻写；否则挂一个 unref 定时器到点补写。
   */
  private markDirty(now: number): void {
    this.dirty = true;
    if (this.file === '') return;
    if (now - this.lastPersistAt >= PERSIST_INTERVAL_MS) {
      this.persist();
      return;
    }
    if (this.flushTimer !== null) return;
    const wait = Math.max(0, PERSIST_INTERVAL_MS - (now - this.lastPersistAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) this.persist();
    }, wait);
    // 不阻止进程退出：没落盘的改动由上层在退出时显式 persist()
    this.flushTimer.unref?.();
  }
}

/**
 * 从候选里挑最合适的群：先按 score 降序，分数相同再按 lastAt 降序。
 * 只用 candidates 里给出的群（上层会传"当前存活会话的群"），避免挑到死群。
 * 返回 null 表示没有候选。
 */
export function pickBestGroup(
  store: GroupActivityStore,
  candidates: string[],
  boundOpenids: string[],
  now?: number,
): string | null {
  // 先取一次全量快照：score 只算分，同分比较需要 lastAt
  const lastAtOf = new Map<string, number>();
  for (const entry of store.entries()) lastAtOf.set(entry.groupId, entry.lastAt);

  let best: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestAt = Number.NEGATIVE_INFINITY;
  const seen = new Set<string>();

  for (const raw of candidates ?? []) {
    if (typeof raw !== 'string') continue;
    const gid = raw.trim();
    // 空候选、重复候选都跳过（上层可能把同一个群塞两遍）
    if (gid === '' || seen.has(gid)) continue;
    seen.add(gid);

    const value = store.score(gid, boundOpenids, now);
    const at = lastAtOf.get(gid) ?? 0;
    if (value > bestScore || (value === bestScore && at > bestAt)) {
      best = gid;
      bestScore = value;
      bestAt = at;
    }
  }

  return best;
}

// ── 进程级默认实例（入站埋点用）────────────────────────────────
// 入站消息处理是每消息一个函数调用，拿不到 bootstrap 的局部变量，
// 所以用一个进程级默认实例：bootstrap 启动时 configure，入站时 record。

let defaultStore: GroupActivityStore | null = null;

/** bootstrap 启动时调用：按配置构造进程级实例（dataDir / keywords 都从配置来） */
export function configureGroupActivity(opts: GroupActivityOptions): GroupActivityStore {
  defaultStore = new GroupActivityStore(opts);
  return defaultStore;
}

/** 取进程级实例（没配置过返回 null） */
export function getGroupActivityStore(): GroupActivityStore | null {
  return defaultStore;
}

/** 入站消息埋点：群消息进来时调一句即可，未配置时静默忽略 */
export function recordGroupActivity(groupId: string, senderId: string, text: string): void {
  defaultStore?.record(groupId, senderId, text);
}
