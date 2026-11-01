/**
 * own-life 投递目标 · 回归测试
 * ─────────────────────────────────────────────────────────────
 * 真实事故（2026-11-01 实测）：
 *   own-life.json: lastFiredAt 从 03:00 推进到 08:00（说明触发了）
 *   但 firedToday 恒为 0 —— 每次都跳过
 *
 * 两层原因：
 *   ① quiet 参数写反（[7,3] 覆盖大半天）—— 已修
 *   ② **投递目标不存在**：deliver 用 peek('c2c', owner) 只查内存，
 *      而私聊空闲超 30min 就被回收 → 永远 no-live-session
 *
 * 用户明确要求「想在私聊收到她主动发的话」→ 改成会话不在就拉起。
 *
 * 这里锁住两个易错点：
 *   - 拉起后不能因为 lastActivity 是刚写的，就被判成 peer-active
 *   - 原本就在线的会话，仍要遵守 15 分钟不打断
 */
import { describe, expect, it, vi } from 'vitest';
import { ProactiveBudget } from '../persona/service.ts';

const silentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('peer-active 判断 · 不能把新拉起的会话当"对方在活跃"', () => {
  /**
   * 复刻 bootstrap 里的判断逻辑：
   *   existing = peek() 的结果（undefined = 会话原本不存在）
   *   新拉起时 record.lastActivity 是刚写的 Date.now()
   */
  function shouldSkipAsActive(existing: { lastActivity?: number } | undefined, now: number): boolean {
    const activeGapMs = 15 * 60 * 1000;
    // 只有"原本就在线"的会话才做活跃判断
    return Boolean(existing) && now - (existing!.lastActivity ?? 0) < activeGapMs;
  }

  it('会话原本不存在（刚拉起）→ 不算对方活跃，应该投递', () => {
    expect(shouldSkipAsActive(undefined, 1000)).toBe(false);
  });

  it('会话在线且对方刚说过话（<15min）→ 不打断，跳过', () => {
    const now = 10_000_000;
    expect(shouldSkipAsActive({ lastActivity: now - 60_000 }, now)).toBe(true);
  });

  it('会话在线但已静默超过 15min → 可以投递', () => {
    const now = 10_000_000;
    expect(shouldSkipAsActive({ lastActivity: now - 20 * 60_000 }, now)).toBe(false);
  });
});

describe('ProactiveBudget · 防打扰机制仍然生效（不因修复而被绕过）', () => {
  it('每日上限仍然生效', () => {
    const b = new ProactiveBudget(2, 0, silentLogger);
    b.recordProactive('p1');
    b.recordProactive('p1');
    expect(b.allow('p1').ok).toBe(false);
    expect(b.allow('p1').reason).toBe('daily-cap');
  });

  it('最小间隔仍然生效', () => {
    const b = new ProactiveBudget(10, 60_000, silentLogger);
    b.recordProactive('p2');
    const r = b.allow('p2');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too-soon');
  });
});
