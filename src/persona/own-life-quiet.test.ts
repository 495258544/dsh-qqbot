/**
 * own-life 安静时段 · 回归测试
 * ─────────────────────────────────────────────────────────────
 * 真实事故（2026-11-01 实测）：
 *   own-life.json: lastFiredAt 有值，firedToday=0
 *
 * 也就是"触发了但被静默跳过"。根因是 quiet 参数顺序写反了：
 *   quiet = [surfToHour, surfFromHour] = [7, 3]
 * 而 isHourInRange 对 from>to 的解释是 "hour>=from || hour<to"
 *   → 覆盖 7:00 到次日 03:00，**大半天都被禁掉**
 *   → 她唯一能自由活动的时间只剩 3-7 点（还正好是冲浪时段）
 *
 * 这个测试锁住语义，防止再写反。
 */
import { describe, expect, it } from 'vitest';
import { isHourInRange } from './clock.ts';

describe('quiet 时段语义', () => {
  it('写反的 [7,3] 会覆盖大半天（这就是事故）', () => {
    // hour >= 7 || hour < 3
    const covered = [1, 2, 7, 9, 12, 15, 18, 22].every((h) => isHourInRange(h, 7, 3));
    expect(covered, '[7,3] 应该几乎全天命中，正是 bug 的表现').toBe(true);
    // 只有 3-6 点被放行 —— 而那正是冲浪时段，冲突
    for (const h of [3, 4, 5, 6]) expect(isHourInRange(h, 7, 3)).toBe(false);
  });

  it('正确的 [23,8] 只禁深夜到清晨（睡觉时段）', () => {
    // 深夜/凌晨被禁
    for (const h of [23, 0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(isHourInRange(h, 23, 8), `${h} 点应属于睡觉时段`).toBe(true);
    }
    // 白天晚上都是她的时间
    for (const h of [8, 9, 12, 15, 18, 20, 22]) {
      expect(isHourInRange(h, 23, 8), `${h} 点应是自由时间`).toBe(false);
    }
  });

  it('凌晨 3 点（原来被误禁的时刻）在正确配置下是睡觉时段，白天才是自由时间', () => {
    expect(isHourInRange(3, 7, 3), '旧配置把 3 点放行了，但那是冲浪时段').toBe(false);
    expect(isHourInRange(3, 23, 8), '新配置下 3 点是深夜').toBe(true);
    expect(isHourInRange(10, 23, 8), '上午 10 点应该可以自由活动').toBe(false);
  });
});
