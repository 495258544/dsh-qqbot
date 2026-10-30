import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceService } from './voice.ts';

let dir: string;
let v: VoiceService;

beforeEach(() => {
  dir = path.join(os.tmpdir(), `voice-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  v = new VoiceService(dir);
});

describe('VoiceService · 采集', () => {
  it('记录合适的发言，过滤图片占位和过短内容', () => {
    expect(v.recordUtterance('t1', 'group:g', '说实话这游戏还行')).toBe(true);
    expect(v.recordUtterance('t2', 'group:g', '嗯')).toBe(false); // 太短
    expect(v.recordUtterance('t3', 'group:g', '[图片]')).toBe(false); // 占位
    expect(v.snapshot().pending.length).toBe(1);
  });

  it('判定"被接住"：哈哈/确实/问号 都算', () => {
    v.recordUtterance('t1', 'group:g', '说实话这游戏还行');
    const caught1 = v.judgeIncoming('group:g', '哈哈哈确实');
    expect(caught1.length).toBe(1);
    expect(v.caughtSampleCount()).toBe(1);

    v.recordUtterance('t2', 'group:g', '要不先睡吧');
    v.judgeIncoming('group:g', '？');
    expect(v.caughtSampleCount()).toBe(2);
  });

  it('被嫌的发言不记为负样本、也不进正样本', () => {
    v.recordUtterance('t1', 'group:g', '这话我说了算');
    v.judgeIncoming('group:g', '太吵了闭嘴');
    expect(v.caughtSampleCount()).toBe(0);
    expect(v.snapshot().pending.filter((p) => p.turnId === 't1')).toHaveLength(0);
  });

  it('平淡回应保留在待判定队列（可能下一句才接住）', () => {
    v.recordUtterance('t1', 'group:g', '今天有点累');
    v.judgeIncoming('group:g', '嗯我在忙');
    expect(v.snapshot().pending.some((p) => p.turnId === 't1')).toBe(true);
  });

  it('跨会话的发言不被误判', () => {
    v.recordUtterance('t1', 'c2c:a', '说实话不想动');
    v.judgeIncoming('group:b', '哈哈哈');
    expect(v.caughtSampleCount()).toBe(0);
    expect(v.snapshot().pending.length).toBe(1);
  });
});

describe('VoiceService · 抽取与护栏', () => {
  function seedSamples(service: VoiceService, lines: string[]): void {
    for (const [i, l] of lines.entries()) {
      service.recordUtterance(`t${i}`, 'group:g', l);
      service.judgeIncoming('group:g', '哈哈确实');
    }
  }

  it('样本不足不抽取（<4 条）', () => {
    seedSamples(v, ['说实话还行', '这个吧']);
    expect(v.extractCandidates().length).toBe(0);
  });

  it('抽取重复出现的句式特征', () => {
    seedSamples(v, ['说实话挺好', '说实话有点难', '先这样吧', '不聊了吧']);
    const c = v.extractCandidates();
    expect(c.length).toBeGreaterThan(0);
    expect(c.some((h) => h.style === '说实话')).toBe(true);
  });

  it('子串去重："说实" 不重复出现', () => {
    seedSamples(v, ['说实话挺好', '说实话有点难', '先这样吧', '不聊了吧']);
    const c = v.extractCandidates();
    const styles = c.map((h) => h.style);
    // "说实" 是 "说实话" 的子串，应被去掉
    expect(styles).not.toContain('说实');
  });

  it('冲突词被过滤（不学"哇/太棒了"这类破坏人设的话）', () => {
    seedSamples(v, ['哇这太棒了', '哇真的绝', '哇哈哈', '太棒了吧']);
    const c = v.extractCandidates();
    expect(c.every((h) => !h.style.includes('哇') && !h.style.includes('太棒'))).toBe(true);
  });
});

describe('VoiceService · 确认门槛与注入', () => {
  function seed(service: VoiceService, n: number, line: string): void {
    for (let i = 0; i < n; i++) {
      service.recordUtterance(`t${i}`, 'group:g', line);
      service.judgeIncoming('group:g', '哈哈确实');
    }
  }

  it('未过门槛不注入', () => {
    seed(v, 4, '说实话挺好');
    v.extractCandidates();
    expect(v.renderSection()).toBe(''); // 候选不注入
  });

  it('满足门槛后转正并注入', () => {
    seed(v, 4, '说实话挺好');
    v.extractCandidates();
    const promoted = v.promoteHabits();
    expect(promoted).toBeGreaterThan(0);
    const sec = v.renderSection();
    expect(sec).toContain('说话习惯');
    expect(sec).toContain('说实话');
    expect(sec).toContain('不强求');
  });

  it('她可以表态拒绝某条口癖', () => {
    seed(v, 4, '说实话挺好');
    v.extractCandidates();
    const habits = v.snapshot().habits;
    expect(habits.length).toBeGreaterThan(0);
    const target = habits[0];
    expect(v.decideHabit(target.id, false)).toBe(true);
    expect(v.activeHabits()).toHaveLength(0);
  });

  it('长期不用会退役', () => {
    seed(v, 4, '说实话挺好');
    v.extractCandidates();
    v.promoteHabits();
    const before = v.activeHabits().length;
    const future = Date.now() + 100 * 24 * 3600 * 1000;
    const retired = v.retireStale(future);
    expect(retired).toBe(before);
    expect(v.activeHabits()).toHaveLength(0);
  });
});

describe('VoiceService · 持久化', () => {
  it('落盘后重新加载保持一致', () => {
    v.recordUtterance('t1', 'group:g', '说实话这游戏还行');
    v.judgeIncoming('group:g', '哈哈确实');
    v.save();
    const v2 = new VoiceService(dir);
    expect(v2.caughtSampleCount()).toBe(1);
  });
});
