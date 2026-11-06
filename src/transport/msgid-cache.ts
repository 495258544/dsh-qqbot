/**
 * 被动回复目标缓存 — 记录最近处理的 msgId / eventId，供「无上下文的出站发送」
 * 获取被动回复目标。
 *
 * 按类型区分：普通消息 msgId（填 msg_id）与互动事件 eventId（填 event_id），
 * 避免用字符串前缀做隐式类型判别。
 */
import type { ChatScope } from '../types.ts';

/** 被动回复目标类型 */
export type ReplyIdKind = 'msg' | 'event';

/** 缓存的被动回复目标 */
export interface CachedReplyId {
  kind: ReplyIdKind;
  /** msg: 消息 id；event: 带 INTERACTION_CREATE 前缀的完整事件 id */
  id: string;
}

interface CachedEntry {
  target: CachedReplyId;
  timestamp: number;
}

const MAX_PER_TARGET = 10;
/**
 * 被动回复窗口（官方文档「消息收发概述 · 频率与时效规则」）。
 *
 *   场景 | 有效期 | 每条消息可回复次数
 *   单聊 | 60 分钟 | 4 次
 *   群聊 |  5 分钟 | 5 次
 *
 * 原来私聊用 30 分钟（比官方短一半），与 reply-limiter 的 60 分钟也不一致。
 * 短了不会超发（提前丢弃 msgId → 提前降级主动推送），但会**白丢 30 分钟的
 * 被动回复机会** —— 30~60 分钟内她本可以正常被动回复，却只能走主动推送
 * （而主动消息用户可以关掉开关）。已按官方改为 60 分钟。
 */
const TTL_GROUP = 5 * 60 * 1000; // 群消息被动回复窗口 5 分钟
const TTL_C2C = 60 * 60 * 1000; // 私聊被动回复窗口 60 分钟（官方值）
const MAX_TARGETS = 200;
const EVENT_PREFIX = 'INTERACTION_CREATE:';

const cache = new Map<string, CachedEntry[]>();

function cacheKey(scope: ChatScope, targetId: string): string {
  return `${scope}:${targetId}`;
}

function push(scope: ChatScope, targetId: string | undefined, target: CachedReplyId): void {
  if (!scope || !targetId || !target.id) return;
  const key = cacheKey(scope, targetId);
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    existing.push({ target, timestamp: Date.now() });
    if (existing.length > MAX_PER_TARGET) existing.shift();
    cache.set(key, existing);
    return;
  }
  cache.set(key, [{ target, timestamp: Date.now() }]);
  if (cache.size > MAX_TARGETS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** 记录普通消息 msgId */
export function cacheMsgId(scope: ChatScope, targetId: string | undefined, msgId: string | undefined): void {
  if (!msgId) return;
  push(scope, targetId, { kind: 'msg', id: msgId });
}

/** 记录互动事件 eventId（内部拼 INTERACTION_CREATE 前缀） */
export function cacheEventId(scope: ChatScope, targetId: string | undefined, eventId: string | undefined): void {
  if (!eventId) return;
  push(scope, targetId, { kind: 'event', id: `${EVENT_PREFIX}${eventId}` });
}

/** 获取所有未过期的被动回复目标（按时间倒序，最新在前） */
export function getCachedReplyIds(scope: ChatScope, targetId: string): CachedReplyId[] {
  const list = cache.get(cacheKey(scope, targetId));
  if (!list || list.length === 0) return [];
  const now = Date.now();
  const ttl = scope === 'group' ? TTL_GROUP : TTL_C2C;
  const result: CachedReplyId[] = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (now - list[i]!.timestamp < ttl) {
      result.push(list[i]!.target);
    }
  }
  return result;
}
