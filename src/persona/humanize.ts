/**
 * 拟人化发送 · 让它打字不像机器
 * ─────────────────────────────────────────────────────────────
 * 移植自 ai-companion-kit（MIT）packages/companion/src/humanize.js。
 *
 * 真人发消息：先"正在输入…"一会儿（时长与字数相关但不完全成正比）、
 * 短句分几条发、条间停顿、偶尔停久一点（像被打断）、深夜节奏变慢。
 *
 * dsh-qqbot 适配（相对原版）：
 * - burstMax 默认 4 → **2**：官方 API 同一 msgId 被动回复限 4 次，
 *   要给工具结果与异常提示留额度，超出会静默降级为主动推送（见 DESIGN §3.4 冲突A）
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
   * 上限仍受 burstMax 约束（官方 API 同一 msgId 被动回复限 4 次，要留额度）。
   */
  private effectiveBurstMax(): number {
    const want = this.mood?.().burst ?? this.burstMax;
    return Math.max(1, Math.min(this.burstMax, want));
  }

  /**
   * 把一段长回复切成"像人打出来的"若干条：
   * 先按换行切，过长的按中文标点再切，太短的相邻项合并，
   * 超过 burstMax 的合并进最后一条。
   */
  split(text: string, max = this.effectiveBurstMax()): string[] {
    const raw = String(text ?? '').trim();
    if (!raw) return [];
    let parts = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const out: string[] = [];
    for (const p of parts) {
      if ([...p].length <= 40) {
        out.push(p);
        continue;
      }
      const segs = p.split(/(?<=[。！？!?…~])\s*/).map((s) => s.trim()).filter(Boolean);
      out.push(...(segs.length ? segs : [p]));
    }
    parts = out;
    const merged: string[] = [];
    for (const s of parts) {
      const last = merged[merged.length - 1];
      if (last && [...last].length < 6 && [...last].length + [...s].length <= 24) {
        merged[merged.length - 1] = last + s;
      } else {
        merged.push(s);
      }
    }
    if (merged.length > max) {
      const head = merged.slice(0, max - 1);
      head.push(merged.slice(max - 1).join(' '));
      return head;
    }
    return merged;
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
