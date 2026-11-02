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

describe('dislikes · 衰减（比喜好慢 3 倍）', () => {
  it('90 天掉一半；30 天只掉一点', () => {
    const { svc } = mkSelf();
    svc.recordDislike('短视频');
    const s0 = svc.topDislikes(1)[0]!.strength ?? 0;

    // 30 天 ≈ 1/3 个半衰期 → 还剩八成多
    svc.decayDislikes(Date.now() + 30 * 24 * 3600_000);
    const s30 = svc.topDislikes(1)[0]?.strength ?? 0;
    expect(s30).toBeGreaterThan(s0 * 0.7);

    // 累计 90 天 = 1 个半衰期 → 约剩一半
    // （注意：s0 本身是"刚记下"的强度，30 天后已降过一次，
    //  这里的参照是 s30 而不是 s0，所以用区间断言而不是精确值）
    svc.decayDislikes(Date.now() + 90 * 24 * 3600_000);
    const s90 = svc.topDislikes(1)[0]?.strength ?? 0;
    expect(s90).toBeLessThan(s30 * 0.75);
    expect(s90).toBeGreaterThan(0.05);
  });

  it('衰减到冻结线以下只是淡忘（frozen），不会消失', () => {
    const { svc } = mkSelf();
    svc.recordDislike('短视频');
    // 90 天半衰期 → 要 300 天左右才跌破 0.1
    svc.decayDislikes(Date.now() + 400 * 24 * 3600_000);
    // 还在数组里，可追溯
    expect(svc.snapshot().dislikes).toHaveLength(1);
    // 但不再出现在 top 里
    expect(svc.topDislikes(5)).toHaveLength(0);
  });

  it('厌恶比兴趣活得久（3 倍半衰期这件事在数值上必须成立）', () => {
    const { svc } = mkSelf();
    svc.touchInterest('猫');
    svc.recordDislike('短视频');
    const i0 = svc.snapshot().interests[0]!.strength ?? 0;
    const d0 = svc.snapshot().dislikes[0]!.strength ?? 0;

    const later = Date.now() + 30 * 24 * 3600_000;
    svc.decayInterests(later);
    svc.decayDislikes(later);

    // 同样 30 天：兴趣掉到一半，厌恶还剩八成多
    const iRatio = (svc.snapshot().interests[0]!.strength ?? 0) / i0;
    const dRatio = (svc.snapshot().dislikes[0]!.strength ?? 0) / d0;
    expect(dRatio).toBeGreaterThan(iRatio);
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

describe('聊天续命 · 不接这条衰减等于一键清空', () => {
  const mkSvc = async (dir: string, selfSeed: (s: SelfProfileService) => void) => {
    const { PersonaService } = await import('./service.ts');
    const svc = new PersonaService({
      config: {
        enabled: true, dataDir: dir, roleCardPath: '', roleMaxChars: 12000,
        wakeEnabled: true, names: [], keywords: [], ownerOpenids: [], groupProbability: 0,
        humanizeEnabled: true, msPerChar: 110, burstMax: 2, gapMinMs: 700, gapMaxMs: 2600,
        ownLifeEnabled: false, ownLifeIntervalMs: 9000000, ownLifeMaxPerDay: 6,
        maxProactivePerDay: 2, proactiveMinGapMs: 7200000,
      } as never,
      dataDir: dir,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    });
    selfSeed(svc.self);
    return svc;
  };

  it('聊天里聊到兴趣 → lastAt 被刷新', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
    const svc = await mkSvc(dir, (s) => {
      s.touchInterest('咖啡');
      // 手动做旧：假装 5 天前碰过
      const e = s.snapshot().interests[0]!;
      e.lastAt = Date.now() - 5 * 24 * 3600_000;
    });
    const before = svc.self.snapshot().interests[0]!.lastAt;

    svc.noteUserTurn('s1', '今天又喝咖啡了', 'u1');
    svc.flushTurn('s1', 'c2c:u1', 'u1');

    const after = svc.self.snapshot().interests[0]!.lastAt;
    expect(after).toBeGreaterThan(before);
  });

  it('没聊到的兴趣不被动（续命不是无差别刷）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
    const svc = await mkSvc(dir, (s) => {
      s.touchInterest('咖啡');
      const e = s.snapshot().interests[0]!;
      e.lastAt = Date.now() - 5 * 24 * 3600_000;
    });
    const before = svc.self.snapshot().interests[0]!.lastAt;

    svc.noteUserTurn('s1', '今天天气不错', 'u1');
    svc.flushTurn('s1', 'c2c:u1', 'u1');

    expect(svc.self.snapshot().interests[0]!.lastAt).toBe(before);
  });

  it('搜索词型兴趣（带空格）也能被日常说话续命', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
    const svc = await mkSvc(dir, (s) => {
      s.touchInterest('游戏 新作');
      const e = s.snapshot().interests[0]!;
      e.lastAt = Date.now() - 5 * 24 * 3600_000;
    });
    const before = svc.self.snapshot().interests[0]!.lastAt;

    svc.noteUserTurn('s1', '最近有什么新游戏吗', 'u1');
    svc.flushTurn('s1', 'c2c:u1', 'u1');

    expect(svc.self.snapshot().interests[0]!.lastAt).toBeGreaterThan(before);
  });
});

describe('addFinding · 查资料必须续命（越研究越接近过期的 bug）', () => {
  it('写 findings 会刷新 lastAt', () => {
    const { svc } = mkSelf();
    svc.touchInterest('咖啡');
    const e0 = svc.snapshot().interests[0]!;
    e0.lastAt = Date.now() - 5 * 24 * 3600_000;
    const before = e0.lastAt;

    svc.addFinding('咖啡', '一篇关于手冲的文章');

    expect(svc.snapshot().interests[0]!.lastAt).toBeGreaterThan(before);
  });
});

describe('衰减参数 · 必须"活得下来"（M30 重标定的回归测试）', () => {
  // 这一组防的是一个**数学上就活不了**的参数组合。
  //
  // 原参数：HALF_LIFE=24h、ALPHA_ACCESS=0.05。稳态公式
  //   s_eq = d·α / (1 - d + d·α),  d = 2^(-Δt/HL)
  // 代入"每天聊到一次"(d=0.5)：s_eq = 0.048，而冻结线是 0.1。
  // 结论：这套参数下兴趣**不可能存活**，必然被冻结。
  // 实测吻合：她 6 条兴趣里 2 条已冻结在 0.04375（0.35 走 3 个半衰期）。
  //
  // 这些断言不测"算得对"，测的是"这套数字在语义上成立"：
  // 常聊的要活着，久不聊的要淡掉。

  /** 按"每 T 天碰一次"推演稳态（先衰减后强化，与代码顺序一致） */
  function steadyState(T: number, halfLifeDays = 30, alpha = 0.15, days = 3000): number {
    let s = 0.5;
    let since = 0;
    for (let t = T; t <= days; t += T) {
      s *= Math.pow(2, -((t - since) * 24) / (halfLifeDays * 24));
      since = t;
      s += alpha * (1 - s);
    }
    return s;
  }

  it('每天聊到 → 稳稳活着（不是贴着冻结线挣扎）', () => {
    expect(steadyState(1)).toBeGreaterThan(0.6);
  });

  it('每周聊到 → 还喜欢，但已经淡了一些', () => {
    const v = steadyState(7);
    expect(v).toBeGreaterThan(0.35);
    expect(v).toBeLessThan(0.75);
  });

  it('一个月不理 → 淡到接近冻结（这才叫"那阵子喜欢过"）', () => {
    expect(steadyState(30)).toBeLessThan(0.4);
  });

  it('原参数（24h/0.05）在数学上活不下来 —— 这是重标定的依据', () => {
    // 每天聊到一次，稳态也只有 0.048，低于冻结线 0.1
    expect(steadyState(1, 1, 0.05)).toBeLessThan(0.1);
  });

  it('衰减是单调的：越常碰强度越高', () => {
    const a = steadyState(1), b = steadyState(7), c = steadyState(30);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('真类的衰减幅度与公式一致（不会因为实现细节跑偏）', () => {
    const { svc } = mkSelf();
    svc.touchInterest('咖啡');
    const e = svc.snapshot().interests[0]!;
    e.strength = 0.8;
    e.weight = 0.8;
    e.lastAt = Date.now() - 30 * 24 * 3600_000; // 30 天没碰
    svc.decayInterests();
    // 半衰期 30 天 → 掉一半左右
    expect(svc.snapshot().interests[0]!.strength).toBeCloseTo(0.4, 1);
  });
});
