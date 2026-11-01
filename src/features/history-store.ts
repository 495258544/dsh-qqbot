/**
 * 群历史存储共享模块
 *
 * historyBuffer 中间件需要一个跨调用可访问的 HistoryStore 实例，
 * 以便在回复完成后清空某群的历史缓存（避免下次 @ 时重复组包）。
 */
import { MemoryHistoryStore } from '@tencent-connect/qqbot-nodejs';
import type { HistoryStore } from '@tencent-connect/qqbot-nodejs';

let _store: HistoryStore | null = null;

/** 获取共享历史存储（单例） */
export function getHistoryStore(): HistoryStore {
  if (!_store) _store = new MemoryHistoryStore();
  return _store;
}

/** 用 appId 前缀隔离群历史（单账号下等价于 groupOpenid，保留多账号扩展） */
export function historyGroupKey(appId: string, groupId: string): string {
  return `${appId}:${groupId}`;
}

/**
 * 把机器人自己的发言写进群历史。
 *
 * 为什么需要：`clearGroupHistory` 在每轮回复后清空缓冲，而机器人自己的话
 * 从来没有被记录过。于是「用户引用小羽说过的话」这个场景里，
 * 按内容反查永远查不到 → 只能标成「某人」→ 模型会把自己的话当成别人说的。
 *
 * @param groupId 群 openid
 * @param text    机器人发出的正文
 */
export function appendBotHistory(appId: string, groupId: string, text: string, senderId: string): void {
  const body = String(text ?? '').trim();
  if (!body) return;
  _store?.append?.(historyGroupKey(appId, groupId), {
    senderId,
    senderName: '小羽',
    content: body.slice(0, 200),
    timestamp: Date.now(),
    messageId: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }, 50);
}

/** 清空群历史（回复后调用，避免下次 @ 时重复组包） */
export function clearGroupHistory(appId: string, groupId: string): void {
  _store?.clear?.(historyGroupKey(appId, groupId));
}
