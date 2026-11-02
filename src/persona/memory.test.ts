import { describe, expect, it } from 'vitest';


describe('M35 · renderRecent 接进了注入链路（原来零调用）', () => {
  it('openid 不再原样暴露，解析成人名或「某人」', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-recent-'));
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    // 造一条流水 + 一个带名字的账本
    fs.writeFileSync(path.join(dir, 'memory', 'turns.jsonl'),
      JSON.stringify({ t: Date.now() - 60_000, where: 'c2c:owner', who: 'OWNERID', text: '你好', reply: '在' }) + '\n',
      'utf8');
    fs.writeFileSync(path.join(dir, 'memory', 'people.json'),
      JSON.stringify({ OWNERID: { name: '小鲸鱼', traits: [], facts: [], topics: [], pending: [], interactions: 1, firstSeenAt: 1, lastSeenAt: 1 } }),
      'utf8');

    const { Memory } = await import('./memory.ts');
    const mem = new Memory({ dir: path.join(dir, 'memory') });
    const out = mem.renderRecent(3, { sinceMs: 3600_000 });
    expect(out).toContain('小鲸鱼');
    // 关键：openid 不能出现在给她看的文本里（实测踩过：是"2DA749E8…（私聊）"）
    expect(out).not.toContain('OWNERID');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('没有名字的账本显示「某人」而不是 openid', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-recent2-'));
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'turns.jsonl'),
      JSON.stringify({ t: Date.now() - 60_000, where: 'c2c:x', who: 'XID', text: '嗨', reply: '嗯' }) + '\n', 'utf8');
    const { Memory } = await import('./memory.ts');
    const mem = new Memory({ dir: path.join(dir, 'memory') });
    const out = mem.renderRecent(3, { sinceMs: 3600_000 });
    expect(out).toContain('某人');
    expect(out).not.toContain('XID');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
