/**
 * own-life · 时段锚点模式（2026-11-04 修订）
 * ─────────────────────────────────────────────────────────────
 * 相对间隔（intervalMs）的问题：触发时间随机游走，
 * 上午可能连掷两次烧掉当天额度，晚上反而沉默。
 *
 * 时段锚点：固定槽（北京时刻）到点掷骰一次，
 * 没掷中该槽当天作废（不重掷——重掷就退化回随机游走），下个槽再试。
 * 每槽 45 分钟宽限容错进程重启。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createOwnLife } from './own-life.ts';

// 北京时刻 → UTC ms（北京 = UTC+8）
const BJ = (y: number, m: number, d: number, hh: number, mm = 0) =>
  Date.UTC(y, m - 1, d, hh - 8, mm);

function mk(opts: {
  slots?: string[];
  roll?: number;
  maxPerDay?: number;
  statePath?: string;
}) {
  const delivered: string[] = [];
  const h = createOwnLife({
    deliver: async (t: string) => { delivered.push(t); return true; },
    statePath: opts.statePath ?? `/tmp/ol-slots-${Math.random().toString(36).slice(2)}.json`,
    intervalMs: 4 * 3600_000,
    daySlots: opts.slots,
    maxPerDay: opts.maxPerDay ?? 99,
    quiet: [23, 8],
    rollProbability: opts.roll ?? 1,
    log: () => {},
  });
  return { h, delivered };
}

describe('own-life · 时段锚点模式', () => {
  it('槽到点才触发，槽之间不触发', async () => {
    const { h, delivered } = mk({ slots: ['10:00', '14:00', '18:00', '21:00'] });
    const r1 = await h.tick(BJ(2026, 11, 4, 9, 59));
    expect(r1.skipped).toBe('not-yet');
    expect(delivered).toHaveLength(0);

    const r2 = await h.tick(BJ(2026, 11, 4, 10, 1));
    expect(r2.ok).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it('掷不中该槽作废：同槽后续 tick 不重掷（否则退化回随机游走）', async () => {
    const { h, delivered } = mk({ slots: ['10:00', '14:00'], roll: 0 });
    const t1000 = BJ(2026, 11, 4, 10, 0);
    expect((await h.tick(t1000)).skipped).toBe('roll-missed');
    expect(delivered).toHaveLength(0);
    // 5 分钟后再 tick：槽已消耗，不重掷
    expect((await h.tick(BJ(2026, 11, 4, 10, 5))).skipped).toBe('not-yet');
    expect(delivered).toHaveLength(0);
    // 下一个槽 14:00 正常掷（roll=0 依然 miss，但不再报 not-yet）
    expect((await h.tick(BJ(2026, 11, 4, 14, 0))).skipped).toBe('roll-missed');
    expect(h.snapshot().usedSlots?.idx).toEqual([0, 1]);
  });

  it('45 分钟宽限：重启错过锚点仍能补掷', async () => {
    const { h, delivered } = mk({ slots: ['10:00'] });
    // 进程"掉线"到 10:30 才恢复，仍在宽限内
    const r = await h.tick(BJ(2026, 11, 4, 10, 30));
    expect(r.ok).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it('宽限外该槽作废', async () => {
    const { h, delivered } = mk({ slots: ['10:00'] });
    // 10:46 才恢复，超出 45 分钟宽限 → 作废
    const r = await h.tick(BJ(2026, 11, 4, 10, 46));
    expect(r.skipped).toBe('not-yet');
    expect(delivered).toHaveLength(0);
  });

  it('跨天：昨天的 usedSlots 不影响今天，槽重新可用', async () => {
    const statePath = `/tmp/ol-slots-${Math.random().toString(36).slice(2)}.json`;
    const { h, delivered } = mk({ slots: ['10:00'], statePath });
    try {
      await h.tick(BJ(2026, 11, 4, 10, 1));
      expect(delivered).toHaveLength(1);
      // 第二天同一槽
      const r = await h.tick(BJ(2026, 11, 5, 10, 1));
      expect(r.ok).toBe(true);
      expect(delivered).toHaveLength(2);
      expect(h.snapshot().usedSlots).toEqual({ day: '2026-11-05', idx: [0] });
    } finally { fs.rmSync(statePath, { force: true }); }
  });

  it('槽触发同样计入 daily-cap', async () => {
    const { h, delivered } = mk({ slots: ['10:00', '14:00'], maxPerDay: 1 });
    expect((await h.tick(BJ(2026, 11, 4, 10, 1))).ok).toBe(true);
    expect((await h.tick(BJ(2026, 11, 4, 14, 1))).skipped).toBe('daily-cap');
    expect(delivered).toHaveLength(1);
  });

  it('daySlots 与 intervalMs 互斥：配了槽就走锚点，interval 不再驱动', async () => {
    const { h, delivered } = mk({ slots: ['21:00'] });
    // lastFiredAt=0，若走 interval 路径此刻必然到点；走锚点则因槽未到而不触发
    const r = await h.tick(BJ(2026, 11, 4, 12, 0));
    expect(r.skipped).toBe('not-yet');
    expect(delivered).toHaveLength(0);
  });

  it('quiet 时段优先于槽（槽设计在 quiet 内会被拦）', async () => {
    const { h, delivered } = mk({ slots: ['05:00', '10:00'] });
    expect((await h.tick(BJ(2026, 11, 4, 5, 1))).skipped).toBe('quiet');
    expect((await h.tick(BJ(2026, 11, 4, 10, 1))).ok).toBe(true);
    // 05:00 槽在 quiet 里被拦，没消耗；10:00 触发后只有槽 1 被记录
    expect(h.snapshot().usedSlots?.idx).toEqual([1]);
  });
});
