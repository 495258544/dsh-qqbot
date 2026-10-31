/**
 * 归属索引记录中间件 · 回归测试
 * ─────────────────────────────────────────────────────────────
 * 核心回归点（真实事故 2026-10-31）：
 * 记录动作原本放在 handleInbound 里，而群里"没 @她"的消息在半路的
 * personaWakeGate 就被 ctx.stop() 拦掉，永远走不到那里。
 *
 * 症状：引用小羽的话能认出「你自己之前说的」，引用 jmx 的话一律「某人」。
 * 用户原话：「转发里我的名字能带出来，别人就一律变成了"某人"」。
 */
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { rmSync } from 'node:fs';

const TMP = '/tmp/attr-recorder-test.json';
vi.stubEnv('QQBOT_ATTRIBUTION_PATH', TMP);

import { attributionRecorder } from './attribution-recorder.ts';
import {
  lookupAttribution,
  attributionSize,
  resetAttributionForTest,
} from '../features/attribution-index.ts';

const APP = '1906131500';
const GID = '20011D3CAC54F6CA5C780CEFD2E5AF01';

beforeEach(() => {
  try { rmSync(TMP, { force: true }); } catch { /* ignore */ }
  resetAttributionForTest();
});
afterEach(() => {
  try { rmSync(TMP, { force: true }); } catch { /* ignore */ }
});

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    message: {
      kind: 'group',
      groupOpenid: GID,
      senderId: 'CFD96F1AEAFD07BDA2A9FADEE339D723',
      senderName: 'jmx的大蠢鱼',
      content: '卡了就别催了 我这边也动不了',
      ...over,
    },
  } as never;
}

describe('attributionRecorder · 门禁之前的记录', () => {
  it('没被 @ 的群消息也会被记录（关键回归点）', async () => {
    const mw = attributionRecorder({ appId: APP });
    const next = vi.fn().mockResolvedValue(undefined);
    await mw(makeCtx(), next);

    expect(next).toHaveBeenCalled();                       // 不拦截，继续往下走
    expect(attributionSize(APP, GID)).toBe(1);
    const hit = lookupAttribution(APP, GID, '卡了就别催了 我这边也动不了');
    expect(hit?.senderName).toBe('jmx的大蠢鱼');
  });

  it('记录后本条消息仍能正常被反查（下一个引用它的人）', async () => {
    const mw = attributionRecorder({ appId: APP });
    await mw(makeCtx(), vi.fn());
    // 模拟后来有人引用这句话
    const hit = lookupAttribution(APP, GID, '卡了就别催了 我这边也动不了');
    expect(hit?.senderId).toBe('CFD96F1AEAFD07BDA2A9FADEE339D723');
  });

  it('私聊不记录（归属问题只存在于群合并转发）', async () => {
    const mw = attributionRecorder({ appId: APP });
    await mw(makeCtx({ kind: 'c2c', groupOpenid: undefined }), vi.fn());
    expect(attributionSize(APP, GID)).toBe(0);
  });

  it('空正文（纯图片/表情）不记录，但消息照常放行', async () => {
    const mw = attributionRecorder({ appId: APP });
    const next = vi.fn();
    await mw(makeCtx({ content: '   ' }), next);
    expect(next).toHaveBeenCalled();
    expect(attributionSize(APP, GID)).toBe(0);
  });

  it('缺 senderId 时跳过记录但不崩', async () => {
    const mw = attributionRecorder({ appId: APP });
    const next = vi.fn();
    await mw(makeCtx({ senderId: undefined }), next);
    expect(next).toHaveBeenCalled();
    expect(attributionSize(APP, GID)).toBe(0);
  });

  it('多条不同人的消息各自记入，反查分别命中', async () => {
    const mw = attributionRecorder({ appId: APP });
    await mw(makeCtx({ senderName: 'jmx的大蠢鱼', content: '第一句话内容' }), vi.fn());
    await mw(makeCtx({ senderId: 'OTHER', senderName: '另一个人', content: '第二句话内容' }), vi.fn());
    expect(attributionSize(APP, GID)).toBe(2);
    expect(lookupAttribution(APP, GID, '第一句话内容')?.senderName).toBe('jmx的大蠢鱼');
    expect(lookupAttribution(APP, GID, '第二句话内容')?.senderName).toBe('另一个人');
  });
});
