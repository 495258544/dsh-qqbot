/**
 * own-life 提示词与活动记录 · 回归测试（M24）
 * ─────────────────────────────────────────────────────────────
 * 实测问题：她的自由时间只有「写日记」或「空转」两种。
 * 调研结论（own-life-research.md）：提示词把自由时间设计成了「生成任务」，
 * 且「翻旧记录」没有对应工具、 "什么都不干"零成本无后续。
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_TEXT_DAY, DEFAULT_TEXT_MIDNIGHT, createOwnLife,
         loadPromptOverride, writePromptOverridePart, OWN_LIFE_PROMPT_FILE,
         type OwnLifeOptions } from './own-life.ts';
import { dayInTz } from './clock.ts';
import { registerPersonaTools } from './tools.ts';
import { PersonaService } from './service.ts';

describe('提示词 · 每个动作都有对应工具', () => {
  it('点名了真实存在的工具（不再有无法执行的动词）', () => {
    // 旧版写了「翻翻你记着还没说出口的事」，但没有对应工具 → 模型只能退化成写日记
    for (const t of ['qq_write_diary', 'qq_read_diary', 'qq_memory_append',
                     'qq_write_self_note', 'qq_mark_interest', 'qq_browse', 'qq_note_activity']) {
      expect(DEFAULT_TEXT_DAY, t).toContain(t);
    }
  });

  it('包含"先想上一次做了什么" —— 否则每次从零决策', () => {
    expect(DEFAULT_TEXT_DAY).toContain('上一次自由时间');
  });

  it('发呆被写成有产出的状态，而不是空分支', () => {
    const s = DEFAULT_TEXT_DAY;
    expect(s).toContain('什么也不做');
    // 关键：发呆应该被描述成会引发下一件事，而不是"允许你什么都不干"就完了
    expect(s).toMatch(/常常会想出一件/);
  });

  it('有防打卡/防表演的硬规矩', () => {
    expect(DEFAULT_TEXT_DAY).toContain('日记不是打卡');
    expect(DEFAULT_TEXT_DAY).toContain('别为了');
  });

  it('夜间版承认"困就睡"，不要求留痕迹（对照 SillyTavern 的表演式发呆）', () => {
    expect(DEFAULT_TEXT_MIDNIGHT).toContain('困');
    expect(DEFAULT_TEXT_MIDNIGHT).toContain('不用留痕迹');
  });
});

describe('活动记录 · 让"上一次"可被引用', () => {
  function mk() {
    const statePath = `/tmp/ol-${Math.random().toString(36).slice(2)}.json`;
    const delivered: string[] = [];
    const h = createOwnLife({
      deliver: async (t: string) => { delivered.push(t); return true; },
      statePath,
      intervalMs: 4 * 3600_000,
      maxPerDay: 99,
      quiet: [23, 8],
      log: () => {},
    });
    return { h, statePath, delivered };
  }

  it('noteActivity 记下之后，下一次提示里会带上', async () => {
    const { h, statePath } = mk();
    try {
      h.noteActivity('翻了上个月的日记');
      expect(h.snapshot().recentActivities?.length).toBe(1);
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });

  it('最多只留 8 条（不无限增长）', () => {
    const { h, statePath } = mk();
    try {
      for (let i = 0; i < 15; i++) h.noteActivity(`第${i}次`);
      expect(h.snapshot().recentActivities?.length).toBe(8);
      // 保留的是最近的
      expect(h.snapshot().recentActivities?.at(-1)?.text).toBe('第14次');
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });

  it('空文本不记（避免产生"上次什么都没做"的噪音条目）', () => {
    const { h, statePath } = mk();
    try {
      h.noteActivity('   ');
      expect(h.snapshot().recentActivities?.length ?? 0).toBe(0);
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });

  it('长文本截断到 60 字（只做提示用，不是日志）', () => {
    const { h, statePath } = mk();
    try {
      h.noteActivity('这是一段很长的描述'.repeat(20));
      expect(h.snapshot().recentActivities?.[0]?.text.length).toBe(60);
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 提示词覆盖文件 <dataDir>/own-life-prompt.json（2026-11-17 热生效）
//
// 语义设计决定（写死在这里，防止后人拍脑袋改）：
//   · 缺 day / midnight 字段 = 该段用默认（两段互相独立，只覆盖想改的那段）
//   · **空数组是合法的 = 该段为空菜单**（"整段替换"语义的忠实实现：写什么就是什么。
//     own-life 会跳过这次投递 skipped:'empty-prompt'，不崩也不悄悄回退默认——
//     悄悄回退会让"我明明删光了怎么还在"没法排查。qq_prompt_edit 工具层拒绝空
//     lines 防她手滑清空，但手工编辑文件清空是允许的）
//   · JSON 坏 / 根不是对象 / 字段不是字符串数组 = 整体回退默认 + logger.warn，不崩
//   · 每次 fire 现读文件（不缓存）→ 改完文件下一次自由时间就生效，不用重载插件
// ─────────────────────────────────────────────────────────────

function mkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'olp-'));
}

/** 让 tick() 一次就命中 day 投递且结果确定：不掷骰、不进 quiet、不撞 midnight */
function dayOpts(overridePath: string, extra: Partial<OwnLifeOptions> = {}): OwnLifeOptions {
  return {
    deliver: async () => true,
    intervalMs: 0,        // 每个 tick 都算到点；intervalMs=0 时不掷骰（见 own-life.ts）
    quiet: [0, 0],        // [from,to) 恒为空 → 永远不 quiet
    midnightAt: '99:99',  // 永远"没到半夜" → 不触发 midnight 分支
    maxPerDay: 99,
    promptOverridePath: overridePath,
    log: () => {},
    ...extra,
  };
}

describe('提示词覆盖文件 · 热生效（own-life-prompt.json）', () => {
  it('没有覆盖文件 → 用内置默认提示词（路径已配，行为与原来完全一致）', async () => {
    const dir = mkDir();
    const overridePath = path.join(dir, OWN_LIFE_PROMPT_FILE);
    const delivered: string[] = [];
    const h = createOwnLife({ ...dayOpts(overridePath), deliver: async (t) => { delivered.push(t); return true; } });
    const r = await h.tick();
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('day');
    expect(delivered[0]).toBe(DEFAULT_TEXT_DAY);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('有合法覆盖文件 → 用覆盖内容；改文件后**同一个 handle**再 tick 就是新内容（不用重载插件）', async () => {
    const dir = mkDir();
    const overridePath = path.join(dir, OWN_LIFE_PROMPT_FILE);
    fs.writeFileSync(overridePath, JSON.stringify({ day: ['新菜单第一行', '', '新菜单第二行'] }), 'utf8');
    const delivered: string[] = [];
    const h = createOwnLife({ ...dayOpts(overridePath), deliver: async (t) => { delivered.push(t); return true; } });
    let r = await h.tick();
    expect(r.ok).toBe(true);
    expect(delivered[0]).toBe('新菜单第一行\n\n新菜单第二行');

    // 热读取的关键证据：不重建 handle、不重载插件，只改文件
    writePromptOverridePart(overridePath, 'day', ['改完之后的行']);
    r = await h.tick();
    expect(r.ok).toBe(true);
    expect(delivered[1]).toBe('改完之后的行');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('只覆盖 midnight → 半夜用覆盖内容（缺的 day 段仍用默认）', async () => {
    const dir = mkDir();
    const overridePath = path.join(dir, OWN_LIFE_PROMPT_FILE);
    fs.writeFileSync(overridePath, JSON.stringify({ midnight: ['半夜新规矩'] }), 'utf8');
    const delivered: string[] = [];
    const h = createOwnLife({
      deliver: async (t) => { delivered.push(t); return true; },
      intervalMs: 0, quiet: [0, 0], maxPerDay: 99,
      midnightAt: '00:00', // 刚过北京 00:00 → 第一次 tick 必走 midnight 分支
      promptOverridePath: overridePath,
      log: () => {},
    });
    const r = await h.tick();
    expect(r.kind).toBe('midnight');
    expect(delivered[0]).toBe('半夜新规矩');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('非法 JSON → 回退默认且不崩，warn 说清原因', async () => {
    const dir = mkDir();
    const overridePath = path.join(dir, OWN_LIFE_PROMPT_FILE);
    fs.writeFileSync(overridePath, '{ 这不是 JSON', 'utf8');
    const warns: string[] = [];
    const delivered: string[] = [];
    const h = createOwnLife({ ...dayOpts(overridePath), deliver: async (t) => { delivered.push(t); return true; }, warn: (m) => warns.push(m) });
    const r = await h.tick();
    expect(r.ok).toBe(true);
    expect(delivered[0]).toBe(DEFAULT_TEXT_DAY);
    expect(warns.join('\n')).toMatch(/own-life-prompt\.json/);
    expect(warns.join('\n')).toMatch(/回退默认/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('空数组 = 合法 = 该段空菜单：这次投递被跳过（skipped empty-prompt），不崩', async () => {
    const dir = mkDir();
    const overridePath = path.join(dir, OWN_LIFE_PROMPT_FILE);
    fs.writeFileSync(overridePath, JSON.stringify({ day: [] }), 'utf8');
    const delivered: string[] = [];
    const h = createOwnLife({ ...dayOpts(overridePath), deliver: async (t) => { delivered.push(t); return true; } });
    const r = await h.tick();
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('empty-prompt');
    expect(delivered).toEqual([]);
    // 文件原样可读回（没被改写、没被回退污染）
    expect(loadPromptOverride(overridePath)).toEqual({ day: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('loadPromptOverride · 结构校验', () => {
  it('文件不存在 → undefined 且不 warn（常态路径，不刷日志）', () => {
    const warns: string[] = [];
    expect(loadPromptOverride(path.join(mkDir(), 'nope.json'), (m) => warns.push(m))).toBeUndefined();
    expect(warns).toEqual([]);
  });

  it('根不是对象（数组/字符串）→ undefined + warn', () => {
    const dir = mkDir();
    const p1 = path.join(dir, 'a.json');
    fs.writeFileSync(p1, '[1,2,3]', 'utf8');
    const warns: string[] = [];
    expect(loadPromptOverride(p1, (m) => warns.push(m))).toBeUndefined();
    expect(warns.join('\n')).toMatch(/对象/);
    const p2 = path.join(dir, 'b.json');
    fs.writeFileSync(p2, '"一个字符串"', 'utf8');
    expect(loadPromptOverride(p2)).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('字段存在但不是字符串数组 → 整体 undefined（不半吃半吐）', () => {
    const dir = mkDir();
    const p = path.join(dir, 'x.json');
    fs.writeFileSync(p, JSON.stringify({ day: '新菜单', midnight: ['ok'] }), 'utf8');
    const warns: string[] = [];
    expect(loadPromptOverride(p, (m) => warns.push(m))).toBeUndefined();
    expect(warns.join('\n')).toMatch(/"day"/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('数组里有非字符串元素 → 整体 undefined', () => {
    const dir = mkDir();
    const p = path.join(dir, 'y.json');
    fs.writeFileSync(p, JSON.stringify({ day: ['好', 42] }), 'utf8');
    expect(loadPromptOverride(p)).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('未知字段（拼错的键）→ 合法段仍生效 + warn 提醒拼写', () => {
    const dir = mkDir();
    const p = path.join(dir, 'z.json');
    fs.writeFileSync(p, JSON.stringify({ days: ['手滑'], midnight: ['夜'] }), 'utf8');
    const warns: string[] = [];
    expect(loadPromptOverride(p, (m) => warns.push(m))).toEqual({ midnight: ['夜'] });
    expect(warns.join('\n')).toMatch(/days/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('合法文件 → 原样返回（空数组也保留）', () => {
    const dir = mkDir();
    const p = path.join(dir, 'ok.json');
    fs.writeFileSync(p, JSON.stringify({ day: ['a', 'b'], midnight: [] }), 'utf8');
    expect(loadPromptOverride(p)).toEqual({ day: ['a', 'b'], midnight: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('writePromptOverridePart · 写入 / 备份 / 合并', () => {
  it('首次写入：建文件、返回行数（缺的另一段记 0）', () => {
    const dir = mkDir();
    const p = path.join(dir, OWN_LIFE_PROMPT_FILE);
    expect(writePromptOverridePart(p, 'day', ['a', 'b'])).toEqual({ path: p, dayLines: 2, midnightLines: 0 });
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({ day: ['a', 'b'] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('再次写入：旧文件备份成 .bak（保留最近一份），另一段已有内容保留', () => {
    const dir = mkDir();
    const p = path.join(dir, OWN_LIFE_PROMPT_FILE);
    writePromptOverridePart(p, 'day', ['v1']);
    writePromptOverridePart(p, 'midnight', ['夜1']);
    writePromptOverridePart(p, 'day', ['v2']);
    // .bak 是上一次写入**前**的完整内容
    expect(JSON.parse(fs.readFileSync(`${p}.bak`, 'utf8'))).toEqual({ day: ['v1'], midnight: ['夜1'] });
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({ day: ['v2'], midnight: ['夜1'] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('防线：part 非法 / lines 空或非字符串数组 → throw 且不留下半成品', () => {
    const dir = mkDir();
    const p = path.join(dir, OWN_LIFE_PROMPT_FILE);
    expect(() => writePromptOverridePart(p, 'noon' as 'day', ['x'])).toThrow(/part/);
    expect(() => writePromptOverridePart(p, 'day', [])).toThrow(/lines/);
    expect(() => writePromptOverridePart(p, 'day', [1, 2] as unknown as string[])).toThrow(/lines/);
    expect(fs.existsSync(p)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────
// qq_prompt_edit 工具：真把 registerPersonaTools 跑起来，拿真实 schema 对象比对
// （项目教训见 mood.test.ts：output 是 additionalProperties:false 时，
//  execute 返回里只要有一个没在顶层 properties 声明的字段，
//  宿主就把整个工具结果判 INVALID_TOOL_OUTPUT 扔掉 —— 必须拿真对象验证）
// ─────────────────────────────────────────────────────────────

interface RegisteredTool {
  name: string;
  description?: string;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  output?: {
    schema?: { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
    render?: (args: unknown, value: unknown) => unknown;
  };
  execute: (args: unknown, exec?: unknown) => Promise<Record<string, unknown>>;
}

function registeredTools(persona: PersonaService): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const fakeCtx = {
    get: () => ({ register: (def: RegisteredTool) => { tools.push(def); } }),
  } as unknown as Parameters<typeof registerPersonaTools>[0];
  const logger = {
    info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined,
  } as unknown as Parameters<typeof registerPersonaTools>[3];
  registerPersonaTools(fakeCtx, persona, () => undefined, logger);
  return tools;
}

function pick(tools: RegisteredTool[], name: string): RegisteredTool {
  const t = tools.find((x) => x.name === name);
  expect(t, `${name} 没有被注册`).toBeDefined();
  return t!;
}

/** 只给 qq_prompt_edit 用到的两个成员（注册阶段不会碰 persona 的其它字段） */
function fakePersonaFor(overridePath: string): PersonaService {
  return {
    ownLifePromptPath: overridePath,
    writeOwnLifePrompt: (part: 'day' | 'midnight', lines: string[]) => writePromptOverridePart(overridePath, part, lines),
  } as unknown as PersonaService;
}

describe('qq_prompt_edit 工具', () => {
  it('写入 → 同一个 handle 再 tick 拿到的就是新内容（工具→文件→own-life 全链路热生效）', async () => {
    const dir = mkDir();
    const overridePath = path.join(dir, OWN_LIFE_PROMPT_FILE);
    const delivered: string[] = [];
    const h = createOwnLife({ ...dayOpts(overridePath), deliver: async (t) => { delivered.push(t); return true; } });
    // 1) 还没写过 → 默认提示词
    await h.tick();
    expect(delivered[0]).toBe(DEFAULT_TEXT_DAY);
    // 2) 她用工具改菜单（运行中进程，不重载插件）
    const tool = pick(registeredTools(fakePersonaFor(overridePath)), 'qq_prompt_edit');
    const r = await tool.execute({ part: 'day', lines: ['她写的新菜单', '', '第二行'] });
    expect(r.ok).toBe(true);
    // 3) 下一次自由时间就是新菜单
    const r2 = await h.tick();
    expect(r2.ok).toBe(true);
    expect(delivered[1]).toBe('她写的新菜单\n\n第二行');
    // 4) 再改一次，仍然即时生效
    await tool.execute({ part: 'day', lines: ['第二版'] });
    await h.tick();
    expect(delivered[2]).toBe('第二版');
    // 5) 备份链也在：.bak 是上一次写入前的内容（含两段）
    expect(JSON.parse(fs.readFileSync(`${overridePath}.bak`, 'utf8')).day).toEqual(['她写的新菜单', '', '第二行']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('output schema：execute 的真实返回字段全部落在顶层 properties 里（防 INVALID_TOOL_OUTPUT）', async () => {
    const dir = mkDir();
    const overridePath = path.join(dir, OWN_LIFE_PROMPT_FILE);
    const tool = pick(registeredTools(fakePersonaFor(overridePath)), 'qq_prompt_edit');
    const schema = tool.output?.schema;
    expect(schema?.additionalProperties).toBe(false);
    const declared = new Set(Object.keys(schema?.properties ?? {}));
    expect([...declared].sort()).toEqual(['dayLines', 'midnightLines', 'ok', 'path']);

    const returns = [
      await tool.execute({ part: 'day', lines: ['x'] }),
      await tool.execute({ part: 'midnight', lines: ['y', 'z'] }),
      await tool.execute({ part: 'midnight', lines: ['二次写入'] }),
    ];
    for (const r of returns) {
      const extra = Object.keys(r).filter((k) => !declared.has(k));
      expect(extra, `返回里的 ${extra.join(',')} 未在 schema 顶层声明 → 整个结果会被判 INVALID_TOOL_OUTPUT`).toEqual([]);
      for (const req of schema?.required ?? []) expect(r).toHaveProperty(req);
    }
    // 行数对得上：day 1 行没动过；midnight 先 2 行、再整段替换成 1 行
    expect(returns[0]).toMatchObject({ ok: true, dayLines: 1, midnightLines: 0 });
    expect(returns[2]).toMatchObject({ dayLines: 1, midnightLines: 1 });
    // render 也不炸，且说清"下次生效"
    const blocks = tool.output?.render?.({}, returns[0]) as { type: string; text: string }[];
    expect(blocks[0]?.text).toContain('下一次自由时间生效');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parameters：part 枚举锁死、lines 是字符串数组且必填；description 讲清整段替换与备份', () => {
    const tool = pick(registeredTools(fakePersonaFor(path.join(mkDir(), 'none.json'))), 'qq_prompt_edit');
    const props = tool.parameters?.properties as Record<string, { enum?: string[]; type?: string; items?: { type?: string } }>;
    expect(Object.keys(props).sort()).toEqual(['lines', 'part']);
    expect(props.part?.enum).toEqual(['day', 'midnight']);
    expect(props.lines?.type).toBe('array');
    expect(props.lines?.items?.type).toBe('string');
    expect(tool.parameters?.required).toEqual(expect.arrayContaining(['part', 'lines']));
    expect(tool.description ?? '').toMatch(/整段替换/);
    expect(tool.description ?? '').toMatch(/\.bak/);
    expect(tool.description ?? '').toMatch(/下一次自由时间.*生效/);
  });

  it('防线：空 lines / 坏 part / 非字符串项 → throw 且不写文件', async () => {
    const dir = mkDir();
    const overridePath = path.join(dir, OWN_LIFE_PROMPT_FILE);
    const tool = pick(registeredTools(fakePersonaFor(overridePath)), 'qq_prompt_edit');
    await expect(tool.execute({ part: 'day', lines: [] })).rejects.toThrow(/lines/);
    await expect(tool.execute({ part: 'noon', lines: ['x'] })).rejects.toThrow(/part/);
    await expect(tool.execute({ part: 'day', lines: [42] })).rejects.toThrow(/字符串/);
    await expect(tool.execute({ part: 'day' })).rejects.toThrow();
    expect(fs.existsSync(overridePath)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('PersonaService · 提示词覆盖接线', () => {
  function mkSvc(dir: string, cfg: Record<string, unknown> = {}): PersonaService {
    return new PersonaService({
      config: {
        enabled: true, dataDir: dir, roleCardPath: '', roleMaxChars: 12000,
        wakeEnabled: true, names: ['小深'], keywords: [], ownerOpenids: [],
        groupProbability: 0, humanizeEnabled: true,
        msPerChar: 110, burstMax: 2, gapMinMs: 700, gapMaxMs: 2600,
        ownLifeEnabled: false, ownLifeIntervalMs: 9000000, ownLifeMaxPerDay: 6,
        maxProactivePerDay: 2, proactiveMinGapMs: 7200000,
        ...cfg,
      } as never,
      dataDir: dir,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    });
  }

  it('writeOwnLifePrompt 写到 ownLifePromptPath；startOwnLife 把覆盖文件接给 own-life（tick 拿覆盖内容）', async () => {
    const dir = mkDir();
    const svc = mkSvc(dir, { ownLifeEnabled: true, ownLifeIntervalMs: 0, ownLifeQuietHours: [0, 0], ownLifeMaxPerDay: 99 });
    expect(svc.ownLifePromptPath).toBe(path.join(dir, 'own-life-prompt.json'));
    const r = svc.writeOwnLifePrompt('day', ['服务层写入的行']);
    expect(r.dayLines).toBe(1);
    expect(JSON.parse(fs.readFileSync(svc.ownLifePromptPath, 'utf8'))).toEqual({ day: ['服务层写入的行'] });

    // 预置状态：半夜槽今天已消耗 → 排除 midnight 分支，tick 必走 day（对任何运行时刻确定）
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'own-life.json'),
      JSON.stringify({ lastMidnightDay: dayInTz(new Date()) }), 'utf8');

    const delivered: string[] = [];
    svc.startOwnLife(async (t) => { delivered.push(t); return true; });
    const res = await svc.ownLife!.tick();
    svc.ownLife!.stop();
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('day');
    expect(delivered[0]).toBe('服务层写入的行');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
