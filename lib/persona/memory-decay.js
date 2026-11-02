/**
 * 记忆鲜活度 · 让记忆"会淡忘，但不是删除"
 * ─────────────────────────────────────────────────────────────
 * 移植自 `Yuuyuko-uu/dsh-fish-memory`（MIT，454 star）的衰减模型。
 * 参数与公式均来自其源码 `lib/index.js`（7,024 行，已逐行核实），非文档转述。
 *
 * ## 为什么需要（我们的现状）
 *
 * `people.json` 现在是**先进先出淘汰**：facts 上限 60 条，满了就挤掉最旧的。
 * 问题：一条"他养了只橘猫"和一条"他今天说好累"分量完全不同，
 * 但 FIFO 一视同仁——**重要的会被闲聊挤掉**。
 *
 * 用户的原话：「人的记忆本身也会遗忘或变形」。
 * 这个模型正好提供了那个中间状态：**不删，但越来越难被想起**。
 *
 * ## 源码里的实际公式（不是文档说的）
 *
 * ```js
 * function 鲜活度(m, policy, now) {
 *   const I = m.importance ?? 0
 *   const H = (policy.baseHalfLifeDays || 30) * (1 + 2 * I)   // ← 关键：半衰期随重要度放大
 *   if (m.category === 'stable_profile') return 常数          // 长期事实不过期
 *   return A0 * Math.pow(2, -daysA / H)                      // 指数衰减
 * }
 * ```
 *
 * **README 只说"半衰期默认 30 天"，没提 H 会随重要度变长**：
 *   importance = 0   → 半衰期 30 天
 *   importance = 0.5 → 半衰期 60 天
 *   importance = 1   → 半衰期 90 天
 * 这才是"为什么有些旧记忆反而活得更久"的真正原因。
 *
 * ## 与源码的差异（刻意不照搬的部分）
 *
 * | 源码 | 我们 | 原因 |
 * |---|---|---|
 * | 权重 0.55/0.25/0.15/0.05 | **0.60/0.30/0.10** | 源码的 `emotion` 是**死字段**（三处创建记忆都写死 null，工具参数里也没有），那 5% 恒不生效、乘数上限永远 0.95。照搬只会得到一个永远不工作的参数 |
 * | 每天最多记 8 条（dailyQuota） | **不设限**（见 DAILY_QUOTA 注释） | 用户决定 |
 * | 长期事实由模型判 importance>=1 | **由规则判定** | 模型容易把闲聊误判成"非常重要"，规则更可靠 |
 */
/** 一天多少毫秒 */
const DAY = 86_400_000;
/**
 * 每天最多写入几条新记忆（源码默认 8）。
 *
 * **它限制的是「写入」**，不是检索、也不是注入。
 * 源码里的位置：`DEFAULT_POLICY.dailyQuota = 8`，
 * UI 标签原文是「每天最多记几条」，tip:「她自己一天最多记几条」，
 * 用途见 `index.js:3636` 的注释 `// 配额（每天最多几条，先宽松）`。
 *
 * 作用：防止她把鸡毛蒜皮全记下来，把存储和上下文塞满。
 * 没了它，密集对话时一天可能抽出几十条，`facts` 的 60 条上限会被迅速占满。
 *
 * **我们当前不设限**（用户决定：2026-11-02）。
 * 保留这个常量 + 检查函数，将来要开只需把 `DAILY_QUOTA` 改成 8 并在
 * `Memory.remember()` 里调用 `withinDailyQuota()`。
 */
export const DAILY_QUOTA = Infinity;
/** 权重（合计 1.00）。源码是 0.55/0.25/0.15/0.05，我们去掉了无效的情绪维度 */
export const WEIGHTS = {
    /** 保底分：但凡被想起来就有 */
    baseline: 0.60,
    /** 鲜活度：越近、越常被想起，加得越多 */
    activation: 0.30,
    /** 重要度：标成重要的加得更多 */
    importance: 0.10,
};
/** 半衰期基数（天）。有效半衰期 = 基数 × (1 + 2×重要度) */
export const BASE_HALF_LIFE_DAYS = 30;
/**
 * 算有效半衰期（天）。
 * 这是源码里最值得抄的一点：**重要的事忘得更慢**。
 */
export function effectiveHalfLife(importance, baseDays = BASE_HALF_LIFE_DAYS) {
    return baseDays * (1 + 2 * importance);
}
/**
 * 算当前鲜活度 A（0~1）。
 *
 * @param st      这条记忆的状态
 * @param nowMs   现在
 * @returns       0~1 的鲜活度
 */
export function freshness(st, nowMs = Date.now()) {
    // 长期事实（画像/喜好/约定）不过期。
    // 源码对它返回常量 unknownActivation=0.5（不是 1.0），
    // 意思是"它一直在，但不会喊得最响"。我们沿用 0.5。
    if (st.stable)
        return 0.5;
    const halfLife = effectiveHalfLife(st.importance);
    const days = Math.max(0, (nowMs - st.anchor) / DAY);
    const a0 = Math.max(0, Math.min(1, st.activation0));
    return a0 * Math.pow(2, -days / halfLife);
}
/**
 * 总分 P = C × (baseline + activation·A + importance·I)
 *
 * @param evidence   证据量 C（0~1），见 {@link evidenceScore}
 * @param st         衰减状态
 * @param nowMs      现在
 */
export function rankScore(evidence, st, nowMs = Date.now()) {
    const a = freshness(st, nowMs);
    const w = WEIGHTS.baseline + WEIGHTS.activation * a + WEIGHTS.importance * st.importance;
    return evidence * w; // 注意：w ∈ [0.60, 1.00]
}
/**
 * 证据量 C = s / (s + rarityK)
 *
 * 源码的 `rarityK = 0.8`。含义：命中的词越"稀有"越值钱，
 * 常用词（"他""好""说"）堆再多也到不了 1。
 *
 * @param s        命中词的权重和（越稀有权重越高）
 * @param rarityK  稀有度饱和点，默认 0.8（越小越容易给分）
 */
export function evidenceScore(s, rarityK = 0.8) {
    const hits = Math.max(0, s);
    return hits / (hits + rarityK);
}
/**
 * 证据门槛：只有 C >= 0.3 才算"相关"。
 * 源码注释特别强调：**门槛卡的是证据 C，不是总分 P** ——
 * 所以调它不会误伤"该想起来但有点旧"的记忆。
 */
export const EVIDENCE_THRESHOLD = 0.3;
/**
 * 按最高证据量决定"这一轮最多注入几条"。
 * 源码分档：>=0.6→6条 / >=0.5→4 / >=0.4→3 / 否则 1。
 */
export function maxItemsFor(topEvidence) {
    if (topEvidence >= 0.6)
        return 6;
    if (topEvidence >= 0.5)
        return 4;
    if (topEvidence >= 0.4)
        return 3;
    return 1;
}
/** 强化：被再次提到时 A' = A + 0.2(1−A)，并把时间锚重置到现在 */
export function reinforce(st, nowMs = Date.now()) {
    const a = freshness(st, nowMs);
    // 长期事实的鲜活度是恒定的（freshness 对它返回 0.5），
    // 所以"强化"对它们没有意义 —— 反复提到一条"他住在杭州"
    // 不该让它从 0.5 漂到 0.6、再漂到 0.68…（实测发现这个漂移）
    if (st.stable)
        return { ...st, anchor: nowMs };
    return {
        ...st,
        activation0: Math.min(1, a + 0.2 * (1 - a)),
        anchor: nowMs,
    };
}
/**
 * 从文本推断重要度（**规则判定，不用模型**）。
 *
 * 源码是让模型打分，容易把闲聊误判成"非常重要"。规则更可靠、零成本。
 *
 * 判定依据：
 *   1   = 稳定事实：工作/住址/家人/宠物/长期喜好/约定
 *   0.5 = 具体的经历、观点、计划
 *   0   = 其余（记下来但不占分量）
 */
export function inferImportance(text) {
    const t = String(text ?? '');
    // 稳定事实的关键词（改成 importance=1 → 半衰期 90 天，且不过期）
    const STABLE = /(?:我是|我在|我做|我住|我老家|我家|我养|我有一只|我有个|结婚|孩子|老婆|老公|男朋|女朋|生日|过敏|不吃|吃素|信佛|工作在|住在)/;
    if (STABLE.test(t))
        return 1;
    // 具体的经历/观点/计划
    // 注意：光有"今天/最近"这类时间词不够 —— 「今天好热」是闲聊，不是值得记的事。
    // 必须**同时有动作**（去了/看了/买了…）或**有明确的观点**（觉得/认为/希望…）。
    const HAS_TIME = /(?:昨天|今天|前天|上周|上个月|刚才|最近|明天|下周)/;
    const HAS_ACTION = /(?:去|看|读|写|玩|做|学|追|听|买|吃|喝|见|参加|开始|完成)/;
    const HAS_OPINION = /(?:觉得|认为|感觉|希望|不想|不喜欢|更想|讨厌|喜欢|打算|计划|决定)/;
    if ((HAS_TIME.test(t) && HAS_ACTION.test(t)) || HAS_OPINION.test(t))
        return 0.5;
    return 0;
}
/**
 * 判断是否"长期事实"（不过期）。
 * 与 {@link inferImportance} 的 stable 判定同源——重要度 1 即长期事实。
 */
export function isStableFact(text) {
    return inferImportance(text) === 1;
}
//# sourceMappingURL=memory-decay.js.map