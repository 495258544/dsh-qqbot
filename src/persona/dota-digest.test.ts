/**
 * dota-digest 测试
 * ─────────────────────────────────────────────────────────────
 * 全部用假 bindings / queryForm / pickGroup / deliver / now，绝不联网。
 * 时间统一用「北京时间」构造（容器无 tzdata，但 Intl 换算是对的）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DotaForm, DotaMatchSummary } from '../dota/service.ts';
import type { Logger } from '../types.ts';
import {
  createDotaDigest,
  type DotaDigestConfig,
  type DotaDigestDeps,
} from './dota-digest.ts';

const TZ = 'Asia/Shanghai';

/** 北京时间 → 时间戳（月份 1-12） */
function cst(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute);
}

/** 查询时刻：2026-03-10 03:30（北京时间） */
const QUERY_AT = cst(2026, 3, 10, 3, 30);
/** 投递日：2026-03-11 */
const FOR_DAY = '2026-03-10';

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let dirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-digest-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// ── 造假数据 ────────────────────────────────────────────────

function mkMatch(o: {
  matchId: number;
  at: number;
  win: boolean;
  hero?: string;
  k?: number;
  d?: number;
  a?: number;
}): DotaMatchSummary {
  const kills = o.k ?? 5;
  const deaths = o.d ?? 5;
  const assists = o.a ?? 5;
  return {
    matchId: o.matchId,
    heroId: 1,
    heroName: o.hero ?? '影魔',
    win: o.win,
    kills,
    deaths,
    assists,
    kdaRatio: Math.round(((kills + assists) / Math.max(1, deaths)) * 100) / 100,
    durationSec: 2400,
    durationText: '40 分钟',
    startedAt: new Date(o.at).toISOString(),
    startedAtText: '几小时前',
    gameMode: 22,
    gameModeText: '全英雄选择',
    lobbyType: 7,
    lobbyTypeText: '天梯',
    isRanked: true,
  };
}

function mkForm(accountId: number, matches: DotaMatchSummary[], empty = false): DotaForm {
  const wins = matches.filter((m) => m.win).length;
  const losses = matches.length - wins;
  let streak = 0;
  const first = matches[0];
  if (first !== undefined) {
    let n = 0;
    for (const m of matches) {
      if (m.win !== first.win) break;
      n += 1;
    }
    streak = first.win ? n : -n;
  }
  return {
    accountId,
    displayName: '',
    rankTier: null,
    rankText: null,
    matches,
    wins,
    losses,
    winRate: matches.length === 0 ? 0 : Math.round((wins / matches.length) * 100),
    avgKda: 0,
    streak,
    empty,
    summaryText: '',
  };
}

function cfg(over: Partial<DotaDigestConfig> = {}): DotaDigestConfig {
  return {
    enabled: true,
    queryHours: [3, 7],
    deliverHours: [10, 12],
    maxItems: 2,
    maxPerDay: 1,
    matchLimit: 10,
    recentHours: 48,
    tz: TZ,
    ...over,
  };
}

/** SteamID64：两个合法但不同的账号（account_id 1 / 2） */
const STEAM_A = '76561197960265729';
const STEAM_B = '76561197960265730';
const STEAM_C = '76561197960265731';

interface Harness {
  deps: DotaDigestDeps;
  dataDir: string;
  deliverCalls: Array<{ groupId: string; text: string }>;
  handle: ReturnType<typeof createDotaDigest>;
}

function harness(o: {
  config?: Partial<DotaDigestConfig>;
  bindings?: DotaDigestDeps['bindings'];
  forms?: Record<number, DotaForm | Error>;
  pickGroup?: DotaDigestDeps['pickGroup'];
  deliver?: DotaDigestDeps['deliver'];
} = {}): Harness {
  const dataDir = tmpDir();
  const deliverCalls: Array<{ groupId: string; text: string }> = [];
  const forms = o.forms ?? {};

  const deps: DotaDigestDeps = {
    config: cfg(o.config),
    dataDir,
    logger: silentLogger,
    bindings: o.bindings ?? (() => []),
    queryForm: async (accountId: number) => {
      const f = forms[accountId];
      if (f === undefined) throw new Error(`测试没有准备 account ${accountId} 的战绩`);
      if (f instanceof Error) throw f;
      return f;
    },
    pickGroup: o.pickGroup ?? (() => 'group-openid-1'),
    deliver:
      o.deliver
      ?? (async (groupId: string, text: string) => {
        deliverCalls.push({ groupId, text });
        return { ok: true };
      }),
    now: () => QUERY_AT,
  };

  return { deps, dataDir, deliverCalls, handle: createDotaDigest(deps) };
}

function exists(dataDir: string): boolean {
  return fs.existsSync(path.join(dataDir, 'dota-digest.json'));
}

// ── 阶段一：查询 ────────────────────────────────────────────

describe('tickQuery · 开关与时段', () => {
  it('enabled=false → 直接跳过', async () => {
    const h = harness({ config: { enabled: false } });
    const res = await h.handle.tickQuery(QUERY_AT);
    expect(res).toEqual({ ran: false, count: 0, reason: 'disabled' });
    expect(exists(h.dataDir)).toBe(false);
  });

  it('不在查询时段（中午 12 点）→ not-query-window', async () => {
    const h = harness();
    const res = await h.handle.tickQuery(cst(2026, 3, 10, 12, 0));
    expect(res.ran).toBe(false);
    expect(res.reason).toBe('not-query-window');
  });
});

describe('tickQuery · 提炼', () => {
  it('一个 3 连败 + 一个 Carry 局 → 2 条，kind 正确且落盘', async () => {
    const h = harness({
      bindings: () => [
        { openid: 'u_a', alias: '小周', steamId: STEAM_A },
        { openid: 'u_b', alias: '芋头', steamId: STEAM_B },
      ],
      forms: {
        1: mkForm(1, [
          mkMatch({ matchId: 101, at: QUERY_AT - 1 * 3600e3, win: false, hero: '影魔', k: 3, d: 9, a: 4 }),
          mkMatch({ matchId: 102, at: QUERY_AT - 2 * 3600e3, win: false, hero: '影魔', k: 4, d: 8, a: 3 }),
          mkMatch({ matchId: 103, at: QUERY_AT - 3 * 3600e3, win: false, hero: '影魔', k: 2, d: 10, a: 5 }),
        ]),
        2: mkForm(2, [
          mkMatch({ matchId: 201, at: QUERY_AT - 5 * 3600e3, win: true, hero: '敌法师', k: 12, d: 2, a: 8 }),
        ]),
      },
    });

    const res = await h.handle.tickQuery(QUERY_AT);
    expect(res.ran).toBe(true);
    expect(res.count).toBe(2);

    const snap = h.handle.snapshot();
    expect(snap.digest).not.toBeNull();
    expect(snap.digest?.forDay).toBe(FOR_DAY);
    expect(snap.digest?.items).toHaveLength(2);
    // 连败优先
    expect(snap.digest?.items[0]?.kind).toBe('lose-streak');
    expect(snap.digest?.items[0]?.text).toContain('最近 3 连败');
    expect(snap.digest?.items[0]?.text).toContain('影魔 3/9/4');
    expect(snap.digest?.items[1]?.kind).toBe('carry');
    expect(snap.digest?.items[1]?.text).toContain('敌法师 打出 12/2/8');
    expect(snap.digest?.items[1]?.text).toContain('KDA 10.00');

    // 落盘文件真实存在且能读回
    expect(exists(h.dataDir)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'dota-digest.json'), 'utf8')) as {
      version: number;
      forDay: string;
      items: unknown[];
    };
    expect(raw.version).toBe(1);
    expect(raw.forDay).toBe(FOR_DAY);
    expect(raw.items).toHaveLength(2);

    // 给 agent 看的那句话里不能出现 openid / steamId（结构化字段是给上层用的，不在此列）
    for (const it of snap.digest?.items ?? []) {
      expect(it.text).not.toContain(it.openid);
      expect(it.text).not.toContain(it.steamId);
      expect(it.text).not.toContain('@');
    }
  });

  it('最近一局在 72 小时前（recentHours=48）→ 该人不产出', async () => {
    const h = harness({
      bindings: () => [
        { openid: 'u_a', alias: '老赖', steamId: STEAM_A },
        { openid: 'u_b', alias: '芋头', steamId: STEAM_B },
      ],
      forms: {
        1: mkForm(1, [
          mkMatch({ matchId: 101, at: QUERY_AT - 72 * 3600e3, win: false, k: 1, d: 12, a: 2 }),
          mkMatch({ matchId: 102, at: QUERY_AT - 73 * 3600e3, win: false, k: 1, d: 12, a: 2 }),
          mkMatch({ matchId: 103, at: QUERY_AT - 74 * 3600e3, win: false, k: 1, d: 12, a: 2 }),
        ]),
        2: mkForm(2, [
          mkMatch({ matchId: 201, at: QUERY_AT - 2 * 3600e3, win: true, k: 12, d: 2, a: 8 }),
        ]),
      },
    });

    const res = await h.handle.tickQuery(QUERY_AT);
    expect(res.count).toBe(1);
    const items = h.handle.snapshot().digest?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.openid).toBe('u_b');
    expect(items.some((it) => it.alias === '老赖')).toBe(false);
  });

  it('form.empty 跳过；某人 queryForm 抛错不影响其他人', async () => {
    const h = harness({
      bindings: () => [
        { openid: 'u_a', alias: '空号', steamId: STEAM_A },
        { openid: 'u_b', alias: '炸号', steamId: STEAM_B },
        { openid: 'u_c', alias: '芋头', steamId: STEAM_C },
      ],
      forms: {
        1: mkForm(1, [], true),
        2: new Error('OpenDota 限流（HTTP 429）'),
        3: mkForm(3, [
          mkMatch({ matchId: 301, at: QUERY_AT - 1 * 3600e3, win: true, hero: '敌法师', k: 15, d: 1, a: 9 }),
        ]),
      },
    });

    const res = await h.handle.tickQuery(QUERY_AT);
    expect(res.ran).toBe(true);
    expect(res.count).toBe(1);
    const items = h.handle.snapshot().digest?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.openid).toBe('u_c');
    expect(items[0]?.kind).toBe('carry');
  });

  it('一条亮点都没有 → 不落盘 + no-highlight', async () => {
    const h = harness({
      bindings: () => [{ openid: 'u_a', alias: '小周', steamId: STEAM_A }],
      forms: {
        1: mkForm(1, [
          mkMatch({ matchId: 101, at: QUERY_AT - 2 * 3600e3, win: true, k: 4, d: 4, a: 6 }),
          mkMatch({ matchId: 102, at: QUERY_AT - 3 * 3600e3, win: false, k: 5, d: 5, a: 5 }),
        ]),
      },
    });

    const res = await h.handle.tickQuery(QUERY_AT);
    expect(res).toEqual({ ran: false, count: 0, reason: 'no-highlight' });
    expect(exists(h.dataDir)).toBe(false);
  });

  it('同一天已备好摘要 → already-prepared，不重复查', async () => {
    const h = harness({
      bindings: () => [{ openid: 'u_a', alias: '小周', steamId: STEAM_A }],
      forms: {
        1: mkForm(1, [
          mkMatch({ matchId: 101, at: QUERY_AT - 1 * 3600e3, win: false, k: 1, d: 9, a: 3 }),
          mkMatch({ matchId: 102, at: QUERY_AT - 2 * 3600e3, win: false, k: 2, d: 9, a: 3 }),
          mkMatch({ matchId: 103, at: QUERY_AT - 3 * 3600e3, win: false, k: 3, d: 9, a: 3 }),
        ]),
      },
    });

    expect((await h.handle.tickQuery(QUERY_AT)).count).toBe(1);
    const again = await h.handle.tickQuery(QUERY_AT + 30 * 60 * 1000);
    expect(again.ran).toBe(false);
    expect(again.reason).toBe('already-prepared');
  });
});

// ── 阶段二：投递 ────────────────────────────────────────────

/** 先备好一份隔夜摘要（3 连败一条） */
async function prepare(h: Harness): Promise<void> {
  const res = await h.handle.tickQuery(QUERY_AT);
  expect(res.ran).toBe(true);
  expect(res.count).toBeGreaterThan(0);
}

function preparedHarness(o: Parameters<typeof harness>[0] = {}): Harness {
  const h = harness({
    bindings: () => [{ openid: 'u_a', alias: '小周', steamId: STEAM_A }],
    forms: {
      1: mkForm(1, [
        mkMatch({ matchId: 101, at: QUERY_AT - 1 * 3600e3, win: false, hero: '影魔', k: 3, d: 9, a: 4 }),
        mkMatch({ matchId: 102, at: QUERY_AT - 2 * 3600e3, win: false, hero: '影魔', k: 4, d: 8, a: 3 }),
        mkMatch({ matchId: 103, at: QUERY_AT - 3 * 3600e3, win: false, hero: '影魔', k: 2, d: 10, a: 5 }),
      ]),
    },
    ...o,
  });
  return h;
}

describe('tickDeliver · 日期与时段', () => {
  it('同一天：查询后当天时段内发一次；再发 → already-delivered', async () => {
    const h = preparedHarness();
    await prepare(h);

    const sent = await h.handle.tickDeliver(cst(2026, 3, 10, 10, 30));
    expect(sent.sent).toBe(true);
    expect(h.deliverCalls).toHaveLength(1);

    // 提示文本：只有 alias、没有 openid、明确要求不要 @
    const text = h.deliverCalls[0]?.text ?? '';
    expect(text).toContain('小周');
    expect(text).not.toContain('u_a');
    expect(text).toContain('别 @ 人');
    // 给的是原始数据，不是现成句子 —— 文案要她自己写
    expect(text).toContain('"name": "小周"');
    expect(text).toContain('"situation": "3 连败"');
    expect(text).toContain('"hero": "影魔"');
    expect(text).toContain('别照抄');
    expect(text).toContain('吐槽一句');
    expect(h.deliverCalls[0]?.groupId).toBe('group-openid-1');

    const again = await h.handle.tickDeliver(cst(2026, 3, 10, 11, 0));
    expect(again).toEqual({ sent: false, reason: 'already-delivered' });
    expect(h.deliverCalls).toHaveLength(1);
  });

  it('不在投递时段 → not-deliver-window', async () => {
    const h = preparedHarness();
    await prepare(h);
    const res = await h.handle.tickDeliver(cst(2026, 3, 10, 9, 0));
    expect(res.reason).toBe('not-deliver-window');
    expect(h.deliverCalls).toHaveLength(0);
  });

  it('pickGroup 返回 null → no-group，且不调 deliver', async () => {
    const h = preparedHarness({ pickGroup: () => null });
    await prepare(h);
    const res = await h.handle.tickDeliver(cst(2026, 3, 10, 10, 30));
    expect(res).toEqual({ sent: false, reason: 'no-group' });
    expect(h.deliverCalls).toHaveLength(0);
    // 没投出去就不能标已投递
    expect(h.handle.snapshot().digest?.deliveredAt).toBeUndefined();
  });

  it('错过一天（今天 = forDay + 2）→ stale 且摘要被清空', async () => {
    const h = preparedHarness();
    await prepare(h);
    expect(h.handle.snapshot().digest).not.toBeNull();

    const res = await h.handle.tickDeliver(cst(2026, 3, 13, 10, 30));
    expect(res).toEqual({ sent: false, reason: 'stale' });
    expect(h.handle.snapshot().digest).toBeNull();
    expect(exists(h.dataDir)).toBe(false);
    expect(h.deliverCalls).toHaveLength(0);
  });
});

describe('tickDeliver · 失败重试', () => {
  it('deliver ok=false → 不标已投递，同一天最多试 3 次', async () => {
    let calls = 0;
    const h = preparedHarness({
      deliver: async () => {
        calls += 1;
        return { ok: false, reason: '会话没活着' };
      },
    });
    await prepare(h);

    for (let i = 0; i < 3; i += 1) {
      const res = await h.handle.tickDeliver(cst(2026, 3, 10, 10, i * 5));
      expect(res.sent).toBe(false);
      expect(res.reason).toBe('会话没活着');
      // 每次失败都不能标已投递
      expect(h.handle.snapshot().digest?.deliveredAt).toBeUndefined();
    }
    expect(calls).toBe(3);

    const fourth = await h.handle.tickDeliver(cst(2026, 3, 10, 11, 0));
    expect(fourth).toEqual({ sent: false, reason: 'too-many-attempts' });
    // 第 4 次连 deliver 都不调，避免死循环刷日志
    expect(calls).toBe(3);
  });
});

describe('持久化', () => {
  it('重启后读回摘要，仍能在当天投递', async () => {
    const dataDir = tmpDir();
    const first = createDotaDigest({
      config: cfg(),
      dataDir,
      logger: silentLogger,
      bindings: () => [{ openid: 'u_a', alias: '小周', steamId: STEAM_A }],
      queryForm: async () => mkForm(1, [
        mkMatch({ matchId: 101, at: QUERY_AT - 1 * 3600e3, win: false, k: 3, d: 9, a: 4 }),
        mkMatch({ matchId: 102, at: QUERY_AT - 2 * 3600e3, win: false, k: 4, d: 8, a: 3 }),
        mkMatch({ matchId: 103, at: QUERY_AT - 3 * 3600e3, win: false, k: 2, d: 10, a: 5 }),
      ]),
      pickGroup: () => 'group-openid-1',
      deliver: async () => ({ ok: true }),
      now: () => QUERY_AT,
    });
    expect((await first.tickQuery(QUERY_AT)).count).toBe(1);

    // 新进程：读盘恢复
    const calls: string[] = [];
    const second = createDotaDigest({
      config: cfg(),
      dataDir,
      logger: silentLogger,
      bindings: () => [],
      queryForm: async () => {
        throw new Error('不应该再查一次');
      },
      pickGroup: () => 'group-openid-1',
      deliver: async (_g: string, text: string) => {
        calls.push(text);
        return { ok: true };
      },
      now: () => cst(2026, 3, 10, 10, 30),
    });

    expect(second.snapshot().digest?.forDay).toBe(FOR_DAY);
    const res = await second.tickDeliver(cst(2026, 3, 10, 10, 30));
    expect(res.sent).toBe(true);
    expect(calls).toHaveLength(1);

    // 损坏的文件降级为 null，不抛错
    fs.writeFileSync(path.join(dataDir, 'dota-digest.json'), '{ 这不是 JSON', 'utf8');
    const third = createDotaDigest({
      config: cfg(),
      dataDir,
      logger: silentLogger,
      bindings: () => [],
      queryForm: async () => mkForm(1, []),
      pickGroup: () => null,
      deliver: async () => ({ ok: true }),
    });
    expect(third.snapshot().digest).toBeNull();
  });
});

// ── 新鲜度窗口 & 跨天去重 ──────────────────────────────────

describe('recentHours · 只要新鲜的', () => {
  it('recentHours=24 时，30 小时前打过的被过滤掉', async () => {
    const forms: Record<number, DotaForm> = {
      // 30 小时前（QUERY_AT 03-10 03:30 往前推 30h = 03-08 21:30）
      1: mkForm(1, [mkMatch({ matchId: 1, at: cst(2026, 3, 8, 21, 30), win: true, k: 10, d: 1, a: 10 })]),
    };
    const h = harness({
      config: { recentHours: 24 },
      forms,
      bindings: () => [{ openid: 'o1', alias: '小周', steamId: STEAM_A }],
    });
    const res = await h.handle.tickQuery(QUERY_AT);
    expect(res.ran).toBe(false);
    expect(res.reason).toBe('no-highlight');
    expect(exists(h.dataDir)).toBe(false);
  });

  it('recentHours=24 时，20 小时前打的 Carry 局可以播', async () => {
    const forms: Record<number, DotaForm> = {
      // 20 小时前（03-09 07:30）
      1: mkForm(1, [mkMatch({ matchId: 2, at: cst(2026, 3, 9, 7, 30), win: true, k: 10, d: 1, a: 10 })]),
    };
    const h = harness({
      config: { recentHours: 24 },
      forms,
      bindings: () => [{ openid: 'o1', alias: '小周', steamId: STEAM_A }],
    });
    const res = await h.handle.tickQuery(QUERY_AT);
    expect(res.ran).toBe(true);
    expect(res.count).toBe(1);
  });
});

describe('跨天去重 · 同人同类 3 天内不重复播', () => {
  it('播过一次连败后，下次同样是连败就不再播；换成连胜仍可播', async () => {
    const forms: Record<number, DotaForm> = {};
    const h = harness({
      config: { recentHours: 48 },
      forms,
      bindings: () => [{ openid: 'o1', alias: '小周', steamId: STEAM_A }],
    });

    // 第一天：3 连败 → 播
    forms[1] = mkForm(1, [
      mkMatch({ matchId: 101, at: cst(2026, 3, 10, 1, 0), win: false }),
      mkMatch({ matchId: 100, at: cst(2026, 3, 9, 23, 0), win: false }),
      mkMatch({ matchId: 99, at: cst(2026, 3, 9, 21, 0), win: false }),
    ]);
    const q1 = await h.handle.tickQuery(QUERY_AT);
    expect(q1.ran).toBe(true);
    expect(q1.count).toBe(1);
    const d1 = await h.handle.tickDeliver(cst(2026, 3, 10, 10, 30));
    expect(d1.sent).toBe(true);

    // 第二天：还是 3 连败（换了新败局，但 kind 一样）→ 被去重，不播
    forms[1] = mkForm(1, [
      mkMatch({ matchId: 201, at: cst(2026, 3, 11, 22, 0), win: false }),
      mkMatch({ matchId: 200, at: cst(2026, 3, 11, 20, 0), win: false }),
      mkMatch({ matchId: 199, at: cst(2026, 3, 11, 18, 0), win: false }),
    ]);
    const q2 = await h.handle.tickQuery(cst(2026, 3, 12, 3, 30));
    expect(q2.ran).toBe(false);
    expect(q2.reason).toBe('no-highlight');

    // 第三天：换成 3 连胜（不同 kind）→ 不该被连败的历史挡住
    forms[1] = mkForm(1, [
      mkMatch({ matchId: 301, at: cst(2026, 3, 12, 22, 0), win: true }),
      mkMatch({ matchId: 300, at: cst(2026, 3, 12, 20, 0), win: true }),
      mkMatch({ matchId: 299, at: cst(2026, 3, 12, 18, 0), win: true }),
    ]);
    const q3 = await h.handle.tickQuery(cst(2026, 3, 13, 3, 30));
    expect(q3.ran).toBe(true);
    expect(q3.count).toBe(1);
    expect(h.handle.snapshot().digest?.items[0]?.kind).toBe('win-streak');
  });

  it('去重历史落盘，重启后依然生效', async () => {
    const forms: Record<number, DotaForm> = {
      1: mkForm(1, [
        mkMatch({ matchId: 1, at: cst(2026, 3, 10, 1, 0), win: false }),
        mkMatch({ matchId: 2, at: cst(2026, 3, 9, 23, 0), win: false }),
        mkMatch({ matchId: 3, at: cst(2026, 3, 9, 21, 0), win: false }),
      ]),
    };
    const first = harness({
      config: { recentHours: 48 },
      forms,
      bindings: () => [{ openid: 'o1', alias: '小周', steamId: STEAM_A }],
    });
    await first.handle.tickQuery(QUERY_AT);
    await first.handle.tickDeliver(cst(2026, 3, 10, 10, 30));

    // 第二天又是 3 连败，且是新鲜战绩（避免被 48h 窗口过滤，确保考的是"去重"而不是"过期"）
    forms[1] = mkForm(1, [
      mkMatch({ matchId: 201, at: cst(2026, 3, 11, 22, 0), win: false }),
      mkMatch({ matchId: 200, at: cst(2026, 3, 11, 20, 0), win: false }),
      mkMatch({ matchId: 199, at: cst(2026, 3, 11, 18, 0), win: false }),
    ]);

    // 新实例指向同一 dataDir：历史应被读回
    const second = createDotaDigest({
      config: cfg({ recentHours: 48 }),
      dataDir: first.dataDir,
      logger: silentLogger,
      bindings: () => [{ openid: 'o1', alias: '小周', steamId: STEAM_A }],
      queryForm: async () => forms[1]!,
      pickGroup: () => 'group-openid-1',
      deliver: async () => ({ ok: true }),
    });
    const res = await second.tickQuery(cst(2026, 3, 12, 3, 30));
    expect(res.ran).toBe(false);
    expect(res.reason).toBe('no-highlight');
  });
});
