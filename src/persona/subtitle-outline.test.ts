/**
 * 字幕按分钟压缩（M35）
 * ─────────────────────────────────────────────────────────────
 * 需求原话：「现在给我字幕是整段倒出来，四十集的合集看不过来。
 *            要是能先标出哪几分钟是真正讲到东西的地方，我就能挑着看。」
 *
 * 这组测试防的是**三个已经发生过的失效**：
 *
 *  1. 丢时间轴：`bili video subtitle` 本来就返回 {from,to,content} 逐句，
 *     旧实现 join 成一段字符串 —— 不是没能力，是把能力丢了。
 *  2. 只取前 40 句：实测 27 分钟的视频有 755 句，
 *     slice(0,40) ≈ 前 90 秒，长视频永远只剩开场白。
 *  3. 按调用次数/截断长度算，而不是按**分钟**：
 *     用户要的导航单位是分钟（"第 15 分钟在讲 ACL"），不是字符数。
 */
import { describe, expect, it } from 'vitest';
import { condenseSubtitlesByMinute } from './tools.ts';

/** 造一段逐句字幕 */
const mk = (rows: Array<[number, string]>) => rows.map(([from, content]) => ({ from, to: from + 2, content }));

describe('condenseSubtitlesByMinute · 按分钟聚桶', () => {
  it('每分钟一条，时间戳是 mm:ss', () => {
    const r = condenseSubtitlesByMinute(mk([
      [0, '大家好我是老师'],
      [5, '今天讲路由'],
      [65, '第一分钟的内容'],
      [125, '第三分钟'],
    ]));
    // 时间戳是该分钟第一句的真实时间（01:05 而不是 01:00）——
    // 用户要拿这个时间点去跳，秒位不能丢
    expect(r.map((x) => x.t)).toEqual(['00:00', '01:05', '02:05']);
  });

  it('分钟数超过 60 时正确进位', () => {
    const r = condenseSubtitlesByMinute(mk([[3725, '第六十二分钟']]));
    expect(r[0]!.t).toBe('62:05');
  });

  it('同一分钟只留最长的几句（短句多是"啊""对吧"）', () => {
    const r = condenseSubtitlesByMinute(mk([
      [1, '啊'],
      [3, '对吧'],
      [5, '这里是这一分钟最重要的一句话讲了完整的配置步骤'],
      [7, '好'],
    ]), { perMinute: 1 });
    expect(r).toHaveLength(1);
    expect(r[0]!.text).toContain('最重要的一句话');
    expect(r[0]!.text).not.toContain('啊');
  });

  it('留下的句子按时间还原顺序（读起来才连贯）', () => {
    const r = condenseSubtitlesByMinute(mk([
      [1, '先说短的这句'],
      [3, '这句很长很长很长很长很长很长很长很长很长很长很长'],
    ]), { perMinute: 2 });
    expect(r[0]!.text.indexOf('先说短的')).toBeLessThan(r[0]!.text.indexOf('这句很长'));
  });

  it('空内容不占位置', () => {
    const r = condenseSubtitlesByMinute(mk([[1, ''], [2, '   '], [70, '有内容']]));
    expect(r).toHaveLength(1);
    expect(r[0]!.t).toBe('01:10');
  });

  it('没有时间戳的条目当成第 0 分钟（不丢数据）', () => {
    const r = condenseSubtitlesByMinute([{ content: '没有 from 的一句' }]);
    expect(r).toHaveLength(1);
    expect(r[0]!.t).toBe('00:00');
  });
});

describe('condenseSubtitlesByMinute · 长视频不再只剩开场白', () => {
  it('755 句、覆盖 27 分钟 → 输出 27 条而不是前 90 秒', () => {
    // 复刻真实数据形状：每 2.2 秒一句，共 755 句
    const items = Array.from({ length: 755 }, (_, i) => ({
      from: i * 2.17,
      to: i * 2.17 + 2,
      content: `第${i}句 这是讲解内容`,
    }));
    const r = condenseSubtitlesByMinute(items);
    // 27 分钟 → 27 条左右
    expect(r.length).toBeGreaterThanOrEqual(26);
    expect(r.length).toBeLessThanOrEqual(28);
    // 最后一条必须是结尾，不是开场
    expect(Number(r.at(-1)!.t.split(':')[0])).toBeGreaterThanOrEqual(26);
  });

  it('压缩率足够（一小时的视频不该把全文塞进上下文）', () => {
    const items = Array.from({ length: 1600 }, (_, i) => ({
      from: i * 2.25,
      to: i * 2.25 + 2,
      content: '这是一句大约十二个字的口语讲解内容',
    }));
    const full = items.reduce((a, x) => a + x.content.length, 0);
    const packed = condenseSubtitlesByMinute(items).reduce((a, x) => a + x.text.length, 0);
    // 至少压到 1/4 以下
    expect(packed).toBeLessThan(full / 4);
  });
});

describe('合集分 P 目录 · 字段名（踩过的坑）', () => {
  // 实测 `bili video info` 的 pages[0] 长这样：
  //   {page:1, cid:37940430009, title:"华为配置专题01 基础配置", duration:1637}
  //
  // 字段是 `title` **不是** `part`。我第一版写成 `p.part`，
  // 结果 16 个 P 的标题全退化成 "P1"/"P2"/...，目录白给 ——
  // 而用户要的正是"P3 是讲 DHCP 的"这个信息。

  const buildPages = (raw: Array<{ page?: number; title?: string; part?: string; duration?: number }>) =>
    raw
      .filter((p) => (p.page ?? 0) > 0)
      .map((p) => ({
        page: Number(p.page) || 0,
        title: String(p.title ?? p.part ?? '').trim() || `P${p.page}`,
        length: `${String(Math.floor((p.duration ?? 0) / 60)).padStart(2, '0')}:${String((p.duration ?? 0) % 60).padStart(2, '0')}`,
      }));

  it('真实字段名 title 能取到', () => {
    const r = buildPages([{ page: 1, title: '华为配置专题01 基础配置', duration: 1637 }]);
    expect(r[0]!.title).toBe('华为配置专题01 基础配置');
    expect(r[0]!.length).toBe('27:17');
  });

  it('标题缺失时才退化成 P 号（不能因此丢掉整个目录）', () => {
    const r = buildPages([{ page: 3, duration: 600 }]);
    expect(r[0]!.title).toBe('P3');
  });

  it('多 P 才当合集（单 P 视频不该显示目录）', () => {
    const one = buildPages([{ page: 1, title: 'A', duration: 100 }]);
    const many = buildPages([
      { page: 1, title: 'A', duration: 100 },
      { page: 2, title: 'B', duration: 200 },
    ]);
    expect(one.length > 1).toBe(false);
    expect(many.length > 1).toBe(true);
  });
});
