/**
 * buildMatchDetailForm 测试
 * ─────────────────────────────────────────────────────────────
 * 纯函数测试，不联网、不碰文件：直接拼一份 RawMatchDetail 喂进去，
 * 验证排名/对位/目标/曲线/团战/点评这些"算出来的东西"。
 */
import { describe, expect, it } from 'vitest';
import type { RawMatchDetail, RawMatchPlayer } from './opendota.ts';
import { buildMatchDetailForm } from './service.ts';

const HERO = {
  SF: 11,
  CM: 5,
  LINA: 14,
  AXE: 2,
  LICH: 31,
  PA: 44,
  QOP: 39,
  ES: 21,
  WD: 30,
  RUBICK: 86,
};

function player(o: {
  slot: number;
  account?: number | null;
  hero: number;
  k: number;
  d: number;
  a: number;
  gpm: number;
  xpm?: number;
  lh?: number;
  dn?: number;
  dmg?: number;
  tower?: number;
  heal?: number;
  worth?: number;
  level?: number;
  lane?: number;
  items?: number[];
}): RawMatchPlayer {
  const items = o.items ?? [0, 0, 0, 0, 0, 0];
  return {
    account_id: o.account ?? null,
    player_slot: o.slot,
    hero_id: o.hero,
    kills: o.k,
    deaths: o.d,
    assists: o.a,
    gold_per_min: o.gpm,
    xp_per_min: o.xpm ?? 500,
    last_hits: o.lh ?? 100,
    denies: o.dn ?? 5,
    hero_damage: o.dmg ?? 10000,
    tower_damage: o.tower ?? 0,
    hero_healing: o.heal ?? 0,
    net_worth: o.worth ?? o.gpm * 40,
    level: o.level ?? 20,
    item_0: items[0] ?? 0,
    item_1: items[1] ?? 0,
    item_2: items[2] ?? 0,
    item_3: items[3] ?? 0,
    item_4: items[4] ?? 0,
    item_5: items[5] ?? 0,
    backpack_0: null,
    backpack_1: null,
    backpack_2: null,
    lane_role: o.lane ?? null,
  };
}

/** 我（account 123）中路天辉，队内经济第一；对位敌方中路 */
function fixture(over: Partial<RawMatchDetail> = {}): RawMatchDetail {
  return {
    matchId: 999,
    startTime: 1_700_000_000,
    durationSec: 41 * 60,
    gameMode: 22,
    lobbyType: 7,
    radiantWin: true,
    players: [
      player({ slot: 0, account: 123, hero: HERO.SF, k: 11, d: 2, a: 18, gpm: 620, lh: 300, dmg: 30000, worth: 25000, level: 26, lane: 2, items: [1, 116, 48, 0, 0, 0] }),
      player({ slot: 1, account: 201, hero: HERO.CM, k: 2, d: 9, a: 8, gpm: 320, lane: 1 }),
      player({ slot: 2, account: 202, hero: HERO.LINA, k: 6, d: 5, a: 9, gpm: 420, lane: 2 }),
      player({ slot: 3, account: 203, hero: HERO.AXE, k: 4, d: 7, a: 11, gpm: 380, lane: 3 }),
      player({ slot: 4, account: 204, hero: HERO.LICH, k: 3, d: 8, a: 14, gpm: 300, lane: 1 }),
      player({ slot: 128, account: 301, hero: HERO.PA, k: 5, d: 6, a: 3, gpm: 480, lane: 1 }),
      player({ slot: 129, account: 302, hero: HERO.QOP, k: 6, d: 5, a: 4, gpm: 450, lane: 2, dmg: 18000, worth: 18000 }),
      player({ slot: 130, account: 303, hero: HERO.ES, k: 2, d: 8, a: 10, gpm: 350, lane: 3 }),
      player({ slot: 131, account: 304, hero: HERO.WD, k: 1, d: 10, a: 7, gpm: 290, lane: 1 }),
      player({ slot: 132, account: 305, hero: HERO.RUBICK, k: 4, d: 7, a: 9, gpm: 340, lane: 3 }),
    ],
    objectives: [
      // 首血：OpenDota 只给 player_slot，没有 team
      { time: 300, type: 'CHAT_MESSAGE_FIRSTBLOOD', team: null, playerSlot: 2, key: null },
      { time: 800, type: 'CHAT_MESSAGE_ROSHAN_KILL', team: 2, playerSlot: 4, key: null },
      // 推塔：没有 team，只能靠建筑名判（badguys = 夜魇建筑，被天辉拆）
      { time: 1200, type: 'building_kill', team: null, playerSlot: 4, key: 'npc_dota_badguys_tower1_mid' },
      { time: 1500, type: 'building_kill', team: null, playerSlot: 131, key: 'npc_dota_goodguys_tower1_top' },
      { time: 2000, type: 'building_kill', team: null, playerSlot: 4, key: 'npc_dota_badguys_tower2_mid' },
    ],
    radiantGoldAdv: [0, 500, -300, 1200, 2500, 1000],
    teamfights: [
      { players: [{ player_slot: 0, damage: 2000 }, { player_slot: 128, damage: 1200 }] },
      { players: [{ player_slot: 0, damage: 0 }] },
    ],
    ...over,
  };
}

const itemName = (id: number): string => `Item${id}`;

describe('buildMatchDetailForm · 基础', () => {
  it('定位玩家、胜负、KDA、经济', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.player.heroName).not.toBe('');
    expect(f.player.isRadiant).toBe(true);
    expect(f.player.win).toBe(true);
    expect(f.player.kills).toBe(11);
    expect(f.player.kdaRatio).toBeCloseTo((11 + 18) / 2, 2);
    expect(f.player.gpm).toBe(620);
  });

  it('账号不在对局里 → 抛错而不是随便找个人', () => {
    expect(() => buildMatchDetailForm(fixture(), 99999, itemName)).toThrow(/没有 account_id/);
  });
});

describe('buildMatchDetailForm · 派生指标', () => {
  it('队内排名：经济与输出都第 1', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.teamRank.teamSize).toBe(5);
    expect(f.teamRank.netWorth).toBe(1);
    expect(f.teamRank.heroDamage).toBe(1);
  });

  it('对位：同 lane_role 的敌方中路，经济和输出都为正向差', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.laneOpponent?.heroName).not.toBe('');
    expect(f.laneOpponent?.gpmDiff).toBe(620 - 450);
    expect(f.laneOpponent?.damageDiff).toBe(30000 - 18000);
  });

  it('目标事件：首血天辉、肉山 1:0、推塔 2:1', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.objectives.firstBlood).toBe('radiant');
    expect(f.objectives.roshan).toEqual({ radiant: 1, dire: 0 });
    expect(f.objectives.towers).toEqual({ radiant: 2, dire: 1 });
  });

  it('经济曲线（玩家视角）：领先取最大值，落后取绝对值', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.goldSwing?.maxLead).toBe(2500);
    expect(f.goldSwing?.maxDeficit).toBe(300);
  });

  it('团战：2 次里参与了 1 次（第二场伤害为 0）', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.teamfights).toEqual({ count: 2, participated: 1 });
  });

  it('团战按 players 下标兜底（真实数据里 teamfights.players 没有 player_slot）', () => {
    const raw = fixture();
    // 把第 9 个人（下标 8、slot 131）换成待查账号，模拟"人不在第 0 位"
    raw.players[8]!.account_id = 999;
    raw.teamfights = [
      { players: Array.from({ length: 10 }, (_, i) => ({ damage: i === 8 ? 1234 : 5 })) },
    ];
    const f = buildMatchDetailForm(raw, 999, itemName);
    expect(f.teamfights).toEqual({ count: 1, participated: 1 });
  });

  it('装备只取非 0 格', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.player.items).toEqual(['Item1', 'Item116', 'Item48']);
  });

  it('未解析的局：曲线与团战为 null，但基础数据仍可算', () => {
    const f = buildMatchDetailForm(fixture({ radiantGoldAdv: null, teamfights: null }), 123, itemName);
    expect(f.goldSwing).toBeNull();
    expect(f.teamfights).toBeNull();
    expect(f.player.win).toBe(true);
    expect(f.summaryText).toContain('没被解析');
  });

  it('summaryText 包含胜负、KDA、装备、点评', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.summaryText).toContain('胜');
    expect(f.summaryText).toContain('11/2/18');
    expect(f.summaryText).toContain('装备');
    expect(f.summaryText).toContain('点评');
  });
});
