/**
 * 中文分词匹配 · 回归测试（M28）
 * ─────────────────────────────────────────────────────────────
 * 借鉴 dsh-fish-memory：「分词用一份通用中文词表，所以『车』不会撞进『车站』里」。
 *
 * 我们原来用 text.includes(topic)：
 *   '车站人很多'.includes('车') → true  ❌
 *   '车厘子好吃'.includes('车')  → true  ❌
 * 后果：兴趣是「游戏」时你说「游戏厅」也会唤醒她。
 */
import { describe, expect, it } from 'vitest';
import { matchesTopic, hanSegments } from './word-match.ts';

describe('matchesTopic · 挡住语义无关的匹配', () => {
  it('单字「车」不会撞进「车站」「车厘子」', () => {
    expect(matchesTopic('车站人很多', '车')).toBe(false);
    expect(matchesTopic('车厘子好吃', '车')).toBe(false);
  });

  it('单字「车」在正常语境下仍能命中', () => {
    expect(matchesTopic('我开车去上班', '车')).toBe(true);
    expect(matchesTopic('这是车', '车')).toBe(true);
    expect(matchesTopic('打车过去', '车')).toBe(true);
  });

  it('双字词普通子串匹配（不需要特殊规则）', () => {
    expect(matchesTopic('我喜欢喝咖啡', '咖啡')).toBe(true);
    expect(matchesTopic('咖啡因让我睡不着', '咖啡')).toBe(true);
    expect(matchesTopic('我在喝茶', '咖啡')).toBe(false);
    expect(matchesTopic('新番推荐', '新番')).toBe(true);
    expect(matchesTopic('动漫不错', '新番')).toBe(false);
  });

  it('含英文/数字的词退回普通子串匹配', () => {
    expect(matchesTopic('我用AI写代码', 'AI')).toBe(true);
    expect(matchesTopic('这个很酷', 'AI')).toBe(false);
    expect(matchesTopic('3D打印好玩', '3D')).toBe(true);
  });

  it('标点/数字能正确分段', () => {
    // 「咖啡」和「茶」在同一段里，不相关的词不该被带出来
    expect(matchesTopic('咖啡，茶，还有牛奶', '茶')).toBe(true);
    expect(matchesTopic('咖啡，茶，还有牛奶', '牛奶')).toBe(true);
  });
});

describe('hanSegments · 切分连续汉字', () => {
  it('按标点/数字/英文断开', () => {
    expect(hanSegments('我买了3个苹果，很好吃')).toEqual(['我买了', '个苹果', '很好吃']);
  });

  it('纯汉字整段返回', () => {
    expect(hanSegments('今天好热')).toEqual(['今天好热']);
  });

  it('没有汉字返回空', () => {
    expect(hanSegments('hello 123')).toEqual([]);
  });
});

describe('多词型 topic（从搜索框来的兴趣）', () => {
  // 背景：兴趣是冲浪时用搜索词建的，天然带空格（"游戏 新作"、"AI 技术"）。
  // 旧逻辑对这类 topic 走 raw.includes，要求原文出现"游戏 新作"五个字符
  // （含空格）—— 人说话不会这么写。实测 124 轮对话命中 0 次。

  it('带空格的 topic 能被各部分的自然说法命中', () => {
    expect(matchesTopic('最近有什么新游戏吗', '游戏 新作')).toBe(true);
    expect(matchesTopic('聊聊AI技术吧', 'AI 技术')).toBe(true);
    expect(matchesTopic('给我推荐个书单', '读书 书单')).toBe(true);
  });

  it('原样的带空格写法当然也命中', () => {
    expect(matchesTopic('游戏 新作 推荐', '游戏 新作')).toBe(true);
  });

  it('完全不相关的话不命中（别因为拆分而变宽松到误触发）', () => {
    expect(matchesTopic('今天天气不错', '游戏 新作')).toBe(false);
    expect(matchesTopic('晚饭吃什么', 'AI 技术')).toBe(false);
  });

  it('多词 topic 的边界判定跟着各单词走，不是无脑 includes', () => {
    // "车" 单字仍然不许撞进 "车站"，即使它出现在多词 topic 里
    expect(matchesTopic('车站人很多', '车 旅行')).toBe(false);
    expect(matchesTopic('我开车去上班', '车 旅行')).toBe(true);
  });
});
