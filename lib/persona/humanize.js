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
import { hourInTz } from "./clock.js";
/** 睡觉时段（**北京时区**），这段时间回复会明显变慢 */
const NIGHT = { from: 2, to: 7 };
/** 打字速度：每字毫秒。中文手打大概 80~140ms/字 */
const DEFAULT_MS_PER_CHAR = 110;
export class Humanizer {
    enabled;
    msPerChar;
    minMs;
    maxMs;
    jitter;
    burstMax;
    gapRange;
    longGapChance;
    longGapRange;
    mood;
    constructor(opts = {}) {
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
    typingMsFor(text) {
        const n = [...String(text ?? '')].length;
        let ms = this.minMs + n * this.msPerChar;
        ms = Math.min(this.maxMs, Math.max(this.minMs, ms));
        // 抖动
        ms *= 1 + (Math.random() * 2 - 1) * this.jitter;
        // 深夜慢一点（半睡半醒）
        // 用显式时区：启动时未设 TZ 环境变量，getHours() 返回 UTC —— 会让"深夜"完全错位
        // （实测：北京 10:35 会被当成凌晨 2:35，误触发 1.6 倍慢速）。
        const h = hourInTz(new Date());
        if (h >= NIGHT.from && h < NIGHT.to)
            ms *= 1.6;
        // M31 闸门②：没精神的时候打字慢（累了会拖）
        const speed = this.mood?.().speed ?? 1;
        ms *= speed;
        return Math.round(ms);
    }
    /** 条与条之间停多久 */
    gapMs() {
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
    effectiveBurstMax() {
        const want = this.mood?.().burst ?? this.burstMax;
        return Math.max(1, Math.min(this.burstMax, want));
    }
    /**
     * 把一段长回复切成"像人打出来的"若干条。
     *
     * ## 2026-11-06 修：超出条数上限时的合并方式
     *
     * 旧实现是 `merged.slice(max - 1).join(' ')` —— 把超出部分**全部用空格拼成一条**。
     * 实测她一条 439 字 / 6 段的回复被切成「12 字 + 427 字」，而那条 427 字
     * 里段落分隔全被空格替换，在 QQ 上就是**一个没有换行的巨块**（用户原话：
     * "又是一大段"）。也就是说"她写了一坨"这个观感有一半是这里造成的，不是她写的。
     *
     * 另外旧实现把全部余量倒进**最后一条**，前一条只剩 max-1 个片段，
     * 分配极不均衡（12 + 427）。
     *
     * 现在：按长度**均衡装桶**，桶内保留换行（段落结构不被破坏），
     * 只有单个段落本身就超过目标长度时才按句切开。
     * 条数上限仍然是 max（官方 API 同一 msgId 被动回复限 4 次，要留额度）。
     */
    split(text, max = this.effectiveBurstMax()) {
        const raw = String(text ?? '').trim();
        if (!raw)
            return [];
        // 1) 先按段落切 —— 段落是作者的排版意图，不再一律按句打碎
        const paras = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
        // 2) 合并极短段（单独一行的「嗯」「好」）
        const blocks = [];
        for (const p of paras) {
            const last = blocks[blocks.length - 1];
            if (last && [...last].length < 6 && [...last].length + [...p].length <= 24) {
                blocks[blocks.length - 1] = last + p;
            }
            else {
                blocks.push(p);
            }
        }
        // 条数够了就直接发，不做任何拼接
        if (blocks.length <= max)
            return blocks;
        // 3) 超出上限：均衡装桶，桶内用换行连接（保留段落）
        const total = blocks.reduce((n, s) => n + [...s].length, 0);
        const target = Math.ceil(total / max);
        const buckets = [];
        let cur = [];
        let curLen = 0;
        for (const b of blocks) {
            // 单段就超目标：允许按句切开，免得一个桶被一整段独占
            let pieces = [b];
            if ([...b].length > target) {
                const segs = b
                    .split(/(?<=[。！？!?…~])\s*/)
                    .map((s) => s.trim())
                    .filter(Boolean);
                if (segs.length > 1)
                    pieces = segs;
            }
            for (const piece of pieces) {
                const len = [...piece].length;
                // 够长了就收口；留够剩余桶位（buckets.length < max-1）
                if (cur.length > 0 && curLen + len > target && buckets.length < max - 1) {
                    buckets.push(cur.join('\n'));
                    cur = [];
                    curLen = 0;
                }
                cur.push(piece);
                curLen += len;
            }
        }
        if (cur.length)
            buckets.push(cur.join('\n'));
        return buckets;
    }
    /** 执行一次拟人化发送 */
    async say(text, { setTyping, send, sleep }) {
        const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        const parts = Array.isArray(text) ? text.map((s) => String(s)) : this.split(text);
        if (!parts.length)
            return { sent: 0, parts: [] };
        if (!this.enabled) {
            for (const p of parts)
                await send(p);
            return { sent: parts.length, parts };
        }
        let sent = 0;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            // 1) 先"正在输入"
            if (setTyping) {
                try {
                    await setTyping(true);
                }
                catch {
                    /* 平台不支持，忽略 */
                }
            }
            await wait(this.typingMsFor(p));
            if (setTyping) {
                try {
                    await setTyping(false);
                }
                catch {
                    /* ignore */
                }
            }
            // 2) 发出去
            await send(p);
            sent += 1;
            // 3) 条间停顿
            if (i < parts.length - 1)
                await wait(this.gapMs());
        }
        return { sent, parts };
    }
}
//# sourceMappingURL=humanize.js.map