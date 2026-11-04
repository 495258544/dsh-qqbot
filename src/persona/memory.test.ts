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

describe('M38 · knownNames 排除自己人（群成员 id ≠ 私聊 owner id）', () => {
  // 用线上真实踩到的形状：主人在群里的 member openid 和 profile 的 ownerOpenids
  // 不是同一个值，光过滤 ownerOpenids 是空操作 —— 这几条钉住"按传入 id 集合过滤"。
  const mk = async (people: Record<string, string>, tag: string) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mem-known-${tag}-`));
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    const rows: Record<string, unknown> = {};
    for (const [id, name] of Object.entries(people)) {
      rows[id] = { name, traits: [], facts: [], topics: [], pending: [], interactions: 1, firstSeenAt: 1, lastSeenAt: 1 };
    }
    fs.writeFileSync(path.join(dir, 'memory', 'people.json'), JSON.stringify(rows), 'utf8');
    const { Memory } = await import('./memory.ts');
    return { mem: new Memory({ dir: path.join(dir, 'memory') }), dir, fs };
  };

  it('不传 excludeIds → 全量（保持旧行为，向后兼容）', async () => {
    const { mem, dir, fs } = await mk({ A: '阿哲', B: '小羽妈', OWNER: '……' }, 'all');
    // '……' 纯符号被既有规则滤掉；A/B 正常进表
    expect(mem.knownNames().sort()).toEqual(['小羽妈', '阿哲'].sort());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('按 id 集合过滤掉自己人（owner 私聊 id + bot id + 当前说话人）', async () => {
    const { mem, dir, fs } = await mk({
      GROUP_SELF: '江铭鑫',   // 主人在群里的 member id（≠ ownerOpenids）
      BOT: '小羽bot',
      OWNER_C2C: '老王',
      OTHER: '芋头',
    }, 'excl');
    const kept = mem.knownNames(new Set(['GROUP_SELF', 'BOT', 'OWNER_C2C']));
    expect(kept).toEqual(['芋头']); // 三个自己人都被剔，只剩真群友
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('同一昵称挂在多个 id 上：只要有一个非排除 id 就保留', async () => {
    const { mem, dir, fs } = await mk({ SELF: '阿哲', BUDDY: '阿哲' }, 'dup');
    expect(mem.knownNames(new Set(['SELF']))).toEqual(['阿哲']);
    // 两个都排除才消失；且去重（不因两 id 出现两次）
    expect(mem.knownNames(new Set(['SELF', 'BUDDY']))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('空集合 = 不过滤（与不传一致）', async () => {
    const { mem, dir, fs } = await mk({ A: '阿哲', B: '小羽妈' }, 'empty');
    expect(mem.knownNames(new Set()).sort()).toEqual(['小羽妈', '阿哲'].sort());
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
