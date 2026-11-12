/**
 * 完整简报构建器测试（方案 B）
 *
 * 重点不是「能拼出 JSON」，而是四件容易翻车的事：
 *   1. 同一场多个群友 → 只产出 1 个 session，且每个群友都关联上；
 *   2. 本地已完整解析的场直接复用，不再打 OpenDota；
 *   3. parsed=false 的场下次会重拉（OpenDota 解析是异步的）；
 *   4. 单场失败不拖垮整批，并发不超过 3（11-12 的 429 教训）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBriefingBuilder } from './briefing.ts';
import { MatchCacheStore } from './match-cache.ts';
import type { DotaService, MatchDetailForm } from './service.ts';

let dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const silent = { info: () => {}, warn: () => {} };

function mkForm(matchId: number, accountId: number, over: Partial<MatchDetailForm['player']> = {}): MatchDetailForm {
  return {
    matchId,
    startTimeSec: 1762879860,
    startText: '',
    durationSec: 2280,
    durationText: '38 分钟',
    gameMode: 18,
    gameModeText: '技能征召',
    lobbyType: 7,
    lobbyTypeText: '天梯',
    isRanked: true,
    radiantWin: true,
    player: {
      accountId,
      heroId: 1,
      heroName: '幻影刺客',
      isRadiant: true,
      win: true,
      kills: 7,
      deaths: 6,
      assists: 24,
      kdaRatio: 5.17,
      gpm: 559,
      xpm: 1133,
      lastHits: 200,
      denies: 10,
      heroDamage: 23828,
      towerDamage: 1000,
      heroHealing: 0,
      netWorth: 27443,
      level: 25,
      items: [],
      backpack: [],
      ...over,
    },
    teamRank: { netWorth: 2, heroDamage: 1, teamSize: 5 },
    laneOpponent: null,
    objectives: { firstBlood: null, roshan: { radiant: 0, dire: 0 }, towers: { radiant: 0, dire: 0 } },
    goldSwing: null,
    teamfights: { count: 16, participated: 16 },
    lineup: { radiant: ['幻影刺客', '撼地者'], dire: ['影魔'] },
    notes: [],
    summaryText: '',
  } as MatchDetailForm;
}

interface Harness {
  matchCache: MatchCacheStore;
  build: ReturnType<typeof createBriefingBuilder>;
  calls: Array<[number, number]>;
  activePeak: { value: number };
}

function harness(o: {
  matchIds?: number[];
  participants?: Record<number, Array<{ accountId: number; alias?: string }>>;
  withAbilities?: boolean;
  failMatchIds?: number[];
  concurrencyDelayMs?: number;
} = {}): Harness {
  const dir = tmpDir();
  const matchCache = new MatchCacheStore(dir);
  const matchIds = o.matchIds ?? [401];
  const participants = o.participants ?? { 401: [{ accountId: 1, alias: '小周' }, { accountId: 2, alias: '芋头' }] };
  for (const id of matchIds) {
    for (const p of participants[id] ?? []) {
      matchCache.upsertMany([{
        matchId: id,
        startTime: 1762879860,
        player: {
          accountId: p.accountId,
          alias: p.alias,
          heroId: 1,
          heroName: '幻影刺客',
          kills: 7,
          deaths: 6,
          assists: 24,
          win: true,
        },
      }]);
    }
  }

  const calls: Array<[number, number]> = [];
  const activePeak = { value: 0 };
  let active = 0;
  const service = {
    matchDetail: async (matchId: number, accountId: number) => {
      calls.push([matchId, accountId]);
      active += 1;
      activePeak.value = Math.max(activePeak.value, active);
      if (o.concurrencyDelayMs !== undefined) {
        await new Promise((r) => setTimeout(r, o.concurrencyDelayMs));
      }
      active -= 1;
      if (o.failMatchIds?.includes(matchId)) throw new Error('模拟单场失败');
      return mkForm(matchId, accountId);
    },
    abilityRecords: {
      get: (matchId: number) => ({
        matchId,
        at: Date.now(),
        gameMode: 18,
        basis: 'uses' as const,
        players: (participants[matchId] ?? []).map((p) => ({
          accountId: p.accountId,
          heroName: '幻影刺客',
          win: true,
          abilities: o.withAbilities === false ? [] : [
            { name: 'Shadowraze', nameZh: '毁灭阴影（影压）', uses: 126, behavior: 'Point Target' },
          ],
          mix: '控场味道很重',
          basis: 'uses' as const,
        })),
      }),
    },
  } as unknown as DotaService;

  return {
    matchCache,
    build: createBriefingBuilder({ service, matchCache, logger: silent, tz: 'Asia/Shanghai' }),
    calls,
    activePeak,
  };
}

describe('createBriefingBuilder · 去重与关联', () => {
  it('同一场 3 个群友 → 只产出 1 个 session，3 人都关联上', async () => {
    const h = harness({
      participants: { 401: [
        { accountId: 1, alias: '小周' },
        { accountId: 2, alias: '芋头' },
        { accountId: 3, alias: '铭鑫' },
      ] },
    });
    const sessions = await h.build([401], 48);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.boundPlayers.map((p) => p.name)).toEqual(['小周', '芋头', '铭鑫']);
    expect(h.calls).toHaveLength(3);
    // 每个人都调了一次 matchDetail，但线上同场只打一次网络（matchRaw 单飞）
    expect(h.calls.every(([id]) => id === 401)).toBe(true);
  });

  it('技能明细 / 队内排名 / 全队阵容都进了简报', async () => {
    const h = harness();
    const [s] = await h.build([401], 48);
    expect(s?.parsed).toBe(true);
    expect(s?.gameMode).toBe('技能征召');
    expect(s?.durationMin).toBe(38);
    expect(s?.when).toContain('月');
    expect(s?.boundPlayers[0]?.abilities[0]?.nameZh).toBe('毁灭阴影（影压）');
    expect(s?.boundPlayers[0]?.teamRank).toBe(2);
    expect(s?.boundPlayers[0]?.damageRank).toBe(1);
    expect(s?.boundPlayers[0]?.teamfight).toBe('参团 16/16');
    expect(s?.lineup?.dire).toEqual(['影魔']);
    expect(h.matchCache.getBriefing(401)?.parsed).toBe(true);
  });

  it('没拿到任何技能 → parsed=false（提示词会限制成只说 KDA）', async () => {
    const h = harness({ withAbilities: false });
    const [s] = await h.build([401], 48);
    expect(s?.parsed).toBe(false);
  });
});

describe('createBriefingBuilder · 缓存与容错', () => {
  it('已完整解析的场直接复用，第二次不再调 matchDetail', async () => {
    const h = harness();
    await h.build([401], 48);
    const before = h.calls.length;
    const again = await h.build([401], 48);
    expect(again).toHaveLength(1);
    expect(h.calls.length).toBe(before);
  });

  it('parsed=false 的场下次会重拉', async () => {
    const h = harness({ withAbilities: false });
    await h.build([401], 48);
    const before = h.calls.length;
    await h.build([401], 48);
    expect(h.calls.length).toBeGreaterThan(before);
  });

  it('本地战绩库后来多认出一个同场群友 → 简报重取而不是复用', async () => {
    const h = harness({ participants: { 401: [{ accountId: 1, alias: '小周' }] } });
    await h.build([401], 48);
    expect(h.matchCache.getBriefing(401)?.boundPlayers).toHaveLength(1);

    // 下一轮又查到同一个 match_id 下还有一个人（战绩库按 accountId 追加）
    h.matchCache.upsertMany([{
      matchId: 401,
      startTime: 1762879860,
      player: { accountId: 2, alias: '芋头', heroId: 1, heroName: '斧王', kills: 9, deaths: 2, assists: 11, win: true },
    }]);
    const before = h.calls.length;
    const sessions = await h.build([401], 48);
    expect(h.calls.length).toBeGreaterThan(before);
    expect(sessions[0]?.boundPlayers).toHaveLength(2);
  });

  it('单场失败不拖垮整批，失败场不写缓存', async () => {
    const h = harness({
      matchIds: [401, 402, 403],
      participants: {
        401: [{ accountId: 1, alias: '小周' }],
        402: [{ accountId: 2, alias: '芋头' }],
        403: [{ accountId: 3, alias: '铭鑫' }],
      },
      failMatchIds: [402],
    });
    const sessions = await h.build([401, 402, 403], 48);
    expect(sessions.map((s) => s.matchId).sort()).toEqual([401, 403]);
    expect(h.matchCache.getBriefing(402)).toBeUndefined();
  });

  it('并发不超过 3（避免集中请求撞 429）', async () => {
    const ids = [401, 402, 403, 404, 405, 406, 407, 408];
    const participants: Record<number, Array<{ accountId: number; alias?: string }>> = {};
    for (const id of ids) participants[id] = [{ accountId: id, alias: `群友${id}` }];
    const h = harness({ matchIds: ids, participants, concurrencyDelayMs: 5 });
    const sessions = await h.build(ids, 48);
    expect(sessions).toHaveLength(ids.length);
    expect(h.activePeak.value).toBeLessThanOrEqual(3);
  });
});
