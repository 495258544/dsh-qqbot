/**
 * 备用通道（failover）· 主通道限流时自动换路
 * ─────────────────────────────────────────────────────────────
 * 真实事故（2026-10-31）：群里刷出
 *   ⚠️ 本轮异常结束
 *   `RATE_LIMIT`: raccoon: 您的模型请求频率超限，请稍后重试
 * 之后小羽连续两轮说不上话。单条通道被打满时，她只能干等。
 *
 * 做法：配置若干备用路由（persona.fallbackRoutes），遇到"这条通道暂时用不了"
 * 的失败就换到下一路。**只在确认是通道问题时才切**，不把代码 bug 也当限流。
 *
 * 设计取舍：
 *   - 切换是"会话级粘性"的：一旦切到某条通道，后续轮次继续用它，
 *     避免每轮都从头试主通道、把主通道继续打满。
 *   - 有冷却：切走后一段时间不再回头试，防止主通道刚恢复就被反复打。
 *   - 不无限重试：一次失败最多前进一格，失败到底就如实告诉用户。
 */
/** 触发换路的错误码：确认是"通道暂时不可用"，而不是代码/上下文问题 */
const FAILOVER_CODES = new Set([
    'RATE_LIMIT', // 限流（最常见的换路场景）
    'OVERLOADED', // 服务过载
    'MODEL_UNAVAILABLE', // 该通道不提供这个模型
    'MISSING_CREDENTIAL', // 这条通道没配好 key
    'NO_ADAPTER', // 这条通道的 adapter 没注册
    'SERVER', // 上游 5xx
]);
/**
 * **不**触发换路的错误：换通道也解决不了，换了只是把同一份上下文
 * 拿去再失败一次，还会增加不必要的调用。
 */
const NO_FAILOVER_CODES = new Set([
    'CONTEXT_TOO_LONG', // 上下文超长：换通道照样超
    'INVALID_REQUEST', // 请求本身有问题
    'ABORTED', // 用户主动中止
    'CANCELLED',
]);
/** 一条路由的可读名，用于日志与提示 */
export function routeLabel(route) {
    return route ? `${route.provider}/${route.model}` : '(none)';
}
export function shouldFailover(code) {
    if (!code)
        return false;
    if (NO_FAILOVER_CODES.has(code))
        return false;
    return FAILOVER_CODES.has(code);
}
/**
 * 路由轮换器。
 *
 * 维护每个会话当前停在备用链的哪一格，并给出"下一路"。
 */
export class Failover {
    primary;
    fallbacks;
    /** 会话 → 当前所在的路由下标（0 = 主通道） */
    cursor = new Map();
    /** 会话 → 最早可以回头试主通道的时间戳 */
    retryAfter = new Map();
    cooldownMs;
    constructor(primary, fallbacks, opts = {}) {
        this.primary = primary;
        this.fallbacks = fallbacks;
        this.cooldownMs = opts.cooldownMs ?? 10 * 60 * 1000;
    }
    /** 备用链是否配置过（没配就完全不做 failover，保持现状） */
    get enabled() {
        return this.fallbacks.length > 0;
    }
    /** 完整链路：主通道 + 备用，去重（provider+model 完全相同视为同一路） */
    get chain() {
        const list = [];
        const seen = new Set();
        for (const r of [this.primary, ...this.fallbacks]) {
            if (!r?.provider || !r?.model)
                continue;
            const k = `${r.provider}/${r.model}`;
            if (seen.has(k))
                continue;
            seen.add(k);
            list.push(r);
        }
        return list;
    }
    /** 这个会话现在该用哪条路由 */
    current(key) {
        const chain = this.chain;
        if (chain.length === 0)
            return this.primary;
        // 冷却期内不回头试主通道：保持当前的备用位置
        const idx = this.cursor.get(key) ?? 0;
        return chain[Math.min(idx, chain.length - 1)];
    }
    /**
     * 记录一次失败，必要时前进一格。
     *
     * @returns 换到的新路由；不换路时返回 undefined（调用方据此判断"要不要告知用户"）
     */
    advance(key, code) {
        if (!this.enabled)
            return undefined;
        if (!shouldFailover(code))
            return undefined;
        const chain = this.chain;
        if (chain.length === 0)
            return undefined;
        const idx = this.cursor.get(key) ?? 0;
        if (idx + 1 >= chain.length)
            return undefined; // 已经到底，没有下一路了
        const from = chain[idx];
        const to = chain[idx + 1];
        if (to === undefined)
            return undefined; // 理论上不可达（上面已判越界）
        this.cursor.set(key, idx + 1);
        // 停在备用通道上至少 cooldownMs，避免主通道刚恢复就被立刻打回去
        this.retryAfter.set(key, Date.now() + this.cooldownMs);
        return { from, to };
    }
    /** 冷却到期后允许回头试主通道（由外部定时或每轮调用） */
    maybeReset(key) {
        const idx = this.cursor.get(key);
        if (idx === undefined || idx === 0)
            return undefined;
        const until = this.retryAfter.get(key) ?? 0;
        if (Date.now() < until)
            return undefined;
        const chain = this.chain;
        const prev = chain[idx];
        this.cursor.delete(key);
        this.retryAfter.delete(key);
        return prev; // 返回"从哪条回退到主通道"，便于日志
    }
    /** 这个会话当前是否在用备用通道 */
    isOnFallback(key) {
        return (this.cursor.get(key) ?? 0) > 0;
    }
    /** 清掉某会话的状态（会话销毁时） */
    forget(key) {
        this.cursor.delete(key);
        this.retryAfter.delete(key);
    }
}
//# sourceMappingURL=failover.js.map