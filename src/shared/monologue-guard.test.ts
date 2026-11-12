/**
 * monologue-guard 测试
 *
 * 样本直接取自 2026-11-12 群里真实发出去的那条（脱敏保留原文）。
 */
import { describe, expect, it } from 'vitest';
import { stripModelMonologue } from './monologue-guard.ts';

const LEAKED = '小周那幻影刺客参团倒是积极，就是没一次真切进去，存在感全靠蹭。 '
  + '铭鑫这把15杀0死，是真不给人留活路。 '
  + 'also i keep repeating this. Let me vary — but the instruction says one person only. '
  + 'Actually I already output two lines. Let me just pick one and be brief. '
  + 'But this is a fresh turn — need to answer this turn only.'
  + '小周这幻影刺客参团26次，跟跑堂似的转了一圈，真打起来一次都没进去。';

describe('stripModelMonologue', () => {
  it('挖掉中段英文独白，前后中文都保留', () => {
    const out = stripModelMonologue(LEAKED);
    expect(out).not.toMatch(/let me vary/i);
    expect(out).not.toMatch(/the instruction says/i);
    expect(out).toContain('存在感全靠蹭');
    expect(out).toContain('跟跑堂似的转了一圈');
    // 两句中文之间不该留下双空格或断句残渣
    expect(out).not.toMatch(/\s{2,}/);
  });

  it('正常中文回复原样返回', () => {
    const text = '小周那幻影刺客参团倒是很积极，就是一次都没真正切进去。';
    expect(stripModelMonologue(text)).toBe(text);
  });

  it('纯英文回复不碰（可能是她正常用英文说话）', () => {
    const text = 'Let me explain: the patch changed the lane equilibrium.';
    expect(stripModelMonologue(text)).toBe(text);
  });

  it('中英混排但没有独白特征 → 原样返回', () => {
    const text = '这局 Tiny 打得不错，GG 对面。';
    expect(stripModelMonologue(text)).toBe(text);
  });

  it('独白在结尾 → 截掉尾巴，保留中文', () => {
    const text = '这局就是送。let me just be brief';
    const out = stripModelMonologue(text);
    expect(out).toBe('这局就是送。');
  });

  it('独白在开头 → 去掉前导英文，保留中文', () => {
    const text = 'I already output two lines.这局确实没打好。';
    expect(stripModelMonologue(text)).toBe('这局确实没打好。');
  });

  it('空串安全', () => {
    expect(stripModelMonologue('')).toBe('');
  });
});
