/**
 * 归属索引 · 回归测试
 * ─────────────────────────────────────────────────────────────
 * 为什么需要它：QQ 合并转发（msgType=103）的 msg_elements 只有一个 content
 * 字符串，**不含发送者**（SDK 类型 `RawMsgElement{msg_idx?,content?,attachments?}`）。
 * 曾经用群历史缓冲反查，但 clearGroupHistory 每轮回复后清空 → 永远命中不了。
 *
 * 真实事故（2026-10-31 用户截图）：群主引用「刚不是你那边卡了…」
 * （这条其实是小羽自己说的），她认不出来，因为归属只剩「某人」。
 */
import { existsSync, rmSync } from 'node:fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  lookupByImageMd5,
  rememberForAttribution,
  lookupAttribution,
  clearAttribution,
  attributionSize,
  resetAttributionForTest,
} from './attribution-index.ts';

const APP = '1906131500';
const GID = '20011D3CAC54F6CA5C780CEFD2E5AF01';
const JMX = { senderId: 'CFD96F1AEAFD07BDA2A9FADEE339D723', senderName: 'jmx的大蠢鱼' };
const BOT = { senderId: 'B1FE2927B46C9AF15C464E62216395FF', senderName: '小羽' };

// 测试用独立文件，绝不碰真实的 ~/.dsh-qqbot/persona/attribution-index.json
// 用 vi.stubEnv 在模块求值前钉住，否则 import 已经解析完路径
const TMP = '/tmp/attr-test-index.json';
vi.stubEnv('QQBOT_ATTRIBUTION_PATH', TMP);

beforeEach(() => {
  try { rmSync(TMP, { force: true }); } catch { /* ignore */ }
  resetAttributionForTest();
});
afterEach(() => {
  try { rmSync(TMP, { force: true }); } catch { /* ignore */ }
});

describe('lookupAttribution · 内容反查', () => {
  it('完整内容能反查到发送者（真实事故里的那句）', () => {
    rememberForAttribution(APP, GID, { ...JMX, content: '卡了就别催了 我这边也动不了' });
    const hit = lookupAttribution(APP, GID, '卡了就别催了 我这边也动不了');
    expect(hit?.senderId).toBe(JMX.senderId);
    expect(hit?.senderName).toBe('jmx的大蠢鱼');
  });

  it('预览被省略号截断时仍能命中（QQ 引用预览会截断）', () => {
    const full = '刚不是你那边卡了，我这边也遇到了限流，回复没发出去。饭应该还没凉，你先吃。';
    rememberForAttribution(APP, GID, { ...BOT, content: full });
    // 模拟 QQ 预览：保留前大半段 + 省略号
    const preview = full.slice(0, 26) + '…';
    const hit = lookupAttribution(APP, GID, preview);
    expect(hit?.senderName).toBe('小羽');
    // 关键：要认出这是"她自己"而不是别人
    expect(hit?.senderId).toBe(BOT.senderId);
  });

  it('引文里夹着合并转发头时也能匹配', () => {
    rememberForAttribution(APP, GID, { ...JMX, content: '这活我接' });
    const hit = lookupAttribution(APP, GID, '=== 消息 2 ===\n[消息内容] 这活我接');
    expect(hit?.senderName).toBe('jmx的大蠢鱼');
  });

  it('多人都说过同一句话时取最近的那条', () => {
    const same = '这句是我先说的';   // 长度够，避免被"太短"规则挡掉
    rememberForAttribution(APP, GID, { ...JMX, content: same });
    rememberForAttribution(APP, GID, { ...BOT, content: same });
    // 最后说的是小羽 → 命中她
    expect(lookupAttribution(APP, GID, same)?.senderId).toBe(BOT.senderId);
  });

  it('索引里没有的话 → 返回 undefined（不瞎猜）', () => {
    rememberForAttribution(APP, GID, { ...JMX, content: '别的话' });
    expect(lookupAttribution(APP, GID, '一句完全没说过的话')).toBeUndefined();
  });

  it('太短的引文不做匹配（防"好""嗯"这类误配）', () => {
    rememberForAttribution(APP, GID, { ...JMX, content: '嗯' });
    expect(lookupAttribution(APP, GID, '嗯')).toBeUndefined();
  });
});

describe('归属索引 · 与群历史解耦', () => {
  it('清空归属索引不影响历史缓冲，反之亦然（两个存储独立）', () => {
    rememberForAttribution(APP, GID, { ...JMX, content: '一句话' });
    expect(attributionSize(APP, GID)).toBe(1);
    clearAttribution(APP, GID);
    expect(attributionSize(APP, GID)).toBe(0);
    expect(lookupAttribution(APP, GID, '一句话')).toBeUndefined();
  });

  it('群与群之间互不干扰', () => {
    rememberForAttribution(APP, 'g1', { ...JMX, content: '群一句话' });
    expect(lookupAttribution(APP, 'g2', '群一句话')).toBeUndefined();
    expect(lookupAttribution(APP, 'g1', '群一句话')?.senderId).toBe(JMX.senderId);
  });

  it('环形上限：超过 100 条后淘汰最旧的，保留最近的', () => {
    for (let i = 0; i < 120; i++) {
      rememberForAttribution(APP, GID, { ...JMX, content: `第${i}条消息内容` });
    }
    expect(attributionSize(APP, GID)).toBe(100);
    // 最近的一定在
    expect(lookupAttribution(APP, GID, '第119条消息内容')).toBeTruthy();
    // 最旧的已被淘汰
    expect(lookupAttribution(APP, GID, '第0条消息内容')).toBeUndefined();
  });
});

describe('归属索引 · 落盘持久化（重启后仍能反查）', () => {
  it('写入后落盘，重新载入仍能反查到', async () => {
    rememberForAttribution(APP, GID, { ...BOT, content: '看不到。转发里每条都只标着某人' });
    // 模拟重启：清内存 → 重新 import 会重新读盘
    const file = process.env.QQBOT_ATTRIBUTION_PATH!;
    expect(existsSync(file)).toBe(true);

    // 手动清内存（等价于进程重启）
    resetAttributionForTest();
    await vi.resetModules();
    const fresh = await import('./attribution-index.ts');
    fresh.reloadForTest();          // 允许重新读盘
    const hit = fresh.lookupAttribution(APP, GID, '看不到。转发里每条都只标着某人');
    expect(hit?.senderId).toBe(BOT.senderId);
  });
});

describe('归属索引 · 图片 MD5 反查（不需要下载图片）', () => {
  const MD5 = 'e0af774221d4bf42638e274b60f0c62e';

  it('记下图片 MD5 后能反查到发送者（QQ 文件名即内容 MD5）', () => {
    rememberForAttribution(APP, GID, { ...JMX, content: '[图片]', imageMd5: [MD5] });
    const hit = lookupByImageMd5(APP, GID, [MD5]);
    expect(hit?.senderName).toBe('jmx的大蠢鱼');
  });

  it('大小写不敏感（QQ 给的是大写）', () => {
    rememberForAttribution(APP, GID, { ...JMX, content: '[图片]', imageMd5: [MD5] });
    expect(lookupByImageMd5(APP, GID, [MD5.toUpperCase()])?.senderName).toBe('jmx的大蠢鱼');
  });

  it('多张图的任意一张命中即可', () => {
    rememberForAttribution(APP, GID, {
      ...JMX, content: '[图片]', imageMd5: ['aaa', 'bbb', 'ccc'],
    });
    expect(lookupByImageMd5(APP, GID, ['zzz', 'BBB'])?.senderName).toBe('jmx的大蠢鱼');
  });

  it('没记过的图 → undefined（不瞎猜）', () => {
    rememberForAttribution(APP, GID, { ...JMX, content: '[图片]', imageMd5: ['aaa'] });
    expect(lookupByImageMd5(APP, GID, ['never-seen'])).toBeUndefined();
  });

  it('空 MD5 列表 → undefined', () => {
    rememberForAttribution(APP, GID, { ...JMX, content: '[图片]', imageMd5: [MD5] });
    expect(lookupByImageMd5(APP, GID, [])).toBeUndefined();
  });
});
