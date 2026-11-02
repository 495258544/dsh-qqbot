/**
 * 冲浪内容质量 · 回归测试（M26）
 * ─────────────────────────────────────────────────────────────
 * 实测问题（2026-11-02）：抓回来的"见闻"是 SEO 垃圾 ——
 *   [咖啡] → "咖啡（百度百科）"、"咖啡推荐：分不清意式…"
 *   [AI]  → "AI工具集官网 | 1000+ AI工具集合"
 *   [游戏] → "Poki 在线游戏"
 * 全是导航站/百科首页，她拿去聊天只能说空话。
 */
import { describe, expect, it } from 'vitest';
import { isMeaningful, refineQuery, queryIntent } from './surf.ts';

describe('isMeaningful · 挡掉导航站和百科首页', () => {
  it('实测抓到的真实垃圾全部被挡', () => {
    const realJunk = [
      { title: 'AI工具集官网 | 1000+ AI工具集合', link: 'https://ai-bot.cn/', description: '' },
      { title: '咖啡（百度百科）', link: 'https://baike.baidu.com/item/咖啡/29518', description: '咖啡是以烘焙研磨后的咖啡豆制成的饮品，云南省是中国咖啡的核心产区'.repeat(2) },
      { title: 'Poki 在线游戏', link: 'https://poki.com/zh', description: '' },
      { title: '经典游戏 - 免费在线玩!', link: 'https://poki.com/zh/经典', description: '' },
      { title: '今日游戏 - 最新手游发布 - TapTap', link: 'https://www.taptap.cn/app-calendar', description: '' },
    ];
    for (const j of realJunk) {
      expect(isMeaningful(j), j.title).toBe(false);
    }
  });

  it('有实际内容的文章才留下', () => {
    const good = {
      title: '不想再瞎喝咖啡了！3分钟入门了解咖啡的分类',
      link: 'https://zhuanlan.zhihu.com/p/381787021',
      description: '中度烘焙的咖啡是日常生活中最常见的类型，是制作拿铁、美式咖啡等常见咖啡饮品的常用选择，这种烘焙程度能够突出咖啡豆的焦糖化',
    };
    expect(isMeaningful(good)).toBe(true);
  });

  it('描述太短（只有标题堆砌）也挡掉', () => {
    expect(isMeaningful({ title: '一个看起来正常的标题啊啊啊', link: 'https://x.com/a', description: '很短' })).toBe(false);
  });
});

describe('refineQuery · 让查询偏向真实内容', () => {
  it('裸关键词加"经验 心得"', () => {
    expect(refineQuery('咖啡')).toBe('咖啡 经验 心得');
  });

  it('已有修饰词就不重复加', () => {
    for (const t of ['咖啡 推荐', '跑步 经验', '怎么学吉他', '相机 评测']) {
      expect(refineQuery(t), t).toBe(t);
    }
  });

  it('空词原样返回', () => {
    expect(refineQuery('')).toBe('');
  });
});

describe('按查询意图过滤（用户指出：不能一刀切挡百科）', () => {
  it('概念型查询允许百科 —— 「什么是通货膨胀」时百科就是最佳答案', () => {
    const wiki = {
      title: '通货膨胀 - 百度百科',
      link: 'https://baike.baidu.com/item/通货膨胀',
      description: '通货膨胀指整体物价水平持续上升，货币购买力下降的经济现象，通常由货币供应量增加引起',
    };
    expect(isMeaningful(wiki, 'concept')).toBe(true);
  });

  it('经验型查询挡掉百科 —— 「咖啡 推荐」时百科没用', () => {
    const wiki = {
      title: '咖啡 - 百度百科',
      link: 'https://baike.baidu.com/item/咖啡',
      description: '咖啡是以烘焙研磨后的咖啡豆制成的饮品，云南省是中国咖啡核心产区',
    };
    expect(isMeaningful(wiki, 'experience')).toBe(false);
  });

  it('纯导航站无论什么意图都挡掉', () => {
    const nav = { title: 'Poki 在线游戏', link: 'https://poki.com/zh', description: '' };
    expect(isMeaningful(nav, 'concept')).toBe(false);
    expect(isMeaningful(nav, 'experience')).toBe(false);
  });

  it('queryIntent 能区分「求解释」和「求经验」', () => {
    // 明确求解释 → concept
    expect(queryIntent('什么是通货膨胀')).toBe('concept');
    expect(queryIntent('量子纠缠的原理')).toBe('concept');
    expect(queryIntent('X 和 Y 有什么区别')).toBe('concept');
    // 明确求经验 → experience
    expect(queryIntent('咖啡 推荐')).toBe('experience');
    expect(queryIntent('跑步 经验')).toBe('experience');
    expect(queryIntent('这个怎么选')).toBe('experience');
    // 裸词默认 experience（想看看别人怎么说；真要查定义会带"是什么/原理"）
    expect(queryIntent('咖啡')).toBe('experience');
  });

  it('概念型查询不加"经验 心得"（否则会把百科挤下去）', () => {
    expect(refineQuery('什么是通货膨胀')).toBe('什么是通货膨胀');
    expect(refineQuery('咖啡')).toBe('咖啡 经验 心得');
  });
});
