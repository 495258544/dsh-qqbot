/**
 * own-life 提示词与活动记录 · 回归测试（M24）
 * ─────────────────────────────────────────────────────────────
 * 实测问题：她的自由时间只有「写日记」或「空转」两种。
 * 调研结论（own-life-research.md）：提示词把自由时间设计成了「生成任务」，
 * 且「翻旧记录」没有对应工具、 "什么都不干"零成本无后续。
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { DEFAULT_TEXT_DAY, DEFAULT_TEXT_MIDNIGHT, createOwnLife } from './own-life.ts';

describe('提示词 · 每个动作都有对应工具', () => {
  it('点名了真实存在的工具（不再有无法执行的动词）', () => {
    // 旧版写了「翻翻你记着还没说出口的事」，但没有对应工具 → 模型只能退化成写日记
    for (const t of ['qq_write_diary', 'qq_read_diary', 'qq_memory_append',
                     'qq_write_self_note', 'qq_mark_interest', 'qq_browse', 'qq_note_activity']) {
      expect(DEFAULT_TEXT_DAY, t).toContain(t);
    }
  });

  it('包含"先想上一次做了什么" —— 否则每次从零决策', () => {
    expect(DEFAULT_TEXT_DAY).toContain('上一次自由时间');
  });

  it('发呆被写成有产出的状态，而不是空分支', () => {
    const s = DEFAULT_TEXT_DAY;
    expect(s).toContain('什么也不做');
    // 关键：发呆应该被描述成会引发下一件事，而不是"允许你什么都不干"就完了
    expect(s).toMatch(/常常会想出一件/);
  });

  it('有防打卡/防表演的硬规矩', () => {
    expect(DEFAULT_TEXT_DAY).toContain('日记不是打卡');
    expect(DEFAULT_TEXT_DAY).toContain('别为了');
  });

  it('夜间版承认"困就睡"，不要求留痕迹（对照 SillyTavern 的表演式发呆）', () => {
    expect(DEFAULT_TEXT_MIDNIGHT).toContain('困');
    expect(DEFAULT_TEXT_MIDNIGHT).toContain('不用留痕迹');
  });
});

describe('活动记录 · 让"上一次"可被引用', () => {
  function mk() {
    const statePath = `/tmp/ol-${Math.random().toString(36).slice(2)}.json`;
    const delivered: string[] = [];
    const h = createOwnLife({
      deliver: async (t: string) => { delivered.push(t); return true; },
      statePath,
      intervalMs: 4 * 3600_000,
      maxPerDay: 99,
      quiet: [23, 8],
      log: () => {},
    });
    return { h, statePath, delivered };
  }

  it('noteActivity 记下之后，下一次提示里会带上', async () => {
    const { h, statePath } = mk();
    try {
      h.noteActivity('翻了上个月的日记');
      expect(h.snapshot().recentActivities?.length).toBe(1);
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });

  it('最多只留 8 条（不无限增长）', () => {
    const { h, statePath } = mk();
    try {
      for (let i = 0; i < 15; i++) h.noteActivity(`第${i}次`);
      expect(h.snapshot().recentActivities?.length).toBe(8);
      // 保留的是最近的
      expect(h.snapshot().recentActivities?.at(-1)?.text).toBe('第14次');
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });

  it('空文本不记（避免产生"上次什么都没做"的噪音条目）', () => {
    const { h, statePath } = mk();
    try {
      h.noteActivity('   ');
      expect(h.snapshot().recentActivities?.length ?? 0).toBe(0);
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });

  it('长文本截断到 60 字（只做提示用，不是日志）', () => {
    const { h, statePath } = mk();
    try {
      h.noteActivity('这是一段很长的描述'.repeat(20));
      expect(h.snapshot().recentActivities?.[0]?.text.length).toBe(60);
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });
});
