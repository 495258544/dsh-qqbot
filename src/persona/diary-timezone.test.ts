/**
 * 日记时区 · 回归测试
 * ─────────────────────────────────────────────────────────────
 * 容器无 tzdata，getFullYear()/getMonth()/getDate() 全部返回 UTC。
 * 实测后果（2026-11-02 早 07:53 北京）：她的"一天"从**北京 08:00** 才开始，
 * 早上 8 点前写的日记会被算进前一天 —— 用户问"今天有写日记吗"时对不上。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { Diary } from './diary.ts';

const TMP = '/tmp/diary-tz-test';

describe('Diary · 按北京时区算日期', () => {
  it('UTC 23:53（北京次日 07:53）应算作次日', () => {
    fs.rmSync(TMP, { recursive: true, force: true });
    const d = new Diary(TMP);
    // 构造一个"UTC 深夜"的时刻：本地此刻在北京已经是第二天早上
    const e = d.add({ text: '时区测试', t: Date.UTC(2026, 10, 1, 23, 53) });
    expect(e.day).toBe('2026-11-02');
    expect(e.time).toMatch(/^07:5/);
  });

  it('北京时间正午应算作当天', () => {
    fs.rmSync(TMP, { recursive: true, force: true });
    const d = new Diary(TMP);
    const e = d.add({ text: '时区测试2', t: Date.UTC(2026, 10, 2, 4, 0) });   // UTC 04:00 = 北京 12:00
    expect(e.day).toBe('2026-11-02');
    expect(e.time).toMatch(/^12:0/);
  });
});
