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

  it('B1 回归：__proto__ 不能写穿全局原型链', () => {
    const mem = new Memory({ dir });
    expect(() => mem.remember('__proto__', { fact: 'x' })).toThrow();
    expect(({} as Record<string, unknown>).interactions).toBeUndefined();
  });

  it('B1 回归：constructor 保留键被拒', () => {
    const mem = new Memory({ dir });
    expect(() => mem.remember('constructor', { trait: '顿悟' })).toThrow();
    // 合法 openid 形态（含 . - ）不受影响
    expect(() => mem.remember('u.abc-def_1', { trait: 'ok' })).not.toThrow();
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

  it('renderSection 超限截断（M13 后只放角色卡，硬约束移到 anchor）', () => {
    const card = path.join(dir, 'role.md');
    fs.writeFileSync(card, 'x'.repeat(500));
    const role = new Role({ cardPath: card, maxChars: 100 });
    const s = role.renderSection();
    expect(s.length).toBeLessThan(500);
    // M13：BASE_RULES 不再塞进 renderSection，改由 renderAnchor 在历史之后注入
    expect(s).not.toContain('基本规矩');
    expect(role.renderAnchor()).toContain('此刻提醒');
    expect(role.renderAnchor()).toContain('不是 AI 助手');
  });
});

describe('Waker · 该不该说话', () => {
  it('群闲聊默认不醒（纯潜水）', () => {
    const w = new Waker({ names: ['小鱼'], probability: 0 });
    w.setConfig('group:1', { probability: 0 });
    const d = w.shouldWake({ key: 'group:1', userId: 'u2', text: '中午吃啥' });
    expect(d.wake).toBe(false);
  });

  it('@ 必醒 / 名字必醒 / owner 不@也潜水', () => {
    const w = new Waker({ names: ['小鱼'], ownerIds: ['boss'] });
    expect(w.shouldWake({ key: 'group:1', userId: 'u2', text: '@小鱼 在吗', isAtMe: true }).reason).toBe('atMention');
    expect(w.shouldWake({ key: 'group:1', userId: 'u2', text: '小鱼你看' }).reason).toContain('name:');
    // 方案A：潜水优先——owner 说话不再强制必醒，不@ 就走潜水
    expect(w.shouldWake({ key: 'group:1', userId: 'boss', text: '随便一句' }).wake).toBe(false);
    // 但 owner @自己名字仍会命中名字规则（潜水规则对 owner 同样生效）
    expect(w.shouldWake({ key: 'group:1', userId: 'boss', text: '小鱼在吗' }).reason).toContain('name:');
  });

  it('潜水期：明确问句且像在问她 → 醒；泛泛的问句不再无脑醒', () => {
    const w = new Waker({ probability: 0, names: ['小羽'] });
    w.setConfig('group:2', { probability: 0 });
    // 明确指向她（第二人称/点名）→ 醒
    expect(w.shouldWake({ key: 'group:2', userId: 'u3', text: '小羽这个怎么玩？' }).wake).toBe(true);
    expect(w.shouldWake({ key: 'group:2', userId: 'u3', text: '你觉得这个怎么玩？' }).wake).toBe(true);
    // 纯问句、完全不指向她 → 潜水期不插手（"只在感兴趣时说话"）
    expect(w.shouldWake({ key: 'group:2', userId: 'u3', text: '这个怎么玩？' }).wake).toBe(false);
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

  it('m9: prune 清理久远唤醒过的会话，保留近期唤醒/纯潜水', () => {
    const w = new Waker();
    w.setConfig('group:old', {});   // 未唤醒过 → 保守保留
    w.wake('group:old');            // wake 但很久以前（模拟，手动改 lastWakeAt）
    // 手动改写两个 key 的时间
    const oldCfg = w.getConfig('group:old');
    oldCfg.lastWakeAt = Date.now() - 60 * 24 * 3600_000;       // 60 天前
    w.setConfig('group:fresh', {});
    w.wake('group:fresh');           // 刚唤醒
    w.setConfig('group:never', {});  // 从未唤醒 → 保守保留
    expect(w.prune(30 * 24 * 3600_000)).toBe(1);               // 只删 old
    // fresh 仍在 → 再次 prune 因 fresh 已存在 getConfig 不再重建 old，返回 0
    expect(w.prune(30 * 24 * 3600_000)).toBe(0);
  });
});

describe('Waker · 多人在同一会话里提她（按人计数）', () => {
  // chimeInProbability: 0 → 关掉"偶尔插一句"的随机性，断言才可重复
  const idle = () => new Waker({ names: ['小羽'], probability: 0, idleDiveThreshold: 5, chimeInProbability: 0 });

  it('阈值是 5：同一个人的连续 5 条无关消息才关他的窗口', () => {
    const w = idle();
    const k = 'group:g';
    w.wake(k, 'A');
    for (let i = 1; i <= 4; i++) {
      const d = w.shouldWake({ key: k, userId: 'A', text: `无关第${i}句`, inActiveWindow: w.isSpeakerActive(k, 'A') });
      expect(d.wake, `第 ${i} 条应为不回答`).toBe(false);
      expect(d.reason).toContain(`${i}/5`);
      expect(w.isSpeakerActive(k, 'A')).toBe(true);   // 还没到阈值，窗口还在
    }
    const fifth = w.shouldWake({ key: k, userId: 'A', text: '无关第5句', inActiveWindow: w.isSpeakerActive(k, 'A') });
    expect(fifth.wake).toBe(false);
    expect(fifth.reason).toBe('active-window:auto-dive'); // 只有他一个人 → 整个会话回潜水
    expect(w.isSpeakerActive(k, 'A')).toBe(false);
  });

  it('只计"提到她的人"的条数——别人插话不算到他头上', () => {
    const w = idle();
    const k = 'group:g';
    w.wake(k, 'A');
    // B 从没提过她，连说 10 句无关 → 不消耗 A 的计数
    for (let i = 0; i < 10; i++) {
      const d = w.shouldWake({ key: k, userId: 'B', text: `B的闲话${i}`, inActiveWindow: w.isSpeakerActive(k, 'B') });
      expect(d.wake, `B 的第 ${i} 句不该被回答`).toBe(false);
      // B 没有窗口 → 走潜水期的常规判定（@/名字/兴趣/概率），绝不是回答闲聊
      expect(w.getConfig(k).speakers?.A?.idleStreak, `B 的话不该记到 A 头上`).toBe(0);
    }
    expect(w.isSpeakerActive(k, 'A')).toBe(true);   // A 的窗口毫发无损
    const a = w.shouldWake({ key: k, userId: 'A', text: '在干嘛', inActiveWindow: w.isSpeakerActive(k, 'A') });
    expect(a.wake).toBe(true);
  });

  it('A 的窗口关掉，B 的窗口还活着 → 会话继续活跃', () => {
    const w = idle();
    const k = 'group:g';
    w.wake(k, 'A');
    w.wake(k, 'B');
    // A 连续 5 句无关 → 只关 A
    for (let i = 1; i <= 5; i++) {
      const d = w.shouldWake({ key: k, userId: 'A', text: `无关${i}`, inActiveWindow: w.isSpeakerActive(k, 'A') });
      if (i === 5) expect(d.reason).toBe('active-window:speaker-closed');
    }
    expect(w.isSpeakerActive(k, 'A')).toBe(false);
    expect(w.isSpeakerActive(k, 'B')).toBe(true);
    expect(w.isActive(k)).toBe(true);
    // B 说话照常接
    const bb = w.shouldWake({ key: k, userId: 'B', text: '吃了吗', inActiveWindow: w.isSpeakerActive(k, 'B') });
    expect(bb.wake).toBe(true);
  });

  it('窗口数超限时挤掉最早到期的（默认 4 个）', () => {
    const w = new Waker({ names: ['小羽'], probability: 0, maxSpeakerWindows: 2, chimeInProbability: 0 });
    const k = 'group:g';
    w.wake(k, 'A'); w.wake(k, 'B'); w.wake(k, 'C');
    const sp = w.getConfig(k).speakers ?? {};
    expect(Object.keys(sp).sort()).toEqual(['B', 'C']);
  });

  it('明确在问别人 → 不抢话，也不消耗任何人的计数', () => {
    const w = idle();
    const k = 'group:g';
    w.setConfig(k, { speakerIds: ['老张'] });
    w.wake(k, 'A');
    const d = w.shouldWake({ key: k, userId: 'A', text: '老张吃了吗', inActiveWindow: w.isSpeakerActive(k, 'A') });
    expect(d.wake).toBe(false);
    expect(d.reason).toBe('active-window:excluded');
    expect(w.getConfig(k).speakers?.A?.idleStreak).toBe(0);
  });
});

describe('Waker · 引用内容参与判定（M22）', () => {
  it('潜水期：有人引用她说过的话 → 必醒（她的发言成了话题中心）', () => {
    const w = new Waker({ names: ['小羽'], probability: 0, chimeInProbability: 0 });
    const k = 'group:g';
    // 正文只是"这是谁说的"，本身毫无信息；引文里出现了她的名字
    const d = w.shouldWake({
      key: k, userId: 'u1', text: '这是谁说的话？',
      quoteText: '小羽：我这边只有两行，另一行是我自己的话',
    });
    expect(d.wake).toBe(true);
    expect(d.reason).toBe('my-words-quoted');
  });

  it('潜水期：正文无关、引文命中她的兴趣 → 也能醒', () => {
    const w = new Waker({ names: ['小羽'], probability: 0, chimeInProbability: 0 });
    w.setInterestProvider(() => ({
      interests: [{ topic: '新番', weight: 1 }],
      chattiness: 1,
      baseProbability: 0.5,
    }));
    w.setConfig('group:g', { probability: 0 });
    // 正文是"这个你看过没"，引文里才出现"新番"
    let woke = false;
    for (let i = 0; i < 12; i++) {
      const d = w.shouldWake({
        key: 'group:g', userId: 'u1', text: '你知道这个吗',
        quoteText: '最近那个新番挺好看的',
      });
      if (d.wake && d.reason.includes('interest')) { woke = true; break; }
    }
    expect(woke, '引文命中兴趣应有机会唤醒').toBe(true);
  });

  it('活跃期：有人引用她的话 → 清零无关计数并接话', () => {
    const w = new Waker({ names: ['小羽'], probability: 0, chimeInProbability: 0 });
    const k = 'group:g';
    w.wake(k, 'A');
    // 先累积 3 条无关
    for (let i = 0; i < 3; i++) {
      w.shouldWake({ key: k, userId: 'A', text: `无关${i}`, inActiveWindow: w.isSpeakerActive(k, 'A') });
    }
    const before = w.getConfig(k).speakers?.A?.idleStreak;
    expect(before).toBe(3);
    // 引用她的话 → 直接接，并把计数清零
    const d = w.shouldWake({
      key: k, userId: 'A', text: '这句谁说的',
      quoteText: '小羽说过：走吧别让饭凉了',
      inActiveWindow: w.isSpeakerActive(k, 'A'),
    });
    expect(d.wake).toBe(true);
    expect(w.getConfig(k).speakers?.A?.idleStreak).toBe(0);
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

  it('安静时段不叫（按北京时间判定，容器无 tzdata）', async () => {
    const life = createOwnLife({
      deliver: async () => {},
      quiet: [3, 8],           // 北京 3:00-8:00 安静
      tz: 'Asia/Shanghai',
      statePath: path.join(dir, 'st3.json'),
      log: () => {},
    });
    // 北京时间 4:00 = UTC 20:00（前一天）
    const at4amBeijing = Date.UTC(2026, 9, 29, 20, 0, 0);
    const r = await life.tick(at4amBeijing);
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

  it('M5 回归：deliver 返回 {ok:false} 业务跳过 → 不计次但推进 lastFiredAt', async () => {
    const statePath = path.join(dir, 'm5.json');
    let count = 0;
    const life = createOwnLife({
      deliver: async () => { count += 1; return { ok: false, reason: 'no-live-session' }; },
      intervalMs: 0, quiet: [0, 0], midnightAt: '00:00',
      statePath, log: () => {},
    });
    const r = await life.tick(Date.now());
    expect(r.skipped).toBe('deliver-skip');
    expect(count).toBe(1);
    expect(life.snapshot().firedToday).toBe(0); // 不计次
    // 间隔 0，本可立即再试；但跳过已推进 lastFiredAt → 再次 tick 仍 counted=0（不刷 error）
    const r2 = await life.tick(Date.now());
    expect(r2.skipped).toBe('deliver-skip');
    expect(life.snapshot().firedToday).toBe(0);
  });

  it('deliver 返回 true/void = 成功，正常计次', async () => {
    const life = createOwnLife({
      deliver: async () => {}, intervalMs: 0, quiet: [0, 0], midnightAt: '00:00',
      statePath: path.join(dir, 'm5b.json'), log: () => {},
    });
    await life.tick(Date.now());
    expect(life.snapshot().firedToday).toBe(1);
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

  it('m9: prune 只清纯占位空壳，保留活跃/冷却/静默', () => {
    const b = new ProactiveBudget(10, 0, silentLogger);
    b.allow('empty1');          // 触发惰性建空壳（无任何主动/冷却）
    b.allow('empty2');
    b.recordProactive('active'); // 活跃，保留
    b.markUnanswered('cooldown');
    b.markUnanswered('cooldown'); // streak≥2 冷却
    expect(b.prune(30 * 24 * 3600_000)).toBe(2); // 只清 empty1/empty2
  });
});
