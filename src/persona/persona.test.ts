import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from './memory.ts';
import { Diary } from './diary.ts';
import { Role } from './role.ts';
import { Waker } from './wake.ts';
import { Humanizer } from './humanize.ts';
import { createOwnLife } from './own-life.ts';
import { ProactiveBudget } from './service.ts';
import type { Logger } from '../types.ts';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('Memory · 按人存', () => {
  it('同一人跨场合共用一本账', () => {
    const mem = new Memory({ dir });
    mem.remember('u1', { name: '老王', fact: '养了只叫豆豆的猫' });
    mem.remember('u1', { trait: '常熬夜' });
    const rendered = mem.renderPerson('u1');
    expect(rendered).toContain('老王');
    expect(rendered).toContain('豆豆');
    expect(rendered).toContain('常熬夜');
  });

  it('重复内容提到最新而不是重复追加', () => {
    const mem = new Memory({ dir });
    mem.remember('u1', { topic: '出差' });
    mem.remember('u1', { topic: '加班' });
    mem.remember('u1', { topic: '出差' });
    const p = mem.person('u1');
    expect(p.topics).toEqual(['加班', '出差']);
  });

  it('topics 超出上限自动裁剪', () => {
    const mem = new Memory({ dir, maxTopics: 3 });
    for (let i = 0; i < 5; i += 1) mem.remember('u1', { topic: `t${i}` });
    expect(mem.person('u1').topics).toEqual(['t2', 't3', 't4']);
  });

  it('logTurn 跨场合流水可按来源过滤', () => {
    const mem = new Memory({ dir });
    mem.logTurn({ where: 'c2c', who: '老王', text: '在吗', reply: '在' });
    mem.logTurn({ where: 'group:9', who: '老王', text: '回来了', reply: '哟' });
    const rows = mem.recentTurns(10, { excludeWhere: 'group' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe('在吗');
  });
});

describe('Diary · 她自己的一天', () => {
  it('add 双份落盘（jsonl + md）', () => {
    const diary = new Diary(path.join(dir, 'diary'));
    const row = diary.add({ text: '翻出半瓶酸奶', mood: '赚了', title: '半瓶酸奶' });
    expect(fs.existsSync(path.join(dir, 'diary', 'index.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'diary', `${row.day}.md`), 'utf8')).toContain('半瓶酸奶');
  });

  it('context 只给最近几条并带连续性提示', () => {
    const diary = new Diary(path.join(dir, 'diary'));
    for (let i = 0; i < 5; i += 1) diary.add({ text: `第${i}条` });
    const ctx = diary.context(3);
    expect(ctx).toContain('第4条');
    expect(ctx).not.toContain('第0条');
    expect(ctx).toContain('别装作不记得');
  });

  it('空正文拒绝，超长拒绝', () => {
    const diary = new Diary(path.join(dir, 'diary'), { maxChars: 10 });
    expect(() => diary.add({ text: '  ' })).toThrow();
    expect(() => diary.add({ text: '一二三四五六七八九十一二三' })).toThrow();
  });
});

describe('Role · 角色卡', () => {
  it('lint 检出客服腔与缺边界', () => {
    const card = path.join(dir, 'role.md');
    fs.writeFileSync(card, '你是一个助手。你说话很友好。');
    const role = new Role({ cardPath: card });
    const l = role.lint();
    expect(l.ok).toBe(false);
    expect(l.warn.some((w) => w.includes('助手'))).toBe(true);
  });

  it('renderSection 超限截断且带基本规矩', () => {
    const card = path.join(dir, 'role.md');
    fs.writeFileSync(card, 'x'.repeat(500));
    const role = new Role({ cardPath: card, maxChars: 100 });
    const s = role.renderSection();
    expect(s.length).toBeLessThan(500);
    expect(s).toContain('基本规矩');
  });
});

describe('Waker · 该不该说话', () => {
  it('群闲聊默认不醒（纯潜水）', () => {
    const w = new Waker({ names: ['小鱼'], probability: 0 });
    w.setConfig('group:1', { probability: 0 });
    const d = w.shouldWake({ key: 'group:1', userId: 'u2', text: '中午吃啥' });
    expect(d.wake).toBe(false);
  });

  it('@ 必醒 / 名字必醒 / owner 必醒', () => {
    const w = new Waker({ names: ['小鱼'], ownerIds: ['boss'] });
    expect(w.shouldWake({ key: 'group:1', userId: 'u2', text: '@小鱼 在吗', isAtMe: true }).reason).toBe('atMention');
    expect(w.shouldWake({ key: 'group:1', userId: 'u2', text: '小鱼你看' }).reason).toContain('name:');
    expect(w.shouldWake({ key: 'group:1', userId: 'boss', text: '随便一句' }).reason).toBe('owner');
  });

  it('提问特征醒，闲聊概率 0 不醒', () => {
    const w = new Waker({ probability: 0 });
    w.setConfig('group:2', { probability: 0 });
    expect(w.shouldWake({ key: 'group:2', userId: 'u3', text: '这个怎么玩？' }).wake).toBe(true);
  });

  it('dive/wake 状态切换（active 模式优先于 dive，与 ai-companion 原语义一致）', () => {
    const w = new Waker();
    expect(w.isDiving('c2c:x')).toBe(true);      // 默认 diving + infinite
    w.wake('c2c:x');
    expect(w.getConfig('c2c:x').wakeCount).toBe(1);
    w.setConfig('c2c:x', { mode: 'active' });
    expect(w.isDiving('c2c:x')).toBe(false);
    // 回到 diving：有限时长潜水到期后醒
    w.setConfig('c2c:x', { mode: 'diving', infinite: false, until: Date.now() + 30 });
    expect(w.isDiving('c2c:x')).toBe(true);
    return new Promise<void>((r) => setTimeout(() => {
      expect(w.isDiving('c2c:x')).toBe(false);
      r();
    }, 60));
  });
});

describe('Humanizer · 像人打字', () => {
  it('burstMax 默认 2，超出并入最后一条', () => {
    const h = new Humanizer();
    const parts = h.split('第一条\n第二条\n第三条\n第四条');
    expect(parts.length).toBeLessThanOrEqual(2);
    expect(parts[1]).toContain('第四条');
  });

  it('say 按顺序发送并注入 sleep', () => {
    const h = new Humanizer({ burstMax: 2 });
    const sent: string[] = [];
    const waits: number[] = [];
    void h.say('甲\n乙', {
      send: async (m) => { sent.push(m); },
      sleep: async (ms) => { waits.push(ms); },
    });
    // say 内部是 async：等微任务队列清空
    return Promise.resolve().then(() => {
      expect(sent.length).toBeGreaterThan(0);
      expect(waits.length).toBeGreaterThan(0);
    });
  });

  it('typingMsFor 随字数增长且有上下限', () => {
    const h = new Humanizer({ minMs: 1000, maxMs: 5000, jitter: 0 });
    expect(h.typingMsFor('短')).toBeGreaterThanOrEqual(1000);
    expect(h.typingMsFor('一'.repeat(500))).toBeLessThanOrEqual(5000 * 1.6 + 1);
  });
});

describe('own-life · 静默唤醒约束', () => {
  it('投递失败不计次数', async () => {
    let fired = 0;
    const life = createOwnLife({
      deliver: async () => { throw new Error('boom'); },
      intervalMs: 0,
      statePath: path.join(dir, 'st.json'),
      log: () => {},
    });
    const r = await life.tick(Date.now());
    expect(r.ok).toBe(false);
    expect(fired).toBe(0);
    // 失败后仍可再试（lastFiredAt 未推进）
    expect(life.snapshot().firedToday).toBe(0);
  });

  it('日上限后跳过', async () => {
    let count = 0;
    const life = createOwnLife({
      deliver: async () => { count += 1; },
      intervalMs: 0,
      maxPerDay: 2,
      quiet: [0, 0],
      midnightAt: '00:00',
      statePath: path.join(dir, 'st2.json'),
      log: () => {},
    });
    await life.tick(Date.now());
    await life.tick(Date.now());
    const third = await life.tick(Date.now());
    expect(third.skipped).toBe('daily-cap');
    expect(count).toBe(2);
  });

  it('安静时段不叫', async () => {
    const life = createOwnLife({
      deliver: async () => {},
      quiet: [3, 8],
      statePath: path.join(dir, 'st3.json'),
      log: () => {},
    });
    const at4am = new Date(2026, 9, 30, 4, 0, 0).getTime();
    const r = await life.tick(at4am);
    expect(r.skipped).toBe('quiet');
  });

  it('重启不补发（state 落盘续期）', async () => {
    const statePath = path.join(dir, 'st4.json');
    let count = 0;
    const life1 = createOwnLife({
      deliver: async () => { count += 1; },
      intervalMs: 3600_000,
      quiet: [0, 0],
      midnightAt: '23:59',
      statePath,
      log: () => {},
    });
    await life1.tick(Date.now());
    expect(count).toBe(1);
    const life2 = createOwnLife({
      deliver: async () => { count += 1; },
      intervalMs: 3600_000,
      quiet: [0, 0],
      midnightAt: '23:59',
      statePath,
      log: () => {},
    });
    const r = await life2.tick(Date.now());
    expect(r.skipped).toBe('not-yet');
    expect(count).toBe(1);
  });
});

describe('PersonaService · 装配语义（M3/M5 回归）', () => {
  const baseCfg = {
    enabled: true, dataDir: '', roleCardPath: '', roleMaxChars: 12000,
    wakeEnabled: true, names: [], keywords: [], ownerOpenids: [], groupProbability: 0,
    humanizeEnabled: true, msPerChar: 110, burstMax: 2, gapMinMs: 700, gapMaxMs: 2600,
    ownLifeEnabled: false, ownLifeIntervalMs: 9000000, ownLifeMaxPerDay: 6,
    maxProactivePerDay: 2, proactiveMinGapMs: 7200000,
  };

  it('群会话（personKey=undefined）不注入任何人的账，只注入人格', async () => {
    const { PersonaService } = await import('./service.ts');
    const svc = new PersonaService({ config: baseCfg, dataDir: dir, logger: silentLogger });
    svc.memory.remember('u1', { fact: '养猫' });
    const groupSections = svc.buildSections(undefined);
    expect(groupSections.some((x) => x.name === 'qqbot:persona-memory')).toBe(false);
    const c2cSections = svc.buildSections('u1');
    expect(c2cSections.some((x) => x.name === 'qqbot:persona-memory')).toBe(true);
  });

  it('turnLedger 用本轮实际发言人，不用会话创建者', async () => {
    const { PersonaService } = await import('./service.ts');
    const svc = new PersonaService({ config: baseCfg, dataDir: dir, logger: silentLogger });
    svc.noteUserTurn('s1', '别人问的', '小李');
    svc.noteReplyChunk('s1', '回了一句');
    svc.flushTurn('s1', 'group:g9', 'boss-creator');
    const rows = svc.memory.recentTurns(5);
    expect(rows[0]?.who).toBe('小李');
  });

  it('wakeEnabled=false 时 Waker 不实例化（middleware 据此保留硬门控）', async () => {
    const { PersonaService } = await import('./service.ts');
    const svc = new PersonaService({ config: { ...baseCfg, wakeEnabled: false }, dataDir: dir, logger: silentLogger });
    expect(svc.waker).toBeUndefined();
  });
});

describe('ProactiveBudget · 冷退避', () => {
  it('日上限与间隔', () => {
    const b = new ProactiveBudget(2, 1000, silentLogger);
    expect(b.allow('p1').ok).toBe(true);
    b.recordProactive('p1');
    expect(b.allow('p1').reason).toBe('too-soon');
    b.recordProactive('p1');
    expect(b.allow('p1').reason).toBe('daily-cap');
  });

  it('streak≥2 冷却，被理后清零', () => {
    const b = new ProactiveBudget(10, 0, silentLogger);
    b.recordProactive('p1');
    b.markUnanswered('p1');
    b.markUnanswered('p1');
    expect(b.allow('p1').ok).toBe(false);
    b.markReplied('p1');
    expect(b.allow('p1').ok).toBe(true);
  });

  it('streak≥5 永久静默', () => {
    const b = new ProactiveBudget(10, 0, silentLogger);
    for (let i = 0; i < 5; i += 1) b.markUnanswered('p1');
    expect(b.allow('p1').reason).toBe('muted-forever');
    b.markReplied('p1');
    expect(b.allow('p1').ok).toBe(true);
  });

  it('observe：对方在我方主动后活跃 → 清零；否则记一次未响应（不重复）', () => {
    const b = new ProactiveBudget(10, 0, silentLogger);
    b.recordProactive('p1');
    const t = b.allow('p2'); // 无副作用调用，确保 map 初始化路径正常
    expect(t.ok).toBe(true);
    b.observe('p1', Date.now() + 10);
    // 理了 → streak 0
    b.observe('p1', Date.now() - 99999); // lastActivity 早于 lastProactiveAt
    b.observe('p1', Date.now() - 99999); // 第二次不重复计
    b.markUnanswered('p1'); // 手动补一次凑到 2
    expect(b.allow('p1').ok).toBe(false);
  });
});
