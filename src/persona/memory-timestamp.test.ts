/**
 * 「时间感」修复 · memory 层回归测试
 * ─────────────────────────────────────────────────────────────
 * 原缺陷：logTurn 的 t 记的是落盘（回复写完）时刻，23:50 的消息
 * 00:10 落盘会被日记归到次日。修复后 t = inboundAt（消息到达时刻），
 * 出站时刻单独存 outboundAt；旧档没有这两个字段，读到不崩。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory, type TurnRecord } from './memory.ts';

const mk = (): { mem: Memory; dir: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-ts-'));
  return { mem: new Memory({ dir }), dir };
};

const readTurns = (dir: string): TurnRecord[] =>
  fs.readFileSync(path.join(dir, 'turns.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as TurnRecord);

describe('logTurn · t 取消息到达时刻（inboundAt）', () => {
  it('传入 inboundAt / outboundAt → t=inboundAt，两个字段都落盘', () => {
    const { mem, dir } = mk();
    const tIn = Date.UTC(2026, 10, 20, 15, 50);   // 北京 23:50
    const tOut = Date.UTC(2026, 10, 20, 16, 10);  // 北京 次日 00:10
    mem.logTurn({ where: 'c2c', who: 'u1', text: '睡了吗', reply: '还没', inboundAt: tIn, outboundAt: tOut });

    const [rec] = readTurns(dir);
    expect(rec.t).toBe(tIn);
    expect(rec.inboundAt).toBe(tIn);
    expect(rec.outboundAt).toBe(tOut);
  });

  it('没传 inboundAt → 回落落盘时刻（旧行为，不崩）', () => {
    const { mem, dir } = mk();
    const before = Date.now();
    mem.logTurn({ where: 'c2c', who: 'u1', text: '在吗', reply: '在' });
    const after = Date.now();

    const [rec] = readTurns(dir);
    expect(rec.t).toBeGreaterThanOrEqual(before);
    expect(rec.t).toBeLessThanOrEqual(after);
    expect(rec.inboundAt).toBeUndefined();
    expect(rec.outboundAt).toBeUndefined();
  });

  it('读旧档（无 inboundAt 的行）不崩，recentTurns 正常返回', () => {
    const { mem, dir } = mk();
    // 手写一条旧格式记录
    fs.writeFileSync(
      path.join(dir, 'turns.jsonl'),
      JSON.stringify({ t: Date.now() - 1000, where: 'c2c', who: 'u1', text: '旧消息', reply: '旧回复' }) + '\n',
      'utf8',
    );
    const rows = mem.recentTurns(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('旧消息');
    expect(rows[0]!.inboundAt).toBeUndefined();
  });
});
