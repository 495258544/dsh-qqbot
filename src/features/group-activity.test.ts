/**
 * group-activity 测试
 * ─────────────────────────────────────────────────────────────
 * 风格对齐 src/steam/settings.test.ts：每个用例一个独立临时目录（mkdtempSync），
 * afterEach 直接 rmSync 掉，避免落盘状态互相污染；logger 用自己写的收集型实现，
 * 不引入 mock 库。
 *
 * 时间全部用注入的时钟（opts.now / score 的 now 参数）控制，
 * 不依赖真实时间流逝，避免测试变慢或抖动。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupActivityStore, isDotaText, pickBestGroup, DOTA_KEYWORDS } from './group-activity.ts';

/** 固定的"现在"：2026-01-01 12:00:00 UTC，跟机器时区无关 */
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const HOUR = 3600 * 1000;

/** 收集型 logger：把日志攒下来供断言 */
class CollectingLogger {
  readonly messages: string[] = [];

  log(msg: string): void {
    this.messages.push(msg);
  }
}

let dir: string;
let logger: CollectingLogger;
/** 可变的注入时钟：用例里想"走到几小时后"，改它就行 */
let clockNow: number;

/** 每个用例一个独立临时目录 */
function makeStore(dataDir: string = dir): GroupActivityStore {
  return new GroupActivityStore({ dataDir, log: (m) => logger.log(m), now: () => clockNow });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-group-activity-'));
  logger = new CollectingLogger();
  clockNow = BASE;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isDotaText', () => {
  it('正例：黑话、dota 大小写混写都算', () => {
    expect(isDotaText('今晚开黑吗')).toBe(true);
    expect(isDotaText('来把dota')).toBe(true);
    expect(isDotaText('DOTA2 上号')).toBe(true);
    expect(isDotaText('这把战绩太坑了')).toBe(true);
    expect(isDotaText('我天梯 5000')).toBe(true);
    expect(isDotaText('TI 冠军是谁')).toBe(true);
  });

  it('反例：time / title 这类含 ti 的单词不能误中，日常闲聊也不算', () => {
    expect(isDotaText('time')).toBe(false);
    expect(isDotaText('title')).toBe(false);
    expect(isDotaText('today is a good day')).toBe(false);
    expect(isDotaText('今天吃什么')).toBe(false);
    expect(isDotaText('')).toBe(false);
  });

  it('DOTA_KEYWORDS 覆盖需求里点名的词（含群里的习惯说法「打刀」）', () => {
    for (const kw of ['dota', 'dota2', '刀塔', '刀圈', '打刀', '开黑', '上号', '上分', '天梯', '硬辅', '大哥', '中单', '打野', '战绩', '坑', '送', '划水', '五黑', 'rank', 'mmr', 'vp', 'ti']) {
      expect(DOTA_KEYWORDS).toContain(kw);
    }
  });

  it('「打刀」这种群里习惯说法能命中', () => {
    expect(isDotaText('今晚打刀去')).toBe(true);
    expect(isDotaText('下班打刀吗')).toBe(true);
  });

  it('关键词表可自定义：传了自定义表就只用自定义表', () => {
    // 自定义表里没有「打刀」，就不该命中
    expect(isDotaText('今晚打刀去', ['dota', '刀塔'])).toBe(false);
    // 自定义表里有专属词，就命中
    expect(isDotaText('来一把 1v1', ['1v1', 'solo'])).toBe(true);
    // 空数组 = 永不算命中
    expect(isDotaText('来把dota', [])).toBe(false);
  });
});

describe('GroupActivityStore · 关键词可配置', () => {
  it('构造时传 keywords，record 只认这套词', () => {
    const store = new GroupActivityStore({
      dataDir: dir,
      log: (m) => logger.log(m),
      now: () => clockNow,
      keywords: ['solo'],
    });
    // 默认表里有「打刀」，但自定义表没有 → 不算 Dota 命中
    store.record('g1', 'u1', '今晚打刀去');
    // 自定义表里的词 → 命中
    store.record('g2', 'u1', '来把 solo');

    const e1 = store.entries().find((e) => e.groupId === 'g1');
    const e2 = store.entries().find((e) => e.groupId === 'g2');
    expect(e1?.lastDotaAt).toBe(0);
    expect(e2?.lastDotaAt).toBe(clockNow);
  });
});

describe('GroupActivityStore · 基础', () => {
  it('全新 store：score 为 0，entries 为空', () => {
    const store = makeStore();

    expect(store.score('g:1', [])).toBe(0);
    expect(store.score('g:1', ['openid-a'])).toBe(0);
    expect(store.entries()).toEqual([]);
  });

  it('record 一条含关键词的消息：lastDotaAt > 0、dotaHits = 1，分数明显高于只有闲聊的群', () => {
    const store = makeStore();

    store.record('g:dota', 'u1', '今晚开黑吗');
    store.record('g:plain', 'u2', '今天吃什么');

    const dotaEntry = store.entries().find((e) => e.groupId === 'g:dota');
    expect(dotaEntry).toBeDefined();
    expect(dotaEntry?.lastDotaAt).toBe(BASE);
    expect(dotaEntry?.dotaHits).toBe(1);
    expect(dotaEntry?.lastAt).toBe(BASE);

    const dotaScore = store.score('g:dota', []);
    const plainScore = store.score('g:plain', []);
    // Dota 相关度满档 100 + 活跃 20 = 120；闲聊群只有活跃 20
    expect(dotaScore).toBe(120);
    expect(plainScore).toBe(20);
    expect(dotaScore - plainScore).toBeGreaterThanOrEqual(100);
  });

  it('成员相关度：当事人 openid 在该群说过话，至少多拿 30 分', () => {
    const store = makeStore();
    store.record('g:1', 'openid-a', '随便聊聊');

    const withMember = store.score('g:1', ['openid-a']);
    const withoutMember = store.score('g:1', []);

    expect(withMember - withoutMember).toBeGreaterThanOrEqual(30);
    // 同一个人传两遍只算一次
    expect(store.score('g:1', ['openid-a', 'openid-a'])).toBe(withMember);
  });

  it('空 groupId / 空 senderId 直接忽略；空文本只更新 lastAt，不算 Dota 也不算发言者', () => {
    const store = makeStore();

    store.record('', 'u1', '开黑');
    store.record('  ', 'u1', '开黑');
    store.record('g:1', '', '开黑');
    expect(store.entries()).toEqual([]);

    store.record('g:1', 'u1', '');
    const entry = store.entries()[0];
    expect(entry?.groupId).toBe('g:1');
    expect(entry?.lastAt).toBe(BASE);
    expect(entry?.lastDotaAt).toBe(0);
    expect(entry?.dotaHits).toBe(0);
    expect(entry?.senders).toEqual([]);
  });

  it('发言者去重、新的在前、最多 20 个', () => {
    const store = makeStore();
    for (let i = 0; i < 25; i += 1) store.record('g:1', `u${i}`, '在');

    const senders = store.entries()[0]?.senders ?? [];
    expect(senders.length).toBe(20);
    expect(senders[0]).toBe('u24');
    expect(senders).not.toContain('u4');

    // 同一个人再说一句：只挪到最前，不重复占位
    store.record('g:1', 'u10', '我又来了');
    const after = store.entries()[0]?.senders ?? [];
    expect(after.filter((id) => id === 'u10')).toHaveLength(1);
    expect(after[0]).toBe('u10');
  });

  it('entries 按 lastAt 倒序；返回的是拷贝，改它不影响内部状态', () => {
    const store = makeStore();
    store.record('g:old', 'u1', '早上好');
    clockNow = BASE + HOUR;
    store.record('g:new', 'u1', '中午好');

    expect(store.entries().map((e) => e.groupId)).toEqual(['g:new', 'g:old']);

    const copy = store.entries()[0];
    expect(copy).toBeDefined();
    if (copy) copy.senders.push('hacker');
    expect(store.entries()[0]?.senders).not.toContain('hacker');
  });
});

describe('GroupActivityStore · 评分衰减', () => {
  it('Dota 关键词 10 小时前命中 vs 100 小时前命中：前者更高，超 72h 那档 Dota 分为 0', () => {
    const store = makeStore();
    store.record('g:1', 'u1', '来把dota'); // lastAt = lastDotaAt = BASE

    const at10h = store.score('g:1', [], BASE + 10 * HOUR);
    const at100h = store.score('g:1', [], BASE + 100 * HOUR);

    // 10h：Dota 100-10=90，活跃 20 → 110
    expect(at10h).toBe(110);
    // 100h：Dota 超窗记 0，活跃超 72h 也记 0 → 0
    expect(at100h).toBe(0);
    expect(at10h).toBeGreaterThan(at100h);

    // 边界：71h 还在窗内（29 分 + 活跃 10 分），73h 两档都归零
    expect(store.score('g:1', [], BASE + 71 * HOUR)).toBe(29 + 10);
    expect(store.score('g:1', [], BASE + 73 * HOUR)).toBe(0);
  });

  it('命中次数每 5 次 +2，最多 +10', () => {
    const store = makeStore();
    for (let i = 0; i < 25; i += 1) store.record('g:1', 'u1', '开黑');

    const entry = store.entries()[0];
    expect(entry?.dotaHits).toBe(25);
    // 25 次 → floor(25/5)*2 = 10（正好封顶），Dota 分 100 + 10 但总分封顶 100
    expect(store.score('g:1', [], BASE)).toBe(100 + 20);
  });
});

describe('pickBestGroup', () => {
  it('聊过 dota 且有当事人发言的群，击败只是最近活跃的群', () => {
    const store = makeStore();
    store.record('g:a', 'openid-a', '来把dota');
    store.record('g:b', 'someone', '早上好');

    expect(pickBestGroup(store, ['g:a', 'g:b'], ['openid-a'], BASE)).toBe('g:a');
    // 顺序无关：候选倒过来还是 A
    expect(pickBestGroup(store, ['g:b', 'g:a'], ['openid-a'], BASE)).toBe('g:a');
    // 没有当事人绑定时，A 依然靠 Dota 相关度赢
    expect(pickBestGroup(store, ['g:b', 'g:a'], [], BASE)).toBe('g:a');
  });

  it('候选为空（或全是空串）返回 null', () => {
    const store = makeStore();
    store.record('g:a', 'u1', '开黑');

    expect(pickBestGroup(store, [], ['u1'], BASE)).toBeNull();
    expect(pickBestGroup(store, ['', '  '], ['u1'], BASE)).toBeNull();
  });

  it('候选里没给出的群不参与，哪怕它分最高', () => {
    const store = makeStore();
    store.record('g:hot', 'openid-a', '开黑上号');
    store.record('g:alive', 'someone', '早上好');

    // g:hot 分远高于 g:alive，但不在候选（= 会话已死）里，不能被挑中
    expect(store.score('g:hot', ['openid-a'], BASE)).toBeGreaterThan(store.score('g:alive', [], BASE));
    expect(pickBestGroup(store, ['g:alive'], ['openid-a'], BASE)).toBe('g:alive');
  });

  it('同分时按 lastAt 倒序（谁更新谁赢）', () => {
    const store = makeStore();
    clockNow = BASE;
    store.record('g:old', 'u1', '在');
    clockNow = BASE + HOUR;
    store.record('g:new', 'u1', '在');

    expect(pickBestGroup(store, ['g:old', 'g:new'], [], clockNow)).toBe('g:new');
  });
});

describe('GroupActivityStore · 落盘', () => {
  it('record + persist 后新实例能读回同样的 groupId 与 dotaHits', () => {
    const store = makeStore();
    store.record('g:1', 'u1', '开黑');
    store.record('g:1', 'u2', '上号');
    store.record('g:2', 'u3', '今天吃什么');
    store.persist();

    // 盘上结构固定：{ version: 1, groups: [...] }
    const onDisk = JSON.parse(readFileSync(join(dir, 'group-activity.json'), 'utf8')) as {
      version: number;
      groups: { groupId: string; dotaHits: number }[];
    };
    expect(onDisk.version).toBe(1);
    expect(onDisk.groups.map((g) => g.groupId).sort()).toEqual(['g:1', 'g:2']);

    const reloaded = makeStore();
    const entry = reloaded.entries().find((e) => e.groupId === 'g:1');
    expect(entry?.dotaHits).toBe(2);
    expect(entry?.lastDotaAt).toBe(BASE);
    expect(entry?.senders).toEqual(['u2', 'u1']);
    expect(reloaded.entries().find((e) => e.groupId === 'g:2')?.dotaHits).toBe(0);
  });

  it('dataDir 为空串：纯内存模式不落盘，也不抛错', () => {
    const store = makeStore('');
    store.record('g:1', 'u1', '开黑');
    expect(() => store.persist()).not.toThrow();
    expect(store.entries()[0]?.dotaHits).toBe(1);
  });

  it('文件被写坏（{bad）：构造不抛错，entries 为空，且 log 被调用', () => {
    writeFileSync(join(dir, 'group-activity.json'), '{bad', 'utf8');

    let store: GroupActivityStore | undefined;
    expect(() => {
      store = makeStore();
    }).not.toThrow();

    expect(store?.entries()).toEqual([]);
    expect(logger.messages.length).toBeGreaterThan(0);
  });

  it('最多保留 200 个群，超出按 lastAt 淘汰最久没动静的', () => {
    const store = makeStore();
    for (let i = 0; i < 205; i += 1) {
      clockNow = BASE + i * 1000;
      store.record(`g:${i}`, 'u1', '在');
    }

    const list = store.entries();
    expect(list.length).toBe(200);
    expect(list.some((e) => e.groupId === 'g:0')).toBe(false);
    expect(list.some((e) => e.groupId === 'g:4')).toBe(false);
    expect(list[0]?.groupId).toBe('g:204');
  });
});
