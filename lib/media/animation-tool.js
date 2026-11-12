/**
 * qq_watch_animation —— 看懂一张动图/视频里**发生了什么动作**。
 *
 * ## 为什么要有这个工具
 *
 * 2026-11-12，用户发了一张 42 帧的 GIF，她的回答是：
 *
 * > 「比抽帧还糙——聊天里收到的动图，管线直接塞给我一张静帧。就这一格：
 * >  蓝的趴在电脑上，白的站在后头。她们俩这中间做了什么动作，趴下去的过程、
 * >  眨眼、尾巴晃没晃，我全不知道。除非我哪天闲了自己拿 ffmpeg 抽帧，
 * >  那算是加班。」
 *
 * 她把缺口说得很准。管线那一侧已经补了自动元信息（见
 * `transport/inbound.ts` 的 renderMediaLine + `media/animation-probe.ts`）：
 * 她至少**知道**收到的是动图、多少帧、多长。但「知道是动图」不等于
 * 「知道里面动了什么」—— 后者必须真的解码抽帧。
 *
 * ## 为什么不做成「所有动图自动抽帧描述」
 *
 * 抽帧要跑 ffmpeg（实测 300ms），逐帧描述要调视觉模型（每帧一次 LLM 调用）。
 * 每条带图消息都自动走一遍，会让她聊天整体变慢、烧 token，而大多数动图
 * （表情包、贴纸）她根本不需要理解动作。所以抽帧是**她自己按需调用**的工具，
 * 元信息才是管线自动给的。
 *
 * ## 输出：两条路给她
 *
 *   1. 一张带时间戳的**胶片条**（contact sheet）—— 她（和用户）能直接看
 *   2. 一段**动作序列**文字 —— `0.00s 蓝的趴在电脑上 → 0.42s 蓝的抬头 → …`
 *
 * 两者都要：图直观，字说得出来。
 *
 * ## ⚠️ output schema 的坑
 *
 * 本项目的工具 output schema 是 `additionalProperties: false` 的：execute 返回
 * 里只要有一个没在**顶层** properties 声明的字段，宿主会把整个结果判成
 * `INVALID_TOOL_OUTPUT` 静默扔掉（qq_nga 因此连挂两次）。嵌套数组（timeline）
 * 的 items 那层也要单独声明完整。见 `animation-tool.test.ts`。
 */
import { mkdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { PLUGIN_HOME } from "../shared/dirs.js";
import { formatAnimationMeta, probeAnimationSync } from "./animation-probe.js";
import { buildContactSheet, cleanupFrameDir, downSample, extractKeyFrames, isVideoPath, } from "./animation-frames.js";
import { createMultiVisionCaller, describeFramesWithVision, } from "./vision-tool.js";
/** 工具名 */
export const WATCH_ANIMATION_TOOL_NAME = 'qq_watch_animation';
/** 抽帧临时目录（放在插件数据目录下，和 media 同级，便于一起清理） */
const FRAME_TMP_ROOT = join(PLUGIN_HOME, 'media', 'frames');
/** 拼图输出目录（和 media 同一个根，媒体清理会按 mtime 一起扫） */
const SHEET_ROOT = join(PLUGIN_HOME, 'media');
/** 送视觉模型的最多帧数（再多意义不大，成本和延迟却是线性的） */
export const MAX_VISION_FRAMES = 4;
const DESCRIPTION = 'Watch what HAPPENS in an animated image (GIF / APNG / animated WebP) or a short video: '
    + 'extract the key frames, build a timestamped contact sheet, and describe the action sequence. '
    + 'Use this when a chat message carries an animation and the motion matters (who moved, what '
    + 'changed, the sequence of poses) — a still image cannot answer that. Static images do not '
    + 'need this tool; use qqbot_describe_image for those. Slower than a plain image read '
    + '(it runs ffmpeg and calls the vision model a few times), so call it when the motion matters.';
/** 时间轴渲染成一行，如 `0.00s 蓝的趴在电脑上 → 0.42s 蓝的抬头` */
export function renderTimeline(timeline) {
    if (timeline.length === 0)
        return '';
    return timeline
        .map((p) => `${p.t.toFixed(2)}s ${p.note}`.trim())
        .join(' → ');
}
/** 拼图文件名：抓源文件名的主体，避免覆盖（同一张图多次看也不该互相踩） */
function sheetFileName(sourcePath) {
    const stem = basename(sourcePath).replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]/g, '_');
    const short = stem.slice(-40) || 'anim';
    return `${short}_sheet_${Date.now()}.png`;
}
/**
 * 把挑出来的帧分成「送去视觉描述」的那几组。
 *
 * 为什么不是全部送：6~9 帧每帧一次 LLM 调用，延迟和成本都翻倍，而
 * 相邻帧的描述高度重复。抽样时**必须保住首尾**（起点和终点是动作的
 * 两端，中间丢一帧还能推，两头丢了就说不出"发生了什么变化"）。
 */
export function pickVisionFrames(frames, max) {
    if (frames.length <= max)
        return [...frames];
    const out = [frames[0]];
    const middle = max - 2;
    if (middle > 0) {
        for (let i = 1; i <= middle; i += 1) {
            const idx = Math.round((i * (frames.length - 1)) / (middle + 1));
            const f = frames[idx];
            if (f !== undefined && !out.some((p) => p.index === f.index))
                out.push(f);
        }
    }
    const last = frames[frames.length - 1];
    if (!out.some((p) => p.index === last.index))
        out.push(last);
    return out.sort((a, b) => a.index - b.index);
}
const requestTime = (r) => r.frame.t;
/**
 * 把抽出来的帧规划成视觉调用请求（核心纯函数）。
 *
 * 调用总次数有硬上限（{@link MAX_VISION_FRAMES}，成本线性）：
 *   - 动作特写段存在（≥2 帧）→ 相邻两张一组送视觉（问「两帧之间发生了什么
 *     变化」——「挥动/抽打」的证据在帧间位置变化里，单帧看不到），概览帧用
 *     剩余预算送单帧；
 *   - 没有特写段（退化路径 / 扫不出分数）→ 全部单帧，行为与老版一致。
 *
 * 帧对永远优先：概览帧本来就是离散采样，丢一段还能靠特写段补；特写段的
 * 连续性丢了，「抽打」就又变回「拿着东西」了。
 */
export function planVisionRequests(overview, action, maxCalls) {
    const budget = Math.max(1, Math.floor(maxCalls));
    if (!action || action.length < 2) {
        return pickVisionFrames(overview, budget).map((frame) => ({ kind: 'single', frame }));
    }
    // 帧对预算：至少留 1 次给全片概览（起点状态是理解动作的上下文）
    const pairBudget = Math.max(1, budget - 1);
    let act = [...action];
    if (act.length > pairBudget * 2)
        act = downSample(act, pairBudget * 2); // 保首尾的等距收缩
    const requests = [];
    let i = 0;
    for (; i + 1 < act.length; i += 2) {
        requests.push({ kind: 'pair', frame: act[i], second: act[i + 1] });
    }
    // 奇数个时落单的段尾帧单独问：它是动作的终点，丢了就说不出「打没打上」
    let singles = budget - requests.length;
    if (i < act.length && singles > 0) {
        requests.push({ kind: 'single', frame: act[i] });
        singles -= 1;
    }
    // 剩余预算给概览帧（首尾优先，slice 防 max=1 时 pickVisionFrames 溢出预算）
    if (singles > 0) {
        for (const frame of pickVisionFrames(overview, singles).slice(0, singles)) {
            requests.push({ kind: 'single', frame });
        }
    }
    return requests.sort((a, b) => requestTime(a) - requestTime(b));
}
/** 注册 qq_watch_animation（依赖缺失时优雅降级，不阻断插件启动） */
export function registerWatchAnimationTool(ctx, vision, logger, deps = {}) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，qq_watch_animation 工具未注册');
        return;
    }
    // 视觉调用：显式注入优先；否则用 dsh 的 llm+attachments 造一个
    // （服务缺失时返回 null → 只出拼图和时间轴，不阻断工具）。
    // 多图调用器管「相邻帧对比」，单图路径由它退化（1 张图的 message 形状相同）；
    // 只注入单图 callVision 的场合（测试/老链路）维持单图，帧对自动降级。
    const injectedSingle = deps.callVision;
    const visionMulti = deps.callVisionMulti
        ?? (injectedSingle === undefined ? createMultiVisionCaller(ctx, vision, logger) : null);
    const visionSingle = injectedSingle
        ?? (visionMulti !== null
            ? (data, mediaType, prompt, signal) => visionMulti([{ data, mediaType }], prompt, signal)
            : null);
    const probe = deps.probe ?? probeAnimationSync;
    const extract = deps.extract ?? extractKeyFrames;
    const buildSheet = deps.buildSheet ?? buildContactSheet;
    const definition = {
        name: WATCH_ANIMATION_TOOL_NAME,
        description: DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Absolute path to a local animation (GIF/APNG/animated WebP) or short video.',
                },
                prompt: {
                    type: 'string',
                    description: 'Optional: what you care about (e.g. "这俩在干嘛", "尾巴动了吗"). '
                        + 'It is passed to the vision model to focus its per-frame reading.',
                },
            },
            required: ['path'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    path: { type: 'string' },
                    frames: { type: 'integer' },
                    duration: { type: 'number' },
                    sheet: { type: 'string' },
                    sheetPath: { type: 'string' },
                    timeline: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                t: { type: 'number' },
                                note: { type: 'string' },
                            },
                            required: ['t', 'note'],
                            additionalProperties: false,
                        },
                    },
                    error: { type: 'string' },
                },
                required: ['ok', 'path', 'frames', 'duration', 'sheet', 'sheetPath', 'timeline'],
                additionalProperties: false,
            },
            render: (_a, value) => {
                const v = value;
                if (!v.ok)
                    return [{ type: 'text', text: `看不懂这张动图：${v.error ?? '未知原因'}` }];
                const seq = renderTimeline(v.timeline);
                const head = `动图 ${v.frames} 帧`
                    + (v.duration > 0 ? ` / ${v.duration.toFixed(2)}s` : '')
                    + `；拼图：${v.sheetPath}`;
                return [{ type: 'text', text: seq === '' ? head : `${head}\n${seq}` }];
            },
        },
        async execute(args, exec) {
            const { path: inputPath, prompt } = (args ?? {});
            if (typeof inputPath !== 'string' || inputPath.length === 0) {
                throw new Error('qq_watch_animation: `path` must be a non-empty string');
            }
            const path = resolve(inputPath);
            // 先确认文件存在：这条不会白跑 ffmpeg，也给出明确错误
            const info = (() => {
                try {
                    return statSync(path);
                }
                catch {
                    return null;
                }
            })();
            if (info === null || !info.isFile()) {
                return {
                    ok: false, path, frames: 0, duration: 0, sheet: '', sheetPath: '', timeline: [],
                    error: `文件不存在：${path}`,
                };
            }
            // ── 1. 元信息 ──
            // 视频没有 GIF 帧表，probe 对 mp4 走 ffprobe 也可能读到帧数；读不到就按
            // 时间均匀抽（extractKeyFrames 内部会处理）。
            const meta = probe(path);
            const isVideo = isVideoPath(path);
            const duration = meta?.duration ?? 0;
            const totalFrames = meta?.frames ?? 0;
            if (!isVideo && meta !== null && meta.frames <= 1) {
                // 静态图被误送进来：说清楚，别让她以为工具坏了
                return {
                    ok: false, path, frames: meta.frames, duration, sheet: '', sheetPath: '', timeline: [],
                    error: '这是一张静态图（1 帧），没有动作。看内容请用 qqbot_describe_image。',
                };
            }
            // ── 2. 抽关键帧 ──
            const tmpDir = join(FRAME_TMP_ROOT, `${Date.now()}_${process.pid}_${Math.random().toString(16).slice(2, 8)}`);
            let extracted;
            try {
                mkdirSync(tmpDir, { recursive: true });
                extracted = await extract(path, tmpDir, totalFrames, duration);
            }
            catch (err) {
                await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
                return {
                    ok: false, path, frames: 0, duration, sheet: '', sheetPath: '', timeline: [],
                    error: `抽帧失败：${err instanceof Error ? err.message : String(err)}`,
                };
            }
            try {
                if (extracted.frames.length === 0) {
                    return {
                        ok: false, path, frames: totalFrames, duration, sheet: '', sheetPath: '', timeline: [],
                        error: '抽不出任何帧（文件可能损坏，或不是动图/视频）。',
                    };
                }
                // ── 3. 拼带时间戳的胶片条 ──
                // 拼图失败不算致命：时间轴文字仍然有用，所以降级成空路径继续。
                // 有动作特写段时传给拼图（双排布局），构建失败会自动退回单网格。
                let sheetPath = '';
                try {
                    mkdirSync(SHEET_ROOT, { recursive: true });
                    const built = await buildSheet(extracted.frames, join(SHEET_ROOT, sheetFileName(path)), { action: extracted.action?.frames ?? null });
                    sheetPath = built ?? '';
                }
                catch {
                    sheetPath = '';
                }
                // ── 4. 逐帧 / 逐对送视觉（调用数有硬上限）──
                // visionSingle 为 null 表示视觉服务没就绪（没开 vision / llm 不在），
                // 这时不报错，只出拼图 + 时间骨架：能看多少算多少。
                let timeline = [];
                let pairCount = 0;
                if (visionSingle !== null) {
                    const requests = planVisionRequests(extracted.frames, extracted.action?.frames ?? null, MAX_VISION_FRAMES);
                    pairCount = requests.filter((r) => r.kind === 'pair').length;
                    try {
                        timeline = await describeFramesWithVision(visionSingle, requests.map((r) => (r.kind === 'pair'
                            ? { t: r.frame.t, path: r.frame.path, second: { t: r.second.t, path: r.second.path } }
                            : { t: r.frame.t, path: r.frame.path })), prompt, exec.signal ?? new AbortController().signal, visionMulti);
                    }
                    catch (err) {
                        // 视觉挂了也别把抽帧/拼图的成果扔了 —— 至少时间轴和拼图还在
                        logger.warn(`im-qqbot: qq_watch_animation 逐帧描述失败（保留拼图）：`
                            + `${err instanceof Error ? err.message : String(err)}`);
                    }
                }
                // 没有视觉时，至少给出「帧 + 时间点」的骨架，别返回空时间轴
                if (timeline.length === 0) {
                    timeline = extracted.frames.map((f) => ({ t: f.t, note: '' }));
                }
                logger.info(`im-qqbot: qq_watch_animation ${basename(path)} — `
                    + `${formatAnimationMeta({
                        frames: extracted.totalFrames,
                        duration: extracted.duration,
                        width: meta?.width ?? 0,
                        height: meta?.height ?? 0,
                        source: meta?.source ?? 'container',
                    })}`
                    + `，抽 ${extracted.frames.length} 帧${extracted.degraded ? '（退化均匀抽帧）' : ''}`
                    + (extracted.action
                        ? `，动作段 ${extracted.action.start.toFixed(2)}-${extracted.action.end.toFixed(2)}s`
                            + ` 特写 ${extracted.action.frames.length} 帧`
                        : '')
                    + `，描述 ${timeline.filter((p) => p.note !== '').length} 段`
                    + (pairCount > 0 ? `（含 ${pairCount} 组相邻帧对）` : ''));
                return {
                    ok: true,
                    path,
                    frames: extracted.totalFrames,
                    duration: extracted.duration,
                    sheet: sheetPath,
                    sheetPath,
                    timeline,
                };
            }
            finally {
                // 抽出来的散帧是中间产物，拼图做完就可以删了（拼图里已经有了）
                await cleanupFrameDir(tmpDir);
            }
        },
    };
    tools.register(definition);
    logger.info('im-qqbot: qq_watch_animation 工具已注册');
}
//# sourceMappingURL=animation-tool.js.map