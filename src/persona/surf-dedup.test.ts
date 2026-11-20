/**
 * 自主冲浪「结果重复注入」修复（2026-11-18）
 * ─────────────────────────────────────────────────────────────
 * 实测的坏样子（68 轮冲浪统计）：「清晨咖啡」出现 25 次。
 * 根因链：每轮只取搜索结果前 2 条 → 同一 query 的排序几乎恒定 →
 * 同一批 URL 每轮原样注入一遍。self.ts 的 addFinding 判重（11-12）
 * 只保住了 findings 的格子，注入块（notifySurfResults 拼的是本轮
 * results）没有判重 —— 所以修在**选择端 + 结果端**两层：
 *   ① surfTopic 的 exclude：slice 之前剔掉近 7 天已见 URL 的条目；
 *      全被剔除时退回首条（不饿死），但**不进本轮 results**（不重复注入）；
 *   ② runSurfRound 的话题排序换成轮换分（权重 × 闲置加成），
 *      durable 兴趣不再靠不衰减的裸权重永久霸位。
 *
 * 判据一致性也是钉的点：exclude 的键必须走 findingSourceKey（与
 * addFinding 同一把尺子），否则写进去一个形状、查出来另一个形状，
 * 排除会静默失效。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfProfileService, findingSourceKey, type SelfInterest } from './self.ts';
import {
  surfTopic,
  runSurfRound,
  rankSurfTopics,
  recentSeenUrls,
  SURF_SEEN_WINDOW_MS,
  type WebSearchLike,
} from './surf.ts';

const DAY = 24 * 3600_000;

/** 造一个假 web 服务（形状同 surf-web.test.ts） */
function fakeWeb(sources: Array<{ url: string; title?: string; snippet?: string }>): WebSearchLike {
  return {
    async search() {
      return { sources };
    },
  };
}

/** 三条都过质量闸的假结果（web 口径 snippet ≥ 12 字、标题 ≥ 5 字、非百科/导航） */
const THREE = [
  { url: 'https://a.com/1', title: '咖啡渣的十种妙用', snippet: '把喝剩的咖啡渣晒干装袋放在鞋柜里吸味效果很好' },
  { url: 'https://a.com/2', title: '意式浓缩入门笔记', snippet: '九巴压力萃取出金黄crema的espresso才算及格' },
  { url: 'https://a.com/3', title: '手冲注水手法心得', snippet: '中心画圈注水三段式萃取风味更干净稳定' },
];

function tmpSelf(): { self: SelfProfileService; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-dedup-'));
  return { self: new SelfProfileService(dir, () => {}), dir };
}

describe('surfTopic · exclude 近期已见排除', () => {
  it('exclude 命中首条 → 给的是没给过的第 2、3 条', async () => {
    const r = await surfTopic('咖啡', {
      maxFindings: 2,
      web: fakeWeb(THREE),
      exclude: new Set([findingSourceKey('https://a.com/1')]),
    });
    expect(r.layer).toBe('web');
    expect(r.findings.map((f) => f.url)).toEqual(['https://a.com/2', 'https://a.com/3']);
  });

  it('exclude 比对与 addFinding 同一把尺子（协议/www/尾斜杠归一后仍命中）', async () => {
    // findings 里存的是 http://www.a.com/1/ ，搜索结果给的是 https://a.com/1 —— 同一个页面
    const r = await surfTopic('咖啡', {
      maxFindings: 2,
      web: fakeWeb(THREE),
      exclude: new Set([findingSourceKey('http://www.a.com/1/')]),
    });
    expect(r.findings.map((f) => f.url)).not.toContain('https://a.com/1');
  });

  it('全部命中 exclude → 退回首条而不是返回空（不饿死）', async () => {
    const r = await surfTopic('咖啡', {
      maxFindings: 2,
      web: fakeWeb(THREE),
      exclude: new Set(THREE.map((s) => findingSourceKey(s.url))),
    });
    expect(r.layer).toBe('web');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.url).toBe('https://a.com/1');
  });

  it('不传 exclude → 行为与从前完全一致（原样前 maxFindings 条）', async () => {
    const r = await surfTopic('咖啡', { maxFindings: 2, web: fakeWeb(THREE) });
    expect(r.findings.map((f) => f.url)).toEqual(['https://a.com/1', 'https://a.com/2']);
  });
});

describe('recentSeenUrls · 7 天窗口', () => {
  const now = 1_800_000_000_000;
  const interests: SelfInterest[] = [
    {
      topic: '咖啡',
      weight: 0.6,
      kind: 'durable',
      count: 5,
      lastAt: now,
      findings: [
        { at: now - DAY, summary: '昨天的', source: 'https://a.com/recent' },
        { at: now - 8 * DAY, summary: '太久没算数', source: 'https://a.com/stale' },
        { at: now - DAY, summary: '没有出处的笔记' }, // qq_mark_interest 的 note 路径：无 URL，不进集合
      ],
    },
  ];

  it('7 天内的 URL 进集合；更早的、无 URL 的不进', () => {
    const s = recentSeenUrls(interests, '咖啡', now);
    expect(s.has(findingSourceKey('https://a.com/recent'))).toBe(true);
    expect(s.has(findingSourceKey('https://a.com/stale'))).toBe(false);
    expect(s.size).toBe(1);
  });

  it('窗口常量是 7 天', () => {
    expect(SURF_SEEN_WINDOW_MS).toBe(7 * DAY);
  });
});

describe('rankSurfTopics · 轮换打破 durable 永久霸位', () => {
  const now = 1_800_000_000_000;
  const mk = (topic: string, weight: number, idleDays: number, kind: SelfInterest['kind'] = 'durable'): SelfInterest => ({
    topic,
    weight,
    strength: weight,
    kind,
    count: 5,
    lastAt: now - idleDays * DAY,
  });

  it('低权重久未冲浪的兴趣能挤进名额（旧裸权重门槛下它连入选资格都没有）', () => {
    // 实测画像：咖啡 0.601 / 读书 0.53 刚被冲过（几乎没闲置），做饭 0.098 闲置 7 天
    const pool = [mk('咖啡', 0.601, 0.02), mk('读书 书单', 0.53, 0.02), mk('做饭 家常菜', 0.098, 7, 'current')];
    // 旧逻辑的先决条件：0.098 < 0.3，裸权重门槛直接把它挡死
    expect(pool[2]!.weight).toBeLessThan(0.3);
    const picked = rankSurfTopics(pool, { maxTopics: 2, now });
    expect(picked.map((i) => i.topic)).toEqual(['做饭 家常菜', '咖啡']);
  });

  it('不饿死 durable：闲置时长相当时，高权重仍排在前', () => {
    const pool = [mk('咖啡', 0.601, 2), mk('做饭 家常菜', 0.098, 2, 'current')];
    const picked = rankSurfTopics(pool, { maxTopics: 1, now });
    expect(picked.map((i) => i.topic)).toEqual(['咖啡']);
  });

  it('同分先选更久没碰的（lastAt 更旧优先）', () => {
    // A：0.5 × (1+1d) = 1.0，闲置 1 天；B：1.0 × (1+0) = 1.0，刚碰过 —— 真同分
    const pool = [mk('A', 0.5, 1), mk('B', 1.0, 0)];
    const picked = rankSurfTopics(pool, { maxTopics: 1, now });
    expect(picked.map((i) => i.topic)).toEqual(['A']);
  });

  it('加成封顶 8 倍：0.01 级弱兴趣闲置再久也够不着门槛（防跑飞）', () => {
    const pool = [mk('手冲咖啡的细节参数', 0.01, 3000, 'current')];
    expect(rankSurfTopics(pool, { maxTopics: 2, now })).toHaveLength(0);
  });

  it('厌恶仍然被掐掉（M30 语义不回归）', () => {
    const pool = [mk('短视频', 0.6, 5)];
    expect(rankSurfTopics(pool, { maxTopics: 2, hated: new Set(['短视频']), now })).toHaveLength(0);
  });
});

describe('runSurfRound · 重复条目不进注入结果', () => {
  it('候选全被 exclude 时：搜索层退回首条，但本轮 results 不含重复条目', async () => {
    const { self, dir } = tmpSelf();
    try {
      self.touchInterest('咖啡');
      // 预置：三条候选近 7 天都已存进 findings（全部算"近期已见"）
      self.addFinding('咖啡', '[咖啡渣的十种妙用] 旧摘要', 'https://a.com/1');
      self.addFinding('咖啡', '[意式浓缩入门笔记] 旧摘要', 'https://a.com/2');
      self.addFinding('咖啡', '[手冲注水手法心得] 旧摘要', 'https://a.com/3');

      const results = await runSurfRound(self, { maxTopics: 1, web: fakeWeb(THREE) });
      const r = results.find((x) => x.topic === '咖啡');
      // dropSeen 退回首条（不饿死），但注入块（notifySurfResults 拼的就是 results）拿不到重复条目
      expect(r?.findings).toHaveLength(0);
      // addFinding 判重生效：findings 仍是 3 条，没被重复副本占格挤掉真新内容
      const f = self.snapshot().interests.find((i) => i.topic === '咖啡')?.findings ?? [];
      expect(f).toHaveLength(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('部分被 exclude 时：只剔重复，没给过的新条目照常进 results（不误杀）', async () => {
    const { self, dir } = tmpSelf();
    try {
      self.touchInterest('咖啡');
      self.addFinding('咖啡', '[咖啡渣的十种妙用] 旧摘要', 'https://a.com/1');

      const results = await runSurfRound(self, { maxTopics: 1, web: fakeWeb(THREE) });
      const r = results.find((x) => x.topic === '咖啡');
      expect(r?.findings.map((f) => f.url)).toEqual(['https://a.com/2', 'https://a.com/3']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
