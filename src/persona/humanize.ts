/**
 * 拟人化发送 · 让它打字不像机器
 * ─────────────────────────────────────────────────────────────
 * 移植自 ai-companion-kit（MIT）packages/companion/src/humanize.js。
 *
 * 真人发消息：先"正在输入…"一会儿（时长与字数相关但不完全成正比）、
 * 短句分几条发、条间停顿、偶尔停久一点（像被打断）、深夜节奏变慢。
 *
 * dsh-qqbot 适配（相对原版）：
 * - burstMax 默认 4 → **2**：官方限制是「单聊每条消息被动回复 4 次、群聊 5 次」，
 *   要给工具结果与异常提示留额度。超出的部分**不会被截断**，而是由
 *   reply-target 的三级兜底降级成主动消息发出（见 DESIGN §3.4 冲突A）
 * - send 回调由调用方注入（outbound 里是 bootstrap 包装过的 sender，
 *   其内部每次 sendMarkdown 独立过 resolveReplyTarget 三级兜底）
 * - typing 由官方 sendTyping 承担（仅 c2c），失败忽略
 */

import { hourInTz } from './clock.ts';

/** 睡觉时段（**北京时区**），这段时间回复会明显变慢 */
const NIGHT = { from: 2, to: 7 };
/** 打字速度：每字毫秒。中文手打大概 80~140ms/字 */
const DEFAULT_MS_PER_CHAR = 110;

export interface HumanizerOptions {
  /** 总开关 */
  enabled?: boolean;
  /** 每字打字时间（作者实测真人值 110，原版默认 85 偏快） */
  msPerChar?: number;
  /** 最短"正在输入"时长 */
  minMs?: number;
  /** 最长"正在输入"时长 */
  maxMs?: number;
  /** 抖动比例（±20%） */
  jitter?: number;
  /** 一次最多分几条发（官方 API 建议 ≤2） */
  burstMax?: number;
  /** 条间停顿范围（毫秒） */
  gapRange?: [number, number];
  /** 出现"长停顿"的概率 */
  longGapChance?: number;
  /** 长停顿范围 */
  longGapRange?: [number, number];
  /**
   * 情绪系数提供者（M31 闸门②③）。
   *
   * 为什么做成注入而不是直接 import emotion.ts：
   * Humanizer 是从 ai-companion-kit 移植来的通用工具，
   * 不该知道"情绪"这种东西存在。注入一个返回数字的函数即可，
   * 没注入时完全退化成原行为 —— 既有测试不用搭情绪环境。
   */
  mood?: () => { speed: number; burst: number };
}

export interface HumanizerIO {
  /** 切换"正在输入"状态（可选，平台不支持时忽略） */
  setTyping?: (on: boolean) => Promise<unknown>;
  /** 真正发一条 */
  send: (msg: string) => Promise<unknown>;
  /** 等待（默认 setTimeout，测试可注入） */
  sleep?: (ms: number) => Promise<void>;
}

export class Humanizer {
  public readonly enabled: boolean;
  private readonly msPerChar: number;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly jitter: number;
  private readonly burstMax: number;
  private readonly gapRange: [number, number];
  private readonly longGapChance: number;
  private readonly longGapRange: [number, number];
  private readonly mood: (() => { speed: number; burst: number }) | undefined;

  constructor(opts: HumanizerOptions = {}) {
    this.enabled = opts.enabled !== false;
    this.msPerChar = opts.msPerChar ?? DEFAULT_MS_PER_CHAR;
    this.minMs = opts.minMs ?? 1200;
    this.maxMs = opts.maxMs ?? 6000;
    this.jitter = opts.jitter ?? 0.2;
    this.burstMax = opts.burstMax ?? 2;
    this.gapRange = opts.gapRange ?? [700, 2600];
    this.longGapChance = opts.longGapChance ?? 0.25;
    this.longGapRange = opts.longGapRange ?? [3000, 9000];
    this.mood = opts.mood;
  }

  /** 按字数算"正在输入"该持续多久 */
  typingMsFor(text: string): number {
    const n = [...String(text ?? '')].length;
    let ms = this.minMs + n * this.msPerChar;
    ms = Math.min(this.maxMs, Math.max(this.minMs, ms));
    // 抖动
    ms *= 1 + (Math.random() * 2 - 1) * this.jitter;
    // 深夜慢一点（半睡半醒）
    // 用显式时区：启动时未设 TZ 环境变量，getHours() 返回 UTC —— 会让"深夜"完全错位
    // （实测：北京 10:35 会被当成凌晨 2:35，误触发 1.6 倍慢速）。
    const h = hourInTz(new Date());
    if (h >= NIGHT.from && h < NIGHT.to) ms *= 1.6;
    // M31 闸门②：没精神的时候打字慢（累了会拖）
    const speed = this.mood?.().speed ?? 1;
    ms *= speed;
    return Math.round(ms);
  }

  /** 条与条之间停多久 */
  gapMs(): number {
    const [a, b] = this.gapRange;
    let ms = a + Math.random() * Math.max(0, b - a);
    if (Math.random() < this.longGapChance) {
      const [c, d] = this.longGapRange;
      ms += c + Math.random() * Math.max(0, d - c);
    }
    return Math.round(ms);
  }

  /**
   * M31 闸门③：今天分几条发。
   * 激动时更容易连发两条，蔫的时候合成一条。
   * 上限仍受 burstMax 约束（官方：单聊每条消息可被动回复 4 次、群聊 5 次，
   * 要给工具结果与异常提示留额度）。
   */
  private effectiveBurstMax(): number {
    const want = this.mood?.().burst ?? this.burstMax;
    return Math.max(1, Math.min(this.burstMax, want));
  }

  /**
   * 把一段长回复切成"像人打出来的"若干条。
   *
   * ## 2026-11-06 修：切分必须落在语义边界上
   *
   * 这个函数改过两轮，两轮的教训都要留着：
   *
   * **第一轮（旧实现）**：`merged.slice(max-1).join(' ')` —— 把超出部分全部用
   * 空格拼成一条。实测她一条 439 字 / 6 段的回复被切成「12 字 + 427 字」，
   * 那 427 字里段落分隔全被替换，在 QQ 上就是一个**没有换行的巨块**
   * （用户原话"又是一大段"）。所以"她写了一坨"这个观感有一半是这里造成的。
   *
   * **第二轮**：改成按字数均衡装桶、桶内保留换行。修掉了巨块，但引入了
   * 新问题——**切分点落在语义中间**。实测她那条 200 字 / 4 段的冲浪见闻被切成
   * 「82 + 115」，把「两条对胃口的：」这个引导句和它引出的内容拆开了；
   * 另一条 255 字的被切成「40 + 211」，刻度表和"对不上的地方"挤在一起。
   * 根因：按字符数均衡**不知道句子在哪结束**。
   *
   * **现在（第三轮）**：切分**优先落在语义边界**上——
   *   段落（作者自己的排版意图）> 句子（句末标点）；
   * 字数只作**上限**（一条太长了不好看），不再作为切分的主要依据。
   * 只有在段落和句子都切不动时（单个超长句）才硬切。
   *
   * 条数上限仍然是 max（官方：单聊每条消息可被动回复 4 次、群聊 5 次，
   * 要给工具结果与异常提示留额度）。
   */
  split(text: string, max = this.effectiveBurstMax()): string[] {
    const raw = String(text ?? '').trim();
    if (!raw) return [];

    // 1) 段落是作者自己的排版意图 —— 最优先的语义边界
    const paras = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);

    // 2) 合并极短段（单独一行的「嗯」「好」）
    const blocks: string[] = [];
    for (const p of paras) {
      const last = blocks[blocks.length - 1];
      if (last && [...last].length < 6 && [...last].length + [...p].length <= 24) {
        blocks[blocks.length - 1] = last + p;
      } else {
        blocks.push(p);
      }
    }

    if (blocks.length <= max) return blocks;

    // 单段软上限：一条气泡里太长观感也不好。超了沿句子边界拆。
    const SOFT_MAX = 220;

    // 3) 超出条数上限：**每个段落优先独占一条气泡**。
    //
    // ## 2026-11-07 修：多段不再挤进一条
    //
    // 上一版贪心装桶按 SOFT_MAX=220 字收口，结果她一条 3 段 / 167 字的回复
    // 被合成**一个带两个换行的气泡** —— 用户反馈「所有内容挤在一条消息里面」。
    // 真人分段的想法就是连着发几条，不是一个气泡里按两下回车。
    //
    // 现在：段落即气泡；只有单段自己超长（>SOFT_MAX）才沿句子边界拆开。
    // 拆完若条数仍超 max，合并**最短的相邻对**（用换行连接，绝不空格拼接）。
    type Unit = { text: string; para: number };
    const units: Unit[] = [];
    let paraIdx = 0;
    for (const b of blocks) {
      // 段落本身够短 → 整段一个 unit（一个气泡）
      if ([...b].length <= SOFT_MAX) {
        units.push({ text: b, para: paraIdx });
      } else {
        // 超长段落沿句子切开（每句仍是独立 unit/气泡候选）
        const segs = b
          .split(/(?<=[。！？!?…~])\s*/)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const s of (segs.length > 0 ? segs : [b])) units.push({ text: s, para: paraIdx });
      }
      paraIdx++;
    }

    /** 把一组 unit 拼回文本：同段落直接相连，跨段落用换行 */
    const render = (group: Unit[]): string => {
      let out = '';
      let prevPara = -1;
      for (const u of group) {
        if (prevPara >= 0) out += u.para !== prevPara ? '\n' : '';
        out += u.text;
        prevPara = u.para;
      }
      return out;
    };

    // 初始：每个 unit 一组（一段/一句 = 一个气泡）
    const groups: Unit[][] = units.map((u) => [u]);

    // 条数超上限 → 反复合并**合并后总长最短**的相邻对（保持语义相邻），
    // 直到降到 max。合并用换行连接（跨段落）或直连（同段落被句拆的）。
    while (groups.length > max && groups.length > 1) {
      let bestIdx = 0;
      let bestLen = Infinity;
      for (let i = 0; i < groups.length - 1; i++) {
        const l = groups[i]!.reduce((n, u) => n + [...u.text].length, 0)
          + groups[i + 1]!.reduce((n, u) => n + [...u.text].length, 0);
        if (l < bestLen) {
          bestLen = l;
          bestIdx = i;
        }
      }
      groups[bestIdx] = [...groups[bestIdx]!, ...groups[bestIdx + 1]!];
      groups.splice(bestIdx + 1, 1);
    }
    return groups.map(render);
  }

  /** 执行一次拟人化发送 */
  async say(text: string | string[], { setTyping, send, sleep }: HumanizerIO): Promise<{ sent: number; parts: string[] }> {
    const wait = sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const parts = Array.isArray(text) ? text.map((s) => String(s)) : this.split(text);
    if (!parts.length) return { sent: 0, parts: [] };

    if (!this.enabled) {
      for (const p of parts) await send(p);
      return { sent: parts.length, parts };
    }

    let sent = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i] as string;
      // 1) 先"正在输入"
      if (setTyping) {
        try {
          await setTyping(true);
        } catch {
          /* 平台不支持，忽略 */
        }
      }
      await wait(this.typingMsFor(p));
      if (setTyping) {
        try {
          await setTyping(false);
        } catch {
          /* ignore */
        }
      }
      // 2) 发出去
      await send(p);
      sent += 1;
      // 3) 条间停顿
      if (i < parts.length - 1) await wait(this.gapMs());
    }
    return { sent, parts };
  }
}
