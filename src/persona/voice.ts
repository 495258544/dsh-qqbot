/**
 * 口癖系统（M11）— 从「她自己被接住的那句话」里长出说话习惯
 * ─────────────────────────────────────────────────────────────
 * 为什么自研（research-digest.md §一1）：
 *   - MaiBot 的过滤第一刀是 `is_bot_self()` —— **明确不学自己说的话**
 *   - Mirrai 的口头禅是从用户上传的记录蒸馏，不是从分身自身生成
 *   - elizaOS / AstrBot / SillyTavern 全是静态角色卡字段
 *   → 全行业没有现成实现。但零件可借：
 *     · MaiBot 的「当 A 时可以用 B」表示法 + 四关护栏
 *     · Mirrai 的 micro-rule 形状（证据 + verified）+ 未确认不注入
 *
 * 核心创新（本模块自己的设计）：
 *   用「她的话被接住」作为正样本奖励信号 —— 等价 D-MEM 的奖励预测门控。
 *   冷场不算负样本（可能是别人没看到）；只有被明确嫌才算负样本。
 *   这天然解决 MaiBot 不敢学自己的顾虑（它怕学到幻觉和客户腔）。
 *
 * 流程：
 *   outbound：记下她说过的短句（带 turnId）
 *   inbound：5 分钟内同一会话的下一条人类消息 = 「接住」（引用/复读/哈哈/确实/问号）
 *   攒够样本 → 抽取候选句式 → 护栏 → state='candidate'
 *   满足确认门槛（count>=2 且至少2条不同证据）→ state='active' → 才注入 prompt
 */
import fs from 'node:fs';
import path from 'node:path';

/** 一条口癖 */
export interface VoiceHabit {
  id: string;
  /** 当"…"时（≤20字，MaiBot 规范） */
  situation: string;
  /** 可以说"…"（≤20字，保留原作句式，不做抽象） */
  style: string;
  /** 被使用次数 */
  count: number;
  /** 开始采用的时间 */
  adoptedAt: number;
  /** 最后说的时问 */
  lastSaidAt?: number;
  /** 状态：候选 / 生效 / 退役 */
  state: 'candidate' | 'active' | 'retired';
  /** 证据（她被接住的具体案例） */
  evidence: Array<{ turnId: string; herLine: string; theirReply: string; at: number }>;
  /** 语气分类 */
  tone?: 'warm' | 'dry' | 'teasing' | 'tired';
  /** 与角色卡硬约束冲突的项 */
  conflictWith?: string[];
}

/** 她说的一句话 */
export interface Utterance {
  turnId: string;
  /** 会话键（scope:peerId） */
  key: string;
  /** 原话 */
  text: string;
  /** 发送时间 */
  at: number;
  /** 是否被接住（后续判定） */
  caught?: boolean;
  /** 接住她的人说了什么 */
  reply?: string;
}

/** 文件结构 */
interface VoiceFile {
  version: number;
  /** 待判定的发言（最近 N 条） */
  pending: Utterance[];
  /** 已确认被接住的正样本 */
  caughtSamples: Array<{ turnId: string; herLine: string; theirReply: string; at: number; key: string }>;
  /** 口癖库 */
  habits: VoiceHabit[];
  updatedAt?: string;
}

/** 「接住」判据：用户回应里出现这些就说明她的话被接住了 */
const CAUGHT_PATTERNS = [
  /哈+|笑死|笑|233/i,
  /确实|是这样|对|真的|可不是/i,
  /照做|学你|复读/i,
  /？/,
  /好家伙|绝了|妙|太对/i,
];

/** 「被嫌」判据（负样本，复用 M5） */
const COMPLAINT_RE = /太吵|别刷屏|刷屏了|安静点|安静些|闭嘴|别发了|少说点|烦死了|别吵|能不能别发|话太多|别这样/i;

/** 太短或太长的话不算口癖素材 */
const MIN_LINE = 4;
const MAX_LINE = 60;

/** 待判定队列上限 */
const MAX_PENDING = 40;
/** 正样本上限 */
const MAX_SAMPLES = 60;
/** 无人回应多久后丢弃待判定项（毫秒） */
const PENDING_TTL_MS = 5 * 60 * 1000;
/** 口癖 active 后连续多久无增长则退役 */
const RETIRE_IDLE_MS = 90 * 24 * 3600_000;

/** 角色卡硬约束的冲突词（学来的口癖如果让她变成这样，就拒绝） */
const CONFLICT_WORDS = ['哇', '太棒了', '哈哈哈哈哈', '亲爱的', '宝贝', '人家', '嘤嘤嘤', '冲鸭'];

/**
 * 口癖服务：读写 voice.json。
 */
export class VoiceService {
  private data: VoiceFile;
  private readonly file: string;

  constructor(dataDir: string, private readonly log?: (m: string) => void) {
    this.file = path.join(dataDir, 'voice.json');
    this.data = this.load();
  }

  private load(): VoiceFile {
    try {
      if (!fs.existsSync(this.file)) return { version: 1, pending: [], caughtSamples: [], habits: [] };
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<VoiceFile>;
      return {
        version: 1,
        pending: Array.isArray(raw.pending) ? raw.pending : [],
        caughtSamples: Array.isArray(raw.caughtSamples) ? raw.caughtSamples : [],
        habits: Array.isArray(raw.habits) ? raw.habits : [],
        updatedAt: raw.updatedAt,
      };
    } catch {
      return { version: 1, pending: [], caughtSamples: [], habits: [] };
    }
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      this.data.updatedAt = new Date().toISOString();
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log?.(`voice: 写入失败 ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  snapshot(): VoiceFile {
    return this.data;
  }

  // ───────────── 采集：她说的话 ─────────────

  /**
   * outbound：记录她说的一句话（待后续判定是否被接住）。
   * 只收长度合适、不像图片/表情占位的内容。
   */
  recordUtterance(turnId: string, key: string, text: string): boolean {
    const t = text.trim();
    if (t.length < MIN_LINE || t.length > MAX_LINE) return false;
    if (/^\[图片|^\[表情|^\[语音|^【图/.test(t)) return false;
    // 占位/系统消息不算
    if (/^\[.*\]$/.test(t)) return false;

    this.data.pending.push({ turnId, key, text: t, at: Date.now() });
    // 控制队列长度
    while (this.data.pending.length > MAX_PENDING) this.data.pending.shift();
    this.save();
    return true;
  }

  /**
   * inbound：判定她之前说的话是否被「接住」。
   * 规则：同会话、5 分钟内的下一条人类消息。
   * 返回被判定为「接住」的发言。
   */
  judgeIncoming(key: string, humanText: string): Utterance[] {
    const now = Date.now();
    const caught: Utterance[] = [];
    const remain: Utterance[] = [];

    for (const u of this.data.pending) {
      // 过了 TTL 的丢弃（冷场不算负样本）
      if (now - u.at > PENDING_TTL_MS) continue;
      // 不同会话的保留
      if (u.key !== key) {
        remain.push(u);
        continue;
      }
      // 同会话且 TTL 内 → 判定
      if (COMPLAINT_RE.test(humanText)) {
        // 被嫌 = 负样本，直接丢（不记入正样本，也不学）
        this.log?.(`voice: 她的「${u.text.slice(0, 16)}」被嫌，丢弃`);
        continue;
      }
      const isCaught = CAUGHT_PATTERNS.some((re) => re.test(humanText));
      if (isCaught) {
        caught.push(u);
        this.data.caughtSamples.push({
          turnId: u.turnId,
          herLine: u.text,
          theirReply: humanText.slice(0, 80),
          at: now,
          key,
        });
      } else {
        // 平淡回应：保留（可能下一句才接住）
        remain.push(u);
      }
    }

    while (this.data.caughtSamples.length > MAX_SAMPLES) this.data.caughtSamples.shift();
    this.data.pending = remain;
    if (caught.length > 0 || remain.length !== this.data.pending.length) this.save();
    return caught;
  }

  // ───────────── 抽取与护栏 ─────────────

  /** 正样本数量（够不够触发抽取） */
  caughtSampleCount(): number {
    return this.data.caughtSamples.length;
  }

  /**
   * 从正样本里抽取候选口癖（纯本地启发式，不调 LLM —— 省成本、可控）。
   *
   * 做法：找她多条「被接住」发言里的**重复句式特征**：
   *   - 开头固定词（"说实话"、"其实"）
   *   - 结尾固定词（"…吧"、"…来着"）
   *   - 常用连接（"反正"、"倒是"）
   * 抽出来存为 candidate，等确认。
   */
  extractCandidates(): VoiceHabit[] {
    const samples = this.data.caughtSamples;
    if (samples.length < 4) return [];

    // 统计各种开头/结尾模式的出现频率
    const starts = new Map<string, number>();
    const ends = new Map<string, number>();
    const middles = new Map<string, number>();

    for (const s of samples) {
      const line = s.herLine;
      // 开头 2-3 字
      for (const n of [2, 3]) {
        const p = line.slice(0, n);
        if (p.length >= 2) starts.set(p, (starts.get(p) ?? 0) + 1);
      }
      // 结尾 2-3 字
      for (const n of [2, 3]) {
        const p = line.slice(-n);
        if (p.length >= 2) ends.set(p, (ends.get(p) ?? 0) + 1);
      }
      // 中间常见词（2字）
      for (let i = 0; i <= line.length - 2; i++) {
        const p = line.slice(i, i + 2);
        middles.set(p, (middles.get(p) ?? 0) + 1);
      }
    }

    // 出现 >=2 次且不是通用词的，作为候选
    const COMMON = new Set(['的话', '时候', '什么', '这个', '那个', '可以', '就是', '还是', '不是']);
    const picked = new Map<string, VoiceHabit>();

    const consider = (kind: 'start' | 'end' | 'mid', word: string, n: number): void => {
      if (n < 2) return;
      if (word.length < 2) return;
      if (COMMON.has(word)) return;
      // 护栏 1：冲突词直接丢
      if (CONFLICT_WORDS.some((w) => word.includes(w))) return;
      const id = `${kind}:${word}`;
      if (picked.has(id)) return;
      const existing = this.data.habits.find((h) => h.situation === kind && h.style === word);
      if (existing) return;
      picked.set(id, {
        id,
        situation: kind === 'start' ? '想说开场白时' : kind === 'end' ? '想收尾时' : '想加个连接词时',
        style: word,
        count: n,
        adoptedAt: Date.now(),
        state: 'candidate',
        evidence: samples.slice(0, 2).map((s) => ({
          turnId: s.turnId,
          herLine: s.herLine,
          theirReply: s.theirReply,
          at: s.at,
        })),
        tone: 'dry',
      });
    };

    // 按出现频次优先：先 ends（收尾句式最像口癖），再 starts，最后 middles
    const byFreq = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    for (const [w, n] of byFreq(ends)) consider('end', w, n);
    for (const [w, n] of byFreq(starts)) consider('start', w, n);
    for (const [w, n] of byFreq(middles)) consider('mid', w, n);

    // 护栏：子串去重 —— "说实" 是 "说实话" 的子串，只保留更长更有意义的那个
    const all = [...picked.values()];
    const deduped = all.filter((h) => {
      return !all.some((o) => o !== h && o.style.length > h.style.length && o.style.includes(h.style));
    });
    // 护栏：太短的片段没有表达性（<2字已排除，这里再排除"纯片段"）
    // 若一个词只是某个更常见词的一部分，它多半是切碎的产物
    const final = deduped.filter((h) => {
      // 中文常见虚词组合，单独拿出来没有意义
      const FRAGMENT = new Set(['说实','实话','这个','那个','时候','什么','的话','可以','就是','还是','不是','有点','真的','觉得']);
      return !FRAGMENT.has(h.style);
    });
    // 最多新增 5 条候选
    const added = final.slice(0, 5);
    for (const h of added) this.data.habits.push(h);
    if (added.length > 0) {
      this.save();
      this.log?.(`voice: 抽取 ${added.length} 条候选口癖`);
    }
    return added;
  }

  /**
   * 确认门槛：count>=2 且至少 2 条不同证据 → 转 active。
   * 对应 Mirrai 的「未 verified 不注入」。
   */
  promoteHabits(): number {
    let promoted = 0;
    for (const h of this.data.habits) {
      if (h.state !== 'candidate') continue;
      const distinctEvidence = new Set(h.evidence.map((e) => e.turnId)).size;
      if (h.count >= 2 && distinctEvidence >= 2) {
        h.state = 'active';
        promoted += 1;
        this.log?.(`voice: 口癖「${h.style}」转正`);
      }
    }
    if (promoted > 0) this.save();
    return promoted;
  }

  /** 她表态：接受/拒绝某条候选口癖 */
  decideHabit(id: string, accept: boolean): boolean {
    const h = this.data.habits.find((x) => x.id === id);
    if (!h) return false;
    h.state = accept ? 'active' : 'retired';
    this.save();
    return true;
  }

  /** 退役体检：active 且 90 天无增长 → retired */
  retireStale(now = Date.now()): number {
    let n = 0;
    for (const h of this.data.habits) {
      if (h.state !== 'active') continue;
      const last = h.lastSaidAt ?? h.adoptedAt;
      if (now - last >= RETIRE_IDLE_MS) {
        h.state = 'retired';
        n += 1;
      }
    }
    if (n > 0) {
      this.save();
      this.log?.(`voice: ${n} 条口癖因长期不用退役`);
    }
    return n;
  }

  /** 生效中的口癖（只有这些会被注入 prompt） */
  activeHabits(): VoiceHabit[] {
    return this.data.habits.filter((h) => h.state === 'active');
  }

  /** 生成注入 prompt 的文本（照 MaiBot 句式） */
  renderSection(): string {
    const active = this.activeHabits();
    if (active.length === 0) return '';
    const lines = active.slice(0, 4).map((h) => `- 当"${h.situation}"时，可以用"${h.style}"来表达。`);
    return [
      '【你自己的一些说话习惯（视情况自由用，不强求；一轮最多用一条，连续两轮不要用同一条）】',
      ...lines,
    ].join('\n');
  }

  /** 记录一次实际使用（她说了带该口癖的话） */
  markUsed(id: string): void {
    const h = this.data.habits.find((x) => x.id === id);
    if (!h) return;
    h.count += 1;
    h.lastSaidAt = Date.now();
    this.save();
  }
}
