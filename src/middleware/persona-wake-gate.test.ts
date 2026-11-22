/**
 * persona 唤醒门 · 「群聊仅回复 @机器人」回归测试
 * ─────────────────────────────────────────────────────────────
 * 用户原话（2026-11-22）：「群聊仅回复 @机器人的消息，我设置了这个，
 * 为什么她还会回答其他消息」
 *
 * 根因：middleware-setup 把 requireMention 算成
 * `wakeByPersona ? false : config.requireMention`，persona 唤醒一开
 * 配置就被 Waker 的兴趣/名字/概率判定覆盖。
 */
import { describe, expect, it } from 'vitest';
import { personaWakeGate } from './persona-wake-gate.ts';

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {},
} as any;

interface CtxOpts {
  mentioned?: boolean;
  attachments?: number;
  content?: string;
  senderId?: string;
}

function makeCtx(o: CtxOpts = {}) {
  const state: any = { mention: { wasMentioned: o.mentioned === true } };
  const calls = { stopped: undefined as string | undefined, passed: false };
  const ctx: any = {
    message: {
      kind: 'group',
      groupOpenid: 'G1',
      senderId: o.senderId ?? 'U1',
      senderName: '小明',
      content: o.content ?? '今天好热',
      attachments: Array.from({ length: o.attachments ?? 0 }, () => ({ content_type: 'image/png' })),
    },
    state,
    stop(reason: string) { calls.stopped = reason; },
  };
  return { ctx, state, calls };
}

function makePersona(o: { speakerActive?: boolean; isActive?: boolean } = {}) {
  return {
    budget: { markReplied() {} },
    self: { registerComplaint: () => 0.5, warmUp() {} },
    waker: {
      isSpeakerActive: () => o.speakerActive === true,
      isActive: () => o.isActive === true,
      shouldWake: () => ({ wake: false, reason: 'active-window:idle' }),
      matchInterest: () => ({ hit: false }),
      wake() {},
    },
    memory: { touch() {}, knownNames: () => [] },
    emotion: { onComplained() {}, onAddressed() {} },
    notePossibleName: () => false,
    runtime: { otherNames: () => [], selfIds: () => [] },
  } as any;
}

async function run(
  gateOpts: { atOnly?: boolean; atOnlyFollowup?: boolean },
  ctxOpts: CtxOpts,
  personaOpts: { speakerActive?: boolean; isActive?: boolean } = {},
) {
  const { ctx, state, calls } = makeCtx(ctxOpts);
  const mw = personaWakeGate(makePersona(personaOpts), logger, gateOpts);
  const next = async () => { calls.passed = true; };
  await mw(ctx, next);
  return { ctx, state, calls };
}

describe('personaWakeGate · 群聊仅回复 @机器人', () => {
  it('未 @ 且没 @ 过她的同人延续 → 拦掉', async () => {
    const { calls } = await run({ atOnly: true }, { mentioned: false });
    expect(calls.stopped).toBe('persona:at-only');
    expect(calls.passed).toBe(false);
  });

  it('@ 了她 → 放行', async () => {
    const { calls } = await run({ atOnly: true }, { mentioned: true });
    expect(calls.stopped).toBeUndefined();
    expect(calls.passed).toBe(true);
  });

  it('刚 @ 过她的同一个人接着说 → 放行，避免每句都要重新 @', async () => {
    const { calls } = await run(
      { atOnly: true },
      { mentioned: false, senderId: 'U2' },
      { speakerActive: true },
    );
    expect(calls.stopped).toBeUndefined();
    expect(calls.passed).toBe(true);
  });

  it('未 @ 但带附件 → 不拦，只归档不回复（手机端没法同时 @ 和发图）', async () => {
    const { calls, state } = await run({ atOnly: true }, { mentioned: false, attachments: 1 });
    expect(calls.stopped).toBeUndefined();
    expect(calls.passed).toBe(true);
    expect(state.collectOnly).toBe(true);
  });

  it('atOnly 关闭时保持原唤醒行为，不误拦', async () => {
    const { calls } = await run({ atOnly: false }, { mentioned: false }, { isActive: true });
    expect(calls.stopped).toBeUndefined();
    expect(calls.passed).toBe(true);
  });

  it('atOnlyFollowup=false → 同一个人接着说也必须重新 @', async () => {
    const { calls } = await run(
      { atOnly: true, atOnlyFollowup: false },
      { mentioned: false, senderId: 'U2' },
      { speakerActive: true },
    );
    expect(calls.stopped).toBe('persona:at-only');
    expect(calls.passed).toBe(false);
  });
});
