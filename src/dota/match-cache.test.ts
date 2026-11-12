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
