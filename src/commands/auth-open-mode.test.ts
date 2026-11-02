/**
 * 管理命令鉴权 · open 模式下的主人校验（H3 加固）
 * ─────────────────────────────────────────────────────────────
 * 审查发现（2026-11-02）：c2cMode=open 时 commandAllowlistAuth 直接 return true，
 * 于是任何能私聊到她的人都能 /model /preset —— 等于把她的通道与人格交给陌生人。
 *
 * open 只该放开「能跟她聊天」，不该放开「能改她」。
 */
import { describe, expect, it, vi } from 'vitest';
import { commandAllowlistAuth } from './auth.ts';

const OWNER = '2DA749E82EB6FC4B2FCCD4102A3EB0AC';
const STRANGER = 'DEADBEEF000000000000000000000000';

function ctxOf(senderId: string) {
  return { message: { senderId } } as never;
}

describe('commandAllowlistAuth', () => {
  it('open 模式下：主人在白名单里 → 放行', () => {
    const auth = commandAllowlistAuth({
      access: { c2cMode: 'open', c2cAllow: [OWNER] },
    } as never);
    expect(auth(ctxOf(OWNER))).toBe(true);
  });

  it('open 模式下：陌生人 → 拒绝（这是修复的核心）', () => {
    const auth = commandAllowlistAuth({
      access: { c2cMode: 'open', c2cAllow: [OWNER] },
    } as never, { warn: vi.fn() } as never);
    expect(auth(ctxOf(STRANGER))).not.toBe(true);
  });

  it('open 模式下：persona.ownerOpenids 也算主人', () => {
    const auth = commandAllowlistAuth({
      access: { c2cMode: 'open', c2cAllow: [] },
      persona: { ownerOpenids: [OWNER] },
    } as never);
    expect(auth(ctxOf(OWNER))).toBe(true);
    expect(auth(ctxOf(STRANGER))).not.toBe(true);
  });

  it('没配任何主人 → 保守放行（否则升级后老用户一个命令都用不了）', () => {
    const auth = commandAllowlistAuth({
      access: { c2cMode: 'open', c2cAllow: [] },
    } as never);
    expect(auth(ctxOf(STRANGER))).toBe(true);
  });

  it('allowlist 模式行为不变', () => {
    const auth = commandAllowlistAuth({
      access: { c2cMode: 'allowlist', c2cAllow: [OWNER] },
    } as never);
    expect(auth(ctxOf(OWNER))).toBe(true);
    expect(auth(ctxOf(STRANGER))).not.toBe(true);
  });
});
