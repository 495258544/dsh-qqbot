/**
 * 观看记录（M37）
 * ─────────────────────────────────────────────────────────────
 * 这组测试防的是**"她记不住自己看过什么"**这件事：
 *
 *  1. 不记录 → 每次被问"最近看了什么"只能现编，或靠上下文碰巧还在
 *  2. 记成 findings → 冲浪一次刷 8 条会把真正的经历挤掉（findings 上限就是 8）
 *  3. 无限追加 → "最近看过"变成一串重复 BV 号，而人只算一次
 *  4. 注入时下结论 → "所以你爱看X"是替她做判断，解释权该在她手里
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfProfileService, MAX_WATCHING } from './self.ts';

const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watching-'));
  return new SelfProfileService(dir);
};

describe('addWatching · 基本记录', () => {
  it('记一条，能读回来', () => {
    const s = mk();
    s.addWatching({ title: '华为配置专题03', ref: 'BV1Xx9bBiEqx' });
    const r = s.recentWatching(3);
    expect(r).toHaveLength(1);
    expect(r[0]!.title).toBe('华为配置专题03');
    expect(r[0]!.ref).toBe('BV1Xx9bBiEqx');
  });

  it('空标题不记（防止写进一条空记录）', () => {
    const s = mk();
    s.addWatching({ title: '   ' });
    expect(s.recentWatching(3)).toHaveLength(0);
  });

  it('note 超长会被截断（观后感不是作业）', () => {
    const s = mk();
    s.addWatching({ title: 'T', note: 'x'.repeat(300) });
    expect(s.recentWatching(1)[0]!.note!.length).toBeLessThanOrEqual(120);
  });
});

describe('addWatching · 去重（同一个片子算一次）', () => {
  it('同 ref 覆盖旧的，不重复追加', () => {
    const s = mk();
    s.addWatching({ title: 'A', ref: 'BV1' });
    s.addWatching({ title: 'A', ref: 'BV1', note: '补看的' });
    expect(s.recentWatching(5)).toHaveLength(1);
    expect(s.recentWatching(1)[0]!.note).toBe('补看的');
  });

  it('没有 ref 时按标题去重', () => {
    const s = mk();
    s.addWatching({ title: '同一个片子' });
    s.addWatching({ title: '同一个片子' });
    expect(s.recentWatching(5)).toHaveLength(1);
  });

  it('补看时**不会冲掉**之前写的感受', () => {
    // 场景：第一次看完记了感受，第二次只说"补看一遍"没写 note
    const s = mk();
    s.addWatching({ title: 'A', ref: 'BV1', note: '讲得挺细' });
    s.addWatching({ title: 'A', ref: 'BV1' });
    expect(s.recentWatching(1)[0]!.note).toBe('讲得挺细');
  });

  it('done 标记不会被后来的 false 冲掉', () => {
    const s = mk();
    s.addWatching({ title: 'A', ref: 'BV1', done: true });
    s.addWatching({ title: 'A', ref: 'BV1', done: false });
    expect(s.recentWatching(1)[0]!.done).toBe(true);
  });
});

describe('addWatching · 上限', () => {
  it(`最多 ${MAX_WATCHING} 条，超了丢最旧的`, () => {
    const s = mk();
    for (let i = 0; i < MAX_WATCHING + 5; i++) {
      s.addWatching({ title: `T${i}`, ref: `BV${i}` });
    }
    expect(s.snapshot().watching!.length).toBe(MAX_WATCHING);
    // 最新的还在
    expect(s.recentWatching(1)[0]!.title).toBe(`T${MAX_WATCHING + 4}`);
  });

  it('recentWatching 新的在前', () => {
    const s = mk();
    const t0 = Date.now();
    s.addWatching({ title: '旧' }, t0);
    s.addWatching({ title: '新' }, t0 + 1000);
    expect(s.recentWatching(2).map((x) => x.title)).toEqual(['新', '旧']);
  });
});

describe('renderWatching · 只给事实', () => {
  it('没有记录时不注入（不占 token）', () => {
    expect(mk().renderWatching()).toBe('');
  });

  it('说出看了什么、什么时候，但不下"所以你爱看X"的结论', () => {
    const s = mk();
    s.addWatching({ title: '华为配置专题03', note: '讲了 DHCP VLAN 的配置步骤' });
    const t = s.renderWatching();
    expect(t).toContain('华为配置专题03');
    expect(t).toContain('今天');
    expect(t).toContain('讲了 DHCP VLAN');
    // 不能替她下结论
    expect(t).not.toContain('你喜欢');
    expect(t).not.toContain('所以你');
  });

  it('久一点的显示"几天前"', () => {
    const s = mk();
    s.addWatching({ title: '老片子' }, Date.now() - 3 * 86_400_000);
    expect(s.renderWatching()).toContain('3 天前');
  });
});

describe('持久化 · 和 findings 分开存', () => {
  it('watching 不影响 findings（冲浪不会挤掉经历）', () => {
    const s = mk();
    s.touchInterest('咖啡');
    // 冲浪刷满 findings
    for (let i = 0; i < 10; i++) s.addFinding('咖啡', `搜到第${i}条`);
    const f = s.snapshot().interests[0]!.findings!;
    expect(f.length).toBeLessThanOrEqual(8);

    // 她自己的经历仍在
    s.addWatching({ title: '看了一个视频' });
    expect(s.recentWatching(1)).toHaveLength(1);
  });

  it('重建实例能读回（真的落盘了）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watching-p-'));
    const a = new SelfProfileService(dir);
    a.addWatching({ title: 'A', ref: 'BV1', note: '不错' });
    const b = new SelfProfileService(dir);
    expect(b.recentWatching(1)[0]!.note).toBe('不错');
  });

  it('老文件没有 watching 字段时读成空数组', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watching-legacy-'));
    const a = new SelfProfileService(dir);
    a.save();
    const file = path.join(dir, 'self.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.watching;
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
    expect(new SelfProfileService(dir).recentWatching(5)).toEqual([]);
  });
});
