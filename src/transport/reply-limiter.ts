/**
 * 被动回复限额管理。
 *
 * ## 官方限制（文档：「消息收发概述 · 频率与时效规则」）
 *
 *   场景 | 有效期 | 每条消息可回复次数
 *   单聊 | 60 分钟 | 4 次
 *   群聊 |  5 分钟 | 5 次
 *
 * 原来 limit 写死 4（且 checkLimit 不带场景），**群聊也被按 4 次算** ——
 * 比官方少 1 次，白丢一次被动回复机会（超出的那条会提前降级主动推送）。
 * 现在按 scope 分别取上限。
 *
 * ## 超限了怎么办
 *
 * 不截断、不丢弃：reply-target 的三级兜底会把它**降级成主动消息**发出
 * （主动消息有独立配额：单聊 30/qpm、每日 1000 条/用户）。
 * 只有主动消息也失败时（比如用户关了「允许主动发送」开关），内容才真的丢，
 * 那时只写日志。
 */

import type { ChatScope } from '../types.ts';

export interface ReplyLimiterConfig {
  /** 单聊每条消息最大被动回复次数（官方 4） */
  limit?: number;
  /** 群聊每条消息最大被动回复次数（官方 5） */
  groupLimit?: number;
  /** 消息 ID 过期时间 ms（默认 1 小时，与官方单聊有效期一致） */
  ttlMs?: number;
  /** 最大跟踪消息数（LRU 驱逐，默认 10000） */
  maxTrackedMessages?: number;
}

export interface ReplyLimitResult {
  allowed: boolean;
  remaining: number;
  fallbackReason?: 'expired' | 'limit_exceeded';
}

interface TrackedMessage {
  count: number;
  firstSeenAt: number;
}

export class ReplyLimiter {
  private readonly limit: number;
  private readonly groupLimit: number;
  private readonly ttlMs: number;
  private readonly maxTracked: number;
  private readonly messages = new Map<string, TrackedMessage>();

  public constructor(config?: ReplyLimiterConfig) {
    this.limit = config?.limit ?? 4;
    this.groupLimit = config?.groupLimit ?? 5;
    this.ttlMs = config?.ttlMs ?? 3600_000;
    this.maxTracked = config?.maxTrackedMessages ?? 10_000;
  }

  /** 该场景的被动回复条数上限（官方：单聊 4 / 群聊 5） */
  public limitFor(scope: ChatScope): number {
    return scope === 'group' ? this.groupLimit : this.limit;
  }

  /** 检查是否允许对指定消息继续被动回复 */
  public checkLimit(messageId: string, scope: ChatScope = 'c2c'): ReplyLimitResult {
    const now = Date.now();
    const tracked = this.messages.get(messageId);
    const cap = this.limitFor(scope);

    if (!tracked) {
      return { allowed: true, remaining: cap };
    }

    if (now - tracked.firstSeenAt > this.ttlMs) {
      this.messages.delete(messageId);
      return { allowed: false, remaining: 0, fallbackReason: 'expired' };
    }

    const remaining = Math.max(0, cap - tracked.count);
    if (remaining <= 0) {
      return { allowed: false, remaining: 0, fallbackReason: 'limit_exceeded' };
    }

    return { allowed: true, remaining };
  }

  /** 记录一次被动回复 */
  public record(messageId: string): void {
    const now = Date.now();
    const tracked = this.messages.get(messageId);

    if (tracked) {
      tracked.count += 1;
      return;
    }

    if (this.messages.size >= this.maxTracked) {
      const firstKey = this.messages.keys().next().value;
      if (firstKey !== undefined) this.messages.delete(firstKey);
    }
    this.messages.set(messageId, { count: 1, firstSeenAt: now });
  }
}
