/**
 * factSheet（事实清单）测试
 * ─────────────────────────────────────────────────────────────
 * 2026-11-16 新增。群里的原话是「我看他从来没有综合分析过能收集的数据吧，
 * 不都是抓一两条就开始评么」——根因不是拿不到数据，是模型拿到的是一堆散字段，
 * 就只挑最好念的 KDA／伤害说。这份清单的目的是逼它逐项对照。
 *
 * 所以这里的用例重点不是「算得准」，而是这几个「不许错」：
 *   1. 辅助不能因为伤害低被判成打得差（findings 不许出现「所以菜」这种话）；
 *   2. 未解析的局不能崩，也不能把「没数据」当「数据不好」；
 *   3. findings 至少 2 条，且 evidence 下标必须合法（指错了模型就会说错话）；
 *   4. 长度上限（整个 factSheet 序列化 <= 1200 字），爆了就按 verdict 截断；
 *   5. verdict 三态都要能出现。
 *
 * 全部是纯函数测试：直接拼 MatchDetailForm 喂 buildFactSheet，不联网、不碰文件。
 */
import { describe, expect, it } from 'vitest';
import type { RawMatchDetail, RawMatchPlayer } from './opendota.ts';
import {
  FACT_THRESHOLDS,
  buildFactSheet,
  buildMatchDetailForm,
  enforceFactSheetLimits,
  type MatchDetailForm,
} from './service.ts';

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
  BH: 62,
  LION: 26,
  TIDE: 29,
} as const;

interface RawPlayerSpec {
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
  lane?: number | null;
  items?: number[];
  obs?: number | null;
  sen?: number | null;
  camps?: number | null;
}

function player(o: RawPlayerSpec): RawMatchPlayer {
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
    camps_stacked: o.camps ?? null,
  };
}

/** 「我」（account 123）在天辉 */
const ME = 123;

const ITEM_NAMES: Record<number, string> = {
  1: 'Blink Dagger',
  116: 'Black King Bar',
  48: 'Battle Fury',
  63: 'Power Treads',
  108: 'Aghanims Scepter',
};

const itemName = (id: number): string => ITEM_NAMES[id] ?? `Item${id}`;

function fixture(over: Partial<RawMatchDetail> = {}): RawMatchDetail {
  return {
    matchId: 9001,
    startTime: 1_760_000_000,
    durationSec: 38 * 60,
    gameMode: 22,
    lobbyType: 7,
    radiantWin: true,
    players: [
      // 天辉：两个核心（我 + 中路），两个辅助，一个三号位
      player({ slot: 0, account: ME, hero: HERO.PA, k: 12, d: 3, a: 15, gpm: 680, lh: 340, dmg: 42000, worth: 28000, tower: 6000, lane: 1, items: [63, 48, 116], obs: 2, sen: 1, camps: 0 }),
      player({ slot: 1, account: 201, hero: HERO.LINA, k: 9, d: 5, a: 12, gpm: 520, lh: 240, dmg: 31000, worth: 21000, lane: 2, obs: 3, sen: 2, camps: 1 }),
      player({ slot: 2, account: 202, hero: HERO.AXE, k: 6, d: 7, a: 18, gpm: 400, lh: 140, dmg: 18000, worth: 15000, lane: 3, obs: 4, sen: 3, camps: 2 }),
      player({ slot: 3, account: 203, hero: HERO.CM, k: 2, d: 9, a: 20, gpm: 310, lh: 30, dmg: 9000, worth: 11000, lane: 1, obs: 14, sen: 10, camps: 3 }),
      player({ slot: 4, account: 204, hero: HERO.LICH, k: 3, d: 8, a: 16, gpm: 290, lh: 24, dmg: 8000, worth: 10000, lane: 1, obs: 9, sen: 7, camps: 1 }),
      // 夜魇
      player({ slot: 128, account: 301, hero: HERO.SF, k: 8, d: 6, a: 9, gpm: 540, lh: 280, dmg: 34000, worth: 22000, lane: 2 }),
      player({ slot: 129, account: 302, hero: HERO.QOP, k: 7, d: 5, a: 8, gpm: 480, lh: 230, dmg: 27000, worth: 19000, lane: 2 }),
      player({ slot: 130, account: 303, hero: HERO.ES, k: 4, d: 8, a: 12, gpm: 380, lh: 150, dmg: 17000, worth: 14000, lane: 3 }),
      player({ slot: 131, account: 304, hero: HERO.WD, k: 2, d: 10, a: 11, gpm: 320, lh: 40, dmg: 11000, worth: 11000, lane: 1, obs: 11, sen: 8 }),
      player({ slot: 132, account: 305, hero: HERO.RUBICK, k: 3, d: 9, a: 10, gpm: 300, lh: 35, dmg: 10000, worth: 10000, lane: 1, obs: 8, sen: 5 }),
    ],
    objectives: [
      { time: 300, type: 'CHAT_MESSAGE_FIRSTBLOOD', team: null, playerSlot: 0, key: null },
      { time: 900, type: 'CHAT_MESSAGE_ROSHAN_KILL', team: 2, playerSlot: 0, key: null },
      { time: 1400, type: 'building_kill', team: null, playerSlot: 0, key: 'npc_dota_badguys_tower1_mid' },
    ],
    radiantGoldAdv: [0, 400, 900, 1500, 2600, 3400],
    teamfights: [
      { players: [{ player_slot: 0, damage: 3000 }, { player_slot: 128, damage: 2000 }] },
      { players: [{ player_slot: 0, damage: 2500 }] },
      { players: [{ player_slot: 0, damage: 1800 }] },
    ],
    ...over,
  };
}

/** 拿 fixture 造一份 form，再单独看 factSheet */
function sheet(raw: RawMatchDetail = fixture(), accountId = ME): MatchDetailForm['factSheet'] {
  return buildMatchDetailForm(raw, accountId, itemName).factSheet;
}

/** 取某个维度的行；找不到返回 undefined */
function lineOf(
  sheetValue: MatchDetailForm['factSheet'],
  dim: string,
): { dim: string; fact: string; verdict: 'plus' | 'minus' | 'flat' } | undefined {
  return sheetValue.lines.find((l) => l.dim === dim);
}

describe('buildFactSheet · 划水核心（伤害低 + 参团少 + 死得多）', () => {
  /** 队内谁都不亮眼，我这个「核心」伤害垫底、团战也不跟 */
  const slacking = (): RawMatchDetail => fixture({
    teamfights: [
      // 三次团战只赶上第一次
      { players: [{ player_slot: 0, damage: 500 }, { player_slot: 128, damage: 3000 }] },
      { players: [{ player_slot: 0, damage: 0 }, { player_slot: 128, damage: 2800 }] },
      { players: [{ player_slot: 0, damage: 0 }, { player_slot: 128, damage: 2400 }] },
    ],
  });

  it('输出垫底 → 记 minus（不是 flat）', () => {
    const raw = slacking();
    // 把「我」的伤害改到全队最低，别人抬上去
    const patched: RawMatchDetail = {
      ...raw,
      players: raw.players.map((p) => (p.account_id === ME ? { ...p, hero_damage: 8000 } : p)),
    };
    const s = sheet(patched);
    expect(lineOf(s, '输出')?.verdict).toBe('minus');
  });

  it('参团率低 → 团战 minus，findings 里能指回团战那行', () => {
    const s = sheet(slacking());
    expect(lineOf(s, '团战')?.verdict).toBe('minus');
    const iTf = s.lines.findIndex((l) => l.dim === '团战');
    const hit = s.findings.find((f) => f.text.includes('参团'));
    expect(hit).toBeDefined();
    expect(hit?.evidence).toContain(iTf);
  });

  it('死得比全队平均多 → 死亡 minus，且 fact 里带着平均值的数字', () => {
    // 把我改成 12 死，全队平均只有 6.4 → 远超 1.3 倍的门槛
    const base = fixture();
    const raw: RawMatchDetail = {
      ...base,
      players: base.players.map((p) => (p.account_id === ME ? { ...p, deaths: 12 } : p)),
    };
    const s = sheet(raw);
    const death = lineOf(s, '死亡');
    expect(death?.verdict).toBe('minus');
    expect(death?.fact).toContain('全队平均');
  });
});

describe('buildFactSheet · 辅助（视野好、伤害低）', () => {
  /** 把一个辅助的插眼抬到队内最高、伤害压到最低 */
  const supportRaw = (): RawMatchDetail => {
    const base = fixture();
    return {
      ...base,
      players: base.players.map((p) => {
        if (p.account_id === 203) {
          // CM 辅助：视野队内第一，伤害垫底
          return { ...p, obs_placed: 22, sen_placed: 14, hero_damage: 5000, last_hits: 18 };
        }
        return p;
      }),
    };
  };

  it('视野占队内最多 → 视野 plus', () => {
    const s = sheet(supportRaw(), 203);
    expect(lineOf(s, '视野')?.verdict).toBe('plus');
  });

  it('辅助伤害垫底 → 输出 minus（数据不篡改），但 findings 必须点明「辅助不靠伤害说话」', () => {
    const s = sheet(supportRaw(), 203);
    expect(lineOf(s, '输出')?.verdict).toBe('minus');

    const dmgFinding = s.findings.find((f) => f.text.includes('伤害'));
    expect(dmgFinding).toBeDefined();
    // 关键断言：不能有「所以他菜」这种结论，必须写明辅助位、不靠伤害说话
    expect(dmgFinding?.text).toContain('辅助');
    expect(dmgFinding?.text).toContain('不靠伤害说话');
    expect(dmgFinding?.text).not.toContain('菜');
    // findings 整体也不许出现贬义人格评价
    for (const f of s.findings) {
      expect(f.text).not.toMatch(/混子|菜|废物|划水鬼/);
    }
  });

  it('辅助不参与补刀比较：补刀行写「不计入比较」，verdict 是 flat', () => {
    const s = sheet(supportRaw(), 203);
    const lh = lineOf(s, '补刀');
    expect(lh?.fact).toContain('辅助位不计入比较');
    expect(lh?.verdict).toBe('flat');
  });

  it('辅助经济跟同定位队友比，而不是跟核心第一比（不会因此判 minus）', () => {
    // 203 的 GPM 310，另一个辅助 204 是 290 → 同定位比是 1.07 倍，属于同一档
    const s = sheet(supportRaw(), 203);
    expect(lineOf(s, '经济')?.verdict).toBe('flat');
  });
});

describe('buildFactSheet · 核心（伤害高、经济高）', () => {
  it('经济与输出都队内第一 → 两项都是 plus', () => {
    const s = sheet();
    expect(lineOf(s, '经济')?.verdict).toBe('plus');
    expect(lineOf(s, '输出')?.verdict).toBe('plus');
  });

  it('findings 里有一条带两个维度的结论（经济 + 输出一起指）', () => {
    const s = sheet();
    const multi = s.findings.find((f) => f.evidence.length >= 2);
    expect(multi).toBeDefined();
    expect(multi?.text).toContain('伤害');
  });

  it('补刀明显多于同定位队友 → 补刀 plus', () => {
    // 340 对同为核心的中路 240 → 1.42 倍，超过 1.2 的门槛
    const s = sheet();
    expect(lineOf(s, '补刀')?.verdict).toBe('plus');
  });

  it('建筑伤害占队内最多 → 目标 plus', () => {
    const s = sheet();
    expect(lineOf(s, '目标')?.verdict).toBe('plus');
  });
});

describe('buildFactSheet · 未解析局（goldSwing / teamfights 为 null）', () => {
  const unparsed = (): RawMatchDetail => fixture({
    radiantGoldAdv: null,
    teamfights: null,
  });

  it('不崩，且基础维度照样算得出来', () => {
    expect(() => sheet(unparsed())).not.toThrow();
    const s = sheet(unparsed());
    expect(s.lines.length).toBeGreaterThan(0);
    expect(lineOf(s, '经济')).toBeDefined();
    expect(lineOf(s, '输出')).toBeDefined();
  });

  it('团战维度记 flat 并写明未解析（不能把「没数据」当「打得差」）', () => {
    const s = sheet(unparsed());
    const tf = lineOf(s, '团战');
    expect(tf?.verdict).toBe('flat');
    expect(tf?.fact).toContain('未解析');
  });

  it('单独给一行「解析」说明，让模型知道这局数据不全', () => {
    const s = sheet(unparsed());
    const note = lineOf(s, '解析');
    expect(note?.fact).toContain('未解析');
    expect(note?.verdict).toBe('flat');
  });

  it('插眼字段整列缺失（obs/sen 为 null）→ 视野 flat 且写明未解析，不说「没插眼」', () => {
    const base = fixture();
    const raw: RawMatchDetail = {
      ...base,
      players: base.players.map((p) => ({ ...p, obs_placed: null, sen_placed: null })),
    };
    const s = sheet(raw);
    const ward = lineOf(s, '视野');
    expect(ward?.verdict).toBe('flat');
    expect(ward?.fact).toContain('未解析');
    expect(ward?.fact).not.toMatch(/插眼 0 个/);
  });
});

describe('buildFactSheet · 结构与上限', () => {
  it('findings 至少 2 条、最多 3 条', () => {
    for (const accountId of [ME, 203, 204, 202]) {
      const s = sheet(fixture(), accountId);
      expect(s.findings.length).toBeGreaterThanOrEqual(FACT_THRESHOLDS.minFindings);
      expect(s.findings.length).toBeLessThanOrEqual(FACT_THRESHOLDS.maxFindings);
    }
  });

  it('每条 finding 的 evidence 下标都合法（指错行就会说错话）', () => {
    for (const accountId of [ME, 201, 202, 203, 204]) {
      const s = sheet(fixture(), accountId);
      for (const f of s.findings) {
        expect(f.evidence.length).toBeGreaterThan(0);
        for (const e of f.evidence) {
          expect(Number.isInteger(e)).toBe(true);
          expect(e).toBeGreaterThanOrEqual(0);
          expect(e).toBeLessThan(s.lines.length);
        }
      }
    }
  });

  it('每条 fact 不超过 40 个汉字，整个 factSheet 序列化不超过 1200 字', () => {
    for (const accountId of [ME, 201, 202, 203, 204]) {
      const s = sheet(fixture(), accountId);
      for (const l of s.lines) {
        expect([...l.fact].length).toBeLessThanOrEqual(FACT_THRESHOLDS.maxFactChars);
      }
      expect(JSON.stringify(s).length).toBeLessThanOrEqual(FACT_THRESHOLDS.maxSerializedChars);
    }
  });

  it('超长时按 verdict 截断：plus/minus 留着，flat 先丢', () => {
    // 自然生成的 9~10 行凑不到 1200 字，走不到截断分支 —— 直接喂一份超长的，
    // 验「超了以后怎么砍」（不然这条分支等于没写）。
    const long = '这是一句刚好撑满四十个汉字上限的事实陈述用来把序列化长度顶爆';
    const lines: Array<{ dim: string; fact: string; verdict: 'plus' | 'minus' | 'flat' }> = [
      { dim: '经济', fact: `${long}${long}`.slice(0, 40), verdict: 'minus' },
      { dim: '输出', fact: `${long}${long}`.slice(0, 40), verdict: 'plus' },
    ];
    // 再来一堆 flat 把长度顶过 1200（单行 JSON 约 80 字，需要 15+ 行）
    for (let i = 0; i < 14; i += 1) {
      lines.push({ dim: `杂项${i}`, fact: `${long}${long}`.slice(0, 40), verdict: 'flat' });
    }
    // 先确认这份输入真的超限（否则这个用例什么都没测到）
    expect(JSON.stringify({ lines, findings: [] }).length)
      .toBeGreaterThan(FACT_THRESHOLDS.maxSerializedChars);

    const findings = [
      { text: '经济掉队', evidence: [0] },
      { text: '输出顶住了', evidence: [1] },
    ];
    const out = enforceFactSheetLimits(lines, findings);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(FACT_THRESHOLDS.maxSerializedChars);
    // 真问题/真亮点那两行必须活着：这是这局最该说的东西，不能被砍
    expect(out.lines.map((l) => l.dim)).toContain('经济');
    expect(out.lines.map((l) => l.dim)).toContain('输出');
    expect(out.lines.find((l) => l.dim === '经济')?.verdict).toBe('minus');
    expect(out.lines.find((l) => l.dim === '输出')?.verdict).toBe('plus');
    // 砍完之后 findings 的下标还得指得着（指错行比不截断更糟）
    for (const f of out.findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
      for (const e of f.evidence) expect(e).toBeLessThan(out.lines.length);
    }
  });

  it('截断后 evidence 下标会往前挪正（丢掉前面的行不能让结论指向错的位置）', () => {
    const pad = '一句话正好撑满四十个汉字的长度用来把序列化总长度顶过上限';
    const lines: Array<{ dim: string; fact: string; verdict: 'plus' | 'minus' | 'flat' }> = [];
    for (let i = 0; i < 8; i += 1) {
      lines.push({ dim: `维度${i}`, fact: `${pad}${pad}`.slice(0, 40), verdict: 'flat' });
    }
    // 最后一行是 minus：前面 8 行 flat 会被砍，它必须活下来且下标从 8 挪到 0
    lines.push({ dim: '输出', fact: `${pad}${pad}`.slice(0, 40), verdict: 'minus' });

    const out = enforceFactSheetLimits(lines, [{ text: '输出不行', evidence: [8] }]);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(FACT_THRESHOLDS.maxSerializedChars);
    const idx = out.lines.findIndex((l) => l.dim === '输出');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.evidence).toEqual([idx]);
  });

  it('verdict 三态都能出现（plus / minus / flat）', () => {
    // 用几份不同的局凑：核心 plus、划水 minus、辅助的补刀 flat
    const core = sheet(fixture(), ME);
    const support = sheet(fixture(), 203);
    const all = [...core.lines, ...support.lines].map((l) => l.verdict);
    expect(all).toContain('plus');
    expect(all).toContain('minus');
    expect(all).toContain('flat');
  });
});

describe('buildFactSheet · 分路与出装', () => {
  it('分路按 lane_role 翻译；未知就说未知，不猜', () => {
    const withLane = sheet(fixture(), ME);
    expect(lineOf(withLane, '分路')?.fact).toContain('优势路');

    const noLane = sheet(fixture(), 203);
    // 203 的 lane 是 1（优势路），换一个没给 lane 的
    const base = fixture();
    const raw: RawMatchDetail = {
      ...base,
      players: base.players.map((p) => (p.account_id === ME ? { ...p, lane_role: null } : p)),
    };
    const s = sheet(raw);
    expect(lineOf(s, '分路')?.fact).toContain('未知');
  });

  it('出装只陈述买了什么，不编「同类英雄出场率」这种本局算不出来的话', () => {
    const s = sheet();
    const items = lineOf(s, '出装');
    expect(items).toBeDefined();
    expect(items?.verdict).toBe('flat');
    expect(items?.fact).toContain('出装');
    // 本局数据里根本没有跨局统计，出现这些词就是在造数据
    expect(items?.fact).not.toMatch(/出场率|常见|主流|推荐/);
  });

  it('出装用的是 itemsZh 里的官方中文名（模型自己译会翻车）', () => {
    const s = sheet();
    const items = lineOf(s, '出装');
    // 63=Power Treads → 「动力鞋」、48=Battle Fury → 「狂战斧」：取的是 item-zh 的官方译名，
    // 不是英文原名、更不是模型现翻的那一套（Maelstrom 被说成「狂战斧」就是这么翻车的）
    expect(items?.fact).toContain('动力鞋');
    expect(items?.fact).not.toContain('Battle Fury');
  });
});

describe('buildFactSheet · 定位判不出时不硬下结论', () => {
  it('role=unknown 时经济/补刀只陈述数字（带参照），不判 minus', () => {
    // 造一个「经济与补刀都夹在中间」的人：GPM 排第 2-3、正补占比 ~14%
    const base = fixture();
    const raw: RawMatchDetail = {
      ...base,
      players: base.players.map((p) => (p.account_id === ME
        ? { ...p, gold_per_min: 470, last_hits: 150 }
        : p)),
    };
    const form = buildMatchDetailForm(raw, ME, itemName);
    // 前提：这个人确实判不出定位（否则这个用例测的就不是 unknown 分支了）
    if (form.player.role !== 'unknown') return;
    const eco = lineOf(form.factSheet, '经济');
    const lh = lineOf(form.factSheet, '补刀');
    expect(eco?.verdict).toBe('flat');
    expect(lh?.verdict).toBe('flat');
    expect(eco?.fact).toContain('定位未判出');
  });
});

// 2026-11-25：定位判不出时，补刀行要能让人自己判断档次。
// 线上 9104947359 的宙斯原来只说「队内最多 373，占全队 15%」——那是别人多少，
// 不是他排第几；补上「队内第 X/Y」才看得出他在五个人里的位置。
describe('buildFactSheet · 定位未判出时的补刀信息量', () => {
  it('role=unknown 的补刀行带「队内第 N/5」（不是只给队内最多）', () => {
    const base = fixture();
    const raw: RawMatchDetail = {
      ...base,
      players: base.players.map((p) => (p.account_id === ME ? { ...p, gold_per_min: 470, last_hits: 150 } : p)),
    };
    const form = buildMatchDetailForm(raw, ME, itemName);
    if (form.player.role !== 'unknown') return; // 前提：这一档确实判不出定位
    const lh = lineOf(form.factSheet, '补刀');
    expect(lh?.fact).toContain('队内第');
    expect(lh?.fact).toContain('/5');
    expect(lh?.fact).toContain('占全队');
    expect(lh?.verdict).toBe('flat'); // 不判优劣仍然成立
  });
});
