/**
 * Humanizer.split · 长回复的分条规则（2026-11-06 修）
 * ─────────────────────────────────────────────────────────────
 * 用户反馈她「又是一大段，AI 味太重」。查下来一部分是**机器造成的**：
 *
 * 旧实现超出条数上限时用 `merged.slice(max-1).join(' ')` 把余量全拼成一条，
 * 后果有两个：
 *   ① 一条 439 字 / 6 段的回复被切成「12 字 + 427 字」—— 分配极不均衡；
 *   ② 那 427 字里段落分隔被**空格**替换，在 QQ 上就是一个没有换行的巨块。
 *
 * 也就是说「她写了一坨」这个观感有一半来自这里，不是她写成一坨。
 * 修法：按长度均衡装桶，桶内保留换行；只有单段本身超长才按句切开。
 * 条数上限仍是 burstMax（官方 API 同一 msgId 被动回复限 4 次，要留额度）。
 */
import { describe, it, expect } from 'vitest';
import { Humanizer } from './humanize.ts';

/** 复刻线上那条真实回复（439 字 / 6 段） */
const REAL_CASE = [
  '查了一下，拼查询是两段。',
  '先是话题本身。话题来自我记下的兴趣，比如「手冲咖啡的细节参数」——这一个是我自己写的，不是它自动生成的。',
  '然后是一层加工，规则是这样的：短的（十二字以内）原样拿去搜；长的、带口语虚词的（「把」「讲得」「那种」这类），先切碎、只留后面两个名词当核心词，再拼上「经验 心得」这种「人写的东西」的标记。概念型的查询不加，因为那时候百科反而是好来源。',
  '问题就出在这两步上。第一，我写兴趣时容易写成半句话（「把小事讲得很慢的散文和随笔」），它一刀切下去只剩「散文 随笔」，太宽了。第二，「经验 心得」是我想让它别回字典页才加的，但它不加区分，所有非概念查询都挂上，反而把搜索压扁到科普那一层。',
  '今天那次能搜到 C40 的内容，是因为我直接把问题写成了「手冲咖啡研磨度 C40 该调到几格」——带着具体的东西。所以关键不在长短，在词里有没有能被搜到的东西。',
  '这条我想记下来：以后记兴趣别写形容词，写具体的名词。',
].join('\n\n');

const n = (s: string) => [...s].length;

describe('Humanizer.split · 超出条数上限时不再拼成一坨', () => {
  it('条数不超过 burstMax', () => {
    expect(new Humanizer({ burstMax: 2 }).split(REAL_CASE, 2).length).toBeLessThanOrEqual(2);
  });

  it('回归：439 字不再变成「12 字 + 427 字」', () => {
    const parts = new Humanizer({ burstMax: 2 }).split(REAL_CASE, 2);
    // 旧实现第一条恒为 12 字、第二条 427 字
    expect(n(parts[0]!)).toBeGreaterThan(50);
    expect(parts.every((p) => n(p) < 300)).toBe(true);
  });

  it('分配是均衡的（两段长度接近，不再全倒进最后一条）', () => {
    const [a, b] = new Humanizer({ burstMax: 2 }).split(REAL_CASE, 2);
    const ratio = n(a!) / n(b!);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(2.5);
  });

  it('桶内保留换行（段落结构不被空格替换）', () => {
    const parts = new Humanizer({ burstMax: 2 }).split(REAL_CASE, 2);
    expect(parts.some((p) => p.includes('\n'))).toBe(true);
  });

  it('内容不丢：分条后拼起来覆盖原文的每一段', () => {
    const parts = new Humanizer({ burstMax: 2 }).split(REAL_CASE, 2);
    const joined = parts.join('\n');
    for (const para of REAL_CASE.split('\n\n')) {
      expect(joined).toContain(para.slice(0, 12));
    }
  });

  it('max=1（情绪低/慢速）时也保留换行，而不是空格拼接', () => {
    const parts = new Humanizer().split(REAL_CASE, 1);
    expect(parts.length).toBe(1);
    expect(parts[0]!.includes('\n')).toBe(true);
  });
});

describe('Humanizer.split · 不变的行为', () => {
  it('段数本来就够少 → 原样返回', () => {
    expect(new Humanizer().split('第一段内容比较长一些\n第二段内容也比较长\n第三段同样不短', 4)).toEqual([
      '第一段内容比较长一些',
      '第二段内容也比较长',
      '第三段同样不短',
    ]);
  });

  it('极短行（<6 字）会被合并 —— 这是原有行为，不是本次改动引入的', () => {
    expect(new Humanizer().split('第一条\n第二条\n第三条', 2)).toEqual(['第一条第二条', '第三条']);
  });

  it('空/空白 → 空数组', () => {
    expect(new Humanizer().split('   ', 2)).toEqual([]);
    expect(new Humanizer().split('', 2)).toEqual([]);
  });

  it('单段超长且无换行 → 按句切开（不产生超长单条）', () => {
    const long = '一。二。三。四。五。六。七。八。九。十。';
    const parts = new Humanizer().split(long, 2);
    expect(parts.length).toBeLessThanOrEqual(2);
  });

  it('极短行会与相邻合并（原有行为保留）', () => {
    const parts = new Humanizer({ burstMax: 4 }).split('好\n的\n今天天气不错我们出去走走吧', 4);
    expect(parts.length).toBeLessThanOrEqual(4);
  });
});
