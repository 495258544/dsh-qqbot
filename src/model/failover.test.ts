/**
 * 备用通道轮换 · 回归测试
 * ─────────────────────────────────────────────────────────────
 * 真实事故驱动（2026-10-31）：主通道 RATE_LIMIT 后小羽连续两轮说不上话。
 * 这里锁住三条关键行为：
 *   1. 只有"通道类"错误才换路（上下文超长换也没用）
 *   2. 换路后会粘在备用通道上一段时间（不立刻回头打主通道）
 *   3. 到底了就停，不无限重试、不假装配好
 */
import { describe, expect, it } from 'vitest';
import { Failover, shouldFailover, routeLabel } from './failover.ts';

const A = { provider: 'trae', model: 'deepseek-v4.1-flash' };
const B = { provider: 'our-free-model', model: 'kimi-k3' };
const C = { provider: 'our-free-model', model: 'glm-5' };

describe('shouldFailover · 哪些错误该换路', () => {
  it('通道类错误换路：限流/过载/缺 key/无 adapter/5xx', () => {
    for (const code of ['RATE_LIMIT', 'OVERLOADED', 'MISSING_CREDENTIAL', 'NO_ADAPTER', 'SERVER', 'MODEL_UNAVAILABLE']) {
      expect(shouldFailover(code), code).toBe(true);
    }
  });

  it('换通道也解决不了的错误不换路', () => {
    for (const code of ['CONTEXT_TOO_LONG', 'INVALID_REQUEST', 'ABORTED', 'CANCELLED', 'STREAM_CLOSED']) {
      expect(shouldFailover(code), code).toBe(false);
    }
  });

  it('未知错误码保守不换（宁可少换，不要瞎换）', () => {
    expect(shouldFailover('')).toBe(false);
    expect(shouldFailover('SOMETHING_NEW')).toBe(false);
  });
});

describe('Failover · 链路与换路', () => {
  it('没配备用通道 → 完全不做 failover（行为与旧版一致）', () => {
    const f = new Failover(A, []);
    expect(f.enabled).toBe(false);
    expect(f.chain).toHaveLength(1);
    expect(f.current('k')).toEqual(A);
    expect(f.advance('k', 'RATE_LIMIT')).toBeUndefined();
    expect(f.isOnFallback('k')).toBe(false);
  });

  it('主通道限流 → 换到第一路备用，并粘住', () => {
    const f = new Failover(A, [B, C]);
    expect(f.current('k')).toEqual(A);

    const moved = f.advance('k', 'RATE_LIMIT');
    expect(moved?.from).toEqual(A);
    expect(moved?.to).toEqual(B);
    expect(f.current('k')).toEqual(B);
    expect(f.isOnFallback('k')).toBe(true);

    // 同一会话继续用 B，不会因为"再失败一次"又跳（advance 是显式调用）
    expect(f.current('k')).toEqual(B);
  });

  it('一路到底：第二路也挂 → 换到第三路；第三路再挂就停，不再前进', () => {
    const f = new Failover(A, [B, C]);
    f.advance('k', 'RATE_LIMIT');   // A → B
    const second = f.advance('k', 'RATE_LIMIT');
    expect(second?.to).toEqual(C);
    expect(f.current('k')).toEqual(C);

    const third = f.advance('k', 'RATE_LIMIT');   // 没有第四路了
    expect(third).toBeUndefined();
    expect(f.current('k')).toEqual(C);            // 停在最后一路，不假装配好
  });

  it('不换路的错误码不会推进游标', () => {
    const f = new Failover(A, [B]);
    expect(f.advance('k', 'CONTEXT_TOO_LONG')).toBeUndefined();
    expect(f.current('k')).toEqual(A);
  });

  it('会话互不干扰：一个群切了备用通道，不影响另一个群', () => {
    const f = new Failover(A, [B]);
    f.advance('group:1', 'RATE_LIMIT');
    expect(f.current('group:1')).toEqual(B);
    expect(f.current('group:2')).toEqual(A);      // 没动过
    expect(f.isOnFallback('group:2')).toBe(false);
  });

  it('冷却到期后回到主通道', () => {
    const f = new Failover(A, [B], { cooldownMs: 10 });
    f.advance('k', 'RATE_LIMIT');
    expect(f.maybeReset('k')).toBeUndefined();     // 还在冷却

    return new Promise<void>((resolve) => setTimeout(() => {
      const prev = f.maybeReset('k');
      expect(prev).toEqual(B);                     // 返回"从哪条回来"
      expect(f.current('k')).toEqual(A);
      expect(f.isOnFallback('k')).toBe(false);
      resolve();
    }, 40));
  });

  it('链路去重：备用里重复写了主通道不会出现两条一样的', () => {
    const f = new Failover(A, [A, B, B]);
    expect(f.chain).toEqual([A, B]);
  });

  it('空路由被跳过（不会把半配好的条目当通道）', () => {
    const f = new Failover(A, [{ provider: '', model: '' }, B, { provider: 'x', model: '' }]);
    expect(f.chain).toEqual([A, B]);
    expect(f.enabled).toBe(true);
  });
});

describe('routeLabel · 日志可读性', () => {
  it('有路由时形如 provider/model，无路由时明确说明', () => {
    expect(routeLabel(A)).toBe('trae/deepseek-v4.1-flash');
    expect(routeLabel(undefined)).toBe('(none)');
  });
});
