/**
 * 「时间感」修复 · service 层回归测试
 * ─────────────────────────────────────────────────────────────
 * 原缺陷：turnLedger 只在 flushTurn（回复写完）时刻落盘 t，
 * inbound（消息到达）不记时间。修复后：
 *   · noteUserTurn 记 inboundAt（到达时刻）
 *   · noteReplyChunk 首块记 outboundAt（出站时刻）
 *   · flushTurn 落盘 t = inboundAt
 * 日界归属按到达时刻算：23:50 到达、00:10 flush → 归属前一天。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dayInTz, DEFAULT_TZ } from './clock.ts';
import { readTurnsOfDay } from './diary-auto.ts';
import type { PersonaService } from './service.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const mkSvc = async (dir: string): Promise<PersonaService> => {
  const { PersonaService } = await import('./service.ts');
  return new PersonaService({
    config: {
      enabled: true, dataDir: dir, roleCardPath: '', roleMaxChars: 12000,
      wakeEnabled: true, names: [], keywords: [], ownerOpenids: [], groupProbability: 0,
      humanizeEnabled: true, msPerChar: 110, burstMax: 2, gapMinMs: 700, gapMaxMs: 2600,
      ownLifeEnabled: false, ownLifeIntervalMs: 9000000, ownLifeMaxPerDay: 6,
      maxProactivePerDay: 2, proactiveMinGapMs: 7200000,
    } as never,
    dataDir: dir,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
  }) as PersonaService;
};

const turnsFile = (dir: string): string => path.join(dir, 'memory', 'turns.jsonl');

const readTurns = (dir: string): Array<{ t: number; inboundAt?: number; outboundAt?: number; text: string }> =>
  fs.readFileSync(turnsFile(dir), 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { t: number; inboundAt?: number; outboundAt?: number; text: string });

describe('flushTurn · 落盘 t 取消息到达时刻', () => {
  it('noteUserTurn 记到达时刻，noteReplyChunk 首块记出站时刻，t=inboundAt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-ts-'));
    const svc = await mkSvc(dir);

    let now = Date.UTC(2026, 10, 20, 15, 50);      // 北京 23:50：消息到达
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    svc.noteUserTurn('s1', '睡了吗', 'u1');

    now = Date.UTC(2026, 10, 20, 16, 5);           // 北京 23:55：首块回复发出
    svc.noteReplyChunk('s1', '还没');
    svc.noteReplyChunk('s1', '呢');                // 第二块不覆盖 outboundAt

    now = Date.UTC(2026, 10, 20, 16, 10);          // 北京 次日 00:10：flush
    svc.flushTurn('s1', 'c2c:u1', 'u1');
    spy.mockRestore();

    const [rec] = readTurns(dir);
    expect(rec.inboundAt).toBe(Date.UTC(2026, 10, 20, 15, 50));
    expect(rec.outboundAt).toBe(Date.UTC(2026, 10, 20, 16, 5));
    expect(rec.t).toBe(rec.inboundAt);             // 落盘 t = 到达时刻，不是 flush 时刻
  });

  it('只走了 noteReplyChunk（无 noteUserTurn 的兜底路径）→ 不崩，t 回落 flush 时刻', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-ts2-'));
    const svc = await mkSvc(dir);

    const before = Date.now();
    svc.noteReplyChunk('s2', '主动说的');
    svc.flushTurn('s2', 'c2c:u1', 'u1');
    const after = Date.now();

    const [rec] = readTurns(dir);
    expect(rec.t).toBeGreaterThanOrEqual(before);
    expect(rec.t).toBeLessThanOrEqual(after);
    expect(rec.inboundAt).toBeUndefined();
    expect(rec.outboundAt).toBeGreaterThanOrEqual(before);
  });
});

describe('日记日界 · 到达时刻决定归属日', () => {
  it('23:50 到达、00:10 flush → 归属前一天（北京时区）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-ts3-'));
    const svc = await mkSvc(dir);

    const tIn = Date.UTC(2026, 10, 20, 15, 50);    // 北京 2026-11-20 23:50
    let now = tIn;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    svc.noteUserTurn('s3', '跨午夜的消息', 'u1');
    now = Date.UTC(2026, 10, 20, 16, 10);          // 北京 2026-11-21 00:10
    svc.noteReplyChunk('s3', '回完了');
    svc.flushTurn('s3', 'c2c:u1', 'u1');
    spy.mockRestore();

    // 时间锚必须用 clock.ts 的时区辅助（容器无本地时区语义，禁 toLocaleString）
    expect(dayInTz(new Date(tIn), DEFAULT_TZ)).toBe('2026-11-20');
    expect(dayInTz(new Date(Date.UTC(2026, 10, 20, 16, 10)), DEFAULT_TZ)).toBe('2026-11-21');

    // 归属日跟着 inboundAt 走：记到 20 日，不落到 21 日
    expect(readTurnsOfDay(turnsFile(dir), '2026-11-20')).toHaveLength(1);
    expect(readTurnsOfDay(turnsFile(dir), '2026-11-21')).toHaveLength(0);
  });
});
