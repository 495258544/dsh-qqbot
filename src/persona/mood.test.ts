/**
 * 心情自述入口 · 行为契约测试（M-mood，2026-11-12）
 * ─────────────────────────────────────────────────────────────
 * ## 这个功能要防的那个真实失效
 *
 * 情绪系统原本 6 个写入点**全是社交事件**（被叫到/被回应/没人理/被嫌吵/
 * 深夜/睡够），没有任何一个接收"她看到了什么"。
 * 于是她读《赛博英雄传》第十一章（向山敲自己胸口那章）、写下"我和向山的处境
 * 有镜像"这条自我认识 —— 对人来说是明确的情绪事件，对 valence 的贡献是 0。
 * 她的心情只反映"今天用户跟她说了几句话"。
 *
 * ## 这个文件钉什么
 *
 * 不是"四个枚举值返回了四个数"，而是这几条**会真的坏掉**的行为：
 *   · 四种方向的数值幅度（尤其 up 弱于 onReplied、mixed 几乎不抵消）
 *   · 日软上限：第 7 次起边际递减（否则天天看书能刷满 valence）
 *   · **daily 计数器跨 regress/applyDeltas 存活** —— 这里踩过血泪坑：
 *     那两个函数构建新对象时丢过 daily，导致计数器恒 undefined、日上限形同虚设，
 *     130 轮后 valence 仍贴顶 1.000。加了 mood 这个新 kind 之后更容易复发。
 *   · undo 标 revoked 但**不回滚 valence**（情绪发生了就是发生了）
 *   · undo 缺 why 拒绝（不许静默删）
 *   · feel 只存不算（她自己的坐标系，不参与数值）
 *   · **output schema 覆盖 execute 的所有返回字段** —— 见文件末尾那段说明
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EmotionService } from './emotion.ts';
import { registerPersonaTools } from './tools.ts';
import type { PersonaService } from './service.ts';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function svc(dir = tempDir()): EmotionService {
  return new EmotionService(dir);
}

/**
 * 记一笔之前/之后的差。
 *
 * 必须传**固定时间戳**：默认 `Date.now()` 会让 before/after 两次调用之间
 * 隔着几十微秒，`current()` 每次都要按真实经过时间回归一遍，
 * 于是差值里混进 ~1e-8 的衰减噪声。那点噪声在"判断方向对不对"时无所谓，
 * 但"写不写 feel 数值必须完全一致"这种断言会被它咬到 ——
 * 而那条断言恰恰是这个功能最重要的一条（feel 不参与计算）。
 */
const T0 = 1_700_000_000_000;

function deltaOf(fn: (s: EmotionService, now: number) => void, dir = tempDir()): { v: number; a: number } {
  const s = new EmotionService(dir);
  const before = s.current(T0);
  fn(s, T0);
  const after = s.current(T0);
  return { v: after.valence - before.valence, a: after.arousal - before.arousal };
}

/**
 * 只用来比**大小关系**的版本（社交事件 onAddressed/onReplied 不接受 now，
 * 走真实时钟）。这里不断言精确数值，所以那点微秒级回归噪声无所谓。
 */
function roughDelta(fn: (s: EmotionService) => void, dir = tempDir()): number {
  const s = new EmotionService(dir);
  const before = s.current().valence;
  fn(s);
  return s.current().valence - before;
}

describe('四种方向的数值幅度', () => {
  it('up → valence +0.06 / arousal +0.05', () => {
    const d = deltaOf((s, now) => s.onContentMood('up', '读到向山敲胸口那章', undefined, now));
    expect(d.v).toBeCloseTo(0.06, 3);
    expect(d.a).toBeCloseTo(0.05, 3);
  });

  it('down → valence −0.08 / arousal +0.04（心里堵着不会平静）', () => {
    const d = deltaOf((s, now) => s.onContentMood('down', '翻到一个很难受的帖子', undefined, now));
    expect(d.v).toBeCloseTo(-0.08, 3);
    // 关键：负向事件同时**抬高** arousal。若写成降 arousal，
    // "心里堵着"就变成了"淡漠"，那是另一种东西。
    expect(d.a).toBeCloseTo(0.04, 3);
    expect(d.a).toBeGreaterThan(0);
  });

  it('mixed → valence 几乎不动（+0.01）/ arousal +0.06', () => {
    const d = deltaOf((s, now) => s.onContentMood('mixed', '想通了但有点涩', undefined, now));
    // 不抵消成负数：复杂情绪不会净变差，重心在"翻腾"不在"好坏"
    expect(d.v).toBeGreaterThan(0);
    expect(d.v).toBeLessThan(0.02);
    expect(d.a).toBeCloseTo(0.06, 3);
  });

  it('still → 只降 arousal（−0.10），valence 不变', () => {
    const s = svc();
    // 先把 valence 抬起来，才能验证 still 不碰它
    s.bump({ valence: 0.3, arousal: 0.5 }, T0);
    const before = s.current(T0);
    s.onContentMood('still', '坐着发了会儿呆，脑子安静下来', undefined, T0);
    const after = s.current(T0);
    expect(after.valence).toBeCloseTo(before.valence, 3);
    expect(after.arousal - before.arousal).toBeCloseTo(-0.1, 3);
  });

  it('内容驱动弱于社交驱动：up(0.06) ≤ onAddressed(0.06) < onReplied(0.14)', () => {
    // 用户定的原则：看书感动 ≠ 被在意的人回了一句。
    // 这条不钉死具体数字，钉的是**序关系** —— 将来调参也不能把内容抬到社交之上。
    const up = roughDelta((s) => s.onContentMood('up', 'x'));
    const addressed = roughDelta((s) => s.onAddressed());
    const replied = roughDelta((s) => s.onReplied());
    expect(up).toBeLessThan(replied);
    expect(up).toBeLessThanOrEqual(addressed + 1e-9);
  });

  it('方向至少不反：up 之后的 valence 高于 down 之后', () => {
    const up = (() => { const s = svc(); s.onContentMood('up', 'x'); return s.current().valence; })();
    const down = (() => { const s = svc(); s.onContentMood('down', 'x'); return s.current().valence; })();
    expect(up).toBeGreaterThan(down);
  });
});

describe('日软上限（复用 DAILY_SOFT_CAP 那套）', () => {
  it('前 6 次全额，第 7 次起边际递减', () => {
    // cap=6、overflow damp=1/10。不这么压的话"天天读书"能把 valence 刷到贴顶，
    // 和 M34 修的那个"永远开心 = 没有心情"是同一个病。
    const s = svc();
    const full: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = s.current().valence;
      s.onContentMood('up', `第 ${i + 1} 段`);
      full.push(s.current().valence - before);
    }
    const before = s.current().valence;
    s.onContentMood('up', '第 7 段');
    const seventh = s.current().valence - before;

    expect(full[0]).toBeCloseTo(0.06, 3);
    expect(seventh).toBeLessThan(full[0]! * 0.2);
    expect(s.current().daily?.mood).toBe(7);
  });

  it('mood 计数与 addressed/replied 分开记（看书多了不该削弱"被叫到"）', () => {
    const s = svc();
    for (let i = 0; i < 8; i++) s.onContentMood('up', `x${i}`);
    s.onAddressed();
    const st = s.current();
    expect(st.daily?.mood).toBe(8);
    expect(st.daily?.addressed).toBe(1);
  });

  it('daily 计数器跨 regress / applyDeltas 存活（回归测试，专防旧坑）', () => {
    // ⚠️ 血泪坑：regress() / applyDeltas() 曾经在构建新对象时丢掉 daily，
    // 计数器恒 undefined，日上限形同虚设（130 轮后 valence 仍 1.000）。
    // 新增 mood 这个 kind 时是最容易复发的时刻，所以单独钉一条。
    const s = svc();
    s.onContentMood('up', 'a');
    expect(s.current().daily?.mood).toBe(1);
    // current() 走 regress
    expect(s.current().daily?.mood).toBe(1);
    // bump 走 applyDeltas
    s.bump({ valence: 0.05 });
    expect(s.current().daily?.mood).toBe(1);
    expect(s.current().daily?.addressed).toBe(0);
    // 再记一笔，计数要能继续累加（不是被重置回 0 再 +1）
    s.onContentMood('up', 'b');
    expect(s.current().daily?.mood).toBe(2);
  });

  it('旧档（M34 时期的 daily 没有 mood 字段）不会算出 NaN', () => {
    // 升级兼容：老 emotion.json 里 daily = { day, addressed, replied }，
    // 读上来 d.mood 是 undefined，`undefined + 1 = NaN` 会一路渗进 delta。
    const dir = tempDir();
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state', 'emotion.json'),
      JSON.stringify({ valence: 0, arousal: 0.3, energy: 0.7, at: Date.now(), daily: { day, addressed: 3, replied: 1 } }),
      'utf8',
    );
    const s = new EmotionService(dir);
    s.onContentMood('up', '旧档也要能用');
    const st = s.current();
    expect(Number.isFinite(st.valence)).toBe(true);
    expect(Number.isFinite(st.arousal)).toBe(true);
    expect(st.daily?.mood).toBe(1);
    expect(st.valence).toBeCloseTo(0.06, 3);
  });
});

describe('mood-log · 记录可溯源', () => {
  it('每次自述都留下 时间 / 方向 / 为什么', () => {
    const s = svc();
    const e = s.onContentMood('up', '读到向山敲胸口那章');
    expect(e.id).toBeTruthy();
    expect(e.sense).toBe('up');
    expect(e.because).toBe('读到向山敲胸口那章');
    expect(e.at).toBeGreaterThan(0);
    expect(e.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.moodEntries()).toHaveLength(1);
  });

  it('写进 state/mood-log.json，重建实例能读回（她要能回看）', () => {
    const dir = tempDir();
    const first = new EmotionService(dir);
    first.onContentMood('down', '刷到一条让人堵的新闻');

    const file = path.join(dir, 'state', 'mood-log.json');
    expect(fs.existsSync(file)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { sense: string; because: string }[];
    expect(raw[0]?.sense).toBe('down');
    expect(raw[0]?.because).toBe('刷到一条让人堵的新闻');

    const second = new EmotionService(dir);
    const rows = second.moodEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sense).toBe('down');
  });

  it('mood-log 坏档 → 当空数组，不拖垮启动', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'mood-log.json'), '{ 这不是合法 JSON', 'utf8');
    let s: EmotionService | undefined;
    expect(() => { s = new EmotionService(dir); }).not.toThrow();
    expect(s!.moodEntries()).toEqual([]);
    // 而且还能继续用
    expect(() => s!.onContentMood('up', 'x')).not.toThrow();
  });

  it('新的在前，默认不含已撤销的', () => {
    const s = svc();
    const a = s.onContentMood('up', '第一次');
    s.onContentMood('down', '第二次');
    expect(s.moodEntries()[0]?.because).toBe('第二次');
    s.undoMood(a.id, '当时记错了');
    expect(s.moodEntries().map((e) => e.because)).toEqual(['第二次']);
    expect(s.moodEntries({ includeRevoked: true })).toHaveLength(2);
  });

  it('because 超 60 字被截断，不报错', () => {
    // 一句写长了不该让整条记录丢失 —— 截断比拒绝好
    const s = svc();
    const e = s.onContentMood('up', '啊'.repeat(200));
    expect(e.because.length).toBe(60);
  });

  it('最近七天的按方向统计（撤销的不算）', () => {
    const s = svc();
    s.onContentMood('up', 'a');
    s.onContentMood('up', 'b');
    const c = s.onContentMood('down', 'c');
    s.onContentMood('still', 'd');
    s.undoMood(c.id, '这条不算');
    const st = s.moodStats(7);
    expect(st.total).toBe(3);
    expect(st.bySense.up).toBe(2);
    expect(st.bySense.down).toBe(0);
    expect(st.bySense.still).toBe(1);
  });
});

describe('feel · 她自己的坐标系（只存不算）', () => {
  it('带 feel → 原文存进 mood-log', () => {
    const dir = tempDir();
    const s = new EmotionService(dir);
    s.onContentMood('down', '读到向山敲胸口那章', '像被人从背后拍了一下');
    const e = s.moodEntries()[0]!;
    expect(e.feel).toBe('像被人从背后拍了一下');
    // 落盘的原样
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'mood-log.json'), 'utf8')) as { feel?: string }[];
    expect(raw[0]?.feel).toBe('像被人从背后拍了一下');
  });

  it('不带 feel → 正常成功，记录里没有 feel 字段', () => {
    const dir = tempDir();
    const s = new EmotionService(dir);
    const e = s.onContentMood('up', '说不上来，就是有点轻快');
    expect(e.because).toBe('说不上来，就是有点轻快');
    expect('feel' in e).toBe(false);
    const rows = s.moodEntries();
    expect(rows[0]?.feel).toBeUndefined();
  });

  it('feel 绝不参与数值：写不写 feel，valence/arousal 完全一样', () => {
    // 这是 feel 的全部意义 —— 细在她自己身上，不在数值里。
    // 一旦它影响 delta，就等于"会写字的人心情更好"。
    const withFeel = deltaOf((s, now) => s.onContentMood('up', 'x', '像有人在背后推了一把', now));
    const without = deltaOf((s, now) => s.onContentMood('up', 'x', undefined, now));
    expect(withFeel.v).toBeCloseTo(without.v, 10);
    expect(withFeel.a).toBeCloseTo(without.a, 10);
  });

  it('feel 超 40 字被 slice，不报错', () => {
    const s = svc();
    const e = s.onContentMood('mixed', 'x', '嗯'.repeat(120));
    expect(e.feel?.length).toBe(40);
  });
});

describe('undo · 标 revoked、留理由、不回滚 valence', () => {
  it('撤销后记录标 revoked 而不是消失', () => {
    const s = svc();
    const e = s.onContentMood('down', '记错了');
    const r = s.undoMood(e.id, '那其实是在羡慕，不是在难受');
    expect(r.ok).toBe(true);
    const all = s.moodEntries({ includeRevoked: true });
    expect(all).toHaveLength(1);
    expect(all[0]?.revoked).toBe(true);
    expect(all[0]?.revokedWhy).toBe('那其实是在羡慕，不是在难受');
    expect(all[0]?.revokedAt).toBeGreaterThan(0);
    // 原始内容一个字都不能丢
    expect(all[0]?.because).toBe('记错了');
    expect(all[0]?.sense).toBe('down');
  });

  it('撤销**不回滚** valence（情绪已经发生了）', () => {
    // 重新评估"这条其实不该算"是认知上的修正，不等于那段时间没发生过。
    // 更要紧的是：一旦能回滚，撤销就成了数值后门，日上限全部失效。
    const s = svc();
    s.onContentMood('down', '当时觉得堵');
    const afterNote = s.current().valence;
    expect(afterNote).toBeLessThan(0);
    s.undoMood(s.moodEntries()[0]!.id, '后来想想没那么严重');
    expect(s.current().valence).toBeCloseTo(afterNote, 5);
  });

  it('缺 why 拒绝执行（取消静默删除）', () => {
    const s = svc();
    const e = s.onContentMood('up', 'x');
    for (const why of ['', '   ', '　']) {
      const r = s.undoMood(e.id, why);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('理由');
    }
    // 记录必须还在（没被静默删掉）
    expect(s.moodEntries()).toHaveLength(1);
    expect(s.moodEntries()[0]?.revoked).toBeUndefined();
  });

  it('id 不存在 / 重复撤销 → 报错且不改动任何东西', () => {
    const s = svc();
    expect(s.undoMood('nope', '想撤').ok).toBe(false);
    const e = s.onContentMood('up', 'x');
    expect(s.undoMood(e.id, '第一次撤').ok).toBe(true);
    const again = s.undoMood(e.id, '再撤一次');
    expect(again.ok).toBe(false);
    expect(again.error).toContain('撤过');
  });

  it('撤销不会让当天的 mood 计数清零（否则上限可被绕过）', () => {
    const s = svc();
    for (let i = 0; i < 3; i++) s.onContentMood('up', `x${i}`);
    for (const e of s.moodEntries({ limit: 10 })) s.undoMood(e.id, '都撤了');
    expect(s.current().daily?.mood).toBe(3);
  });
});

describe('renderSection · 她读得到自己的记录，且不下结论', () => {
  it('没有记录时不出现这一行', () => {
    const s = svc();
    expect(s.renderSection()).toBe('');
  });

  it('有记录时给一行统计，用她自己的话而不是枚举名', () => {
    const s = svc();
    s.onContentMood('up', '读书');
    s.onContentMood('up', '又是读书');
    s.onContentMood('down', '翻帖子', '像被人从背后拍了一下');
    const t = s.renderSection();
    expect(t).toContain('往上 2');
    expect(t).toContain('往下 1');
    // 不能把代码里的枚举名直接塞给她
    expect(t).not.toContain('up 2');
    expect(t).not.toContain('mixed');
    // 她自己起的名字要原样出现 —— 那比任何统计都准
    expect(t).toContain('像被人从背后拍了一下');
    // 语气：只给事实，不替她下结论
    expect(t).toContain('随你');
    expect(t).not.toContain('所以你');
  });

  it('统计里不含已撤销的记录', () => {
    const s = svc();
    const e = s.onContentMood('up', '读书');
    s.undoMood(e.id, '不算');
    expect(s.renderSection()).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────
// output schema：真的把 registerPersonaTools 跑起来，拿真实 schema 对象比对
//
// ⚠️ 这个项目里踩过的致命坑（连挂两次，都是 qq_nga）：
//   工具 output schema 是 `additionalProperties: false` 的 —— execute 返回里
//   只要有一个**没在顶层 properties 声明**的字段，宿主 dsh-tools 就会把整个
//   工具结果判成 `INVALID_TOOL_OUTPUT` 扔掉。
//   第二次更隐蔽：用字符串替换插字段，锚点匹配到了 `topics.items.properties`
//   里那个 —— 表面上 schema 里"有这些字"，实际校验照样失败。
//
// 所以下面**不看字段名在不在源码文本里**，而是执行注册流程拿到真实 schema 对象，
// 再拿真的 execute 返回值逐字段比对。这才是校验器看到的那个东西。
// ─────────────────────────────────────────────────────────────

interface RegisteredTool {
  name: string;
  description?: string;
  parameters?: { properties?: Record<string, { enum?: string[] }>; required?: string[] };
  output?: {
    schema?: { properties?: Record<string, unknown>; required?: string[] };
    render?: (args: unknown, value: unknown) => unknown;
  };
  execute: (args: unknown, exec?: unknown) => Promise<Record<string, unknown>>;
}

function registeredTools(emotion: EmotionService): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const fakeCtx = {
    get: () => ({ register: (def: RegisteredTool) => { tools.push(def); } }),
  } as unknown as Parameters<typeof registerPersonaTools>[0];
  // 只给 emotion —— 注册阶段不会碰 persona 的其它字段，
  // 而这两个工具的 execute 也只用 emotion。
  const fakePersona = { emotion } as unknown as PersonaService;
  const logger = {
    info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined,
  } as unknown as Parameters<typeof registerPersonaTools>[3];
  registerPersonaTools(fakeCtx, fakePersona, () => undefined, logger);
  return tools;
}

function pick(tools: RegisteredTool[], name: string): RegisteredTool {
  const t = tools.find((x) => x.name === name);
  expect(t, `${name} 没有被注册`).toBeDefined();
  return t!;
}

describe('output schema 覆盖 execute 的所有返回字段（防 INVALID_TOOL_OUTPUT）', () => {
  it('qq_note_mood：所有真实返回形状都落在顶层 properties 里', async () => {
    const emotion = svc();
    const tool = pick(registeredTools(emotion), 'qq_note_mood');
    const declared = new Set(Object.keys(tool.output?.schema?.properties ?? {}));
    expect(declared.size, 'schema 里一个属性都没有 —— 提取失败了').toBeGreaterThan(0);

    // 这些形状是 execute 里真的会 return 的（成功带 feel / 成功不带 feel /
    // sense 非法 / because 空 / 超过日上限）
    const returns: Record<string, unknown>[] = [];
    returns.push(await tool.execute({ sense: 'up', because: '读到向山敲胸口那章', feel: '像被人从背后拍了一下' }));
    returns.push(await tool.execute({ sense: 'down', because: '翻到一个帖子' }));
    for (let i = 0; i < 6; i++) returns.push(await tool.execute({ sense: 'up', because: `批量 ${i}` }));
    returns.push(await tool.execute({ sense: 'bogus', because: 'x' }));
    returns.push(await tool.execute({ sense: 'up', because: '' }));
    returns.push(await tool.execute({}));

    for (const r of returns) {
      const extra = Object.keys(r).filter((k) => !declared.has(k));
      expect(extra, `返回里的 ${extra.join(',')} 未在 schema 顶层声明 → 整个结果会被判 INVALID_TOOL_OUTPUT`).toEqual([]);
    }
  });

  it('qq_undo_mood：所有真实返回形状都落在顶层 properties 里', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    const tool = pick(tools, 'qq_undo_mood');
    const declared = new Set(Object.keys(tool.output?.schema?.properties ?? {}));
    expect(declared.size).toBeGreaterThan(0);

    // 先记一条拿到真 id
    const note = await pick(tools, 'qq_note_mood').execute({ sense: 'up', because: 'x' });
    const id = String(note.id);

    const returns: Record<string, unknown>[] = [
      await tool.execute({ id, why: '' }),        // 缺 why
      await tool.execute({ id: '', why: '理由' }), // 缺 id
      await tool.execute({ id: 'nope', why: '理由' }), // 找不到
      await tool.execute({ id, why: '后来觉得那不算' }), // 成功
      await tool.execute({ id, why: '再撤一次' }),  // 重复撤销
    ];
    for (const r of returns) {
      const extra = Object.keys(r).filter((k) => !declared.has(k));
      expect(extra, `返回里的 ${extra.join(',')} 未在 schema 顶层声明`).toEqual([]);
    }
  });

  it('parameters：feel 在 properties 里但**不在** required（可省）', () => {
    const tool = pick(registeredTools(svc()), 'qq_note_mood');
    const props = tool.parameters?.properties ?? {};
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['sense', 'because', 'feel']));
    expect(tool.parameters?.required).toEqual(expect.arrayContaining(['sense', 'because']));
    expect(tool.parameters?.required).not.toContain('feel');
    // enum 锁死在四个方向（不让她自己编）
    expect(props.sense?.enum).toEqual(['up', 'down', 'mixed', 'still']);
  });

  it('qq_undo_mood 的 why 是 required，且参数里没有任何"指定他人"的口子', () => {
    const tool = pick(registeredTools(svc()), 'qq_undo_mood');
    expect(tool.parameters?.required).toContain('why');
    expect(tool.parameters?.required).toContain('id');
    const keys = Object.keys(tool.parameters?.properties ?? {});
    expect(keys.sort()).toEqual(['id', 'why']);
  });

  it('description 说清了 because 与 feel 的区别（她照着这句话决定写不写）', () => {
    const tool = pick(registeredTools(svc()), 'qq_note_mood');
    const d = tool.description ?? '';
    expect(d).toContain('because');
    expect(d).toContain('feel');
    expect(d).toMatch(/可省|不写/);
  });
});

describe('qq_undo_mood · 工具层必须自己拦缺 why（不信 schema 的 required）', () => {
  it('why 是空串 / 纯空白 → ok:false，记录不动', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    const note = await pick(tools, 'qq_note_mood').execute({ sense: 'up', because: 'x' });
    const id = String(note.id);
    const undo = pick(tools, 'qq_undo_mood');

    for (const why of ['', '   ']) {
      const r = await undo.execute({ id, why });
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain('理由');
    }
    expect(emotion.moodEntries({ includeRevoked: true })[0]?.revoked).toBeUndefined();
  });

  it('缺少整个 why 字段（模型漏填）也不能静默删', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    const note = await pick(tools, 'qq_note_mood').execute({ sense: 'up', because: 'x' });
    const r = await pick(tools, 'qq_undo_mood').execute({ id: note.id });
    expect(r.ok).toBe(false);
    expect(emotion.moodEntries({ includeRevoked: true })[0]?.revoked).toBeUndefined();
  });

  it('成功撤销后 render 文案提到"标了撤销"（她该知道自己没真删掉）', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    const note = await pick(tools, 'qq_note_mood').execute({ sense: 'down', because: '当时觉得堵' });
    const undo = pick(tools, 'qq_undo_mood');
    const r = await undo.execute({ id: note.id, why: '后来想想没那么严重' });
    const blocks = undo.output?.render?.({}, r) as { type: string; text: string }[];
    expect(blocks[0]?.text).toContain('撤销');
    expect(blocks[0]?.text).toContain('后来想想没那么严重');
  });
});

describe('工具层写入与直调服务一致', () => {
  it('qq_note_mood 走的是同一个 onContentMood（数值 + 日志都落地）', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    const note = await pick(tools, 'qq_note_mood').execute({ sense: 'up', because: '读到向山敲胸口那章' });

    expect(note.ok).toBe(true);
    expect(note.sense).toBe('up');
    expect(note.because).toBe('读到向山敲胸口那章');
    expect(note.countToday).toBe(1);
    expect(note.damped).toBe(false);
    // 数值真的动了
    expect(emotion.current().valence).toBeCloseTo(0.06, 3);
    expect(emotion.moodEntries()).toHaveLength(1);
  });

  it('超过 6 条后 damped=true（她该知道这条算得轻，而不是以为记了就等于满分）', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    const note = pick(tools, 'qq_note_mood');
    for (let i = 0; i < 6; i++) await note.execute({ sense: 'up', because: `x${i}` });
    const seventh = await note.execute({ sense: 'up', because: '第七次' });
    expect(seventh.damped).toBe(true);
    expect(seventh.countToday).toBe(7);
  });

  it('非法 sense / 空 because 都被拒，且不写日志（脏数据不进 mood-log）', async () => {
    const emotion = svc();
    const note = pick(registeredTools(emotion), 'qq_note_mood');
    expect((await note.execute({ sense: 'happy', because: 'x' })).ok).toBe(false);
    expect((await note.execute({ sense: 'up', because: '' })).ok).toBe(false);
    expect(emotion.moodEntries()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// qq_read_mood —— 读端
//
// 为什么这个工具不是"顺便加个查询"：任务要求 mood-log「要能被她自己读到」，
// 而**没有它 qq_undo_mood 根本用不起来** —— 撤销要传 id，
// 而 id 只在 qq_note_mood 的返回值里出现过一次，隔一场对话她手上就没有了。
// （同类问题在 qq_decide_name 上出现过：写端接了、读端没接。）
// ─────────────────────────────────────────────────────────────
describe('qq_read_mood · 她读得到自己的记录，也拿得到撤销用的 id', () => {
  it('读回来的每条都带 id（撤销的入口）', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    await pick(tools, 'qq_note_mood').execute({ sense: 'up', because: '读到向山敲胸口那章', feel: '像被人从背后拍了一下' });
    await pick(tools, 'qq_note_mood').execute({ sense: 'down', because: '翻到一个帖子' });

    const r = await pick(tools, 'qq_read_mood').execute({});
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    const entries = r.entries as { id: string; sense: string; because: string; feel?: string; day: string; time: string }[];
    // 新的在前
    expect(entries[0]?.because).toBe('翻到一个帖子');
    expect(entries[1]?.feel).toBe('像被人从背后拍了一下');
    for (const e of entries) {
      expect(e.id, '没有 id 就没法撤销').toBeTruthy();
      expect(e.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.time).toMatch(/^\d{2}:\d{2}$/);
    }
    // 拿读回来的 id 真的能撤
    const undo = await pick(tools, 'qq_undo_mood').execute({ id: entries[0]!.id, why: '那条不算' });
    expect(undo.ok).toBe(true);
  });

  it('默认不显示已撤销的；includeRevoked=true 才显示并带标记', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    const note = pick(tools, 'qq_note_mood');
    const a = await note.execute({ sense: 'up', because: '读书' });
    await note.execute({ sense: 'down', because: '翻帖子' });
    await pick(tools, 'qq_undo_mood').execute({ id: a.id, why: '不算' });

    const normal = await pick(tools, 'qq_read_mood').execute({});
    expect(normal.count).toBe(1);
    const all = await pick(tools, 'qq_read_mood').execute({ includeRevoked: true });
    expect(all.count).toBe(2);
    const revoked = (all.entries as { revoked?: boolean }[]).filter((e) => e.revoked);
    expect(revoked).toHaveLength(1);
  });

  it('四个方向的七天统计一起返回（平坦字段，不做嵌套对象）', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    const note = pick(tools, 'qq_note_mood');
    await note.execute({ sense: 'up', because: 'a' });
    await note.execute({ sense: 'up', because: 'b' });
    await note.execute({ sense: 'down', because: 'c' });
    await note.execute({ sense: 'still', because: 'd' });

    const r = await pick(tools, 'qq_read_mood').execute({});
    expect(r.up).toBe(2);
    expect(r.down).toBe(1);
    expect(r.mixed).toBe(0);
    expect(r.still).toBe(1);
  });

  it('一条都没有时正常返回，不报错', async () => {
    const r = await pick(registeredTools(svc()), 'qq_read_mood').execute({});
    expect(r.ok).toBe(true);
    expect(r.count).toBe(0);
    expect(r.entries).toEqual([]);
  });

  it('n 被夹到 [1,50]，异常值不让工具崩', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    const note = pick(tools, 'qq_note_mood');
    for (let i = 0; i < 5; i++) await note.execute({ sense: 'up', because: `x${i}` });
    const read = pick(tools, 'qq_read_mood');
    expect((await read.execute({ n: -3 })).ok).toBe(true);
    expect((await read.execute({ n: 999 })).count).toBe(5);
    expect((await read.execute({ n: Number.NaN })).ok).toBe(true);
  });

  it('output schema 覆盖所有返回字段（同样防 INVALID_TOOL_OUTPUT）', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    const tool = pick(tools, 'qq_read_mood');
    const declared = new Set(Object.keys(tool.output?.schema?.properties ?? {}));
    expect(declared.size).toBeGreaterThan(0);

    // 空 / 带 feel / 带 revoked / 全都有
    const returns: Record<string, unknown>[] = [];
    returns.push(await tool.execute({}));
    const note = pick(tools, 'qq_note_mood');
    const a = await note.execute({ sense: 'up', because: 'x', feel: '有点轻' });
    returns.push(await tool.execute({}));
    await pick(tools, 'qq_undo_mood').execute({ id: a.id, why: '不算' });
    returns.push(await tool.execute({ includeRevoked: true }));

    for (const r of returns) {
      const extra = Object.keys(r).filter((k) => !declared.has(k));
      expect(extra, `返回里的 ${extra.join(',')} 未在 schema 顶层声明`).toEqual([]);
    }
    // entries 里的字段也要被声明（那是最容易漏的一层）
    const itemProps = (tool.output?.schema?.properties as Record<string, { items?: { properties?: Record<string, unknown> } }>)
      .entries?.items?.properties ?? {};
    const itemDeclared = new Set(Object.keys(itemProps));
    const row = (await tool.execute({ includeRevoked: true })).entries as Record<string, unknown>[];
    for (const e of row) {
      const extra = Object.keys(e).filter((k) => !itemDeclared.has(k));
      expect(extra, `entries 里的 ${extra.join(',')} 未在 items.properties 声明`).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// mixed 收口 A+B（task-9，用户 2026-11-12 从决策页 mixed-and-length 确认）
//
// mixed 是四档里唯一"说了等于没说"的方向：feel 才是她留给回看的钥匙。
//   A：note 没留 feel 时软引导一句（可跳过，不命令不评判）
//   B：回看时让"筐"可见（renderSection 点一句 + read_mood 标（没留话））
// C 扩枚举已否决 —— 坐标系固化，不加。回复长度问题"先不动"。
// ─────────────────────────────────────────────────────────────
describe('mixed 收口 A · qq_note_mood render 软引导', () => {
  it('mixed 且没留 feel → 引导句出现（可跳过的语气）', async () => {
    const emotion = svc();
    const tool = pick(registeredTools(emotion), 'qq_note_mood');
    const r = await tool.execute({ sense: 'mixed', because: '想通了但有点涩' });
    const blocks = tool.output?.render?.({}, r) as { type: string; text: string }[];
    expect(blocks[0]?.text).toContain('说不清的话');
    expect(blocks[0]?.text).toContain('那一下像什么');
    expect(blocks[0]?.text).toContain('哪怕半句');
    // 引导只出现在成功文本的末尾，"记下了"这个事实照旧在最前
    expect(blocks[0]?.text).toContain('记下了（mixed）');
  });

  it('mixed 且留了 feel → 不引导（话已经留了，别多嘴）', async () => {
    const emotion = svc();
    const tool = pick(registeredTools(emotion), 'qq_note_mood');
    const r = await tool.execute({ sense: 'mixed', because: '又感动又难受', feel: '像被人从背后拍了一下' });
    const blocks = tool.output?.render?.({}, r) as { type: string; text: string }[];
    expect(blocks[0]?.text).toContain('像被人从背后拍了一下');
    expect(blocks[0]?.text).not.toContain('试着留一句');
  });

  it('up → 永远不引导（只有 mixed 是那个筐）', async () => {
    const emotion = svc();
    const tool = pick(registeredTools(emotion), 'qq_note_mood');
    const r = await tool.execute({ sense: 'up', because: '说不上来，就是有点轻快' });
    const blocks = tool.output?.render?.({}, r) as { type: string; text: string }[];
    expect(blocks[0]?.text).toBe('记下了（up）');
    expect(blocks[0]?.text).not.toContain('试着留一句');
  });
});

describe('mixed 收口 B1 · renderSection 里 mixed 的留话可见（同条不重复）', () => {
  it('mixed+feel 不是最新 feel 条 → 单独点一句，最新那条照常', () => {
    const s = svc();
    s.onContentMood('mixed', '翻到一个很难受的帖子', '像被人从背后拍了一下');
    s.onContentMood('up', '读到向山敲胸口那章', '像有人在背后推了一把');
    const t = s.renderSection();
    expect(t).toContain('有条说不清的，你留了话：「像被人从背后拍了一下」');
    expect(t).toContain('最近一条你想说的是「像有人在背后推了一把」');
  });

  it('mixed+feel 恰好是最新 feel 条 → 只展示一次，不出现两句', () => {
    const s = svc();
    s.onContentMood('mixed', '想通了但有点涩', '像被人从背后拍了一下');
    const t = s.renderSection();
    // 原话只在「最近一条你想说的是」里出现一次
    expect(t.split('像被人从背后拍了一下')).toHaveLength(2);
    expect(t).not.toContain('有条说不清的');
  });

  it('mixed 没留 feel → 行结构与从前一致，不追加任何子句', () => {
    const s = svc();
    s.onContentMood('mixed', '说不清，就是堵得慌');
    const t = s.renderSection();
    expect(t).toContain('说不清 1');
    expect(t).not.toContain('你留了话');
  });
});

describe('mixed 收口 B2 · qq_read_mood render 的（没留话）标记', () => {
  it('mixed 没留 feel → 该行带（没留话）', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    await pick(tools, 'qq_note_mood').execute({ sense: 'mixed', because: '说不清，就是堵得慌' });
    const read = pick(tools, 'qq_read_mood');
    const r = await read.execute({});
    const blocks = read.output?.render?.({}, r) as { type: string; text: string }[];
    const line = blocks[0]?.text.split('\n').find((l) => l.includes('堵得慌'));
    expect(line, 'mixed 那行应该在渲染结果里').toBeDefined();
    expect(line!).toContain('（没留话）');
  });

  it('mixed 留了 feel / 非 mixed 条目 → 都不带标记', async () => {
    const emotion = svc();
    const tools = registeredTools(emotion);
    const note = pick(tools, 'qq_note_mood');
    await note.execute({ sense: 'mixed', because: '又感动又难受', feel: '像被人从背后拍了一下' });
    await note.execute({ sense: 'up', because: '说不上来，就是有点轻快' });
    const read = pick(tools, 'qq_read_mood');
    const r = await read.execute({});
    const blocks = read.output?.render?.({}, r) as { type: string; text: string }[];
    const lines = blocks[0]!.text.split('\n');
    const mixedLine = lines.find((l) => l.includes('又感动又难受'));
    expect(mixedLine, 'mixed+feel 那行应该在').toBeDefined();
    expect(mixedLine!).toContain('像被人从背后拍了一下');
    expect(mixedLine!).not.toContain('（没留话）');
    const upLine = lines.find((l) => l.includes('有点轻快'));
    expect(upLine, 'up 那行应该在').toBeDefined();
    expect(upLine!).not.toContain('（没留话）');
  });
});
