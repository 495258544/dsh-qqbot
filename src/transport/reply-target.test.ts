import { describe, it, expect, vi } from 'vitest';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import { ReplyLimiter } from './reply-limiter.ts';
import { cacheMsgId, cacheEventId } from './msgid-cache.ts';
import { resolveReplyTarget, sendResolvedMarkdown } from './reply-target.ts';
import type { ReplyTarget } from '../types.ts';

function makeTarget(msgId?: string, targetId = 'peer-1', scope: 'c2c' | 'group' = 'c2c'): ReplyTarget {
  return { scope, targetId, msgId };
}

describe('resolveReplyTarget', () => {
  it('prefers explicit target.msgId (cached & within window)', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheMsgId('c2c', 'peer-1', 'm1');
    const result = resolveReplyTarget(makeTarget('m1'), limiter, true);
    expect(result.msgId).toBe('m1');
    expect(result.eventId).toBeUndefined();
  });

  it('falls back to cached msgId after target.msgId is exhausted', () => {
    const limiter = new ReplyLimiter({ limit: 1 });
    cacheMsgId('c2c', 'peer-2', 'cached-1');
    limiter.record('m-exhausted');
    const result = resolveReplyTarget(makeTarget('m-exhausted', 'peer-2'), limiter, true);
    expect(result.msgId).toBe('cached-1');
  });

  it('drops explicit msgId beyond the platform window: falls back to a fresher cached candidate', () => {
    vi.useFakeTimers();
    try {
      const limiter = new ReplyLimiter({ limit: 4 });
      cacheMsgId('c2c', 'peer-10', 'stale-id');
      // 官方「消息收发概述」：单聊被动回复有效期 **60 分钟**（群聊 5 分钟）。
      // 原来这里按 31 分钟断言（那时 TTL 写的是 30 分钟，比官方短一半）。
      vi.setSystemTime(Date.now() + 61 * 60 * 1000); // 超出 c2c 60min 窗口
      cacheMsgId('c2c', 'peer-10', 'fresh-id'); // 窗口过期后用户又发了一条
      const result = resolveReplyTarget(makeTarget('stale-id', 'peer-10'), limiter, true);
      expect(result.msgId).toBe('fresh-id');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops explicit msgId beyond the platform window: no candidates → proactive', () => {
    vi.useFakeTimers();
    try {
      const limiter = new ReplyLimiter({ limit: 4 });
      cacheMsgId('c2c', 'peer-11', 'stale-id');
      vi.setSystemTime(Date.now() + 61 * 60 * 1000); // 超出 c2c 60min 窗口
      const result = resolveReplyTarget(makeTarget('stale-id', 'peer-11'), limiter, true);
      expect(result.msgId).toBeUndefined();
      expect(result.eventId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips event candidates when allowEvent is false', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheEventId('c2c', 'peer-3', 'evt-1');
    const result = resolveReplyTarget(makeTarget(undefined, 'peer-3'), limiter, false);
    expect(result.eventId).toBeUndefined();
    expect(result.msgId).toBeUndefined();
  });

  it('returns eventId when allowEvent is true', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheEventId('c2c', 'peer-4', 'evt-2');
    const result = resolveReplyTarget(makeTarget(undefined, 'peer-4'), limiter, true);
    expect(result.eventId).toBe('INTERACTION_CREATE:evt-2');
    expect(result.msgId).toBeUndefined();
  });
});

describe('sendResolvedMarkdown', () => {
  it('fills event_id via bot.send when target has eventId', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'c2c', targetId: 'p', eventId: 'INTERACTION_CREATE:evt' };
    await sendResolvedMarkdown(bot, target, 'hello');
    expect(bot.send).toHaveBeenCalledWith(expect.objectContaining({
      extra: { event_id: 'INTERACTION_CREATE:evt' },
    }));
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('uses sendMarkdown for msgId targets', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'c2c', targetId: 'p', msgId: 'm1' };
    await sendResolvedMarkdown(bot, target, 'hello');
    expect(bot.sendMarkdown).toHaveBeenCalledWith(target, 'hello', undefined);
    expect(bot.send).not.toHaveBeenCalled();
  });
});

describe('被动回复条数上限按场景区分（官方限制）', () => {
  it('单聊 4 次后降级主动推送（官方：单聊每条消息可回复 4 次）', () => {
    const limiter = new ReplyLimiter({ limit: 4, groupLimit: 5 });
    cacheMsgId('c2c', 'peer-c2c', 'm1');
    const target = makeTarget('m1', 'peer-c2c');
    for (let i = 1; i <= 4; i++) {
      expect(resolveReplyTarget(target, limiter, true).msgId).toBe('m1');
    }
    // 第 5 次超限 → 降级主动推送（不截断，由三级兜底转主动消息发出）
    expect(resolveReplyTarget(target, limiter, true).msgId).toBeUndefined();
  });

  it('群聊 5 次后降级主动推送（官方：群聊每条消息可回复 5 次）', () => {
    const limiter = new ReplyLimiter({ limit: 4, groupLimit: 5 });
    cacheMsgId('group', 'peer-grp', 'm1');
    const target = makeTarget('m1', 'peer-grp', 'group');
    for (let i = 1; i <= 5; i++) {
      expect(resolveReplyTarget(target, limiter, true).msgId).toBe('m1');
    }
    expect(resolveReplyTarget(target, limiter, true).msgId).toBeUndefined();
  });

  it('limitFor 暴露该场景的上限', () => {
    const limiter = new ReplyLimiter({ limit: 4, groupLimit: 5 });
    expect(limiter.limitFor('c2c')).toBe(4);
    expect(limiter.limitFor('group')).toBe(5);
  });
});
