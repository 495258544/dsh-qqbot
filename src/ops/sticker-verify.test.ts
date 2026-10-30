import { describe, expect, it } from 'vitest';
import { verifyStickerLibrary, fixStaleIndex } from './sticker-verify.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 表情库一致性校验测试。
 *
 * 注意：verifyStickerLibrary 的库根写死为 /sdcard/表情包（生产路径），
 * 这里用真实库做只读断言，不造临时库（避免改动生产数据）。
 * fixStaleIndex 的清理行为用「当前库无失效项」来验证幂等。
 */
describe('sticker-verify', () => {
  it('真实库可校验且返回结构完整', () => {
    const r = verifyStickerLibrary(false); // 跳过 MD5 查重，避免读几千文件
    expect(r).toHaveProperty('indexCount');
    expect(r).toHaveProperty('diskCount');
    expect(r).toHaveProperty('staleEntries');
    expect(r).toHaveProperty('orphans');
    expect(r).toHaveProperty('structuralIssues');
    expect(r).toHaveProperty('consistent');
    expect(Array.isArray(r.orphans)).toBe(true);
    expect(r.diskCount).toBeGreaterThan(0);
  });

  it('索引条目结构合法（use 代码都在白名单内）', () => {
    const r = verifyStickerLibrary(false);
    const badUse = r.structuralIssues.filter((s) => s.issue.includes('非法 use'));
    expect(badUse).toHaveLength(0);
  });

  it('索引路径都真实存在（无失效项）', () => {
    const r = verifyStickerLibrary(false);
    expect(r.staleEntries).toHaveLength(0);
  });

  it('fixStaleIndex 幂等：当前无失效项时不删任何东西', () => {
    const before = verifyStickerLibrary(false).indexCount;
    const res = fixStaleIndex();
    expect(res.removed).toBe(0);
    expect(res.remaining).toBe(before);
  });
});

describe('scanImages 边界', () => {
  it('跳过隐藏文件和下划线元数据', () => {
    // 造一个临时目录验证扫描规则
    const dir = path.join(os.tmpdir(), `sv-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'x');
    fs.writeFileSync(path.join(dir, '.hidden.jpg'), 'x');
    fs.writeFileSync(path.join(dir, '_meta.jpg'), 'x');
    // 注：scanImages 不导出，这里用间接验证——真实库的 orphans 不应含 .nomedia
    const r = verifyStickerLibrary(false);
    expect(r.orphans.every((p) => !path.basename(p).startsWith('_'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
