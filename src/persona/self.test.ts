/**
 * 兴趣 findings 的写入语义（2026-11-12 去重修复）
 * ─────────────────────────────────────────────────────────────
 * 这些测试防的是一个**实测发生过**的坏样子，不是为了覆盖率：
 *
 * 修之前 `addFinding` 只按 topic 找条目，然后 `push` + `while(>8) shift()`，
 * 没有任何内容判据。于是每轮冲浪都把同一批网页原样再写一遍：
 *   · `self.json` 里「咖啡」8 条 findings 只有 3 条内容不同；
 *   · 「读书 书单」8 条里只有 4 条不同；
 *   · 11-12 08:06 那轮把 11-11 21:29 的同一批又完整写了一遍。
 *
 * 关键不是"数字难看"：8 格被 3~4 篇网页的重复副本占满之后，
 * 真新内容一进来就把旧的 shift 掉 —— 重复**让记忆变少**。
 *
 * 所以这里断言两件事：
 *   1. 同一内容重复写 → 只有一格，且 `at` 被推到最新（"又看了一遍"是续命信号）；
 *   2. 去重**不能**顺手把 M30 的续命语义弄丢（重复阅读也是投入）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfProfileService } from './self.ts';

function mkSelf(): { svc: SelfProfileService; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-findings-'));
  return { svc: new SelfProfileService(dir), dir };
}

/** 造一个带「咖啡」兴趣的实例（addFinding 只对已存在的 topic 生效） */
function mkWithTopic(): { svc: SelfProfileService; dir: string } {
  const { svc, dir } = mkSelf();
  svc.touchInterest('咖啡');
  return { svc, dir };
}

function findingsOf(svc: SelfProfileService): Array<{ at: number; summary: string; source?: string }> {
  return svc.snapshot().interests[0]?.findings ?? [];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('addFinding · 内容去重', () => {
  it('同一 summary 连写 3 次只留 1 条，at 更新为最新', () => {
    const { svc } = mkWithTopic();
    const t0 = 1_800_000_000_000;
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(t0);
    svc.addFinding('咖啡', '一篇讲手冲水温的文章');
    now.mockReturnValue(t0 + 1000);
    svc.addFinding('咖啡', '一篇讲手冲水温的文章');
    now.mockReturnValue(t0 + 2000);
    svc.addFinding('咖啡', '一篇讲手冲水温的文章');

    const f = findingsOf(svc);
    expect(f).toHaveLength(1);
    expect(f[0]!.summary).toBe('一篇讲手冲水温的文章');
    expect(f[0]!.at).toBe(t0 + 2000);
  });

  it('无 URL 时按摘要判重（这是 qq_mark_interest 的 note 路径）', () => {
    const { svc } = mkWithTopic();
    svc.addFinding('咖啡', '喜欢浅烘的酸');
    svc.addFinding('咖啡', '喜欢浅烘的酸');
    expect(findingsOf(svc)).toHaveLength(1);
  });

  it('摘要只差空白/标点也算同一条（抓取两次标点会变，汉字不会）', () => {
    const { svc } = mkWithTopic();
    svc.addFinding('咖啡', '手冲水温 92 度，研磨度中细。');
    svc.addFinding('咖啡', '手冲水温 92 度, 研磨度中细');
    svc.addFinding('咖啡', '  手冲水温92度，研磨度中细！！ ');
    expect(findingsOf(svc)).toHaveLength(1);
  });

  it('同 URL 不同 summary 也算重复（按 source 判，标题被改写不算新）', () => {
    const { svc } = mkWithTopic();
    const url = 'https://example.com/a';
    svc.addFinding('咖啡', '[咖啡，你喝对了吗] 早上先接一杯', url);
    svc.addFinding('咖啡', '[咖啡你喝对了吗？] 早上先接一杯，下午再来一杯', url);
    const f = findingsOf(svc);
    expect(f).toHaveLength(1);
    // 保留首次写入的摘要（不因重复写入把内容改写成另一条）
    expect(f[0]!.summary).toContain('早上先接一杯');
    expect(f[0]!.source).toBe(url);
  });

  it('URL 尾部斜杠 / host 大小写差异视为同一个 source', () => {
    const { svc } = mkWithTopic();
    svc.addFinding('咖啡', 'A', 'https://Example.com/x/');
    svc.addFinding('咖啡', 'B', 'https://example.com/x');
    expect(findingsOf(svc)).toHaveLength(1);
  });

  it('http / https 与 www. 前缀差异视为同一个 source', () => {
    const { svc } = mkWithTopic();
    svc.addFinding('咖啡', 'A', 'http://www.example.com/x');
    svc.addFinding('咖啡', 'B', 'https://example.com/x');
    expect(findingsOf(svc)).toHaveLength(1);
  });

  it('路径大小写不同 → 不合并（路径可能区分大小写，误并等于丢数据）', () => {
    const { svc } = mkWithTopic();
    // 宁可留一条"看着像重复"的，也不要把两篇不同的内容合成一篇
    svc.addFinding('咖啡', 'A', 'https://example.com/wiki/Coffee');
    svc.addFinding('咖啡', 'B', 'https://example.com/wiki/coffee');
    expect(findingsOf(svc)).toHaveLength(2);
  });

  it('查询串不同 → 不合并（不同参数常是不同的页面内容）', () => {
    const { svc } = mkWithTopic();
    svc.addFinding('咖啡', 'A', 'https://example.com/s?q=1');
    svc.addFinding('咖啡', 'B', 'https://example.com/s?q=2');
    expect(findingsOf(svc)).toHaveLength(2);
  });

  it('不同内容正常追加', () => {
    const { svc } = mkWithTopic();
    svc.addFinding('咖啡', '第一篇', 'https://example.com/1');
    svc.addFinding('咖啡', '第二篇', 'https://example.com/2');
    svc.addFinding('咖啡', '第三篇');
    expect(findingsOf(svc).map((f) => f.summary)).toEqual(['第一篇', '第二篇', '第三篇']);
  });

  it('不同 URL + 不同摘要各自留一格（不同网页是不同情报）', () => {
    const { svc } = mkWithTopic();
    for (let i = 0; i < 5; i++) svc.addFinding('咖啡', `第${i}篇`, `https://example.com/${i}`);
    expect(findingsOf(svc)).toHaveLength(5);
  });

  it('不同 URL 但摘要相同 → 仍留两格（URL 优先，出处不同就是两条）', () => {
    const { svc } = mkWithTopic();
    // 同一篇被转载到两个站：摘要一样，出处不同。
    // 这里刻意选择"不合并"—— 两个 URL 是两条可回溯的线索，
    // 因为前 40 字撞了就吞掉一条，等于悄悄丢信息。
    svc.addFinding('咖啡', '[咖啡你喝对了吗] 早上先接一杯', 'https://a.example.com/x');
    svc.addFinding('咖啡', '[咖啡你喝对了吗] 早上先接一杯', 'https://b.example.com/y');
    expect(findingsOf(svc)).toHaveLength(2);
    expect(findingsOf(svc).map((f) => f.source)).toEqual([
      'https://a.example.com/x',
      'https://b.example.com/y',
    ]);
  });

  it('老数据缺 source 时按摘要命中，并补上出处', () => {
    const { svc } = mkWithTopic();
    // 旧条目没有 source（history 里真实存在这种）
    svc.addFinding('咖啡', '一篇关于手冲的文章');
    svc.addFinding('咖啡', '一篇关于手冲的文章', 'https://example.com/handpour');
    const f = findingsOf(svc);
    expect(f).toHaveLength(1);
    expect(f[0]!.source).toBe('https://example.com/handpour');
  });
});

describe('addFinding · 上限 8 条', () => {
  it('真新内容超 8 条时 shift 掉最旧的', () => {
    const { svc } = mkWithTopic();
    for (let i = 0; i < 12; i++) svc.addFinding('咖啡', `第${i}篇`, `https://example.com/${i}`);
    const f = findingsOf(svc);
    expect(f).toHaveLength(8);
    // 留下的是最后 8 条
    expect(f[0]!.summary).toBe('第4篇');
    expect(f[7]!.summary).toBe('第11篇');
  });

  it('重复写不会把长度顶到 8 条以上，也不会挤掉别的条目', () => {
    const { svc } = mkWithTopic();
    svc.addFinding('咖啡', 'A', 'https://example.com/a');
    svc.addFinding('咖啡', 'B', 'https://example.com/b');
    for (let i = 0; i < 10; i++) svc.addFinding('咖啡', 'A', 'https://example.com/a');
    const f = findingsOf(svc);
    expect(f).toHaveLength(2);
    expect(f.map((x) => x.summary)).toEqual(['A', 'B']);
  });
});

describe('addFinding · 去重不影响 M30 的续命语义', () => {
  it('重复写入同样刷新 lastAt（"又看了一遍"是投入）', () => {
    const { svc } = mkWithTopic();
    const e0 = svc.snapshot().interests[0]!;
    e0.lastAt = Date.now() - 5 * 24 * 3600_000;
    const before = e0.lastAt;

    svc.addFinding('咖啡', '一篇关于手冲的文章');
    svc.addFinding('咖啡', '一篇关于手冲的文章');

    expect(svc.snapshot().interests[0]!.lastAt).toBeGreaterThan(before);
    expect(findingsOf(svc)).toHaveLength(1);
  });

  it('重复写入同样刷新 lastSurfAt', () => {
    const { svc } = mkWithTopic();
    svc.addFinding('咖啡', 'X', 'https://example.com/x');
    const first = svc.snapshot().lastSurfAt ?? 0;

    const t = first + 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(t);
    svc.addFinding('咖啡', 'X', 'https://example.com/x');

    expect(svc.snapshot().lastSurfAt).toBe(t);
  });

  it('topic 不存在时静默返回（不抛、不新建）', () => {
    const { svc } = mkSelf();
    expect(() => svc.addFinding('不存在的兴趣', 'x')).not.toThrow();
    expect(svc.snapshot().interests).toHaveLength(0);
  });
});

describe('addFinding · 落盘', () => {
  it('去重后的结果重建实例能读回（真的写进 self.json）', () => {
    const { svc, dir } = mkWithTopic();
    svc.addFinding('咖啡', 'A', 'https://example.com/a');
    svc.addFinding('咖啡', 'A', 'https://example.com/a');

    const fresh = new SelfProfileService(dir);
    const f = fresh.snapshot().interests[0]!.findings ?? [];
    expect(f).toHaveLength(1);
    expect(f[0]!.summary).toBe('A');
    expect(f[0]!.source).toBe('https://example.com/a');
  });

  it('老数据里已经堆了重复时，再写一次会把它们的时间一起续上（不再新增）', () => {
    const { svc, dir } = mkWithTopic();
    // 手工造一段"修之前"的坏数据：同一 URL 三条
    const file = path.join(dir, 'self.json');
    svc.addFinding('咖啡', 'A', 'https://example.com/a');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const dup = { at: 1, summary: 'A(旧)', source: 'https://example.com/a' };
    raw.interests[0].findings = [dup, { ...dup }, { ...dup }];
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');

    const svc2 = new SelfProfileService(dir);
    const t = 1_900_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t);
    svc2.addFinding('咖啡', 'A', 'https://example.com/a');

    const f = svc2.snapshot().interests[0]!.findings ?? [];
    // 不新增（长度仍是 3 —— 历史重复由上限慢慢自然淘汰，不在这里删数据）
    expect(f).toHaveLength(3);
    expect(f.every((x) => x.at === t)).toBe(true);
  });
});
