/**
 * 装备中文名对照表测试
 * ─────────────────────────────────────────────────────────────
 * 这张表的价值只有一条：**绝不出错**。
 * 所以除了"该有的有"，还要钉住几条最容易被译错的：
 *   Maelstrom=漩涡（不是狂战斧）、Mjollnir=雷神之锤、Battle Fury=狂战斧。
 * 2026-11-16：聊天里暴露过「Maelstrom 说成狂战斧」，这条要一直守着。
 */
import { describe, expect, it } from 'vitest';
import { ITEM_NAME_ZH, itemNameZh } from './item-zh.ts';

describe('itemNameZh · 容易混淆的那几件', () => {
  it('Maelstrom 是漩涡，不是狂战斧', () => {
    expect(itemNameZh('Maelstrom')).toBe('漩涡');
  });

  it('Battle Fury 才是狂战斧', () => {
    expect(itemNameZh('Battle Fury')).toBe('狂战斧');
  });

  it('Mjollnir 是雷神之锤', () => {
    expect(itemNameZh('Mjollnir')).toBe('雷神之锤');
  });

  it('三件同名组件的译名各不相同', () => {
    expect(itemNameZh('Blade of Alacrity')).toBe('敏捷之刃');
    expect(itemNameZh('Ogre Axe')).toBe('食人魔之斧');
    expect(itemNameZh('Staff of Wizardry')).toBe('巫师之杖');
  });
});

describe('itemNameZh · 未收录与边界', () => {
  it('未收录的英文原名原样返回 undefined（调用方保留英文）', () => {
    // Point Booster / Chasm Stone / Khanda 这些故意不收：译名没把握，宁可留英文
    expect(itemNameZh('Point Booster')).toBeUndefined();
    expect(itemNameZh('Khanda')).toBeUndefined();
    expect(itemNameZh('Chasm Stone')).toBeUndefined();
    expect(itemNameZh('这件装备不存在')).toBeUndefined();
  });

  it('空串返回 undefined，不返回空中文名', () => {
    expect(itemNameZh('')).toBeUndefined();
    expect(itemNameZh('   ')).toBeUndefined();
  });

  it('大小写敏感：不会把大小写不同的名字也命中', () => {
    expect(itemNameZh('maelstrom')).toBeUndefined();
  });

  it('配方名不会被误命中（Dagon 与 Dagon Recipe 是两件事）', () => {
    expect(itemNameZh('Dagon')).toBe('达贡之神力');
    expect(itemNameZh('Dagon Recipe')).toBeUndefined();
  });
});

describe('ITEM_NAME_ZH · 表的整体约束', () => {
  it('覆盖足够多的常见装备（至少 120 条）', () => {
    expect(Object.keys(ITEM_NAME_ZH).length).toBeGreaterThanOrEqual(120);
  });

  it('没有空值、没有空 key', () => {
    for (const [en, zh] of Object.entries(ITEM_NAME_ZH)) {
      expect(en.trim()).not.toBe('');
      expect(zh.trim()).not.toBe('');
    }
  });

  it('每条中文名都是真中文（防止手滑打成英文）', () => {
    for (const [en, zh] of Object.entries(ITEM_NAME_ZH)) {
      expect(zh, `${en} 的中文名不像中文`).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});
