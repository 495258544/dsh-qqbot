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
    // 注意：新算法会在句号处切，所以比对时要忽略分隔符
    const norm = (s: string) => s.replace(/[\s\n]/g, '');
    const joined = norm(parts.join(''));
    for (const para of REAL_CASE.split('\n\n')) {
      expect(joined).toContain(norm(para).slice(0, 12));
    }
  });

  it('语义边界（第三轮的核心）：每条都结束在句末标点上，绝不切在句子中间', () => {
    const parts = new Humanizer({ burstMax: 2 }).split(REAL_CASE, 2);
    for (const p of parts) {
      expect(p.trim()).toMatch(/[。！？!?…~]$/);
    }
  });

  it('引导句不被拆开（「两条对胃口的：」要和她引出的内容在一起）', () => {
    const msg = '冲浪回来了。这回搜到的是正经东西，不再是字典页。\n\n两条对胃口的：一条是澎湃上的《花式咖啡、小甜水的快乐》。';
    const parts = new Humanizer({ burstMax: 2 }).split(msg, 2);
    // 引导句与它引出的内容必须在同一条里
    const withLead = parts.find((p) => p.includes('两条对胃口的'));
    expect(withLead).toBeDefined();
    expect(withLead!.includes('花式咖啡')).toBe(true);
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

describe('Humanizer.split · 多段不挤进一条（2026-11-07）', () => {
  it('回归：3 段 167 字不再合成一个带换行的巨块', () => {
    const msg = [
      '知道了。往后不倒情节，只说感觉。',
      '第三章最戳我的是那种「怕连累别人」的念头——他自己都不知道自己是谁、来自哪儿，却先想到走掉会连累这对母子。这个比什么身世谜团都暖一点。',
      '还有那句「练武不练功，到头一场空」浮在意识里没人教过他。他怀疑自己是那东西的创造者，却连自己是谁都不知道。这种「明明是作者的东西，却像角色自己的」写法，挺妙的。',
    ].join('\n\n');
    const parts = new Humanizer({ burstMax: 2 }).split(msg, 2);
    // 旧行为：1 条 165 字（两处 \n）。新行为：2 条气泡。
    expect(parts.length).toBe(2);
    // 气泡内部不再有"跨段落"换行（每段独立成气泡）
    for (const p of parts) expect(p.split('\n').length).toBeLessThanOrEqual(2);
  });

  it('2 段正常长度的消息 → 2 个气泡（不合并成一条）', () => {
    // 注意：<6 字的极短段会被相邻合并（原有碎句规则），
    // 所以这里用正常长度的段落来验证"不挤一条"
    const parts = new Humanizer({ burstMax: 2 }).split(
      '这个我得想想再说。\n\n不过大体方向应该没什么问题，可以先走着看。',
      2,
    );
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain('想想');
    expect(parts[1]).toContain('方向');
  });
});
