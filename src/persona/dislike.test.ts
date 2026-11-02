/**
 * 厌恶（dislikes）系统测试（M30）
 * ─────────────────────────────────────────────────────────────
 * 这套测试防的是**三个已经验证过的死法**，不是为了覆盖率：
 *
 *  1. 「负权重」死法：把讨厌做成 interests 的负强度。
 *     饱和强化 s ← s + α(1-s) 是单调递增函数，s=-0.5 喂一次会变成 -0.425，
 *     也就是"越提越不讨厌"。断言 dislike 强度永远 ≥ 0，且只涨不跌。
 *
 *  2. 「线性减法」死法：dampenInterest 原来是 s - 0.05。
 *     s=0.06 时减一次直接击穿 FREEZE_THRESHOLD=0.1 被冻结 ——
 *     "两次没人理就死了"。断言乘性下调不会跨数量级。
 *
 *  3. 「死代码」死法：写好了但没人调。
 *     decayInterests 从写出来起 0 个调用点，兴趣强度只会涨。
 *     这类测试断言"算得对"没用，必须断言**消费端真的变了**。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfProfileService } from './self.ts';
import { Waker } from './wake.ts';

function mkSelf(): { svc: SelfProfileService; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dislike-'));
  return { svc: new SelfProfileService(dir), dir };
}

describe('dislikes · 结构（不能是负权重）', () => {
  it('默认没有厌恶，且不影响兴趣', () => {
    const { svc } = mkSelf();
    expect(svc.topDislikes(5)).toEqual([]);
    expect(svc.snapshot().interests).toEqual([]);
  });

  it('记厌恶只写 dislikes 列，不动 interests', () => {
    const { svc } = mkSelf();
    svc.recordDislike('短视频');
    expect(svc.topDislikes(5).map((d) => d.topic)).toEqual(['短视频']);
    expect(svc.snapshot().interests).toHaveLength(0);
  });

  it('厌恶强度只会往上涨，且永远 ≥ 0（负权重死法的回归测试）', () => {
    const { svc } = mkSelf();
    svc.recordDislike('短视频');
    const a = svc.topDislikes(1)[0]!.strength ?? 0;
    svc.recordDislike('短视频');
    const b = svc.topDislikes(1)[0]!.strength ?? 0;
    expect(b).toBeGreaterThan(a);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(1);
  });

  it('重复记同一样东西不会长出新条目', () => {
    const { svc } = mkSelf();
    svc.recordDislike('短视频');
    svc.recordDislike('短视频');
    svc.recordDislike('短视频');
    expect(svc.snapshot().dislikes).toHaveLength(1);
  });
});

describe('dislikes · 衰减（比喜好慢）', () => {
  it('72h 后强度减半，24h 后只减一点', () => {
    const { svc } = mkSelf();
    svc.recordDislike('短视频');
    const s0 = svc.topDislikes(1)[0]!.strength ?? 0;

    // 24h：兴趣半衰期是 24h（降一半），厌恶是 72h（只降到约 0.79）
    svc.decayDislikes(Date.now() + 24 * 3600_000);
    const s24 = svc.topDislikes(1)[0]?.strength ?? 0;
    expect(s24).toBeGreaterThan(s0 * 0.5);

    // 再走 48h（累计 72h）：约剩一半
    svc.decayDislikes(Date.now() + 72 * 3600_000);
    const s72 = svc.topDislikes(1)[0]?.strength ?? 0;
    expect(s72).toBeLessThan(s0 * 0.6);
  });

  it('衰减到冻结线以下只是淡忘（frozen），不会消失', () => {
    const { svc } = mkSelf();
    svc.recordDislike('短视频');
    svc.decayDislikes(Date.now() + 90 * 24 * 3600_000); // 90 天
    // 还在数组里，可追溯
    expect(svc.snapshot().dislikes).toHaveLength(1);
    // 但不再出现在 top 里
    expect(svc.topDislikes(5)).toHaveLength(0);
  });
});

describe('dislikes · 消费端真的会变（死代码回归测试）', () => {
  const mk = (dislikes: Array<{ topic: string; weight: number }>) => {
    const w = new Waker({ names: ['小羽'], keywords: [], ownerIds: [] });
    w.setInterestProvider(() => ({
      interests: [{ topic: '短视频', weight: 1 }],
      dislikes,
      chattiness: 1,
      baseProbability: 1,
    }));
    return w;
  };

  it('没记厌恶时，命中兴趣的概率是满的', () => {
    const r = mk([]).matchInterest('今天刷短视频刷了两小时');
    expect(r.hit).toBe(true);
    expect(r.probability).toBeCloseTo(1, 5);
  });

  it('记了厌恶后，同一个兴趣的唤醒概率被压下来', () => {
    const r = mk([{ topic: '短视频', weight: 1 }]).matchInterest('今天刷短视频刷了两小时');
    expect(r.hit).toBe(true);
    // 最多打到 4 折，但必须真的变小
    expect(r.probability).toBeLessThan(0.5);
    expect(r.probability).toBeGreaterThan(0);
  });

  it('厌恶强度是连续的：越讨厌越懒得开口', () => {
    const p = (w: number) => mk([{ topic: '短视频', weight: w }]).matchInterest('聊聊短视频').probability;
    expect(p(0.2)).toBeGreaterThan(p(0.6));
    expect(p(0.6)).toBeGreaterThan(p(1.0));
  });

  it('厌恶惩罚不会把概率打成 0（讨厌也可能正是想吐槽的）', () => {
    const r = mk([{ topic: '短视频', weight: 1 }]).matchInterest('聊聊短视频');
    expect(r.probability).toBeGreaterThan(0);
  });

  it('厌恶不影响其它无关话题的唤醒', () => {
    const w = mk([{ topic: '短视频', weight: 1 }]);
    w.setInterestProvider(() => ({
      interests: [{ topic: '猫', weight: 1 }],
      dislikes: [{ topic: '短视频', weight: 1 }],
      chattiness: 1,
      baseProbability: 1,
    }));
    expect(w.matchInterest('我家猫又胖了').probability).toBeCloseTo(1, 5);
  });
});

describe('dampenInterest · 乘性而非线性（击穿冻结线的回归测试）', () => {
  it('低强度时下调不会一次击穿冻结线', () => {
    const { svc } = mkSelf();
    svc.touchInterest('猫');
    // 手动压到很低（模拟"很久没提"）
    const e = svc.snapshot().interests[0]!;
    e.strength = 0.06;
    e.weight = 0.06;

    svc.dampenInterest('猫');
    const after = svc.snapshot().interests[0]!;
    // 线性减法 0.06-0.05=0.01 → 会被冻结；乘性 0.06*0.85=0.051 → 仍在
    expect(after.frozen).toBeFalsy();
    expect(after.strength).toBeGreaterThan(0.04);
  });

  it('高强度下调是"淡一点"，不是"砍一半"', () => {
    const { svc } = mkSelf();
    svc.touchInterest('猫');
    const e = svc.snapshot().interests[0]!;
    e.strength = 1;
    e.weight = 1;
    svc.dampenInterest('猫');
    expect(svc.snapshot().interests[0]!.strength).toBeGreaterThan(0.8);
  });
});

describe('self.json · 向后兼容', () => {
  it('老文件没有 dislikes 字段时能正常读成空数组', () => {
    const { svc, dir } = mkSelf();
    svc.save();
    const file = path.join(dir, 'self.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.dislikes;
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');

    const again = new SelfProfileService(dir);
    expect(again.snapshot().dislikes).toEqual([]);
    expect(again.topDislikes(3)).toEqual([]);
  });
});

describe('renderSection · 数据和感受必须同时在场', () => {
  it('没兴趣也没厌恶时不注入（不占 token）', () => {
    const { svc } = mkSelf();
    expect(svc.renderSection()).toBe('');
  });

  it('讨厌的东西会进提示词，措辞是"没兴致"不是"拒绝回答"', () => {
    const { svc } = mkSelf();
    svc.recordDislike('短视频');
    const s = svc.renderSection();
    expect(s).toContain('短视频');
    expect(s).toContain('没什么兴致');
    // 不能出现禁令式措辞：那会把模型逼成客服话术
    expect(s).not.toContain('拒绝');
    expect(s).not.toContain('不许');
  });

  it('强度太弱的厌恶不渲染（否则人格变成一张清单）', () => {
    const { svc } = mkSelf();
    svc.recordDislike('短视频');
    const e = svc.snapshot().dislikes[0]!;
    e.strength = 0.1;
    e.weight = 0.1;
    expect(svc.renderSection()).toBe('');
  });

  it('喜欢和讨厌会同时渲染', () => {
    const { svc } = mkSelf();
    svc.touchInterest('猫');
    svc.snapshot().interests[0]!.strength = 1;
    svc.recordDislike('短视频');
    const s = svc.renderSection();
    expect(s).toContain('猫');
    expect(s).toContain('短视频');
  });
});
