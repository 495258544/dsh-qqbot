/** 待领附件保留时长（毫秒） */
const TTL_MS = 3 * 60 * 1000;
const pending = new Map();
/** 生成缓存键 */
export function pendingKey(scope, peerId, senderId) {
    return `${scope}:${peerId}:${senderId}`;
}
/** 存入一批待领附件（同键合并，只保留最近的） */
export function stashPendingAttachments(key, files) {
    if (files.length === 0)
        return;
    const prev = pending.get(key);
    const now = Date.now();
    // 丢弃过期数据后再合并
    const kept = prev && now - prev.at < TTL_MS ? prev.files : [];
    pending.set(key, { files: [...kept, ...files], at: now });
}
/**
 * 取出并清空某键下的待领附件（唤醒时调用）。
 * 过期的不返回。
 */
export function takePendingAttachments(key) {
    const e = pending.get(key);
    if (!e)
        return [];
    pending.delete(key);
    if (Date.now() - e.at >= TTL_MS)
        return [];
    return e.files;
}
/** 清理过期条目（定时调用，避免内存滞留） */
export function prunePendingAttachments() {
    const now = Date.now();
    let n = 0;
    for (const [k, e] of pending) {
        if (now - e.at >= TTL_MS) {
            pending.delete(k);
            n += 1;
        }
    }
    return n;
}
//# sourceMappingURL=pending-attachments.js.map