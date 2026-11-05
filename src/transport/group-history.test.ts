/**
 * 群历史注入 · 时间窗 + 剔除她自己（A+B）
 * ─────────────────────────────────────────────────────────────
 * 2026-11-05 的实测问题：@ 她一句，她把 10 条别人的闲聊全带上再回答。
 *
 * 根因不是"历史不该有"，而是两处叠加：
 *   1. `historyBuffer` 只在**回复之后**清空（inbound 末尾）。她没被唤醒的那些
 *      消息只进缓冲、不清空 → 半小时后 @ 她，缓冲里还挂着半小时前的对话。
 *   2. `appendBotHistory` 把**她的回复**也写进群历史（为了引用场景能认出自己），
 *      但这些条目下一轮会被当成"别人说的话"再喂回去。
 *
 * 修法：注入前先筛——只留窗口内（默认 10 分钟），且剔掉她自己。
 * 引用她的话不受影响：那条走 quote/归属索引，不经过这里。
 */
import { describe, it, expect } from 'vitest';
import { buildAgentBody, selectHistoryForPrompt, GROUP_HISTORY_WINDOW_MS } from './inbound.ts';
import type { HistoryEntry } from './inbound.ts';

const BOT = 'B1FE2927B46C9AF15C464E62216395FF';
const OWNER_GROUP = 'CFD96F1AEAFD07BDA2A9FADEE339D723';
const OTHER = 'DAE485A31F332848D7D9C17CC0999941';

function entry(senderId: string, content: string, at: number, name?: string): HistoryEntry {
  return {
    senderId,
    senderName: name ?? (senderId === BOT ? '小羽' : '某人'),
    content,
    timestamp: at,
    messageId: `m-${at}-${Math.random().toString(36).slice(2, 6)}`,
  };
}

const NOW = 1_800_000_000_000; // 固定"现在"，避免测试跟真实时钟跑

describe('selectHistoryForPrompt · 时间窗（A）', () => {
  it('10 分钟内的留下，超出的丢掉', () => {
    const h = [
      entry(OTHER, '九分钟前', NOW - 9 * 60_000),
      entry(OTHER, '十分钟整', NOW - 10 * 60_000),
      entry(OTHER, '十一分钟前', NOW - 11 * 60_000),
      entry(OTHER, '一小时前', NOW - 60 * 60_000),
    ];
    const kept = selectHistoryForPrompt(h, new Set(), NOW);
    expect(kept.map((x) => x.content)).toEqual(['九分钟前', '十分钟整']);
  });

  it('窗口可注入（测试/调参用），不影响默认', () => {
    const h = [entry(OTHER, '二十分钟前', NOW - 20 * 60_000)];
    expect(selectHistoryForPrompt(h, new Set(), NOW, GROUP_HISTORY_WINDOW_MS)).toHaveLength(0);
    expect(selectHistoryForPrompt(h, new Set(), NOW, 30 * 60_000)).toHaveLength(1);
  });

  it('timestamp 缺失/为 0 的条目按"旧"处理（宁可少带，不注入不明时间的）', () => {
    const bad = { ...entry(OTHER, '没有时间', NaN), timestamp: 0 };
    expect(selectHistoryForPrompt([bad], new Set(), NOW)).toHaveLength(0);
  });
});

describe('selectHistoryForPrompt · 剔除她自己（B）', () => {
  it('她的发言不进"群聊上下文"', () => {
    const h = [
      entry(OTHER, '别人的话', NOW - 60_000),
      entry(BOT, '她自己的话', NOW - 30_000, '小羽'),
    ];
    const kept = selectHistoryForPrompt(h, new Set([BOT]), NOW);
    expect(kept.map((x) => x.content)).toEqual(['别人的话']);
  });

  it('主人自己的发言也可一并剔除（selfIds 支持多个 id）', () => {
    const h = [
      entry(OWNER_GROUP, '主人说的', NOW - 60_000),
      entry(OTHER, '别人说的', NOW - 55_000),
    ];
    const kept = selectHistoryForPrompt(h, new Set([BOT, OWNER_GROUP]), NOW);
    expect(kept.map((x) => x.content)).toEqual(['别人说的']);
  });

  it('不传 selfIds 时行为=只按时间窗（向后兼容，不会莫名丢条目）', () => {
    const h = [entry(BOT, '她的', NOW - 1000), entry(OTHER, '别人的', NOW - 2000)];
    expect(selectHistoryForPrompt(h, new Set(), NOW)).toHaveLength(2);
  });
});

describe('buildAgentBody · A+B 接到注入链路', () => {
  it('@ 她时只注入窗口内、非她自己的条目', () => {
    const now = NOW;
    const history = [
      entry(OTHER, '很久以前聊的', now - 40 * 60_000),
      entry(BOT, '她上次回的', now - 5 * 60_000),
      entry(OTHER, '刚才别人说的', now - 2 * 60_000),
    ];
    const body = buildAgentBody('[当前消息] 在吗', history, true, true, undefined, {
      selfIds: new Set([BOT]),
      now,
    });
    expect(body).toContain('刚才别人说的');
    expect(body).not.toContain('很久以前聊的'); // A
    expect(body).not.toContain('她上次回的');   // B
  });

  it('筛完为空 → 不注入空的 history 段（避免给她一个空壳误导）', () => {
    const history = [entry(OTHER, '一小时前', NOW - 60 * 60_000)];
    const body = buildAgentBody('在吗', history, true, true, undefined, { now: NOW });
    expect(body).toBe('在吗');
    expect(body).not.toContain('Chat history');
  });

  it('群未 @ 她 / 私聊 → 完全不带历史（原有行为不变）', () => {
    const history = [entry(OTHER, '刚说的', NOW - 1000)];
    expect(buildAgentBody('x', history, true, false, undefined, { now: NOW })).toBe('x');
    expect(buildAgentBody('x', history, false, true, undefined, { now: NOW })).toBe('x');
  });

  it('真实回归：她自己的话混在历史里时，当前消息仍完整送达', () => {
    // 复刻线上实测那段（[小羽 (...)] 混在别人对话中）
    const history = [
      entry(BOT, '四条都标着"某人"…', NOW - 3 * 60_000),
      entry(OTHER, '那这轮呢', NOW - 2 * 60_000),
    ];
    const body = buildAgentBody('[当前] 你觉得我开小号打得怎么样', history, true, true, undefined, {
      selfIds: new Set([BOT]),
      now: NOW,
    });
    expect(body).toContain('[Current message]');
    expect(body).toContain('你觉得我开小号打得怎么样'); // 当前消息不受影响
    expect(body).toContain('那这轮呢');                 // 别人的近期话保留
    expect(body).not.toContain('四条都标着');           // 她自己的话剔除
  });
});
