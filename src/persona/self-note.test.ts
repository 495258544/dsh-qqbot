import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfNoteService } from './self-note.ts';

let dir: string;
let sn: SelfNoteService;

beforeEach(() => {
  dir = path.join(os.tmpdir(), `sn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  sn = new SelfNoteService(dir);
});

describe('SelfNoteService · 写入', () => {
  it('正常写入一条', () => {
    expect(sn.write('我不太擅长主动开口，但聊开了话会多一点。')).toBe(true);
    expect(sn.stats().count).toBe(1);
  });

  it('拒绝太短的内容', () => {
    expect(sn.write('嗯')).toBe(false);
    expect(sn.stats().count).toBe(0);
  });

  it('拒绝超长内容（>240字）', () => {
    expect(sn.write('x'.repeat(300))).toBe(false);
  });

  it('重复内容跳过（不写车轱辘话）', () => {
    const t = '最近对游戏新作感兴趣，会自己去查。';
    sn.write(t);
    expect(sn.write(t)).toBe(false);
    expect(sn.stats().count).toBe(1);
  });
});

describe('SelfNoteService · 上限与归档', () => {
  it('超过 3 条时归档最旧的（不删除）', () => {
    sn.write('第一条：我不太擅长主动开口。');
    sn.write('第二条：最近对游戏感兴趣。');
    sn.write('第三条：被叫小鲸鱼有点别扭。');
    expect(sn.stats().count).toBe(3);
    expect(sn.stats().archived).toBe(0);

    sn.write('第四条：会替换掉最旧的一条。');
    expect(sn.stats().count).toBe(3);
    expect(sn.stats().archived).toBe(1);
    // 归档的是第一条
    expect(sn.snapshot().archived[0]?.text).toContain('第一条');
  });

  it('总字数超限也触发归档', () => {
    // 每条 200 字，3 条 = 600 字，正好到上限
    for (let i = 0; i < 3; i++) sn.write(`${i}`.repeat(200).slice(0, 200));
    const before = sn.stats().chars;
    sn.write('z'.repeat(200));
    // 应该归档到不超 600
    expect(sn.stats().chars).toBeLessThanOrEqual(600);
    expect(sn.stats().archived).toBeGreaterThan(0);
    expect(sn.stats().chars).toBeLessThan(before + 200);
  });

  it('归档区有上限（最多 20 条）', () => {
    for (let i = 0; i < 30; i++) sn.write(`第${i}条自我叙述内容，用于测试归档上限。`);
    expect(sn.snapshot().archived.length).toBeLessThanOrEqual(20);
  });
});

describe('SelfNoteService · 注入', () => {
  it('没有内容时不注入', () => {
    expect(sn.renderSection()).toBe('');
  });

  it('有内容时注入当前叙述（归档不进上下文）', () => {
    sn.write('我是个话不多但认真的人。');
    const sec = sn.renderSection();
    expect(sec).toContain('对自己的认识');
    expect(sec).toContain('话不多但认真');
    // 归档内容不应出现在 section 里
    sn.write('第二条叙述内容。');
    sn.write('第三条叙述内容。');
    sn.write('第四条会触发归档。');
    const sec2 = sn.renderSection();
    expect(sec2).not.toContain('我是个话不多但认真的人');
    expect(sn.stats().archived).toBeGreaterThan(0);
  });
});

describe('SelfNoteService · 持久化', () => {
  it('落盘后重新加载保持一致', () => {
    sn.write('我最近喜欢自己查资料。');
    sn.save();
    const sn2 = new SelfNoteService(dir);
    expect(sn2.stats().count).toBe(1);
    expect(sn2.renderSection()).toContain('自己查资料');
  });
});
