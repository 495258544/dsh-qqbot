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
     * 上限仍受 burstMax 约束（官方：单聊每条消息可被动回复 4 次、群聊 5 次，
     * 要给工具结果与异常提示留额度）。
     */
    effectiveBurstMax() {
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
    split(text, max = this.effectiveBurstMax()) {
        const raw = String(text ?? '').trim();
        if (!raw)
            return [];
        // 1) 段落是作者自己的排版意图 —— 最优先的语义边界
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
        const units = [];
        let paraIdx = 0;
        for (const b of blocks) {
            const segs = b
                .split(/(?<=[。！？!?…~])\s*/)
                .map((s) => s.trim())
                .filter(Boolean);
            if (segs.length === 0) {
                units.push({ text: b, para: paraIdx });
            }
            else {
                for (const s of segs)
                    units.push({ text: s, para: paraIdx });
            }
            paraIdx++;
        }
        // 单条消息的软上限：一条太长的观感也不好。超了就在句子/逗号处再切一刀。
        const SOFT_MAX = 220;
        const finalUnits = [];
        for (const u of units) {
            if ([...u.text].length <= SOFT_MAX) {
                finalUnits.push(u);
                continue;
            }
            const bits = u.text.split(/(?<=[，,、])/).map((s) => s.trim()).filter(Boolean);
            if (bits.length > 1)
                for (const b of bits)
                    finalUnits.push({ text: b, para: u.para });
            else
                finalUnits.push(u);
        }
        /** 把一组 unit 拼回一段文本：跨段落用换行，同段落直接相连 */
        const render = (group) => {
            let out = '';
            let prevPara = -1;
            for (const u of group) {
                if (prevPara >= 0)
                    out += u.para !== prevPara ? '\n' : '';
                out += u.text;
                prevPara = u.para;
            }
            return out;
        };
        // 贪心装桶：一条到软上限就收口；**永远不会切在句子中间**
        const groups = [];
        let cur = [];
        let curLen = 0;
        for (const u of finalUnits) {
            const len = [...u.text].length;
            if (cur.length > 0 && curLen + len > SOFT_MAX) {
                groups.push(cur);
                cur = [];
                curLen = 0;
            }
            cur.push(u);
            curLen += len;
        }
        if (cur.length)
            groups.push(cur);
        // 桶数超上限（max=1、或段落太少装不下）→ 合并相邻桶，
        // 合并时优先并**最短的那一对相邻桶**，直到降到 max。
        while (groups.length > max && groups.length > 1) {
            let bestIdx = 0;
            let bestLen = Infinity;
            for (let i = 0; i < groups.length - 1; i++) {
                const l = groups[i].reduce((n, u) => n + [...u.text].length, 0)
                    + groups[i + 1].reduce((n, u) => n + [...u.text].length, 0);
                if (l < bestLen) {
                    bestLen = l;
                    bestIdx = i;
                }
            }
            groups[bestIdx] = [...groups[bestIdx], ...groups[bestIdx + 1]];
            groups.splice(bestIdx + 1, 1);
        }
        return groups.map(render);
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