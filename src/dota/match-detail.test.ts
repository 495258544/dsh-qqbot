/**
 * buildMatchDetailForm 测试
 * ─────────────────────────────────────────────────────────────
 * 纯函数测试，不联网、不碰文件：直接拼一份 RawMatchDetail 喂进去，
 * 验证排名/对位/目标/曲线/团战/点评这些"算出来的东西"。
 *
 * 2026-11-16 追加：teamPlayers（队友里谁是群友/路人）与 itemsZh（装备中文名）。
 */
import { describe, expect, it } from 'vitest';
import type { RawMatchDetail, RawMatchPlayer } from './opendota.ts';
import { annotateBoundPlayers, buildMatchDetailForm, buildMatchNotes, pickStandouts } from './service.ts';
import type { MatchDetailForm } from './service.ts';

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
  /** 观察者眼数；不给就是 null（= 这局插眼字段没解析到） */
  obs?: number;
  /** 岗哨眼数 */
  sen?: number;
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
    obs_placed: o.obs ?? null,
    sen_placed: o.sen ?? null,
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

// ── factSheet（事实清单）：2026-11-16 新增 ────────────────────
//
// 群里的原话是「我看他从来没有综合分析过能收集的数据吧，不都是抓一两条就开始评么」。
// 这里只验「它确实挂进了 MatchDetailForm 和摘要」，判定逻辑的细节在
// fact-sheet.test.ts 里；但「数据对照」段必须是 renderMatchSummary 直接拼出来的，
// 不能在 annotateBoundPlayers 阶段重渲（否则技能行会丢，见下面那条用例）。

describe('buildMatchDetailForm · factSheet', () => {
  it('form 一定带 factSheet，lines 非空、findings 至少 2 条', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.factSheet).toBeDefined();
    expect(f.factSheet.lines.length).toBeGreaterThan(0);
    expect(f.factSheet.findings.length).toBeGreaterThanOrEqual(2);
  });

  it('每个维度都有 dim / fact / verdict，verdict 只在三态里', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    for (const l of f.factSheet.lines) {
      expect(l.dim).not.toBe('');
      expect(l.fact).not.toBe('');
      expect(['plus', 'minus', 'flat']).toContain(l.verdict);
    }
  });

  it('维度覆盖到经济/输出/补刀/视野/团战/出装/分路', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    const dims = f.factSheet.lines.map((l) => l.dim);
    for (const want of ['经济', '输出', '补刀', '视野', '团战', '出装', '分路']) {
      expect(dims).toContain(want);
    }
  });

  it('summaryText 里有「数据对照：」段，逐行渲染成 [维度] 事实 → 优势/劣势/无异常', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.summaryText).toContain('数据对照：');
    // 每一行都以「  · [」开头，且带箭头和中文 verdict
    const rows = f.summaryText.split('\n').filter((l) => l.startsWith('  · ['));
    expect(rows.length).toBe(f.factSheet.lines.length);
    for (const row of rows) {
      expect(row).toContain('→');
      expect(row).toMatch(/→ (优势|劣势|无异常)$/);
    }
    // 不用 emoji / 对勾叉：模型会跟着抄，群里看着脏
    expect(f.summaryText).not.toMatch(/✅|❌|🟢|🔴/);
  });

  it('「数据对照」段在「点评：」之后（点评先说结论，对照表跟在后面支撑）', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    const notesAt = f.summaryText.indexOf('点评：');
    const factsAt = f.summaryText.indexOf('数据对照：');
    expect(notesAt).toBeGreaterThanOrEqual(0);
    expect(factsAt).toBeGreaterThan(notesAt);
  });

  it('annotate 之后「数据对照」段和技能行都还在（数据对照是渲染时拼的，重渲会丢技能）', () => {
    const base = buildMatchDetailForm(fixture(), 123, itemName);
    // 模拟 DotaService.matchDetail 在渲染后追加的技能行
    const withSkills = {
      ...base,
      summaryText: `${base.summaryText}\n技能｜神之力量（God's Strength）×12`,
    };
    const out = annotateBoundPlayers(withSkills, (id) => (id === 201 ? '铭鑫' : undefined));
    expect(out.summaryText).toContain('数据对照：');
    expect(out.summaryText).toContain('技能｜神之力量（God\'s Strength）×12');
    // 数据对照只应出现一次，不能被重复插
    expect(out.summaryText.split('数据对照：').length - 1).toBe(1);
  });

  it('未解析局（曲线/团战为 null）也能出 factSheet，不崩', () => {
    const f = buildMatchDetailForm(fixture({ radiantGoldAdv: null, teamfights: null }), 123, itemName);
    expect(f.factSheet.lines.length).toBeGreaterThan(0);
    expect(f.summaryText).toContain('数据对照：');
    // 团战那行要如实说未解析，不能说「0 次团战」
    const tf = f.factSheet.lines.find((l) => l.dim === '团战');
    expect(tf?.fact).toContain('未解析');
  });
});

describe('buildMatchDetailForm · teamPlayers（队友里谁是群友）', () => {
  it('只列本人这一队的五人，按 player_slot 升序', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.teamPlayers).toHaveLength(5);
    // 天辉 slot 0-4；待查账号 123 在 slot 0
    expect(f.teamPlayers.map((p) => p.accountId)).toEqual([123, 201, 202, 203, 204]);
    expect(f.teamPlayers[0]?.isRadiant).toBe(true);
    expect(f.teamPlayers[0]?.heroName).toBe(f.player.heroName);
  });

  it('默认全员 isBound=false、没有 alias（绑定表由上层注入）', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.teamPlayers.every((p) => !p.isBound)).toBe(true);
    expect(f.teamPlayers.every((p) => p.alias === undefined)).toBe(true);
  });

  it('匿名队友（account_id=null）照样列出来，accountId 为 null', () => {
    const raw = fixture();
    raw.players[1]!.account_id = null;
    const f = buildMatchDetailForm(raw, 123, itemName);
    const anon = f.teamPlayers.find((p) => p.heroName === f.teamPlayers[1]?.heroName);
    expect(anon?.accountId).toBeNull();
  });

  it('查夜魇的人 → 列夜魇那边五人', () => {
    const f = buildMatchDetailForm(fixture(), 301, itemName);
    expect(f.teamPlayers).toHaveLength(5);
    expect(f.teamPlayers.every((p) => !p.isRadiant)).toBe(true);
    expect(f.teamPlayers.map((p) => p.accountId)).toEqual([301, 302, 303, 304, 305]);
  });

  it('summaryText 有一行「队友：」，没绑定时全是「路人」', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.summaryText).toContain('队友：');
    expect(f.summaryText).toContain('（路人）');
  });
});

describe('annotateBoundPlayers · 标出群友', () => {
  const ALIASES = new Map<number, string>([
    [201, '铭鑫'],
    [204, '芋头'],
  ]);
  const resolve = (accountId: number): string | undefined => ALIASES.get(accountId);

  it('能解析到 alias 的标成 isBound=true 并带上 alias', () => {
    const f = annotateBoundPlayers(buildMatchDetailForm(fixture(), 123, itemName), resolve);
    const byId = new Map(f.teamPlayers.map((p) => [p.accountId, p]));
    expect(byId.get(201)).toMatchObject({ isBound: true, alias: '铭鑫' });
    expect(byId.get(204)).toMatchObject({ isBound: true, alias: '芋头' });
  });

  it('解析不到的保持 isBound=false（路人）', () => {
    const f = annotateBoundPlayers(buildMatchDetailForm(fixture(), 123, itemName), resolve);
    const byId = new Map(f.teamPlayers.map((p) => [p.accountId, p]));
    expect(byId.get(123)?.isBound).toBe(false);
    expect(byId.get(123)?.alias).toBeUndefined();
    expect(byId.get(202)?.isBound).toBe(false);
  });

  it('summaryText 的队友行混排群友与路人', () => {
    const f = annotateBoundPlayers(buildMatchDetailForm(fixture(), 123, itemName), resolve);
    const line = f.summaryText.split('\n').find((l) => l.startsWith('队友：'));
    expect(line).toBeDefined();
    expect(line).toContain('（铭鑫）');
    expect(line).toContain('（芋头）');
    expect(line).toContain('（路人）');
  });

  it('返回新对象，不改入参（form 可能被缓存/多路径共享）', () => {
    const base = buildMatchDetailForm(fixture(), 123, itemName);
    const before = JSON.stringify(base.teamPlayers);
    const out = annotateBoundPlayers(base, resolve);
    expect(out).not.toBe(base);
    expect(JSON.stringify(base.teamPlayers)).toBe(before);
    expect(base.summaryText).not.toContain('（铭鑫）');
  });

  it('alias 是空白串时当没绑定，不出一个空名字', () => {
    const f = annotateBoundPlayers(buildMatchDetailForm(fixture(), 123, itemName), (id) => (id === 201 ? '   ' : undefined));
    expect(f.teamPlayers.find((p) => p.accountId === 201)?.isBound).toBe(false);
  });

  it('不丢技能那几行：只换「队友：」这一行，其余摘要原样保留', () => {
    const base = buildMatchDetailForm(fixture(), 123, itemName);
    // 模拟 DotaService.matchDetail 在渲染后追加技能行
    const withSkills = { ...base, summaryText: `${base.summaryText}\n技能｜神之力量（God's Strength）×12` };
    const out = annotateBoundPlayers(withSkills, resolve);
    expect(out.summaryText).toContain('技能｜神之力量（God\'s Strength）×12');
    expect(out.summaryText).toContain('（铭鑫）');
    // 队友行只应出现一次，不能重复插
    expect(out.summaryText.split('队友：').length - 1).toBe(1);
  });
});

describe('itemsZh（装备中文名）与 items 对齐', () => {
  it('itemName 给英文时 itemsZh 能给中文（未收录的落英文原名）', () => {
    // itemName 桩按 id 出名字，这里模拟"1=Blink Dagger 有中文，116=未收录"
    const names: Record<number, string> = { 1: 'Blink Dagger', 116: 'Unknown Thing', 48: 'Battle Fury' };
    const f = buildMatchDetailForm(fixture(), 123, (id) => names[id] ?? `#${id}`);
    expect(f.player.items).toEqual(['Blink Dagger', 'Unknown Thing', 'Battle Fury']);
    expect(f.player.itemsZh).toEqual(['闪烁匕首', 'Unknown Thing', '狂战斧']);
  });

  it('itemsZh 与 items 等长（错位的话"第 N 件装备"就会说错）', () => {
    const f = buildMatchDetailForm(fixture(), 123, itemName);
    expect(f.player.itemsZh).toHaveLength(f.player.items.length);
  });

  it('装备行只在中文名与英文不同时才加括号', () => {
    const names: Record<number, string> = { 1: 'Blink Dagger', 116: 'Unknown Thing', 48: 'Battle Fury' };
    const f = buildMatchDetailForm(fixture(), 123, (id) => names[id] ?? `#${id}`);
    const line = f.summaryText.split('\n').find((l) => l.startsWith('装备：'));
    expect(line).toContain('闪烁匕首（Blink Dagger）');
    // 未收录的没有中文名，不加括号
    expect(line).toContain('Unknown Thing');
    expect(line).not.toContain('Unknown Thing（');
  });
});

// ── 点评必须服从事实清单（2026-11-16）─────────────────────────
//
// 线上实锤 match 9091501690（小周 巫医 7/15/9）：满参团 11/11、伤害队内第 2，
// 摘要里却是
//   点评：这局有点划水；死了 15 次，有点多
//   数据对照：· [团战] 参团 11/11（100%） → 优势
// 两段自己打自己。根子就是 `!win && kdaRatio < 1.5 → 划水` 这条写死的启发式。
// 这批用例锁住新规则：「划水/送」必须有 factSheet 里真 minus 的证据。

/** 只改本人（account 123）的字段，队友原样 —— 输局 + 满参团的最小复现 */
function patchMe(raw: RawMatchDetail, patch: Partial<RawMatchPlayer>): RawMatchDetail {
  return {
    ...raw,
    players: raw.players.map((p) => (p.account_id === 123 ? { ...p, ...patch } : p)),
  };
}

/** 两次团战本人全程有输出（参团率 100% → 团战 plus） */
const FULL_TEAMFIGHTS: RawMatchDetail['teamfights'] = [
  { players: [{ player_slot: 0, damage: 3000 }] },
  { players: [{ player_slot: 0, damage: 2500 }] },
];

/** 三次团战只赶上第一次（参团率 33% → 团战 minus） */
const RARE_TEAMFIGHTS: RawMatchDetail['teamfights'] = [
  { players: [{ player_slot: 0, damage: 3000 }] },
  { players: [{ player_slot: 0, damage: 0 }] },
  { players: [{ player_slot: 0, damage: 0 }] },
];

describe('buildMatchNotes · 服从 factSheet', () => {
  it('满参团 + 输出不差 + KDA 差 → 点评里不许出现「划水」', () => {
    // 7/15/9 = KDA 1.07（老逻辑必然推「划水」），但这局参团 2/2、伤害队内第一
    const raw = patchMe(
      fixture({ radiantWin: false, teamfights: FULL_TEAMFIGHTS }),
      { kills: 7, deaths: 15, assists: 9 },
    );
    const f = buildMatchDetailForm(raw, 123, itemName);
    // 先确认前提：factSheet 确实判了团战/输出不差
    expect(f.factSheet.lines.find((l) => l.dim === '团战')?.verdict).toBe('plus');
    expect(f.factSheet.lines.find((l) => l.dim === '输出')?.verdict).toBe('plus');
    const notes = f.notes.join('；');
    expect(notes).not.toContain('划水');
    expect(notes).not.toContain('有点送');
    // 死亡 minus 有数据支撑，这条照旧要说
    expect(notes).toContain('死了 15 次');
  });

  it('输出 minus（伤害只占队内最高 30%）→ 允许说「划水」', () => {
    const raw = patchMe(
      fixture({ radiantWin: false, teamfights: FULL_TEAMFIGHTS }),
      { kills: 10, deaths: 10, assists: 4, hero_damage: 3000 },
    );
    const f = buildMatchDetailForm(raw, 123, itemName);
    expect(f.factSheet.lines.find((l) => l.dim === '输出')?.verdict).toBe('minus');
    expect(f.notes.join('；')).toContain('划水');
  });

  it('团战 minus（参团率不到一半）→ 允许说「划水」', () => {
    const raw = patchMe(
      fixture({ radiantWin: false, teamfights: RARE_TEAMFIGHTS }),
      { kills: 10, deaths: 10, assists: 4 },
    );
    const f = buildMatchDetailForm(raw, 123, itemName);
    expect(f.factSheet.lines.find((l) => l.dim === '团战')?.verdict).toBe('minus');
    expect(f.notes.join('；')).toContain('划水');
  });

  it('死亡 minus + 团战 plus + 输出 plus → 只有死亡那条，不叠加「划水」', () => {
    // 死得多但输出/团战都占优：用命开团也是打法，不能定性成划水
    const raw = patchMe(
      fixture({ radiantWin: false, teamfights: FULL_TEAMFIGHTS }),
      { kills: 7, deaths: 15, assists: 9, gold_per_min: 550 },
    );
    const f = buildMatchDetailForm(raw, 123, itemName);
    const death = f.factSheet.lines.find((l) => l.dim === '死亡');
    expect(death?.verdict).toBe('minus');
    expect(f.factSheet.lines.find((l) => l.dim === '团战')?.verdict).toBe('plus');
    expect(f.factSheet.lines.find((l) => l.dim === '输出')?.verdict).toBe('plus');
    expect(f.notes).toEqual(['死了 15 次，有点多']);
  });

  it('不传 factSheet（老签名）→ 老行为原样保留（向后兼容）', () => {
    const raw = patchMe(
      fixture({ radiantWin: false, teamfights: FULL_TEAMFIGHTS }),
      { kills: 7, deaths: 15, assists: 9 },
    );
    const f = buildMatchDetailForm(raw, 123, itemName);
    // 故意把 factSheet 摘掉、只喂老参数，模拟老缓存 / 老调用方
    const plain = { ...f } as Omit<MatchDetailForm, 'summaryText' | 'factSheet'>;
    const notes = buildMatchNotes(plain);
    // 老逻辑：输局 KDA < 1.5 推「划水」，死 >= 8 推死亡 —— 两条都在，行为不变
    expect(notes).toContain('这局有点划水');
    expect(notes).toContain('死了 15 次，有点多');
  });

  it('视野 plus 的辅助不会被 KDA 判成「送」或「划水」，反而有「视野做得不错」', () => {
    // 203 号位：1/7/3（KDA 0.57，老逻辑必推「送」）+ 伤害队内最低（输出 minus），
    // 但插了 28 个眼（视野队内第一）。辅助不靠伤害说话，这里不许由输出 minus 推「送」。
    const base = fixture({
      radiantWin: false,
      // 203 是 slot 3：两次团战赶上一次 → 参团率 50%，团战 flat（不是 minus）
      teamfights: [
        { players: [{ player_slot: 0, damage: 3000 }, { player_slot: 3, damage: 1000 }] },
        { players: [{ player_slot: 0, damage: 2500 }, { player_slot: 3, damage: 0 }] },
      ],
    });
    const raw: RawMatchDetail = {
      ...base,
      players: base.players.map((p) => (
        p.account_id === 203
          ? { ...p, kills: 1, deaths: 7, assists: 3, obs_placed: 20, sen_placed: 8, last_hits: 40 }
          : p
      )),
    };
    const f = buildMatchDetailForm(raw, 203, itemName);
    expect(f.player.role).toBe('support');
    expect(f.factSheet.lines.find((l) => l.dim === '视野')?.verdict).toBe('plus');
    expect(f.factSheet.lines.find((l) => l.dim === '输出')?.verdict).toBe('minus');
    expect(f.factSheet.lines.find((l) => l.dim === '团战')?.verdict).toBe('flat');
    const notes = f.notes.join('；');
    expect(notes).toContain('视野做得不错');
    expect(notes).not.toContain('划水');
    expect(notes).not.toContain('有点送');
  });
});

// 2026-11-20：局内突出的路人/对手（用户原话「乱杀或巨坑也可以锐评，但别认错人」）。
// 认错人的根本防线在脚本侧：绑定群友绝不进 standouts，模型连 alias 都拿不到。
describe('pickStandouts · 突出的路人/对手，绝不认错人', () => {
  const me = (r: RawMatchDetail): RawMatchPlayer => r.players.find((p) => p.account_id === 123) as RawMatchPlayer;

  it('没传绑定集合 → 一个都不挑（宁可不说，不可认错人）', () => {
    expect(pickStandouts(fixture(), me(fixture()), new Set())).toEqual([]);
  });

  it('乱杀的路人对手被挑出，标 relation=opponent，理由只有客观数据', () => {
    const raw = fixture({
      players: fixture().players.map((p) => (
        p.account_id === 302 ? { ...p, kills: 18, deaths: 3, assists: 6, hero_damage: 34000 } : p
      )),
    });
    // 绑定集合只有 me 自己 → 302 是路人对手
    const out = pickStandouts(raw, me(raw), new Set([123]));
    const foe = out.find((s) => s.heroName === '痛苦女王');
    expect(foe).toBeDefined();
    expect(foe?.relation).toBe('opponent');
    expect(foe?.kda).toBe('18/3/6');
    expect(foe?.reason).toContain('全场乱杀级击杀');
  });

  it('巨坑的路人队友被挑出，标 relation=teammate', () => {
    const raw = fixture({
      players: fixture().players.map((p) => (
        p.account_id === 204 ? { ...p, kills: 1, deaths: 12, assists: 3 } : p
      )),
    });
    const out = pickStandouts(raw, me(raw), new Set([123]));
    const feeder = out.find((s) => s.heroName === '巫妖');
    expect(feeder).toBeDefined();
    expect(feeder?.relation).toBe('teammate');
    expect(feeder?.reason).toContain('死亡偏多');
  });

  it('绑定群友即使数据突出也绝不进 standouts（防认错人核心用例）', () => {
    const raw = fixture({
      players: fixture().players.map((p) => (
        p.account_id === 201 ? { ...p, kills: 20, deaths: 2, assists: 9 } : p
      )),
    });
    // 201 是绑定群友（CM）→ 必须被排除，哪怕 20/2/9
    const out = pickStandouts(raw, me(raw), new Set([123, 201]));
    expect(out.some((s) => s.heroName === '水晶室女')).toBe(false);
  });

  it('最多 2 个，不喧宾夺主', () => {
    const raw = fixture({
      players: fixture().players.map((p) => {
        if (p.account_id === 301) return { ...p, kills: 15, deaths: 4, assists: 2 };
        if (p.account_id === 302) return { ...p, kills: 14, deaths: 5, assists: 8 };
        if (p.account_id === 303) return { ...p, kills: 13, deaths: 3, assists: 4 };
        return p;
      }),
    });
    const out = pickStandouts(raw, me(raw), new Set([123]));
    expect(out.length).toBeLessThanOrEqual(2);
  });
});

