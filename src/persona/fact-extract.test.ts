/**
 * M23 硬触发 · 回归测试
 * ─────────────────────────────────────────────────────────────
 * 真实失效（2026-11-01 实测，两处独立证据）：
 *   diary/          0 个文件
 *   people.json     3 个人 89 次交互 → 实质记忆 0 条（只剩裸计数）
 *
 * 根因（小黑盒那篇文章的说法在我们这儿完全对上）：
 *   **指望模型自觉调工具写记忆 ≈ 不写。** 群聊实测 0 次。
 *
 * 所以改成系统硬触发。这里锁住抽取质量：
 *   - 该抽的抽到
 *   - 不该抽的（闲聊/情绪/隐私）一律不抽
 *   - 日记只写当天真发生过的事，不编造
 */
import { describe, expect, it } from 'vitest';
import { extractFact, extractTrait } from './fact-extract.ts';
import { pickDiaryMaterial, composeDiaryText, shouldWriteDiary } from './diary-auto.ts';

describe('extractFact · 该抽的', () => {
  it('自我介绍类', () => {
    expect(extractFact('我是做前端开发的')?.fact).toContain('前端');
    expect(extractFact('我在腾讯上班')?.fact).toContain('腾讯');
    expect(extractFact('我住在杭州')?.fact).toContain('杭州');
  });

  it('具体经历', () => {
    expect(extractFact('我昨天去看了一场演唱会')?.fact).toContain('演唱会');
  });

  it('喜好', () => {
    expect(extractFact('我喜欢喝美式')?.fact).toContain('美式');
  });

  it('宠物（短语序也要中）', () => {
    expect(extractFact('我家养了只橘猫')?.fact).toContain('橘猫');
  });

  it('计划', () => {
    expect(extractFact('我明天要去医院复查')?.fact).toContain('医院');
  });
});

describe('extractFact · 不该抽的（宁可少抽，不可错抽）', () => {
  it('闲聊/情绪不抽', () => {
    for (const t of ['今天好热', '卡了就别催了 我这边也动不了', '啊 这就超限了', '就这样吧', '这活我接']) {
      expect(extractFact(t), t).toBeUndefined();
    }
  });

  it('单字应答不抽', () => {
    for (const t of ['嗯', '好', '啊', '哦']) expect(extractFact(t), t).toBeUndefined();
  });

  it('隐私一律不记（错记比不记更糟）', () => {
    for (const t of ['我密码是123456', '我的身份证号是xxx', '我手机号13800138000']) {
      expect(extractFact(t), t).toBeUndefined();
    }
  });
});

describe('extractTrait · 只从强信号下结论', () => {
  it('主动关心 → 会照顾人', () => {
    expect(extractTrait('你早点睡吧')).toContain('照顾');
  });

  it('普通问候不下结论', () => {
    expect(extractTrait('你也早点休息')).toBeUndefined();
  });

  it('连续追问 → 好奇', () => {
    expect(extractTrait('你怎么知道的？为什么？')).toContain('好奇');
  });
});

describe('diary-auto · 日记不编造', () => {
  it('没有对话 → 不写（空正文）', () => {
    const m = pickDiaryMaterial([]);
    expect(composeDiaryText(m)).toBe('');
  });

  it('有对话 → 只写真实发生的人和话题', () => {
    const turns = [
      { t: 1, where: 'group:g', who: 'jmx的大蠢鱼', text: '今天加班到十点', reply: '累坏了吧' },
      { t: 2, where: 'group:g', who: '……', text: '我养了只橘猫', reply: '哦？' },
    ];
    const m = pickDiaryMaterial(turns);
    expect(m.people).toContain('jmx的大蠢鱼');
    const text = composeDiaryText(m);
    expect(text).toContain('jmx的大蠢鱼');
    // 不出现"今天学到了很多"这类空话
    expect(text).not.toContain('学到了');
    expect(text).not.toContain('充实');
  });

  it('当天没聊 → 不触发', () => {
    expect(shouldWriteDiary(0, false)).toBe(false);
  });

  it('当天已写过 → 不重复触发', () => {
    expect(shouldWriteDiary(10, true)).toBe(false);
  });

  it('当天有对话且没写过 → 触发', () => {
    expect(shouldWriteDiary(10, false)).toBe(true);
  });
});
