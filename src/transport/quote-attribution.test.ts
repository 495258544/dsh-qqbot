/**
 * 引用块归属 · 回归测试
 * ─────────────────────────────────────────────────────────────
 * 真实事故（2026-10-31，用户截图）：
 *   群里 jmx 说「卡了就别催了 我这边也动不了」，群主引用它 + @小羽。
 *   小羽回：「刚不是你那边卡了，我这边也遇到了限流…」
 *   ——她把 **jmx 说的话算到了群主头上**。
 *
 * 根因：buildQuotePart 只拼引文正文，不拼"这是谁说的"。
 * 模型看到的是两条无署名引文 + 一个 (@you)，自然全归给"你"。
 *
 * 这里锁住：引文必须带发送者；运维提示必须被识别成"系统代发"而非对话。
 */
import { describe, expect, it } from 'vitest';
import { buildQuotePart } from './inbound.ts';

describe('buildQuotePart · 发送者归属', () => {
  it('有 senderName 时明确写出是谁说的，并说明"不是你正在对话的人"', () => {
    const out = buildQuotePart({
      text: '卡了就别催了 我这边也动不了',
      entry: { senderId: 'CFD96F1AEAFD07BDA2A9', senderName: 'jmx的大蠢鱼', content: '' },
    });
    expect(out).toContain('[Quoted message begins]');
    expect(out).toContain('jmx的大蠢鱼');
    expect(out).toContain('不是你正在对话的那个人');
    expect(out).toContain('卡了就别催了');
    expect(out).toContain('[Current message]');
  });

  it('没有 senderName 时用短 id 兜底，仍不丢归属', () => {
    const out = buildQuotePart({
      text: '随便一句',
      entry: { senderId: 'CFD96F1AEAFD07BDA2A9FADEE339D723' },
    });
    expect(out).not.toContain('引文发送者未知');
    expect(out).toMatch(/来自「/);
  });

  it('完全查不到发送者时如实说"未知"，不冒充用户', () => {
    const out = buildQuotePart({ text: '某句话' });
    expect(out).toContain('引文发送者未知');
  });
});

describe('buildQuotePart · 运维提示不算对话', () => {
  it('RATE_LIMIT 这类系统代发的提示被标成"系统提示，不是在聊天"', () => {
    const out = buildQuotePart({
      text: '⚠️ 本轮异常结束\n`RATE_LIMIT`: raccoon: 您的模型请求频率超限，请稍后重试',
      entry: { senderId: 'BOT', senderName: '小羽' },
    });
    expect(out).toContain('系统代你发出的运行状态提示');
    expect(out).toContain('不是别人在跟你聊天');
  });

  it('合并转发里的错误行被剥掉（不让它成为可复述的聊天素材）', () => {
    const out = buildQuotePart({
      text: '=== 消息 1 ===\n[消息内容] ⚠️ 本轮异常结束\n`RATE_LIMIT`: raccoon: 限流\n\n=== 消息 2 ===\n[消息内容] 卡了就别催了 我这边也动不了',
      entry: { senderId: 'X', senderName: 'jmx' },
    });
    expect(out).not.toContain('raccoon');
    expect(out).not.toContain('RATE_LIMIT');
    // 正常对话内容仍然保留，并带上归属
    expect(out).toContain('卡了就别催了');
  });

  it('合并转发逐条标注归属', () => {
    const out = buildQuotePart({
      text: '=== 消息 1 ===\n[消息内容] 第一条\n\n=== 消息 2 ===\n[消息内容] 第二条',
      entry: { senderId: 'X', senderName: 'jmx' },
    });
    expect(out).toContain('=== 消息 1 ===');
    expect(out).toContain('=== 消息 2 ===');
    // 每条正文前都有"（某人）"
    const bodies = out.match(/\[消息内容\] （[^）]+）/g) ?? [];
    expect(bodies.length).toBeGreaterThanOrEqual(2);
  });
});

describe('buildQuotePart · 边界', () => {
  it('没有引文时返回空串（不产生半截块）', () => {
    expect(buildQuotePart(undefined)).toBe('');
    expect(buildQuotePart({})).toBe('');
  });

  it('普通单条引文不会被合并转发的处理逻辑误伤', () => {
    const out = buildQuotePart({
      text: '今天吃啥',
      entry: { senderId: 'Y', senderName: '阿三' },
    });
    expect(out).not.toContain('=== 消息');
    expect(out).toContain('今天吃啥');
    expect(out).toContain('阿三');
  });
});
