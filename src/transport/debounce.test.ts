/**
 * 群聊「同一发送者连发聚合窗口」· 回归测试
 * ─────────────────────────────────────────────────────────────
 * 要防的事故（2026-10-31 凌晨真实发生）：同一个人在群里连发 30+ 条
 * （间隔 2-14 秒），她一条条追着回，撞上官方「群聊每条消息只能被动回复 5 次、
 * 有效期 5 分钟」的限制，超出部分被迫降级成主动推送，把主动配额也烧了。
 *
 * 这里验证的是聚合窗口的可观察行为：
 *   · 同人连发 → 只处理一次，正文按顺序拼接不丢内容
 *   · 不同人 → 各自的批次，绝不混合
 *   · 私聊 → 完全不受影响（逐条立即处理）
 *   · 攒满 maxBatch / 等满 maxWait → 提前开口（不能永远沉默）
 *   · groupDebounceMs: 0 → 关闭聚合
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';

/**
 * 隔离掉调试落盘：inbound 会把每条消息追加到 ~/.dsh-qqbot/debug-inbound.jsonl，
 * 测试不该往用户的真实诊断文件里灌噪音。只替换 appendFileSync，其余 fs 原样保留。
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, appendFileSync: vi.fn() };
});

const { handleInbound, resetGroupDebounceForTest } = await import('./inbound.ts');
const { ConfigSchema } = await import('../config.ts');

const GROUP_ID = '20011D3CAC54F6CA5C780CEFD2E5AF01';
const SENDER_A = 'CFD96F1AEAFD07BDA2A9FADEE339D723';
const SENDER_B = '7A1B2C3D4E5F60718293A4B5C6D7E8F9';

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

/** 按需覆盖 persona 里的聚合参数 */
function makeConfig(over: Partial<ImQQBotConfig['persona']> = {}): ImQQBotConfig {
  const base = ConfigSchema({ appId: '1906131500', appSecret: 'secret' } as ImQQBotConfig);
  return { ...base, persona: { ...base.persona, ...over } } as ImQQBotConfig;
}

interface RecordedTurn {
  /** agent 实际看到的正文（群聊是 `[昵称 (openid)] 内容` 形态，含媒体路径行） */
  body: string;
}

/**
 * 假 SessionManager：只实现 processInbound 用到的那两个方法。
 * 每成功 followup 一次 = 一次 agent turn = 一次真正烧被动回复额度的处理。
 *
 * 附件是否幸存不从这里单独统计——Attachment 会体现在 agent 看到的正文里
 * （`[图片]` 标签 + `Image: /tmp/a.png` 路径行），直接断正文比断计数器更有说服力。
 */
function makeManager(): { manager: SessionManager; turns: RecordedTurn[]; msgIds: string[] } {
  const turns: RecordedTurn[] = [];
  const msgIds: string[] = [];

  const manager = {
    persona: undefined,
    async getOrCreate(
      _scope: string,
      _peerId: string,
      _senderId: string,
      replyTarget: { msgId?: string },
    ) {
      msgIds.push(String(replyTarget.msgId));
      return {
        sessionId: `sess-${msgIds.length}`,
        agent: {
          followup: (message: unknown): void => {
            const m = message as { content: Array<{ text?: string }> };
            turns.push({ body: m.content.map((b) => b.text ?? '').join('') });
          },
          whenIdle: async (): Promise<void> => {},
        },
      };
    },
  } as unknown as SessionManager;

  return { manager, turns, msgIds };
}

/** 造一条入站消息（默认为群里 @ 她的消息，即"会被唤醒、会烧额度"的那类） */
function makeCtx(opts: {
  kind?: 'group' | 'c2c';
  senderId?: string;
  senderName?: string;
  content: string;
  messageId: string;
  groupOpenid?: string;
  wasMentioned?: boolean;
  attachments?: Array<Record<string, unknown>>;
  downloadedFiles?: Array<{ filename: string; localPath: string }>;
  collectOnly?: boolean;
}): MiddlewareContext {
  const kind = opts.kind ?? 'group';
  const state: Record<string, unknown> = {
    mention: { wasMentioned: opts.wasMentioned ?? true },
  };
  if (opts.attachments) state.downloadedFiles = opts.downloadedFiles ?? [];
  if (opts.collectOnly) state.collectOnly = true;

  return {
    bot: { sendMarkdown: vi.fn() },
    message: {
      kind,
      senderId: opts.senderId ?? SENDER_A,
      senderName: opts.senderName ?? '小明',
      content: opts.content,
      messageId: opts.messageId,
      timestamp: new Date().toISOString(),
      groupOpenid: kind === 'group' ? (opts.groupOpenid ?? GROUP_ID) : undefined,
      attachments: opts.attachments,
    },
    state,
    replyTarget: { scope: kind, targetId: kind === 'group' ? (opts.groupOpenid ?? GROUP_ID) : (opts.senderId ?? SENDER_A), msgId: opts.messageId },
    log: createLogger(),
    stop: vi.fn(),
    stopped: false,
    stopReason: undefined,
    signal: new AbortController().signal,
    abort: vi.fn(),
    aborted: false,
    receivedAt: Date.now(),
  } as unknown as MiddlewareContext;
}

/** 让挂在 promise 链上的 flush → processInbound 全部跑完 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // 聚合缓冲与串行链是模块级的：不清会把上一个用例的批次带到下一个
  resetGroupDebounceForTest();
});

afterEach(() => {
  vi.clearAllTimers();
  resetGroupDebounceForTest();
  vi.useRealTimers();
});

describe('群聊同人连发聚合 · 只处理一次且内容按序拼接', () => {
  it('同一人连发 3 条 → 只 followup 一次，正文按顺序拼接', async () => {
    const { manager, turns } = makeManager();
    const config = makeConfig({ groupDebounceMs: 500, groupDebounceMaxWaitMs: 2000, groupDebounceMaxBatch: 3 });

    await handleInbound(makeCtx({ content: '我先说一句', messageId: 'm1' }), manager, config, createLogger());
    await settle();
    await handleInbound(makeCtx({ content: '再补一句', messageId: 'm2' }), manager, config, createLogger());
    await settle();
    await handleInbound(makeCtx({ content: '还有', messageId: 'm3' }), manager, config, createLogger());
    await settle();

    // 攒满 3 条（= maxBatch）立刻处理，不用再等窗口
    expect(turns.length).toBe(1);
    expect(turns[0]!.body).toBe(`[小明 (${SENDER_A})] 我先说一句\n再补一句\n还有 (@you)`);
  });

  it('间隔小于窗口的连发也只处理一次（滑动窗口真的在重置计时）', async () => {
    const { manager, turns } = makeManager();
    // 窗口 500 / maxWait 3000 / maxBatch 10 → 只能靠"静止 500ms"收敛
    const config = makeConfig({ groupDebounceMs: 500, groupDebounceMaxWaitMs: 3000, groupDebounceMaxBatch: 10 });

    await handleInbound(makeCtx({ content: '一句', messageId: 'm1' }), manager, config, createLogger());
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    await handleInbound(makeCtx({ content: '两句', messageId: 'm2' }), manager, config, createLogger());
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    await handleInbound(makeCtx({ content: '三句', messageId: 'm3' }), manager, config, createLogger());
    await settle();

    // 距最后一条才 400ms，还没到 500ms 的静止窗口 → 仍然不能开口
    await vi.advanceTimersByTimeAsync(400);
    expect(turns.length).toBe(0);

    // 再等 100ms 满 500ms 静止 → 一次性处理这 3 条
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(turns.length).toBe(1);
    expect(turns[0]!.body).toContain('一句\n两句\n三句');
  });

  it('用最后一条的 msgId 作被动回复目标（5 分钟有效期取最宽的）', async () => {
    const { manager, msgIds, turns } = makeManager();
    const config = makeConfig({ groupDebounceMs: 100, groupDebounceMaxWaitMs: 2000, groupDebounceMaxBatch: 5 });

    await handleInbound(makeCtx({ content: 'a', messageId: 'msg-early' }), manager, config, createLogger());
    await settle();
    await handleInbound(makeCtx({ content: 'b', messageId: 'msg-late' }), manager, config, createLogger());
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    await settle();

    expect(turns.length).toBe(1);
    expect(msgIds).toEqual(['msg-late']);
  });
});

describe('群聊同人连发聚合 · 不同人绝不混合', () => {
  it('两个人在同一个群各自连发 → 各自一批，内容不串', async () => {
    const { manager, turns } = makeManager();
    const config = makeConfig({ groupDebounceMs: 300, groupDebounceMaxWaitMs: 2000, groupDebounceMaxBatch: 5 });
    const logger = createLogger();

    await handleInbound(makeCtx({ senderId: SENDER_A, senderName: '小明', content: '甲一', messageId: 'a1' }), manager, config, logger);
    await settle();
    await handleInbound(makeCtx({ senderId: SENDER_B, senderName: '小红', content: '乙一', messageId: 'b1' }), manager, config, logger);
    await settle();
    await handleInbound(makeCtx({ senderId: SENDER_A, senderName: '小明', content: '甲二', messageId: 'a2' }), manager, config, logger);
    await settle();
    await handleInbound(makeCtx({ senderId: SENDER_B, senderName: '小红', content: '乙二', messageId: 'b2' }), manager, config, logger);
    await settle();

    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(turns.length).toBe(2);
    const bodies = turns.map((t) => t.body);
    const aBody = bodies.find((b) => b.includes('甲一'));
    const bBody = bodies.find((b) => b.includes('乙一'));
    expect(aBody).toBeDefined();
    expect(bBody).toBeDefined();
    // 关键：A 的批次里不能出现 B 的话，反之亦然
    expect(aBody).toContain('甲一\n甲二');
    expect(aBody).not.toContain('乙一');
    expect(aBody).not.toContain('乙二');
    expect(bBody).toContain('乙一\n乙二');
    expect(bBody).not.toContain('甲一');
    expect(bBody).not.toContain('甲二');
  });

  it('不同群同一个人 → 也各自成批（key 带 peerId）', async () => {
    const { manager, turns } = makeManager();
    const config = makeConfig({ groupDebounceMs: 200, groupDebounceMaxWaitMs: 2000, groupDebounceMaxBatch: 5 });
    const logger = createLogger();

    await handleInbound(makeCtx({ content: '群一的', messageId: 'g1', groupOpenid: 'G1' }), manager, config, logger);
    await settle();
    await handleInbound(makeCtx({ content: '群二的', messageId: 'g2', groupOpenid: 'G2' }), manager, config, logger);
    await settle();
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(turns.length).toBe(2);
    expect(turns.some((t) => t.body.includes('群一的'))).toBe(true);
    expect(turns.some((t) => t.body.includes('群二的'))).toBe(true);
    expect(turns.every((t) => !(t.body.includes('群一的') && t.body.includes('群二的')))).toBe(true);
  });
});

describe('私聊不受影响', () => {
  it('私聊连发 3 条 → 各自立即处理，不聚合', async () => {
    const { manager, turns } = makeManager();
    const config = makeConfig({ groupDebounceMs: 500, groupDebounceMaxWaitMs: 2000, groupDebounceMaxBatch: 3 });
    const logger = createLogger();

    await handleInbound(makeCtx({ kind: 'c2c', content: '一句', messageId: 'c1' }), manager, config, logger);
    await handleInbound(makeCtx({ kind: 'c2c', content: '两句', messageId: 'c2' }), manager, config, logger);
    await handleInbound(makeCtx({ kind: 'c2c', content: '三句', messageId: 'c3' }), manager, config, logger);

    // 一条都不许等
    expect(turns.length).toBe(3);
    expect(turns.map((t) => t.body)).toEqual(['一句', '两句', '三句']);
  });
});

describe('上限保护 · 不能因为有人一直打字就永远不开口', () => {
  it('攒满 maxBatch 就抢先处理，不等窗口走完', async () => {
    const { manager, turns } = makeManager();
    // 窗口 10 秒，但 maxBatch 只有 2 → 第 2 条到达就开口
    const config = makeConfig({ groupDebounceMs: 10_000, groupDebounceMaxWaitMs: 60_000, groupDebounceMaxBatch: 2 });
    const logger = createLogger();

    await handleInbound(makeCtx({ content: '一', messageId: 'x1' }), manager, config, logger);
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    expect(turns.length).toBe(0);

    await handleInbound(makeCtx({ content: '二', messageId: 'x2' }), manager, config, logger);
    await settle();

    expect(turns.length).toBe(1);
    expect(turns[0]!.body).toContain('一\n二');
  });

  it('maxWait 封顶：窗口再长，最多等 maxWait 就开口', async () => {
    const { manager, turns } = makeManager();
    // 窗口 10 秒、无人续发 → 仍然要在 maxWait(1000) 时开口，而不是等满 10 秒
    const config = makeConfig({ groupDebounceMs: 10_000, groupDebounceMaxWaitMs: 1000, groupDebounceMaxBatch: 50 });
    const logger = createLogger();

    await handleInbound(makeCtx({ content: '就一句', messageId: 'y1' }), manager, config, logger);
    await settle();

    await vi.advanceTimersByTimeAsync(999);
    await settle();
    expect(turns.length).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(turns.length).toBe(1);
    expect(turns[0]!.body).toContain('就一句');
  });

  it('一直续发也不会无限推迟：总等待时间不超过 maxWait', async () => {
    const { manager, turns } = makeManager();
    const config = makeConfig({ groupDebounceMs: 500, groupDebounceMaxWaitMs: 1000, groupDebounceMaxBatch: 50 });
    const logger = createLogger();

    // 每 300ms 发一条，滑动窗口每次都重置，但 deadline 被 maxWait 钉在 t0+1000
    await handleInbound(makeCtx({ content: '1', messageId: 'z1' }), manager, config, logger);
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    await handleInbound(makeCtx({ content: '2', messageId: 'z2' }), manager, config, logger);
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    await handleInbound(makeCtx({ content: '3', messageId: 'z3' }), manager, config, logger);
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    await handleInbound(makeCtx({ content: '4', messageId: 'z4' }), manager, config, logger);
    await settle();

    // 此刻 t0+900，仍未开口
    expect(turns.length).toBe(0);

    // t0+1000 → 到 maxWait，必须开口（即使最后一条只过了 100ms）
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(turns.length).toBe(1);
    expect(turns[0]!.body).toContain('1\n2\n3\n4');
  });
});

describe('groupDebounceMs: 0 → 关闭聚合', () => {
  it('关闭后群聊连发照旧逐条立即处理', async () => {
    const { manager, turns } = makeManager();
    const config = makeConfig({ groupDebounceMs: 0, groupDebounceMaxWaitMs: 2000, groupDebounceMaxBatch: 3 });
    const logger = createLogger();

    await handleInbound(makeCtx({ content: '一句', messageId: 'd1' }), manager, config, logger);
    await handleInbound(makeCtx({ content: '两句', messageId: 'd2' }), manager, config, logger);
    await handleInbound(makeCtx({ content: '三句', messageId: 'd3' }), manager, config, logger);

    expect(turns.length).toBe(3);
    expect(turns[0]!.body).toBe(`[小明 (${SENDER_A})] 一句 (@you)`);
  });
});

describe('聚合不丢附件、不吃掉纯收集标记', () => {
  it('一批里混了带附件的消息 → 附件与下载结果都带进合并后的 ctx', async () => {
    const { manager, turns } = makeManager();
    const config = makeConfig({ groupDebounceMs: 100, groupDebounceMaxWaitMs: 2000, groupDebounceMaxBatch: 5 });
    const logger = createLogger();

    await handleInbound(makeCtx({ content: '先看图', messageId: 'p1' }), manager, config, logger);
    await settle();
    await handleInbound(makeCtx({
      content: '这张',
      messageId: 'p2',
      attachments: [{ content_type: 'image/png', filename: 'a.png', size: 10, url: 'https://x/a.png' }],
      downloadedFiles: [{ filename: 'a.png', localPath: '/tmp/a.png' }],
    }), manager, config, logger);
    await settle();
    await handleInbound(makeCtx({ content: '还有这张', messageId: 'p3' }), manager, config, logger);
    await settle();

    await vi.advanceTimersByTimeAsync(100);
    await settle();

    expect(turns.length).toBe(1);
    // 正文顺序没乱，附件也没丢：下载好的本地路径要出现在 agent 看到的内容里
    expect(turns[0]!.body).toContain('先看图\n这张\n还有这张');
    expect(turns[0]!.body).toContain('[图片]');
    expect(turns[0]!.body).toContain('Image: /tmp/a.png');
  });

  it('整批都是"只收图"消息 → 合并后仍是只收图，不会突然开口', async () => {
    const { manager, turns } = makeManager();
    const config = makeConfig({ groupDebounceMs: 100, groupDebounceMaxWaitMs: 2000, groupDebounceMaxBatch: 5 });
    const logger = createLogger();

    const atts = [{ content_type: 'image/png', filename: 'b.png', size: 10, url: 'https://x/b.png' }];
    const files = [{ filename: 'b.png', localPath: '/tmp/b.png' }];

    await handleInbound(makeCtx({
      content: '', messageId: 'q1', wasMentioned: false, collectOnly: true, attachments: atts, downloadedFiles: files,
    }), manager, config, logger);
    await settle();
    await handleInbound(makeCtx({
      content: '再来一张', messageId: 'q2', wasMentioned: false, collectOnly: true,
      attachments: atts, downloadedFiles: files,
    }), manager, config, logger);
    await settle();

    await vi.advanceTimersByTimeAsync(100);
    await settle();

    // 只收集、不回复：一次 followup 都不该发生
    expect(turns.length).toBe(0);
  });

  it('一批里有一条唤醒消息 → 整批正常回话（不被纯收集分支吞掉）', async () => {
    const { manager, turns } = makeManager();
    const config = makeConfig({ groupDebounceMs: 100, groupDebounceMaxWaitMs: 2000, groupDebounceMaxBatch: 5 });
    const logger = createLogger();

    const atts = [{ content_type: 'image/png', filename: 'c.png', size: 10, url: 'https://x/c.png' }];
    const files = [{ filename: 'c.png', localPath: '/tmp/c.png' }];

    await handleInbound(makeCtx({
      content: '', messageId: 'r1', wasMentioned: false, collectOnly: true, attachments: atts, downloadedFiles: files,
    }), manager, config, logger);
    await settle();
    await handleInbound(makeCtx({ content: '看下这个', messageId: 'r2', wasMentioned: true }), manager, config, logger);
    await settle();

    await vi.advanceTimersByTimeAsync(100);
    await settle();

    expect(turns.length).toBe(1);
    expect(turns[0]!.body).toContain('看下这个');
  });
});
