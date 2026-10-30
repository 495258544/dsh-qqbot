/**
 * 自我画像（self.json）— 「她自己的」喜好与兴趣
 * ─────────────────────────────────────────────────────────────
 * 与 memory.ts 的区别：
 *   memory.ts  → 按「人」存，记的是**别人**（用户的 traits/facts/topics）
 *   self.ts    → 只存一份，记的是**她自己**（喜欢什么、对什么有兴趣、被叫几个名字）
 *
 * 文件：~/.dsh-qqbot/persona/app-{appId}/self.json
 *
 * 设计要点：
 * - 称呼要「喜欢才接受」（accepted 标记），不是无脑全学
 * - 兴趣带权重，会随互动涨落、随时间衰减（借鉴 MaiBot 加权 + generative_agents 重要度）
 * - engagement.chattiness 记录「被嫌吵」后的收敛程度
 */
import fs from 'node:fs';
import path from 'node:path';

/** 一个称呼 */
export interface SelfName {
  /** 称呼本身 */
  name: string;
  /** 权重 0~1，越高越"喜欢" */
  weight: number;
  /** 是否接受（只有接受的才真正能唤醒她） */
  accepted: boolean;
  /** 被叫过几次 */
  calledCount: number;
  /** 来源：角色卡 / 学来的 */
  source: string;
  /** 首次被叫时间 */
  firstAskedAt?: number;
  /** 最近被叫时间 */
  lastAskedAt?: number;
}

/** 一项兴趣 */
export interface SelfInterest {
  /** 话题名 */
  topic: string;
  /** 权重 0~1 */
  weight: number;
  /** 累计提及次数 */
  count: number;
  /** 最近提及时间 */
  lastAt: number;
  /** 自主冲浪收集到的见闻（摘要） */
  findings?: Array<{ at: number; summary: string; source?: string }>;
}

/** 社交状态（被嫌吵后的收敛） */
export interface SelfEngagement {
  /** 话痨度 1.0 正常 → 0.1 几乎不说话 */
  chattiness: number;
  /** 上次被嫌吵的时间 */
  lastComplainedAt: number;
  /** 被嫌吵总次数 */
  complaints: number;
}

/** 看屏幕的配置 */
export interface SelfScreenWatch {
  enabled: boolean;
  /** 允许观察的 App 包名白名单 */
  allowedApps: string[];
  /** 观察间隔(ms) */
  intervalMs: number;
}

/** 她想要的功能/需求（会提给用户，被拒后 1 个月可再提） */
export interface WishRequest {
  /** 唯一 id */
  id: string;
  /** 她想要什么 */
  wish: string;
  /** 为什么想要（一句话） */
  why: string;
  /** 提出时间 */
  raisedAt?: number;
  /** 用户拒绝的时间（0=未拒） */
  rejectedAt?: number;
  /** 被拒后多久可再提（默认 30 天） */
  retryAfterMs: number;
  /** 状态 */
  status: 'pending' | 'raised' | 'rejected' | 'accepted';
}

/** 完整自我画像 */
export interface SelfProfile {
  names: SelfName[];
  interests: SelfInterest[];
  engagement: SelfEngagement;
  screenWatch: SelfScreenWatch;
  /** 自主冲浪：上次活动时间 */
  lastSurfAt?: number;
  /** 她想要的功能（提给用户的） */
  wishes: WishRequest[];
}

/** 兴趣权重下限，低于则移除 */
const MIN_INTEREST_WEIGHT = 0.1;
/** 兴趣上限 */
const MAX_INTEREST_WEIGHT = 1.0;
/** 无提及多少天后开始衰减 */
const DECAY_AFTER_MS = 7 * 24 * 3600_000;
/** 每天衰减系数 */
const DECAY_FACTOR = 0.95;
/** 称呼被叫多少次才进入"候选"（还需她表态接受） */
const NAME_ACCEPT_THRESHOLD = 3;

/** 默认画像 */
function emptyProfile(): SelfProfile {
  return {
    names: [],
    interests: [],
    engagement: { chattiness: 1.0, lastComplainedAt: 0, complaints: 0 },
    screenWatch: { enabled: false, allowedApps: [], intervalMs: 30 * 60 * 1000 },
    wishes: [],
  };
}

/**
 * 自我画像服务：读写 self.json，并提供兴趣/称呼/收敛的更新逻辑。
 */
export class SelfProfileService {
  private data: SelfProfile;
  private readonly file: string;

  constructor(dataDir: string, private readonly log?: (m: string) => void) {
    this.file = path.join(dataDir, 'self.json');
    this.data = this.load();
  }

  private load(): SelfProfile {
    try {
      if (!fs.existsSync(this.file)) return emptyProfile();
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SelfProfile>;
      const base = emptyProfile();
      return {
        names: Array.isArray(raw.names) ? raw.names : base.names,
        interests: Array.isArray(raw.interests) ? raw.interests : base.interests,
        engagement: { ...base.engagement, ...(raw.engagement ?? {}) },
        screenWatch: { ...base.screenWatch, ...(raw.screenWatch ?? {}) },
        lastSurfAt: raw.lastSurfAt,
        wishes: Array.isArray(raw.wishes) ? raw.wishes : base.wishes,
      };
    } catch (err) {
      this.log?.(`self: 读取失败，用空画像: ${err instanceof Error ? err.message : String(err)}`);
      return emptyProfile();
    }
  }

  /** 持久化（原子写，避免半截文件） */
  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log?.(`self: 写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 只读快照 */
  snapshot(): SelfProfile {
    return this.data;
  }

  // ───────────── 称呼 ─────────────

  /** 当前真正能唤醒她的称呼（accepted 且 weight>0） */
  activeNames(): string[] {
    return this.data.names.filter((n) => n.accepted && n.weight > 0).map((n) => n.name);
  }

  /**
   * 记录一次"被叫"。新称呼先进候选（accepted=false），
   * 被叫满 NAME_ACCEPT_THRESHOLD 次后标记 pending，等她通过 acceptName 表态。
   * 返回当前状态供调用方决定是否要提示她表态。
   */
  recordNameCall(name: string): { isNew: boolean; reachedThreshold: boolean; accepted: boolean } {
    const now = Date.now();
    let entry = this.data.names.find((n) => n.name === name);
    const isNew = !entry;
    if (!entry) {
      entry = { name, weight: 0, accepted: false, calledCount: 0, source: 'learned' };
      this.data.names.push(entry);
    }
    entry.calledCount += 1;
    entry.lastAskedAt = now;
    if (!entry.firstAskedAt) entry.firstAskedAt = now;
    const reachedThreshold =
      !entry.accepted && entry.calledCount >= NAME_ACCEPT_THRESHOLD && entry.weight === 0;
    if (isNew) this.log?.(`self: 新称呼「${name}」进入候选`);
    this.save();
    return { isNew, reachedThreshold, accepted: entry.accepted };
  }

  /** 她表态接受某个称呼 */
  acceptName(name: string, weight = 0.6): boolean {
    const entry = this.data.names.find((n) => n.name === name);
    if (!entry) return false;
    entry.accepted = true;
    entry.weight = Math.min(MAX_INTEREST_WEIGHT, weight);
    this.log?.(`self: 接受称呼「${name}」`);
    this.save();
    return true;
  }

  /** 她表态拒绝某个称呼 */
  rejectName(name: string): boolean {
    const entry = this.data.names.find((n) => n.name === name);
    if (!entry) return false;
    entry.accepted = false;
    entry.weight = 0;
    this.log?.(`self: 拒绝称呼「${name}」`);
    this.save();
    return true;
  }

  // ───────────── 兴趣 ─────────────

  /** 提到某兴趣：权重 +0.05，计数 +1 */
  touchInterest(topic: string): void {
    const now = Date.now();
    let e = this.data.interests.find((i) => i.topic === topic);
    if (!e) {
      e = { topic, weight: 0.3, count: 0, lastAt: now };
      this.data.interests.push(e);
    }
    e.count += 1;
    e.weight = Math.min(MAX_INTEREST_WEIGHT, e.weight + 0.05);
    e.lastAt = now;
    this.save();
  }

  /** 因兴趣接话、且被回应 → 更"喜欢" */
  reinforceInterest(topic: string): void {
    const e = this.data.interests.find((i) => i.topic === topic);
    if (!e) return;
    e.weight = Math.min(MAX_INTEREST_WEIGHT, e.weight + 0.1);
    this.save();
  }

  /** 因兴趣接话但没人理 → 兴趣降温 */
  dampenInterest(topic: string): void {
    const e = this.data.interests.find((i) => i.topic === topic);
    if (!e) return;
    e.weight = Math.max(0, e.weight - 0.05);
    this.save();
  }

  /** 按当前时间做衰减（7 天未提，按天 ×0.95），低于下限则移除 */
  decayInterests(now = Date.now()): number {
    let removed = 0;
    for (const e of [...this.data.interests]) {
      const idle = now - e.lastAt;
      if (idle <= DECAY_AFTER_MS) continue;
      const days = Math.floor((idle - DECAY_AFTER_MS) / (24 * 3600_000));
      e.weight *= Math.pow(DECAY_FACTOR, days);
      if (e.weight < MIN_INTEREST_WEIGHT) {
        this.data.interests = this.data.interests.filter((x) => x.topic !== e.topic);
        removed += 1;
      }
    }
    if (removed > 0) this.log?.(`self: 淡忘 ${removed} 个兴趣`);
    this.save();
    return removed;
  }

  /** 取权重最高的前 n 个兴趣 */
  topInterests(n = 3): SelfInterest[] {
    return [...this.data.interests].sort((a, b) => b.weight - a.weight).slice(0, n);
  }

  /** 记录一次冲浪成果 */
  addFinding(topic: string, summary: string, source?: string): void {
    const e = this.data.interests.find((i) => i.topic === topic);
    if (!e) return;
    e.findings = e.findings ?? [];
    e.findings.push({ at: Date.now(), summary, source });
    // 上限 8 条，防膨胀
    while (e.findings.length > 8) e.findings.shift();
    this.data.lastSurfAt = Date.now();
    this.save();
  }

  // ───────────── 收敛（被嫌吵） ─────────────

  /** 被嫌吵 → 话痨度按倍率下降 */
  registerComplaint(): number {
    const g = this.data.engagement;
    g.chattiness = Math.max(0.1, g.chattiness * 0.3);
    g.lastComplainedAt = Date.now();
    g.complaints += 1;
    this.log?.(`self: 被嫌吵，chattiness → ${g.chattiness.toFixed(2)}`);
    this.save();
    return g.chattiness;
  }

  /** 用户主动找她说话 → 恢复一点话痨度 */
  warmUp(amount = 0.2): void {
    const g = this.data.engagement;
    g.chattiness = Math.min(1.0, g.chattiness + amount);
    this.save();
  }

  /** 24h 未再被嫌 → 缓慢恢复 */
  recoverIfCalm(now = Date.now()): void {
    const g = this.data.engagement;
    if (g.lastComplainedAt === 0 || g.chattiness >= 1.0) return;
    if (now - g.lastComplainedAt >= 24 * 3600_000) {
      g.chattiness = Math.min(1.0, g.chattiness + 0.1);
      g.lastComplainedAt = now; // 平滑推进，避免一次跳很多
      this.save();
    }
  }

  /** 当前话痨度 */
  chattiness(): number {
    return this.data.engagement.chattiness;
  }

  // ───────────── 需求（她想让用户实现的功能） ─────────────

  /** 提出一条需求（每周最多 2 条由调用方限制） */
  raiseWish(wish: string, why: string): WishRequest {
    const now = Date.now();
    const existing = this.data.wishes.find((w) => w.wish === wish);
    if (existing) {
      existing.raisedAt = now;
      existing.status = 'raised';
      this.save();
      return existing;
    }
    const req: WishRequest = {
      id: `w${now}`,
      wish,
      why,
      raisedAt: now,
      rejectedAt: 0,
      retryAfterMs: 30 * 24 * 3600_000, // 用户确认：被拒后 1 个月可再提
      status: 'raised',
    };
    this.data.wishes.push(req);
    this.save();
    return req;
  }

  /** 用户拒绝某需求 → 记录时间，1 个月后可再提 */
  rejectWish(id: string): boolean {
    const w = this.data.wishes.find((x) => x.id === id);
    if (!w) return false;
    w.rejectedAt = Date.now();
    w.status = 'rejected';
    this.log?.(`self: 需求「${w.wish}」被拒，${Math.round(w.retryAfterMs / 86400000)}天后可再提`);
    this.save();
    return true;
  }

  /** 用户接受某需求 */
  acceptWish(id: string): boolean {
    const w = this.data.wishes.find((x) => x.id === id);
    if (!w) return false;
    w.status = 'accepted';
    this.save();
    return true;
  }

  /** 当前可以提的需求（未被拒，或已过 1 个月冷静期） */
  raisableWishes(now = Date.now()): WishRequest[] {
    return this.data.wishes.filter((w) => {
      if (w.status === 'accepted') return false;
      if (w.status === 'rejected') return now - (w.rejectedAt ?? 0) >= w.retryAfterMs;
      return true;
    });
  }

  /** 本周已提过几条（用于限流：每周最多 2 条） */
  wishesRaisedSince(sinceMs: number): number {
    return this.data.wishes.filter((w) => (w.raisedAt ?? 0) >= sinceMs).length;
  }

  /** 全部需求快照 */
  allWishes(): WishRequest[] {
    return this.data.wishes;
  }
}
