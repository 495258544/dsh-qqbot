/**
 * 归属索引 · 引用消息的发送者反查（M21）
 * ─────────────────────────────────────────────────────────────
 * 问题：QQ 合并转发（msgType=103）的 `msg_elements` **只有 content 字符串**，
 * 不含每条消息的发送者/nickname/timestamp。SDK 类型定义就是：
 *
 *     interface RawMsgElement { msg_idx?; content?; attachments? }
 *
 * 拿不到发送者 → 模型只能看到"某人" → 会瞎猜归属。
 * 真实事故（2026-10-31）：小羽把 jmx 说的「卡了就别催了」算成群主说的，
 * 回了句「刚不是你那边卡了」。
 *
 * 曾经用群历史缓冲反查，但 `clearGroupHistory` 每轮回复后都会清空它，
 * 导致反查永远命中不了。所以这里单独存一份**只用于反查**的小索引：
 *   - 与 historyBuffer 完全分离，不被清理
 *   - 不进模型上下文（只喂给 buildQuotePart 做归属判定）
 *   - 环形保存最近 N 条，内存占用固定
 */
/** 每个群保留多少条用于反查（够覆盖"引用几句话之前"的常见操作） */
const MAX_PER_GROUP = 40;
/** 内存里最多保留多少个群（防内存无界增长） */
const MAX_GROUPS = 200;
const index = new Map();
function groupKey(appId, groupId) {
    return `${appId}:${groupId}`;
}
/**
 * 记一条消息，供后续引用时反查归属。
 *
 * 用户消息和机器人自己的消息都要记 —— 否则「引用小羽说过的话」查不到，
 * 她就会把自己的话当成别人说的。
 */
export function rememberForAttribution(appId, groupId, entry) {
    const body = String(entry.content ?? '').trim();
    if (!body || !entry.senderId)
        return;
    const key = groupKey(appId, groupId);
    let list = index.get(key);
    if (!list) {
        // 群数上限：挤掉最久没更新的那个
        if (index.size >= MAX_GROUPS) {
            let oldestKey;
            let oldestTs = Infinity;
            for (const [k, v] of index) {
                const ts = v[v.length - 1]?.timestamp ?? 0;
                if (ts < oldestTs) {
                    oldestTs = ts;
                    oldestKey = k;
                }
            }
            if (oldestKey !== undefined)
                index.delete(oldestKey);
        }
        list = [];
        index.set(key, list);
    }
    list.push({
        senderId: entry.senderId,
        ...(entry.senderName ? { senderName: entry.senderName } : {}),
        content: body.slice(0, 200),
        timestamp: Date.now(),
    });
    if (list.length > MAX_PER_GROUP)
        list.splice(0, list.length - MAX_PER_GROUP);
}
/** 归一化：去合并转发头、去标签、压空白，用于内容比对 */
function norm(text) {
    return String(text ?? '')
        .replace(/^===\s*消息\s*\d+\s*===\s*$/gm, '')
        .replace(/\[消息类型\][^\n]*/g, '')
        .replace(/\[消息内容\]/g, '')
        .replace(/\[图片\]|\[表情\]|\[动画表情\]/g, '')
        .replace(/\s+/g, '')
        .trim();
}
/**
 * 按内容反查这条引文是谁说的。
 *
 * 匹配策略（从严格到宽松）：
 *   1. 完全包含（引文里含历史某条的完整内容）→ 最可信
 *   2. 历史条目包含引文（引文被截断过）
 *   3. 前面若干字的公共前缀足够长 → 应对"预览被省略号截断"
 *
 * 命中多个时取**最近**的那条（同一个群里同一句话更可能是最近说的）。
 */
export function lookupAttribution(appId, groupId, quotedText) {
    const list = index.get(groupKey(appId, groupId));
    if (!list?.length)
        return undefined;
    const probe = norm(quotedText);
    if (probe.length < 4)
        return undefined;
    // 从新到旧找，第一个命中的就是最近说的
    for (let i = list.length - 1; i >= 0; i--) {
        const h = list[i];
        if (!h)
            continue;
        const body = norm(h.content);
        if (!body || body.length < 4)
            continue;
        if (probe.includes(body))
            return h; // 引文含完整原文
        if (body.includes(probe))
            return h; // 引文是原文的一部分
        // 预览被截断（QQ 引用预览会省略后半段）：比公共前缀
        const minLen = Math.min(body.length, probe.length);
        if (minLen >= 8) {
            let same = 0;
            while (same < minLen && body[same] === probe[same])
                same += 1;
            // 前缀几乎一致（允许末尾差一两个字）→ 认定同一句
            if (same >= Math.max(10, minLen - 3))
                return h;
        }
    }
    return undefined;
}
/** 清掉某群的索引（群解散/重置时用；正常回复**不要**调用） */
export function clearAttribution(appId, groupId) {
    index.delete(groupKey(appId, groupId));
}
/** 仅供测试/诊断：当前索引规模 */
export function attributionSize(appId, groupId) {
    return index.get(groupKey(appId, groupId))?.length ?? 0;
}
/** 仅供测试：清空全部（避免测试间互相污染） */
export function resetAttributionForTest() {
    index.clear();
}
//# sourceMappingURL=attribution-index.js.map