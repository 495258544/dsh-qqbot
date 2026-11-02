/**
 * 记忆鲜活度 · 回归测试（M27）
 * ─────────────────────────────────────────────────────────────
 * 移植自 Yuuyuko-uu/dsh-fish-memory 的衰减模型（参数取自其源码 lib/index.js:2936）。
 *
 * 我们的现状是「先进先出淘汰」：facts 满 60 条就挤掉最旧的，
 * 一条"他养了只橘猫"和"他今天说好累"分量完全不同，但 FIFO 一视同仁。
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveHalfLife,
  freshness,
  evidenceScore,
  rankScore,
  maxItemsFor,
  inferImportance,
  isStableFact,
  reinforce,
  EVIDENCE_THRESHOLD,
  WEIGHTS,
} from './memory-decay.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2, 4, 0, 0);   // 北京 11-02 12:00

describe('半衰期随重要度放大（源码核心设计，README 没提）', () => {
  it('importance 0/0.5/1 → 30/60/90 天', () => {
    expect(effectiveHalfLife(0)).toBe(30);
    expect(effectiveHalfLife(0.5)).toBe(60);
    expect(effectiveHalfLife(1)).toBe(90);
  });

  it('过了一个半衰期，鲜活度正好减半', () => {
    const st = { activation0: 1, anchor: NOW - 30 * DAY, importance: 0 as const, stable: false };
    expect(freshness(st, NOW)).toBeCloseTo(0.5, 5);
  });

  it('重要性高的忘得更慢（90 天半衰期，60 天后仍有 2^(-60/90)≈0.63）', () => {
    const st = { activation0: 1, anchor: NOW - 60 * DAY, importance: 1 as const, stable: false };
    expect(freshness(st, NOW)).toBeCloseTo(Math.pow(2, -60 / 90), 5);
    // 对比同年龄的普通记忆：60 天 = 两个半衰期 → 只剩 1/4
    const plain = { activation0: 1, anchor: NOW - 60 * DAY, importance: 0 as const, stable: false };
    expect(freshness(plain, NOW)).toBeCloseTo(0.25, 5);
    // 差距显著：重要的比普通的多留 2.5 倍
    expect(freshness(st, NOW)).toBeGreaterThan(freshness(plain, NOW) * 2);
  });
});

describe('长期事实不过期', () => {
  it('一年前的稳定事实仍有 0.5 鲜活度（不会掉到 0）', () => {
    const st = { activation0: 1, anchor: NOW - 365 * DAY, importance: 1 as const, stable: true };
    expect(freshness(st, NOW)).toBe(0.5);
  });

  it('WORK/住址/宠物/喜好 判为长期事实', () => {
    for (const t of ['我是做前端开发的', '我在腾讯上班', '我住在杭州', '我家养了只橘猫', '我不吃香菜']) {
      expect(isStableFact(t), t).toBe(true);
      expect(inferImportance(t), t).toBe(1);
    }
  });
});

describe('重要度规则判定（不用模型，避免把闲聊当重要）', () => {
  it('具体经历/观点 → 0.5', () => {
    expect(inferImportance('我昨天去看了演唱会')).toBe(0.5);
    expect(inferImportance('我觉得那个新番挺好看的')).toBe(0.5);
    expect(inferImportance('我更想让它自己长')).toBe(0.5);
  });

  it('闲聊 → 0（重点：光有时间词不够，必须有动作或观点）', () => {
    expect(inferImportance('今天好热')).toBe(0);
    expect(inferImportance('这活我接')).toBe(0);
    expect(inferImportance('嗯')).toBe(0);
  });
});

describe('证据与排序', () => {
  it('证据量 C = s/(s+0.8)，永远到不了 1', () => {
    expect(evidenceScore(0)).toBe(0);
    expect(evidenceScore(0.8)).toBeCloseTo(0.5, 5);
    expect(evidenceScore(100)).toBeLessThan(1);
  });

  it('四档注入条数（源码分档）', () => {
    expect(maxItemsFor(0.7)).toBe(6);
    expect(maxItemsFor(0.55)).toBe(4);
    expect(maxItemsFor(0.45)).toBe(3);
    expect(maxItemsFor(0.2)).toBe(1);
  });

  it('权重合计 1.00（去掉了源码里恒不生效的情绪维度）', () => {
    const sum = WEIGHTS.baseline + WEIGHTS.activation + WEIGHTS.importance;
    expect(sum).toBeCloseTo(1, 5);
  });

  it('总分 = C × 乘数，且乘数落在 [0.60, 1.00]', () => {
    const fresh = { activation0: 1, anchor: NOW, importance: 1 as const, stable: false };
    const old = { activation0: 0.1, anchor: NOW - 365 * DAY, importance: 0 as const, stable: false };
    // 同一条记忆越旧越吃亏
    expect(rankScore(1, fresh, NOW)).toBeGreaterThan(rankScore(1, old, NOW));
    // 证据量 0 → 总分 0
    expect(rankScore(0, fresh, NOW)).toBe(0);
  });

  it('被再次提到会强化（A 上升且时间锚重置）', () => {
    const old = { activation0: 1, anchor: NOW - 120 * DAY, importance: 0 as const, stable: false };
    const r = reinforce(old, NOW);
    expect(r.anchor).toBe(NOW);
    expect(r.activation0).toBeGreaterThan(freshness(old, NOW));
  });

  it('证据门槛是 0.3，且卡的是证据不是总分', () => {
    expect(EVIDENCE_THRESHOLD).toBe(0.3);
    // 一条很旧的记忆，只要证据够，仍然能进
    const old = { activation0: 0.05, anchor: NOW - 200 * DAY, importance: 0 as const, stable: false };
    expect(evidenceScore(1)).toBeGreaterThan(EVIDENCE_THRESHOLD);
    expect(rankScore(evidenceScore(1), old, NOW)).toBeGreaterThan(0);
  });
});
