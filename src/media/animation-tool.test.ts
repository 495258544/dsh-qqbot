/**
 * qq_watch_animation 工具层测试（task-7，2026-11-12）
 * ─────────────────────────────────────────────────────────────
 * 防两类真实失效：
 *
 *  1. **output schema 是 additionalProperties:false** —— execute 返回里只要有
 *     一个没在顶层 properties 声明的字段，宿主 dsh-tools 就会把整个结果判成
 *     INVALID_TOOL_OUTPUT 静默扔掉（不报错，结果直接消失；qq_nga 因此连挂两次）。
 *     timeline 数组的 items 嵌套层也一样要单独声明完整。所以这里**不看源码文本**，
 *     而是真调 registerWatchAnimationTool 拿真实 schema 对象、真跑 execute、
 *     逐字段比对 —— 校验器看到的是什么，就比什么。
 *
 *  2. **视觉链路任何一环挂掉都不能带崩工具** —— 抽帧/拼图的成果必须保住：
 *     callVision 挂 → 降级成「拼图 + 时间骨架（note 空）」；拼图挂 → 时间轴还在。
 *
 * 全部走 deps 注入（probe / extract / buildSheet / callVision，见
 * animation-tool.ts 的 registerWatchAnimationTool），不跑真 ffmpeg、不调真视觉模型。
 * 仅有的真实 fs 触碰：
 *   · execute 会 mkdir PLUGIN_HOME 下的临时帧目录，并在 finally 里清掉；
 *   · describeFramesWithVision 要真读帧文件嗅探 magic bytes（读不到/不是图片的
 *     帧会被静默跳过），所以注入的假帧是**真的 1x1 PNG**，源文件是随便一个
 *     带 GIF 魔数的文件（probe/extract 都注入了，内容无所谓）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { VisionConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { PLUGIN_HOME } from '../shared/dirs.ts';
import type { AnimationMeta } from './animation-probe.ts';
import { sheetLayout, type ExtractedFrames } from './animation-frames.ts';
import {
  MAX_VISION_FRAMES,
  WATCH_ANIMATION_TOOL_NAME,
  pickVisionFrames,
  registerWatchAnimationTool,
  renderTimeline,
  type WatchAnimationDeps,
} from './animation-tool.ts';

// ─────────────────────────────────────────────────────────────
// 夹具与注册捕获（照 mood.test.ts 的模式：真调注册函数拿真实定义对象）
// ─────────────────────────────────────────────────────────────

/** 捕获到的工具定义（只声明 schema 比对关心的部分） */
interface RegisteredTool {
  name: string;
  description?: string;
  parameters?: {
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  output?: {
    schema?: {
      properties?: Record<
        string,
        {
          type?: string;
          items?: {
            properties?: Record<string, unknown>;
            required?: string[];
            additionalProperties?: boolean;
          };
        }
      >;
      required?: string[];
      additionalProperties?: boolean;
    };
    render?: (args: unknown, value: unknown) => Array<{ type: string; text: string }>;
  };
  execute: (args: unknown, exec?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>;
}

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anim-tool-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}

function makeVision(enabled: boolean): VisionConfig {
  return {
    enabled,
    provider: 'test-provider',
    model: 'test-vision',
    defaultPrompt: '描述这张图片',
    maxBytes: 1024 * 1024,
    maxTokens: 256,
    timeoutMs: 5000,
  };
}

function makeMeta(frames: number, duration = 1.75): AnimationMeta {
  return { frames, duration, width: 334, height: 250, source: 'container' };
}

/** 1x1 合法 PNG（describeFramesWithVision 会真读文件嗅探 magic bytes） */
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000'
  + '01f15c4890000000a49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082',
  'hex',
);

/** 源文件（内容无所谓：probe/extract 都注入了，只有 statSync 会真的碰它） */
function srcGif(dir: string): string {
  const p = join(dir, 'cat.gif');
  writeFileSync(p, Buffer.from('47494638396101000100800000', 'hex'));
  return p;
}

/** 在测试临时目录里写 n 张真 PNG 假帧，拼成 ExtractedFrames 形状 */
function fakeFrames(dir: string, count: number, totalFrames: number, duration: number): ExtractedFrames {
  const frames: ExtractedFrames['frames'] = [];
  for (let i = 0; i < count; i += 1) {
    const p = join(dir, `f_${String(i + 1).padStart(3, '0')}.png`);
    writeFileSync(p, PNG_1X1);
    frames.push({ index: i, t: count > 1 ? (duration * i) / (count - 1) : 0, path: p });
  }
  return { frames, totalFrames, duration, degraded: false };
}

/** 全注入的基础 deps：一切成功、每帧都有视觉描述 */
function baseDeps(dir: string): WatchAnimationDeps {
  return {
    probe: () => makeMeta(42, 1.75),
    extract: async () => fakeFrames(dir, 6, 42, 1.75),
    buildSheet: async (_frames, outPath) => outPath,
    callVision: async () => '这一帧的描述',
  };
}

/** 宿主调 execute 时带的第二参（工具只用 signal） */
const EXEC = { signal: new AbortController().signal };

/** 真调注册函数，捕获真实 definition 对象 */
function registerTool(
  deps: WatchAnimationDeps = {},
  vision: VisionConfig = makeVision(true),
): RegisteredTool {
  const captured: RegisteredTool[] = [];
  const ctx = {
    get: (name: string) =>
      name === 'tools'
        ? { register: (def: unknown) => { captured.push(def as RegisteredTool); } }
        : undefined,
  } as unknown as Parameters<typeof registerWatchAnimationTool>[0];
  registerWatchAnimationTool(ctx, vision, fakeLogger(), deps);
  const tool = captured.find((t) => t.name === WATCH_ANIMATION_TOOL_NAME);
  expect(tool, 'qq_watch_animation 没有被注册').toBeDefined();
  return tool!;
}

async function runTool(
  deps: WatchAnimationDeps,
  args: unknown,
  vision?: VisionConfig,
): Promise<Record<string, unknown>> {
  return registerTool(deps, vision).execute(args, EXEC);
}

// ─────────────────────────────────────────────────────────────
// 1. output schema 覆盖 execute 的所有返回字段（防 INVALID_TOOL_OUTPUT）
//
// 这个项目踩过两次的坑：additionalProperties:false + 一个未声明字段 = 整个
// 结果被宿主静默扔掉。所以每个真实返回形状都要落在顶层 properties 里，
// timeline 的 items 嵌套层单独比对。
// ─────────────────────────────────────────────────────────────
describe('output schema 覆盖 execute 的所有返回字段（防 INVALID_TOOL_OUTPUT）', () => {
  it('顶层：8 种真实返回形状的键都 ⊆ schema.properties，required 字段每次都齐', async () => {
    const tool = registerTool();
    const schema = tool.output?.schema;
    expect(schema?.additionalProperties, 'schema 必须是 additionalProperties:false，否则这段测试白写').toBe(false);
    const declared = new Set(Object.keys(schema?.properties ?? {}));
    expect(declared.size, 'schema 里一个属性都没有 —— 捕获失败了').toBeGreaterThan(0);
    const required = schema?.required ?? [];

    // error 是可选字段（feel 式）：必须在 properties 里声明（失败路径要返回它），但不进 required
    expect(declared.has('error'), 'error 必须在顶层 properties 里声明（失败路径要返回它）').toBe(true);
    expect(required, 'error 可选：不该进 required').not.toContain('error');
    for (const key of ['ok', 'path', 'frames', 'duration', 'sheet', 'sheetPath', 'timeline']) {
      expect(declared.has(key), `${key} 没在顶层 properties 声明`).toBe(true);
      expect(required, `${key} 是必有字段，该进 required`).toContain(key);
    }

    const dir = tmpDir();
    const src = srcGif(dir);
    const deps: WatchAnimationDeps = { ...baseDeps(dir), callVision: undefined };
    const returns: Record<string, unknown>[] = [
      // 成功 + 有视觉描述
      await runTool(baseDeps(dir), { path: src, prompt: '尾巴动了吗' }),
      // 视觉全挂 → 降级（note 空）
      await runTool({ ...baseDeps(dir), callVision: async () => { throw new Error('模型挂了'); } }, { path: src }),
      // 没有视觉服务 → 降级
      await runTool(deps, { path: src }, makeVision(false)),
      // 拼图失败 → 降级（sheetPath 空）
      await runTool({ ...baseDeps(dir), buildSheet: async () => { throw new Error('拼图挂了'); } }, { path: src }),
      // 抽帧抛异常
      await runTool({ ...baseDeps(dir), extract: async () => { throw new Error('抽帧挂了'); } }, { path: src }),
      // 抽不出任何帧
      await runTool(
        { ...baseDeps(dir), extract: async () => ({ frames: [], totalFrames: 42, duration: 1.75, degraded: true }) },
        { path: src },
      ),
      // 静态图（1 帧）
      await runTool({ ...baseDeps(dir), probe: () => makeMeta(1, 0) }, { path: src }),
      // 文件不存在
      await runTool(baseDeps(dir), { path: join(dir, 'no-such-file.gif') }),
    ];

    for (const r of returns) {
      const extra = Object.keys(r).filter((k) => !declared.has(k));
      expect(
        extra,
        `返回里的 ${extra.join(',')} 未在 schema 顶层声明 → 整个结果会被宿主判 INVALID_TOOL_OUTPUT 静默扔掉`,
      ).toEqual([]);
      const missing = required.filter((k) => !(k in r));
      expect(missing, `required 里的 ${missing.join(',')} 没出现在返回里`).toEqual([]);
      if (r.ok === true) {
        expect('error' in r, '成功路径不该带 error 字段').toBe(false);
      } else {
        expect(typeof r.error, '失败路径必须带 string 类型的 error（schema 里已声明）').toBe('string');
      }
    }
  });

  it('timeline 嵌套层：items.properties 覆盖 {t, note}，两个都 required（第二次踩坑的位置）', async () => {
    const tool = registerTool();
    const timeline = tool.output?.schema?.properties?.timeline;
    expect(timeline?.type).toBe('array');
    expect(
      timeline?.items?.additionalProperties,
      'items 层同样必须 additionalProperties:false —— 嵌套层漏声明照样炸',
    ).toBe(false);
    expect(Object.keys(timeline?.items?.properties ?? {}).sort()).toEqual(['note', 't']);
    expect(timeline?.items?.required).toEqual(['t', 'note']);

    // 真实返回的每一条都要落在 items.properties 里
    const dir = tmpDir();
    const src = srcGif(dir);
    const withNotes = await runTool(baseDeps(dir), { path: src });
    const degraded = await runTool(
      { ...baseDeps(dir), callVision: async () => { throw new Error('挂'); } },
      { path: src },
    );
    for (const r of [withNotes, degraded]) {
      const entries = r.timeline as Array<Record<string, unknown>>;
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        const extra = Object.keys(e).filter((k) => !['t', 'note'].includes(k));
        expect(extra, `timeline 项里的 ${extra.join(',')} 未在 items.properties 声明`).toEqual([]);
        expect(typeof e.t).toBe('number');
        expect(typeof e.note).toBe('string');
      }
    }
  });

  it('顶层字段类型与实际返回一致（frames 是 integer、timeline 是 array）', () => {
    const props = registerTool().output?.schema?.properties ?? {};
    expect(props.ok).toMatchObject({ type: 'boolean' });
    expect(props.frames).toMatchObject({ type: 'integer' });
    expect(props.duration).toMatchObject({ type: 'number' });
    expect(props.path).toMatchObject({ type: 'string' });
    expect(props.sheet).toMatchObject({ type: 'string' });
    expect(props.sheetPath).toMatchObject({ type: 'string' });
    expect(props.error).toMatchObject({ type: 'string' });
    expect(props.timeline).toMatchObject({ type: 'array' });
  });

  it('parameters：path required、prompt 可选、additionalProperties:false', () => {
    const p = registerTool().parameters;
    expect(p?.additionalProperties).toBe(false);
    expect(p?.required).toEqual(['path']);
    expect(Object.keys(p?.properties ?? {}).sort()).toEqual(['path', 'prompt']);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. execute 行为（全注入，不跑真 ffmpeg、不调真视觉模型）
// ─────────────────────────────────────────────────────────────
describe('execute · 参数校验', () => {
  it('path 缺失 / 空串 / 非字符串 → 抛错（不白跑任何一步）', async () => {
    const dir = tmpDir();
    const tool = registerTool(baseDeps(dir));
    await expect(tool.execute({}, EXEC)).rejects.toThrow('`path` must be a non-empty string');
    await expect(tool.execute({ path: '' }, EXEC)).rejects.toThrow('`path`');
    await expect(tool.execute({ path: 42 }, EXEC)).rejects.toThrow('`path`');
  });
});

describe('execute · 失败路径', () => {
  it('文件不存在 → ok:false + error 说明；路径指向目录也一样', async () => {
    const dir = tmpDir();
    const missing = await runTool(baseDeps(dir), { path: join(dir, 'nope.gif') });
    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toContain('文件不存在');
    expect(missing.frames).toBe(0);
    expect(missing.sheetPath).toBe('');
    expect(missing.timeline).toEqual([]);

    const isDir = await runTool(baseDeps(dir), { path: dir });
    expect(isDir.ok).toBe(false);
    expect(String(isDir.error)).toContain('文件不存在');
  });

  it('probe 报 1 帧（静态图）→ ok:false，并指路 qqbot_describe_image', async () => {
    const dir = tmpDir();
    const r = await runTool({ ...baseDeps(dir), probe: () => makeMeta(1, 0) }, { path: srcGif(dir) });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('静态图');
    expect(String(r.error)).toContain('qqbot_describe_image');
    expect(r.frames).toBe(1);
    expect(r.timeline).toEqual([]);
  });

  it('probe 返回 null（元信息未知）→ 不当错误：按抽帧结果继续', async () => {
    // 文档化实际行为：probe null 的语义是「读不到帧表」（视频、未知容器），源码
    // 注释明说「读不到就按时间均匀抽」，所以继续抽帧而不是报错。真实静态图的
    // probe 也返回 null，那条路由 extract 抽不出帧时的另一条 error 兜底。
    const dir = tmpDir();
    let passedTotal = -1;
    let passedDuration = -1;
    const deps: WatchAnimationDeps = {
      ...baseDeps(dir),
      probe: () => null,
      extract: async (_path, _tmp, totalFrames, duration) => {
        passedTotal = totalFrames;
        passedDuration = duration;
        return fakeFrames(dir, 4, 4, 1.0);
      },
    };
    const r = await runTool(deps, { path: srcGif(dir) });
    expect(r.ok).toBe(true);
    expect(passedTotal, 'probe null → 元信息按 0 传给抽帧（不猜）').toBe(0);
    expect(passedDuration).toBe(0);
    expect(r.frames, '返回的 frames 是抽帧结果的 totalFrames').toBe(4);
  });

  it('extract 抛异常 → ok:false + 抽帧失败（异常信息透传）', async () => {
    const dir = tmpDir();
    const r = await runTool(
      { ...baseDeps(dir), extract: async () => { throw new Error('ffmpeg 不在'); } },
      { path: srcGif(dir) },
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('抽帧失败');
    expect(String(r.error)).toContain('ffmpeg 不在');
  });

  it('extract 返回 0 帧 → ok:false + 抽不出任何帧（totalFrames 照实回传）', async () => {
    const dir = tmpDir();
    const r = await runTool(
      { ...baseDeps(dir), extract: async () => ({ frames: [], totalFrames: 42, duration: 1.75, degraded: true }) },
      { path: srcGif(dir) },
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('抽不出任何帧');
    expect(r.frames).toBe(42);
  });
});

describe('execute · 正常路径与降级', () => {
  it('42 帧动图：抽 6 帧、送视觉 4 帧、一帧挂 → timeline 3 条、首尾都进了视觉、拼图路径对', async () => {
    const dir = tmpDir();
    const src = srcGif(dir);
    const fake = fakeFrames(dir, 6, 42, 1.75);
    const extractCalls: Array<{ totalFrames: number; duration: number }> = [];
    const sheetCalls: Array<{ count: number; outPath: string }> = [];
    const visionCalls: Array<{ prompt: string; mediaType: string }> = [];
    let n = 0;
    const deps: WatchAnimationDeps = {
      probe: () => makeMeta(42, 1.75),
      extract: async (_path, _tmp, totalFrames, duration) => {
        extractCalls.push({ totalFrames, duration });
        return fake;
      },
      buildSheet: async (frames, outPath) => {
        sheetCalls.push({ count: frames.length, outPath });
        return outPath;
      },
      callVision: async (_data, mediaType, prompt) => {
        visionCalls.push({ prompt, mediaType });
        n += 1;
        if (n === 2) throw new Error('模型这帧抽风');
        return `描述${n}`;
      },
    };

    const r = await runTool(deps, { path: src, prompt: '尾巴动了吗' });

    expect(r.ok).toBe(true);
    expect(r.path).toBe(resolve(src));
    expect(r.frames).toBe(42);
    expect(r.duration).toBe(1.75);
    expect(r.sheet).toBe(r.sheetPath);
    // timeline = 3 条：第 2 帧的描述挂了被跳过，但不能毁掉整条时间轴
    const timeline = r.timeline as Array<{ t: number; note: string }>;
    expect(timeline).toHaveLength(3);
    expect(timeline.map((e) => e.note)).toEqual(['描述1', '描述3', '描述4']);
    expect(timeline[0]!.t).toBe(0);
    expect(timeline[1]!.t).toBeCloseTo(1.05, 10);
    expect(timeline[2]!.t).toBeCloseTo(1.75, 10);
    // 抽帧拿到的是 probe 的元信息
    expect(extractCalls[0]).toEqual({ totalFrames: 42, duration: 1.75 });
    // 拼图拿到全部 6 帧，输出落在 media 根目录，文件名抓源文件主体
    expect(sheetCalls).toHaveLength(1);
    expect(sheetCalls[0]!.count).toBe(6);
    expect(sheetCalls[0]!.outPath.startsWith(join(PLUGIN_HOME, 'media'))).toBe(true);
    expect(sheetCalls[0]!.outPath).toMatch(/cat_sheet_\d+\.png$/);
    // 视觉只送挑过的 4 帧（6 取 4），首尾都在里面；prompt 带上了关注点
    expect(visionCalls).toHaveLength(4);
    expect(visionCalls.every((c) => c.mediaType === 'image/png')).toBe(true);
    expect(visionCalls[0]!.prompt).toContain('尾巴动了吗');
    expect(visionCalls[0]!.prompt).toContain('第 0.00 秒');
    expect(visionCalls[3]!.prompt).toContain('第 1.75 秒');
    expect(visionCalls.every((c) => c.prompt.includes('正在发生什么'))).toBe(true);
  });

  it('callVision 全挂 → 工具不倒：ok:true，时间轴降级为全帧 note=""', async () => {
    const dir = tmpDir();
    const r = await runTool(
      { ...baseDeps(dir), callVision: async () => { throw new Error('always dead'); } },
      { path: srcGif(dir) },
    );
    expect(r.ok).toBe(true);
    expect(r.sheetPath, '拼图的成果不能跟着视觉一起丢').not.toBe('');
    const timeline = r.timeline as Array<{ t: number; note: string }>;
    expect(timeline).toHaveLength(6);
    expect(timeline.every((e) => e.note === '')).toBe(true);
  });

  it('没有视觉服务（vision.enabled=false）→ 同样只出拼图 + 时间骨架', async () => {
    const dir = tmpDir();
    const deps: WatchAnimationDeps = { ...baseDeps(dir), callVision: undefined };
    const r = await runTool(deps, { path: srcGif(dir) }, makeVision(false));
    expect(r.ok).toBe(true);
    const timeline = r.timeline as Array<{ note: string }>;
    expect(timeline).toHaveLength(6);
    expect(timeline.every((e) => e.note === '')).toBe(true);
  });

  it('buildSheet 挂 → 拼图降级为空路径，时间轴照常返回', async () => {
    const dir = tmpDir();
    const r = await runTool(
      { ...baseDeps(dir), buildSheet: async () => { throw new Error('ffmpeg gone'); } },
      { path: srcGif(dir) },
    );
    expect(r.ok).toBe(true);
    expect(r.sheet).toBe('');
    expect(r.sheetPath).toBe('');
    expect(r.timeline as unknown[]).toHaveLength(4);
  });
});

describe('render · 给她看的那两行', () => {
  it('成功：帧数/时长/拼图路径 + 完整时间轴', async () => {
    const dir = tmpDir();
    const tool = registerTool(baseDeps(dir));
    const r = await tool.execute({ path: srcGif(dir) }, EXEC);
    const blocks = tool.output?.render?.({}, r) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[0]!.text).toContain('动图 42 帧 / 1.75s');
    expect(blocks[0]!.text).toContain(String(r.sheetPath));
    expect(blocks[0]!.text).toContain('→');
    expect(blocks[0]!.text).toContain('这一帧的描述');
  });

  it('失败：说「看不懂」+ 原因，不装懂', async () => {
    const dir = tmpDir();
    const tool = registerTool({ ...baseDeps(dir), probe: () => makeMeta(1, 0) });
    const r = await tool.execute({ path: srcGif(dir) }, EXEC);
    const blocks = tool.output?.render?.({}, r) ?? [];
    expect(blocks[0]!.text).toContain('看不懂这张动图');
    expect(blocks[0]!.text).toContain('静态图');
  });
});

// ─────────────────────────────────────────────────────────────
// 3. 导出的纯函数
// ─────────────────────────────────────────────────────────────
describe('pickVisionFrames · 首尾帧必须保住（两头丢了就说不出发生了什么变化）', () => {
  interface Frame { index: number; t: number; path: string }
  const framesOf = (n: number): Frame[] =>
    Array.from({ length: n }, (_, i) => ({ index: i, t: i / 10, path: `/tmp/f${i}.png` }));

  it('12 帧 max 4 → 恰好 [0,4,7,11]，首尾都在', () => {
    const out = pickVisionFrames(framesOf(12), 4);
    expect(out.map((f) => f.index)).toEqual([0, 4, 7, 11]);
  });

  it('12 帧 max 3 → [0,6,11]', () => {
    expect(pickVisionFrames(framesOf(12), 3).map((f) => f.index)).toEqual([0, 6, 11]);
  });

  it('max=2 → 只有首尾', () => {
    expect(pickVisionFrames(framesOf(12), 2).map((f) => f.index)).toEqual([0, 11]);
  });

  it('帧数不超过 max → 原样全保留（返回的是副本，不共享数组）', () => {
    const frames = framesOf(3);
    const out = pickVisionFrames(frames, 4);
    expect(out).not.toBe(frames);
    expect(out).toEqual(frames);
  });

  it('max 大于帧数 / 空数组 → 不炸', () => {
    expect(pickVisionFrames(framesOf(2), 9)).toHaveLength(2);
    expect(pickVisionFrames([], 4)).toEqual([]);
  });

  it('任意 (n, max) 组合：升序、无重复、≤ max、超取样时首尾必在', () => {
    for (const n of [5, 7, 9, 12, 20]) {
      for (const max of [2, 3, 4, 5]) {
        const idx = pickVisionFrames(framesOf(n), max).map((f) => f.index);
        expect([...idx].sort((a, b) => a - b)).toEqual(idx);
        expect(new Set(idx).size).toBe(idx.length);
        expect(idx.length).toBeLessThanOrEqual(max);
        if (n > max) {
          expect(idx[0], `n=${n} max=${max} 丢了首帧`).toBe(0);
          expect(idx[idx.length - 1], `n=${n} max=${max} 丢了尾帧`).toBe(n - 1);
        }
      }
    }
  });

  it('MAX_VISION_FRAMES = 4（送视觉的上限，成本线性，别被手滑改大）', () => {
    expect(MAX_VISION_FRAMES).toBe(4);
  });
});

describe('renderTimeline', () => {
  it('空时间轴 → 空串', () => {
    expect(renderTimeline([])).toBe('');
  });

  it('单帧 → 两位小数 + 描述', () => {
    expect(renderTimeline([{ t: 0, note: '蓝的趴在电脑上' }])).toBe('0.00s 蓝的趴在电脑上');
    expect(renderTimeline([{ t: 0.42, note: '抬头' }])).toBe('0.42s 抬头');
    expect(renderTimeline([{ t: 1.75, note: '尾巴晃' }])).toBe('1.75s 尾巴晃');
  });

  it('多帧 → ` → ` 连接成动作序列', () => {
    expect(renderTimeline([{ t: 0, note: 'a' }, { t: 0.42, note: 'b' }, { t: 1, note: 'c' }]))
      .toBe('0.00s a → 0.42s b → 1.00s c');
  });

  it('note 为空 → trim 掉尾巴空格（降级骨架不该有 `0.50s ` 这样的悬空空格）', () => {
    expect(renderTimeline([{ t: 0.5, note: '' }])).toBe('0.50s');
  });
});

describe('sheetLayout（拼图网格，来自 animation-frames.ts）', () => {
  it.each([
    [0, 1, 1], [1, 1, 1],
    [2, 2, 1],
    [3, 2, 2], [4, 2, 2],
    [5, 3, 2], [6, 3, 2],
    [7, 3, 3], [9, 3, 3], [10, 3, 3],
  ])('count=%i → %i 列 × %i 行', (count, cols, rows) => {
    expect(sheetLayout(count)).toEqual({ cols, rows });
  });
});

describe('注册降级', () => {
  it('tools 服务不可用 → 不注册、不抛（不阻断插件启动）', () => {
    const ctx = { get: () => undefined } as unknown as Parameters<typeof registerWatchAnimationTool>[0];
    expect(() => registerWatchAnimationTool(ctx, makeVision(true), fakeLogger())).not.toThrow();
  });
});
