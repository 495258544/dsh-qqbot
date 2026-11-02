/**
 * own-life 掷骰 · 回归测试（M25）
 * ─────────────────────────────────────────────────────────────
 * 借鉴 dsh-speak-up（Yuuyuko-uu/dsh-speak-up，207 star）：
 * 定时器到点先掷一次本地骰子（Math.random，**零 token**），
 * 没掷中什么都不做；掷中才真的开口。
 *
 * 与原来的区别：原来"到点必投"，每 4 小时必然产生一次提示（占 token）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createOwnLife } from './own-life.ts';

function mk(roll: number) {
  const statePath = `/tmp/ol-roll-${Math.random().toString(36).slice(2)}.json`;
  const delivered: string[] = [];
  const h = createOwnLife({
    deliver: async (t: string) => { delivered.push(t); return true; },
    statePath,
    intervalMs: 4 * 3600_000,
    maxPerDay: 99,
    quiet: [23, 8],
    rollProbability: roll,
    log: () => {},
  });
  return { h, statePath, delivered };
}

describe('own-life · 掷骰子决定是否打扰', () => {
  it('rollProbability=0 → 永远不投递（纯零 token 路径）', async () => {
    const { h, statePath, delivered } = mk(0);
    try {
      // 用固定的北京正午时刻（避开 quiet [23,8]，否则会先被 quiet 拦掉）
      const NOON = Date.UTC(2026, 10, 2, 4, 0, 0);   // UTC 04:00 = 北京 12:00
      const r = await h.tick(NOON);
      expect(r.ok).toBe(false);
      expect(r.skipped).toBe('roll-missed');
      expect(delivered.length).toBe(0);
    } finally { fs.rmSync(statePath, { force: true }); }
  });

  it('rollProbability=1 → 到点必投（等价于原来的行为）', async () => {
    const { h, statePath, delivered } = mk(1);
    try {
      const NOON = Date.UTC(2026, 10, 2, 4, 0, 0);
      const r = await h.tick(NOON);
      expect(r.ok).toBe(true);
      expect(delivered.length).toBe(1);
    } finally { fs.rmSync(statePath, { force: true }); }
  });

  it('掷不中时不推进 lastFiredAt（下个 tick 会再掷，概率累积）', async () => {
    const { h, statePath } = mk(0);
    try {
      const NOON = Date.UTC(2026, 10, 2, 4, 0, 0);
      await h.tick(NOON);
      // 关键：lastFiredAt 仍然是 0，所以下次到点还会再掷
      expect(h.snapshot().lastFiredAt).toBe(0);
    } finally { fs.rmSync(statePath, { force: true }); }
  });

  it('掷不中不算入 daily-cap（否则会把配额白白耗掉）', async () => {
    const { h, statePath } = mk(0);
    try {
      const NOON = Date.UTC(2026, 10, 2, 4, 0, 0);
      await h.tick(NOON);
      expect(h.snapshot().firedToday).toBe(0);
    } finally { fs.rmSync(statePath, { force: true }); }
  });
});
