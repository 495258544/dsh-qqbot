/**
 * 本地战绩库测试
 *
 * 重点不是「能存」，而是三件容易错的事：
 *   1. 同一场被两个人分别写进来时，合并成一条、不覆盖比赛时间；
 *   2. 同一个人重复查，覆盖而不是追加；
 *   3. 文件坏了不能让播报整条挂掉。
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MatchCacheStore } from './match-cache.ts';

let dirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'match-cache-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function p(accountId: number, over: Partial<{ alias: string; heroName: string; kills: number; win: boolean }> = {}) {
  return {
    accountId,
    ...(over.alias !== undefined ? { alias: over.alias } : {}),
    heroId: 1,
    heroName: over.heroName ?? '影魔',
    kills: over.kills ?? 5,
    deaths: 5,
    assists: 5,
    win: over.win ?? true,
  };
}

describe('MatchCacheStore · 合并', () => {
  it('同一场两个人分别写入 → 一条记录、两个参与者', () => {
    const store = new MatchCacheStore(tmpDir());
    store.upsertMany([
      { matchId: 900, startTime: 1794406267, player: p(1, { alias: '铭鑫', heroName: '巫医' }) },
      { matchId: 900, startTime: 1794406267, player: p(2, { alias: '小周', heroName: '幻影刺客' }) },
    ]);

    expect(store.participantsOf(900)).toHaveLength(2);
    expect(store.get(900)?.startTime).toBe(1794406267);
  });

  it('同一个人重复写入 → 覆盖，不追加', () => {
    const store = new MatchCacheStore(tmpDir());
    store.upsertMany([{ matchId: 901, startTime: 100, player: p(1, { kills: 3 }) }]);
    store.upsertMany([{ matchId: 901, startTime: 100, player: p(1, { kills: 9 }) }]);

    const players = store.participantsOf(901);
    expect(players).toHaveLength(1);
    expect(players[0]?.kills).toBe(9);
  });

  it('alias 为空时不覆盖已有的名字', () => {
    const store = new MatchCacheStore(tmpDir());
    store.upsertMany([{ matchId: 902, startTime: 100, player: p(1, { alias: '铭鑫' }) }]);
    store.upsertMany([{ matchId: 902, startTime: 100, player: p(1) }]);
    expect(store.participantsOf(902)[0]?.alias).toBe('铭鑫');
  });

  it('比赛时间以已写入的为准，不被后写覆盖', () => {
    const store = new MatchCacheStore(tmpDir());
    store.upsertMany([{ matchId: 903, startTime: 100, player: p(1) }]);
    store.upsertMany([{ matchId: 903, startTime: 999, player: p(2) }]);
    expect(store.get(903)?.startTime).toBe(100);
  });

  it('非法 startTime / accountId 被忽略，不产生空场次', () => {
    const store = new MatchCacheStore(tmpDir());
    store.upsertMany([
      { matchId: 904, startTime: 0, player: p(1) },
      { matchId: 905, startTime: 100, player: p(0) },
    ]);
    expect(store.get(904)).toBeUndefined();
    expect(store.get(905)).toBeUndefined();
  });
});

describe('MatchCacheStore · 落盘与淘汰', () => {
  it('重新打开能读回同一份数据', () => {
    const dir = tmpDir();
    const a = new MatchCacheStore(dir);
    a.upsertMany([{ matchId: 906, startTime: 500, player: p(1, { alias: '芋头' }) }]);

    const b = new MatchCacheStore(dir);
    expect(b.participantsOf(906)[0]?.alias).toBe('芋头');
  });

  it('超过上限时淘汰最旧的场次', () => {
    const dir = tmpDir();
    const store = new MatchCacheStore(dir, undefined, 50);
    const items = [];
    for (let i = 0; i < 60; i++) {
      items.push({ matchId: 1000 + i, startTime: 1000 + i, player: p(1) });
    }
    store.upsertMany(items);
    expect(store.get(1059)).toBeDefined();
    expect(store.get(1000)).toBeUndefined();
  });

  it('文件损坏 → 当空库，不抛错', () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'matches.json'), '{ this is not json', 'utf8');
    const store = new MatchCacheStore(dir);
    expect(store.get(1)).toBeUndefined();
    // 还能继续写
    store.upsertMany([{ matchId: 907, startTime: 100, player: p(1) }]);
    expect(store.get(907)).toBeDefined();
  });
});

// ── 完整简报（方案 B）：按 matchId 只存一份，含 OMG 技能明细 ──

describe('MatchCacheStore · 完整简报', () => {
  const session = (over: Partial<{ matchId: number; parsed: boolean }> = {}) => ({
    matchId: over.matchId ?? 910,
    when: '11月11日 21:08',
    gameMode: '技能征召',
    durationMin: 38,
    parsed: over.parsed ?? true,
    boundPlayers: [{
      name: '小周',
      hero: '幻影刺客',
      kda: '7/6/24',
      win: true,
      heroDamage: 23828,
      teamRank: 2,
      damageRank: 1,
      teamSize: 5,
      teamfight: '参团 16/16',
      abilityMix: '控场味道很重',
      abilityBasis: 'uses' as const,
      abilities: [
        { name: 'Shadowraze', nameZh: '毁灭阴影（影压）', uses: 126, behavior: 'Point Target' },
        { name: 'Fissure', nameZh: '沟壑', uses: 40 },
      ],
      // 2026-11-16：事实清单也进简报缓存，模型才有得逐项对照
      factSheet: {
        lines: [
          { dim: '经济', fact: 'GPM 559（队内第 2/5，比队内第一低 40）', verdict: 'plus' as const },
          { dim: '输出', fact: '伤害 23828（队内第 1/5，占队内最高 100%）', verdict: 'plus' as const },
        ],
        findings: [{ text: '伤害 23828 占队内最高的 100%，这局输出靠他', evidence: [0, 1] }],
      },
    }],
    lineup: { radiant: ['幻影刺客', '撼地者'], dire: ['影魔'] },
    fetchedAt: 1,
  });

  it('写入后读得回，重开进程也在（技能中文名/输出排名不丢）', () => {
    const dir = tmpDir();
    const a = new MatchCacheStore(dir);
    a.upsertMany([{ matchId: 910, startTime: 1794406267, player: p(1, { alias: '小周' }) }]);
    a.putBriefing(session());

    const got = a.getBriefing(910);
    expect(got?.parsed).toBe(true);
    expect(got?.boundPlayers[0]?.abilities[0]?.nameZh).toBe('毁灭阴影（影压）');
    expect(got?.lineup?.dire).toEqual(['影魔']);

    const b = new MatchCacheStore(dir);
    expect(b.getBriefing(910)?.boundPlayers[0]?.damageRank).toBe(1);
    expect(b.getBriefing(910)?.boundPlayers[0]?.teamfight).toBe('参团 16/16');
    // 2026-11-16：factSheet 也要过一遍读回来的 sanitize 还在（否则第二天复用时
    // 模型又只剩散字段，「抓一两条就评」照旧）
    expect(b.getBriefing(910)?.boundPlayers[0]?.factSheet?.lines).toHaveLength(2);
    expect(b.getBriefing(910)?.boundPlayers[0]?.factSheet?.findings[0]?.evidence).toEqual([0, 1]);
  });

  it('factSheet 形状坏掉时逐条丢弃，不让整份简报失效', () => {
    const dir = tmpDir();
    const store = new MatchCacheStore(dir);
    store.upsertMany([{ matchId: 911, startTime: 1794406267, player: p(1, { alias: '小周' }) }]);
    const broken = session({ matchId: 911 });
    // 手工把 round-trip 弄坏：verdict 拼错、evidence 越界 / 不是整数
    (broken as unknown as Record<string, unknown>).boundPlayers = [{
      ...broken.boundPlayers[0],
      factSheet: {
        lines: [
          { dim: '经济', fact: 'GPM 559（队内第 2/5）', verdict: 'plus' },
          { dim: '输出', fact: '伤害 23828', verdict: 'PLUS' }, // 大小写错 → 丢
          { dim: '', fact: '没维度名', verdict: 'flat' }, // 没 dim → 丢
          { dim: '团战', fact: '参团 16/16', verdict: 'plus' },
        ],
        findings: [
          { text: '指到不存在的行', evidence: [99] }, // 越界 → 丢
          { text: '指向第 0 行', evidence: [0, 1.5] }, // 非整数被过滤，剩 [0] → 留
        ],
      },
    }];
    store.putBriefing(broken);

    const again = new MatchCacheStore(dir);
    const got = again.getBriefing(911)?.boundPlayers[0]?.factSheet;
    expect(got?.lines.map((l) => l.dim)).toEqual(['经济', '团战']);
    // 越界的 evidence 丢了之后，下标必须落在 lines 范围内 —— 否则模型会指错行说错话
    expect(got?.findings).toHaveLength(1);
    expect(got?.findings[0]?.evidence).toEqual([0]);
    for (const f of got?.findings ?? []) {
      for (const e of f.evidence) expect(e).toBeLessThan(got?.lines.length ?? 0);
    }
  });

  it('factSheet 整份坏掉时丢掉它，但简报本身仍然可用', () => {
    const dir = tmpDir();
    const store = new MatchCacheStore(dir);
    store.upsertMany([{ matchId: 912, startTime: 1794406267, player: p(1, { alias: '小周' }) }]);
    const broken = session({ matchId: 912 });
    (broken as unknown as Record<string, unknown>).boundPlayers = [{
      ...broken.boundPlayers[0],
      factSheet: { lines: 'not-an-array', findings: 42 },
    }];
    store.putBriefing(broken);

    const again = new MatchCacheStore(dir);
    const s = again.getBriefing(912);
    expect(s?.parsed).toBe(true);
    expect(s?.boundPlayers).toHaveLength(1);
    expect(s?.boundPlayers[0]?.factSheet).toBeUndefined();
    // 其它字段一个都没伤到
    expect(s?.boundPlayers[0]?.abilities[0]?.nameZh).toBe('毁灭阴影（影压）');
  });

  it('原始战绩再次 upsert 不会把简报冲掉', () => {
    const store = new MatchCacheStore(tmpDir());
    store.upsertMany([{ matchId: 910, startTime: 100, player: p(1) }]);
    store.putBriefing(session());
    store.upsertMany([{ matchId: 910, startTime: 100, player: p(2, { alias: '芋头' }) }]);

    expect(store.participantsOf(910)).toHaveLength(2);
    expect(store.getBriefing(910)?.parsed).toBe(true);
  });

  it('同一场写两次简报只留最新一份', () => {
    const store = new MatchCacheStore(tmpDir());
    store.upsertMany([{ matchId: 910, startTime: 100, player: p(1) }]);
    store.putBriefing(session({ parsed: false }));
    store.putBriefing(session({ parsed: true }));
    expect(store.getBriefing(910)?.parsed).toBe(true);
    expect(store.getBriefing(910)?.boundPlayers).toHaveLength(1);
  });

  it('没有原始战绩记录时拒绝写入并告警（避免重读被丢掉）', () => {
    const warns: string[] = [];
    const store = new MatchCacheStore(tmpDir(), { warn: (m) => warns.push(m) });
    store.putBriefing(session());
    expect(store.getBriefing(910)).toBeUndefined();
    expect(warns.join('')).toContain('还没有原始战绩记录');
  });
});
