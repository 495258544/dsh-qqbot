/**
 * 唤醒判定 · 什么时候该说话，什么时候该安静
 * ─────────────────────────────────────────────────────────────
 * 移植自 ai-companion-kit（MIT）packages/companion/src/wake.js。
 *
 * 把"要不要醒"拆成独立条件，任一命中才醒：
 *   atMention / nameMention / keywords / question / speakerIds /
 *   probability / anyMessage
 * 注：原版的 poke（拍一拍）在 QQ 官方 Bot API 无对应事件，未移植。
 * 另含「无限期潜水」概念：醒过一次后，一段时间内除非再次命中否则装没看见。
 */
/** 中文里"在问问题"的粗略特征 */
const QUESTION_HINTS = /[?？]|怎么|为什么|为啥|如何|是不是|能不能|可不可以|有没有|谁|哪儿|哪里|何时|多少/;
export class Waker {
    names;
    keywords;
    ownerIds;
    defaultProbability;
    configs = new Map();
    constructor(opts = {}) {
        this.names = (opts.names ?? []).filter(Boolean);
        this.keywords = (opts.keywords ?? []).filter(Boolean);
        this.ownerIds = (opts.ownerIds ?? []).map(String);
        this.defaultProbability = opts.probability ?? 0.05;
    }
    /** 给某个会话设置唤醒配置 */
    setConfig(key, cfg = {}) {
        this.configs.set(key, {
            mode: 'diving', // 'diving' 潜水 | 'active' 活跃
            infinite: true, // 无限期，直到再次命中条件
            until: 0,
            atMention: true,
            nameMention: true,
            keywords: [],
            question: true,
            speakerIds: [],
            probability: this.defaultProbability,
            anyMessage: false,
            ...cfg,
        });
    }
    getConfig(key) {
        if (!this.configs.has(key))
            this.setConfig(key, {});
        return this.configs.get(key);
    }
    /** 现在是不是在潜水（潜水中 = 不该主动说话） */
    isDiving(key) {
        const c = this.getConfig(key);
        if (c.mode === 'active')
            return false;
        if (c.infinite)
            return true;
        return Date.now() < c.until;
    }
    /** 把它从潜水里叫起来 */
    wake(key) {
        const c = this.getConfig(key);
        c.lastWakeAt = Date.now();
        c.wakeCount = (c.wakeCount ?? 0) + 1;
    }
    /**
     * 定期清理长期无活跃的会话配置（审查 m9）。
     * staleMs 太长会把活跃潜水误判为过期，太短又删得太勤 → 保守用 30 天。
     * 半衰指标：最后一次唤醒距今。返回清理数。
     */
    prune(staleMs = 30 * 24 * 3600_000) {
        const now = Date.now();
        let removed = 0;
        for (const [key, c] of this.configs) {
            // 只清"唤醒过一次且很久没再醒"的会话；从未醒过的潜水配置保守保留
            // 否则 getConfig 惰性创建的 key 会在第二次 prune 被误删、丢掉潜水语义
            if (c.lastWakeAt !== undefined && c.lastWakeAt < now - staleMs) {
                this.configs.delete(key);
                removed += 1;
            }
        }
        return removed;
    }
    /** 让它继续潜水（可以指定潜多久） */
    dive(key, ms = 0) {
        const c = this.getConfig(key);
        c.infinite = !ms;
        c.until = ms ? Date.now() + ms : 0;
    }
    /** 判定一条消息要不要唤醒 */
    shouldWake(msg) {
        const c = this.getConfig(msg.key);
        const text = String(msg.text ?? '');
        const uid = String(msg.userId ?? '');
        // 主人（或指定的人）说话 → 一定醒
        if (this.ownerIds.includes(uid) && c.mode !== 'active')
            return { wake: true, reason: 'owner' };
        if (Array.isArray(c.speakerIds) && c.speakerIds.map(String).includes(uid)) {
            return { wake: true, reason: 'speaker' };
        }
        if (c.anyMessage)
            return { wake: true, reason: 'anyMessage' };
        if (c.mode === 'active')
            return { wake: true, reason: 'active' };
        if (c.atMention && (msg.isAtMe || msg.isQuoteMe))
            return { wake: true, reason: 'atMention' };
        if (c.nameMention) {
            const hit = this.names.find((n) => text.includes(n));
            if (hit)
                return { wake: true, reason: 'name:' + hit };
        }
        const kw = [...(c.keywords ?? []), ...this.keywords];
        if (kw.length) {
            const hit = kw.find((k) => k && text.includes(k));
            if (hit)
                return { wake: true, reason: 'keyword:' + hit };
        }
        if (c.question && QUESTION_HINTS.test(text) && [...text].length >= 4) {
            return { wake: true, reason: 'question' };
        }
        if (Number(c.probability) > 0 && Math.random() < Number(c.probability)) {
            return { wake: true, reason: 'probability' };
        }
        return { wake: false, reason: '' };
    }
}
//# sourceMappingURL=wake.js.map