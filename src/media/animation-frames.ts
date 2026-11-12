/**
 * 动图抽帧 + 拼图（contact sheet）— qq_watch_animation 的底层实现。
 *
 * ## 选帧策略：为什么不用 `select='gt(scene,0.1)'`
 *
 * 任务书建议用场景检测 `select='gt(scene,0.1)'`，理由是「均匀抽帧会选到
 * 稀疏且可能无关的帧」。方向对，但**参数在表情包动图上完全不成立**。
 * 在真实 42 帧 GIF 上实测每个阈值抽出的帧数：
 *
 *   | 阈值 | 0.01 | 0.02 | 0.03 | 0.04 | 0.05 | 0.06 | 0.07 | 0.10 |
 *   | 帧数 |  39  |  32  |  20  |  13  |   6  |   3  |   0  |   0  |
 *
 * 全片最大 scene 分数只有 **0.069**（第 26 帧）。也就是说任务书里那个 0.1
 * 在这个文件上抽出 **0 帧**，工具会直接空手而归。
 *
 * 原因很实在：这个 GIF 是**同一场景里的细微动作**（角色趴着、尾巴晃、爱心
 * 飘过、闪光），没有镜头切换。scene 分数衡量的是「画面整体变了多少」，
 * 天然对小幅度、局部的变化不敏感 —— 而这恰好是表情包动图的全部内容。
 *
 * ## 实际做法：先拿全片分数，再按「分数」+「时间间距」双重约束挑
 *
 * `select='gte(scene,0),metadata=print'` 一次扫过拿每帧的 scene 分数和
 * pts_time（实测 42 帧 174ms，只跑一次），然后在 JS 里挑：
 *   1. 第 0 帧必选（起点）
 *   2. 按分数从高到低挑，但和已选帧保持最小时间间距（避免 3 张几乎一样的）
 *   3. 挑不够就用「等距最接近的候选」补齐（保证时间轴覆盖到片尾）
 *
 * 这样既是「按画面变化选」（分数高的优先），又是「覆盖全片」（最小间距 +
 * 等距补齐），不会像纯 scene 阈值那样要么 0 帧要么一堆。
 *
 * ## 动作特写段（2026-11-12 追加）：为什么概览帧不够
 *
 * 用户发了一张 42 帧 GIF：白龙娘用尾巴末端的鞭状物抽打蓝鱼。按上面策略出的
 * 6 帧概览，看图的人（用户和 Lead 都）把「抽打」误读成了「拿着针管」。
 * 密集帧实验证明根因：**识别「抽打」靠的不是看清鞭子（细长物体在 334×250 里
 * 只有几像素宽），而是看出它相邻帧之间的位置变化**（翘起 → 横扫 → 贴身）。
 * 单帧 + 星形打击特效 = 必然误读成静止工具。
 *
 * 所以在概览之外增加一条「动作特写」线：
 *   1. `findActionWindow`：滑动窗口（窗口 = 有效时长 × 0.45，见函数注释里的
 *      实测依据）扫全片分数，找分数和最大的连续段 —— 打击动作的所在；
 *   2. `pickActionFrames`：段内等距补抽最多 6 帧（含段首段尾）；
 *   3. 拼图改成双排：上排概览（黄色时间戳），下排特写（青色时间戳 + `[动作]`
 *      前缀 + 青色边条），两排之间有分隔。
 *
 * 窗口系数为什么不是任务书里的 1/3：真实 42 帧 GIF 实测 W=1/3 时最优窗口为
 * [0.38, 0.96]，会漏掉 1.08s 的第三个分数峰；0.45×时长时为 [0.38, 1.13]，
 * 三个峰全在段内，与人工验证过的密集帧区间（0.42–1.13s）重合。
 */
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 单帧采样（scene 扫描结果的一条） */
export interface FrameSample {
  /** 帧序号（0 起） */
  index: number;
  /** 该帧在时间轴上的位置（秒） */
  t: number;
  /** 相对上一帧的 scene 分数（0~1，越大变化越大） */
  score: number;
}

/** 动作特写段：最快变化窗口内的连续帧（暴露「相邻帧之间的位置变化」） */
export interface ActionSegment {
  /** 窗口起点（秒，锚定到实际帧） */
  start: number;
  /** 窗口终点（秒，锚定到实际帧） */
  end: number;
  /** 窗口内等距补抽的帧（时间升序，含段首段尾） */
  frames: Array<{ index: number; t: number; path: string }>;
}

/** 一次抽帧的结果 */
export interface ExtractedFrames {
  /** 抽出的帧（按时间升序） */
  frames: Array<{ index: number; t: number; path: string }>;
  /** 原动图的总帧数 */
  totalFrames: number;
  /** 时长（秒） */
  duration: number;
  /** 是否因为 scene 检测抽不出东西而退化成均匀抽帧 */
  degraded: boolean;
  /** 动作特写段（扫不出分数 / 画面几乎不动时缺省） */
  action?: ActionSegment | null;
}

/** 外部命令执行器（测试可注入，生产走 execFile） */
export type CommandRunner = (
  bin: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

/** ffmpeg 单次调用超时（同步抽帧/拼图；大视频也别无限等） */
const FFMPEG_TIMEOUT_MS = 60_000;

/** scene 扫描超时（只解码一遍，给足时间） */
const SCAN_TIMEOUT_MS = 30_000;

/** 默认 runner：execFile + 超时，失败抛错由调用方决定降级 */
export const defaultCommandRunner: CommandRunner = (bin, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      bin,
      [...args],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
      },
    );
  });

/**
 * 扫描全片每帧的 scene 分数与时间点。
 *
 * 为什么用 `metadata=print:file=-` 打到 stdout：进程 stdout 是 pipe（这个项目
 * logger 不落盘），走文件会让并发调用互相踩；stdout 是天然隔离的。
 *
 * 失败（没有 ffmpeg / 坏文件 / 超时）返回空数组，调用方退化均匀抽帧。
 */
export async function scanFrameScores(
  path: string,
  run: CommandRunner = defaultCommandRunner,
): Promise<FrameSample[]> {
  let out: string;
  try {
    out = await run(
      'ffmpeg',
      [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-i', path,
        // gte(scene,0) 让每一帧都通过（scene 分数照算），否则 select 会把
        // 「分数不够」的帧整帧丢掉，我们就没有完整的时间轴了
        '-vf', 'select=gte(scene\\,0),metadata=print:file=-',
        '-f', 'null', '-',
      ],
      SCAN_TIMEOUT_MS,
    );
  } catch {
    return [];
  }

  const samples: FrameSample[] = [];
  let pending: FrameSample | null = null;
  for (const line of out.split('\n')) {
    // `frame:0    pts:0       pts_time:0`
    const head = /^frame:(\d+)\s+pts:\S+\s+pts_time:([\d.]+)/.exec(line);
    if (head !== null) {
      if (pending !== null) samples.push(pending);
      pending = { index: Number(head[1]), t: Number(head[2]), score: 0 };
      continue;
    }
    // `lavfi.scene_score=0.061036`
    const score = /^lavfi\.scene_score=([\d.]+)/.exec(line);
    if (score !== null && pending !== null) {
      pending.score = Number(score[1]);
    }
  }
  if (pending !== null) samples.push(pending);

  // 时间必须单调（pts 乱序的文件按时间排好，后面按 t 计算间距才成立）
  return samples.filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
}

/**
 * 从全片采样里挑出关键帧（核心算法，纯函数）。
 *
 * @param samples 全片每帧的分数/时间（时间升序）
 * @param target  想要几帧
 */
export function selectKeyFrames(samples: readonly FrameSample[], target: number): FrameSample[] {
  if (samples.length === 0) return [];
  const desired = Math.max(1, Math.min(Math.floor(target), samples.length));
  if (desired === 1) return [samples[0]!];

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const span = last.t - first.t;

  // 最小间距：想让 desired 帧铺满全片，理想间距是 span/(desired-1)。
  // 乘 0.7 是留一点余地（允许比理想更密一点，否则末尾容易凑不满）。
  const minGap = span > 0 ? (span / (desired - 1)) * 0.7 : 0;

  const picked: FrameSample[] = [first];
  const isPicked = (s: FrameSample): boolean => picked.some((p) => p.index === s.index);
  const farEnough = (s: FrameSample): boolean =>
    minGap <= 0 || picked.every((p) => Math.abs(p.t - s.t) >= minGap);

  // 第一轮：分高的优先（这就是「按画面变化选」的部分）
  const byScore = [...samples].sort((a, b) => b.score - a.score || a.index - b.index);
  for (const cand of byScore) {
    if (picked.length >= desired) break;
    if (isPicked(cand)) continue;
    if (!farEnough(cand)) continue;
    picked.push(cand);
  }

  // 第二轮：分都不够分散时，按等距位置补齐（保证覆盖到片尾，不留半段空白）
  for (let i = 1; i < desired && picked.length < desired; i += 1) {
    const want = first.t + (span * i) / (desired - 1);
    const cand = samples
      .filter((s) => !isPicked(s))
      .sort((a, b) => Math.abs(a.t - want) - Math.abs(b.t - want) || a.index - b.index)[0];
    if (cand !== undefined) picked.push(cand);
  }

  return picked.sort((a, b) => a.index - b.index);
}

/**
 * 均匀抽帧的兜底：按「第 i 帧 = total*i/(target-1)」直接算帧号。
 *
 * scene 扫描失败、或扫出来但画面几乎不动（分数全是 0，挑出来会挤在开头）时用。
 */
export function uniformFrames(totalFrames: number, duration: number, target: number): FrameSample[] {
  if (totalFrames <= 0) return [];
  const desired = Math.max(1, Math.min(Math.floor(target), totalFrames));
  if (desired === 1) return [{ index: 0, t: 0, score: 0 }];
  const out: FrameSample[] = [];
  for (let i = 0; i < desired; i += 1) {
    const index = Math.round((totalFrames - 1) * (i / (desired - 1)));
    const t = totalFrames > 1 ? (duration * index) / (totalFrames - 1) : 0;
    out.push({ index, t, score: 0 });
  }
  // 去重（极短动图会算出重复帧号）
  const seen = new Set<number>();
  return out.filter((s) => (seen.has(s.index) ? false : (seen.add(s.index), true)));
}

/** 动作窗口参数：窗口 = 有效时长 × 此系数（实测依据见文件头注释） */
export const ACTION_WINDOW_RATIO = 0.45;
/** 窗口上限（秒）：长视频里「最快的一半」不该占到十几秒，压回这个量级 */
export const ACTION_WINDOW_MAX_SECONDS = 2.5;
/** 特写段补抽帧数（段内帧更多时等距降采样，更少时有多少用多少） */
export const ACTION_SEGMENT_FRAMES = 6;
/** 样本少于这个数就不找动作段（凑不出「连续变化」的证据） */
export const MIN_ACTION_SAMPLES = 4;

/** 动作窗口（时间区间，锚定到实际帧） */
export interface ActionWindow {
  start: number;
  end: number;
}

/**
 * 找全片「变化最快」的连续段（核心纯函数）：滑动窗口，窗口内分数和最大的那段。
 *
 * 分数衡量的是相邻帧的画面变化 —— 打击/挥动瞬间分数最高（实测 42 帧 GIF 的
 * 三个峰 0.0610/0.0607/0.0690 都落在鞭子抽打的 0.42–1.13s 里）。窗口和最大 =
 * 打击最密集的时间段。
 *
 * 窗口锚定到实际帧（start/end 都是某个真实帧的 t），后续补抽才能精确命中。
 * 分数全 0（画面几乎不动）时返回 null —— 没有可指认的「最快段」，别硬凑。
 */
export function findActionWindow(
  samples: readonly FrameSample[],
  duration: number,
): ActionWindow | null {
  const n = samples.length;
  if (n < MIN_ACTION_SAMPLES) return null;
  const span = samples[n - 1]!.t - samples[0]!.t;
  const effective = Math.max(duration, span);
  if (!(effective > 0)) return null;
  const window = Math.min(effective * ACTION_WINDOW_RATIO, ACTION_WINDOW_MAX_SECONDS);
  if (!(window > 0)) return null;

  // 前缀和 + 双指针：i 右移只会让 [i, j] 缩小，j 单调不减，整体 O(n)
  const prefix = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i]! + samples[i]!.score;

  let bestI = -1;
  let bestJ = -1;
  let bestSum = -1;
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    if (j < i) j = i;
    while (j + 1 < n && samples[j + 1]!.t - samples[i]!.t <= window) j += 1;
    const sum = prefix[j + 1]! - prefix[i]!;
    // 平局取最先出现的（更早的段），避免浮点抖动导致结果不稳
    if (sum > bestSum + 1e-12) {
      bestSum = sum;
      bestI = i;
      bestJ = j;
    }
  }
  if (bestI < 0 || bestSum <= 0) return null;
  return { start: samples[bestI]!.t, end: samples[bestJ]!.t };
}

/**
 * 在动作窗口内等距补抽连续帧（含段首段尾），最多 {@link ACTION_SEGMENT_FRAMES} 帧。
 *
 * 相邻两帧的间隔越近，位置变化越容易被看出来 —— 但拼图一格的宽度有限，
 * 6 帧是「连续性」和「单格可读性」的平衡点（与人工验证过的密集帧实验一致）。
 * 段内帧不足时有多少用多少，但至少 2 帧（1 帧构不成「变化」）。
 */
export function pickActionFrames(
  samples: readonly FrameSample[],
  window: ActionWindow,
  max: number = ACTION_SEGMENT_FRAMES,
): FrameSample[] {
  const eps = 1e-9;
  const inWindow = samples.filter((s) => s.t >= window.start - eps && s.t <= window.end + eps);
  if (inWindow.length < 2) return [];
  return inWindow.length <= max ? inWindow : downSample(inWindow, max);
}

/** 短动图目标帧数；长动图的在下面 */
export const SHORT_CLIP_SECONDS = 3;
export const SHORT_CLIP_FRAMES = 6;
export const LONG_CLIP_FRAMES = 9;
/** 抽不够这么多帧 → 退化成均匀抽帧 */
export const MIN_USEFUL_FRAMES = 3;
/** 帧数上限（再多视觉也看不过来，拼图也会糊） */
export const MAX_FRAMES = 9;

/** 按动图时长决定目标帧数 */
export function targetFrameCount(duration: number): number {
  return duration > 0 && duration >= SHORT_CLIP_SECONDS ? LONG_CLIP_FRAMES : SHORT_CLIP_FRAMES;
}

/** 帧的 scale 上限：单边不超过这么多像素（拼图不至于过大，视觉模型也够看） */
const FRAME_MAX_WIDTH = 480;

/** 是否是视频文件（视频走 ffmpeg 解码而不是 GIF 帧） */
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);

export function isVideoPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return VIDEO_EXT.has(path.slice(dot).toLowerCase());
}

/**
 * 抽关键帧到 outDir（PNG，文件名 f_001.png 起，按时间升序）。
 *
 * @param path      源文件
 * @param outDir    输出目录（调用方负责建/清理）
 * @param totalFrames 总帧数（probe 得来）
 * @param duration    时长（秒）
 * @param run       命令执行器
 */
export async function extractKeyFrames(
  path: string,
  outDir: string,
  totalFrames: number,
  duration: number,
  run: CommandRunner = defaultCommandRunner,
): Promise<ExtractedFrames> {
  await mkdir(outDir, { recursive: true });
  const target = targetFrameCount(duration);
  const scale = `scale='min(${FRAME_MAX_WIDTH},iw)':-2`;

  // ── 1. 先按画面变化挑帧 ──
  let picked: FrameSample[] = [];
  let samples: FrameSample[] = [];
  if (!isVideoPath(path) && totalFrames > 1) {
    samples = await scanFrameScores(path, run);
    if (samples.length > 0) {
      picked = selectKeyFrames(samples, target);
    }
  }

  // 视频没有 GIF 帧表可数：直接按时间均匀抽（video 的 scene 扫描成本高且
  // 稳定长视频的分档差异很大，均匀抽对「这视频讲什么」这种问题够用）
  if (isVideoPath(path)) {
    picked = [];
    samples = [];
  }

  let degraded = false;

  // ── 2. 抽不够 / 抽不出来 → 均匀抽帧兜底 ──
  if (picked.length < MIN_USEFUL_FRAMES) {
    degraded = true;
    // scene 分数全是 0（画面几乎不动）时，挑出来的会挤在开头；
    // GIF 有准确帧表就按帧号均匀取，视频按时间取。
    const uniform = totalFrames > 1
      ? uniformFrames(totalFrames, duration, Math.max(target, 4))
      : buildTimeUniformFrames(duration, Math.max(target, 4));
    if (uniform.length > 0) picked = uniform;
  }

  // ── 3. 太多 → 均匀降采样到上限 ──
  if (picked.length > MAX_FRAMES) {
    picked = downSample(picked, MAX_FRAMES);
  }

  if (picked.length === 0) {
    return { frames: [], totalFrames, duration, degraded };
  }

  // ── 3.5 动作特写段 ──
  // 概览帧回答「整条时间线上有什么」，但快速打击动作（鞭子/尾巴/手持工具）
  // 的证据在相邻帧的位置变化里 —— 单帧 + 打击特效必被误读成静止工具
  // （2026-11-12 实测教训，见文件头）。从同一份分数序列里找最快段补抽连续帧。
  // 退化均匀抽帧时分数序列仍然有效（它只是「挑不出高分帧」），照样找。
  let actionWindow: ActionWindow | null = null;
  let actionSamples: FrameSample[] = [];
  if (samples.length >= MIN_ACTION_SAMPLES) {
    actionWindow = findActionWindow(samples, duration);
    if (actionWindow !== null) {
      actionSamples = pickActionFrames(samples, actionWindow);
    }
  }

  // 概览 + 特写合并成一次 ffmpeg 写盘（帧号去重；同一帧可能两排都出现，
  // 磁盘上只落一份文件，两条线各自引用）
  const merged = new Map<number, FrameSample>();
  for (const p of picked) merged.set(p.index, p);
  for (const a of actionSamples) merged.set(a.index, a);
  const mergedList = [...merged.values()].sort((a, b) => a.index - b.index);

  // ── 4. 让 ffmpeg 一次性按帧号抽到磁盘 ──
  // 用 frames 模式（每张输出一张图），而不是 fps 滤镜 —— 我们要的就是
  // 「刚才挑中的那几帧」，不是另一个均匀网格。
  const files = await writeFrames(path, outDir, mergedList, scale, duration, run);
  const pathOf = new Map<number, string>();
  mergedList.forEach((m, i) => {
    const f = files[i];
    if (f !== undefined && f !== '') pathOf.set(m.index, f);
  });

  const frames = picked
    .map((p) => ({ index: p.index, t: p.t, path: pathOf.get(p.index) ?? '' }))
    .filter((f) => f.path !== '');

  const result: ExtractedFrames = { frames, totalFrames, duration, degraded };
  if (actionWindow !== null && actionSamples.length >= 2) {
    const actionFrames = actionSamples
      .map((a) => ({ index: a.index, t: a.t, path: pathOf.get(a.index) ?? '' }))
      .filter((f) => f.path !== '');
    if (actionFrames.length >= 2) {
      result.action = { start: actionWindow.start, end: actionWindow.end, frames: actionFrames };
    }
  }
  return result;
}

/** 视频/无帧表：按时间点均匀生成采样 */
function buildTimeUniformFrames(duration: number, target: number): FrameSample[] {
  if (!(duration > 0)) return [];
  const desired = Math.max(1, Math.floor(target));
  const out: FrameSample[] = [];
  for (let i = 0; i < desired; i += 1) {
    const t = desired === 1 ? 0 : (duration * i) / (desired + 1);
    out.push({ index: i, t, score: 0 });
  }
  return out;
}

/** 等间隔降采样（保留首尾） */
export function downSample<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const out: T[] = [];
  const n = max;
  for (let i = 0; i < n; i += 1) {
    out.push(items[Math.round(((items.length - 1) * i) / (n - 1))]!);
  }
  // 去重（浮点/四舍五入可能撞到同一项）
  return out.filter((x, i) => out.indexOf(x) === i);
}

/**
 * 真正把挑好的帧写到磁盘，返回按 picked 顺序排列的路径。
 *
 * 两类源分开处理：
 *   · GIF/APNG/WebP（有帧号）→ `select='eq(n,X)+eq(n,Y)...'` 精确命中
 *   · 视频（按时间）→ 每帧一次 `-ss <t>` seek（帧号在视频里没有意义）
 */
async function writeFrames(
  path: string,
  outDir: string,
  picked: readonly FrameSample[],
  scale: string,
  duration: number,
  run: CommandRunner,
): Promise<string[]> {
  const pattern = join(outDir, 'f_%03d.png');

  if (isVideoPath(path)) {
    // 视频：逐个时间点 seek 截一帧（一次 ffmpeg 多 -ss 不支持，只能循环）
    const files: string[] = [];
    for (let i = 0; i < picked.length; i += 1) {
      const t = picked[i]!.t;
      const out = join(outDir, `f_${String(i + 1).padStart(3, '0')}.png`);
      try {
        await run(
          'ffmpeg',
          [
            '-hide_banner', '-nostdin', '-loglevel', 'error',
            '-ss', t.toFixed(3),
            '-i', path,
            '-vf', scale,
            '-frames:v', '1', '-update', '1',
            out, '-y',
          ],
          FFMPEG_TIMEOUT_MS,
        );
        files.push(out);
      } catch {
        // 单帧失败就跳过（别让一帧坏掉毁掉整个工具）
      }
    }
    return files;
  }

  // GIF/PNG/WebP：一条 ffmpeg 命令按帧号全抽
  const selectExpr = picked.map((p) => `eq(n\\,${p.index})`).join('+');
  try {
    await run(
      'ffmpeg',
      [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-i', path,
        '-vf', `select=${selectExpr},${scale}`,
        '-vsync', 'vfr',
        pattern, '-y',
      ],
      FFMPEG_TIMEOUT_MS,
    );
  } catch {
    return [];
  }

  // ffmpeg 的输出序号是 1..N（按抽出的顺序），和 picked 一一对应
  const written = await readdir(outDir).catch(() => [] as string[]);
  const pngs = written.filter((f) => f.startsWith('f_') && f.endsWith('.png')).sort();
  if (pngs.length === 0) {
    // 一条命令抽不出来（比如 select 语法被拒）→ 逐个 seek 兜底
    // duration 没读到时按「帧 i 在 t 时刻」估算，只是兜底路径，不追求精确
    const files: string[] = [];
    for (let i = 0; i < picked.length; i += 1) {
      const t = picked[i]!.t > 0 ? picked[i]!.t : (duration * i) / Math.max(1, picked.length);
      const out = join(outDir, `f_${String(i + 1).padStart(3, '0')}.png`);
      try {
        await run(
          'ffmpeg',
          [
            '-hide_banner', '-nostdin', '-loglevel', 'error',
            '-ss', t.toFixed(3), '-i', path,
            '-vf', scale, '-frames:v', '1', '-update', '1',
            out, '-y',
          ],
          FFMPEG_TIMEOUT_MS,
        );
        files.push(existsSync(out) ? out : '');
      } catch {
        files.push('');
      }
    }
    return files;
  }

  return pngs.map((f) => join(outDir, f));
}

/** 拼图布局：最多 3 列（9 帧 = 3×3，6 帧 = 3×2，4 帧 = 2×2） */
export function sheetLayout(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  return { cols: 3, rows: 3 };
}

/** 可用的字体（drawtext 需要真字体文件；找不到就不标时间戳，别让整张图失败） */
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

export function findFontPath(): string | null {
  return FONT_CANDIDATES.find((f) => existsSync(f)) ?? null;
}

/**
 * 「动作」徽标（青字黑底 46×28 透明 PNG，base64 内嵌，dev 时用 PIL+Noto CJK
 * 预渲染）。为什么内嵌位图而不是 drawtext 现画：实测（2026-11-12，逐变体验证）
 * 本机 ffmpeg 6.1.1 的 drawtext 对含 CJK 的 text 有多处解析级损坏 —— 值以 CJK
 * 结尾 → 整段变豆腐块；CJK 后跟 ASCII → 中途吞字（`.`、数字、全角点都触发，
 * 转义 / expansion=none / textfile= / 换字体全部救不了）。overlay 位图完全绕开
 * 文本解析，是唯一稳定的 CJK 通道。内嵌（而不是落一个资产文件）是因为 tsc
 * 构建不带资产拷贝，base64 随源码走才不会在 lib/ 里丢文件。
 */
const ACTION_MARKER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAC4AAAAcCAYAAAAeC42RAAAEaElEQVR4nO2XfUzUdRzHX/fE/Y47Hg64A44IQmRIISOxJmigGMSoRDLNpuWkuZzG7Gk9jeqPYqVrq6lbRmut2RabrbrmVCTlIUUFChCICh9QZgjydDzf0dEfBz88ueM4xmRN39v98f18fp/v5/X9/D6/7/d7EsDI/1DS+QaYre6C327dweBBIQJbdoSjFFzPJVdI2fZKBLpApWhLSPTjnjCVu2mdJ/PXebB4iY/DnyF0MlFElIYP98UiqGQus2VtNJC3Jwa1l9y2ELmEgkNLeGFXhLvgcqeejOxgPv58sUNfwacXef/lBgCk42u3Wl1n2/7aAoqM17ncPABAelYQ+mCBQ9+0uoc9HfjBAy0cPNDicgaFwkY+apmePDlNR3SsN+/srBdtz28Pp7PDjC5QSUq6zmFc/e8mbrSP3GqWMNsD6MylVELDPZ36QyQ/240Li5fho1Xw2JIyABYu0lDSuNJlnq1ZlRz7qe1Ws/OKu9KrObUIKhnJaTo25tzLixuqAUhM8WfrS/fZPbvmmRCWpwbw5WcXRdu7n9xPY62J9AfL2PdtPN6+CjZlnJ1pesfgHkopl4YznUb90zpMQuhxAKJiNHRcH+GXw9cB0AUqGR76V3w20CDwwd4HABgbs9me3GBgVYaedStPY7WOzRTWNbjFbGVdymkAdr61kMBgJXm5k705MjLZz/46JV0dkz2oFKQMD9v8Kk8ZXxsfAqC1ZQiAyGgNewri+O6rK1SUdIpxvloFS5P87DksVmrO9cwcfGwMKkptk+7+Io7D318TxxLJZOVs4B50dpjFscpTxtCgreKBBoHIaA3PZZ7l7Y8W2RY9bKX0WIfdRwoQ/7CWH39NsrO1t40QH1w0c/AJ6YMFIqLUlBffAODN/GjUGrld9aNivKiq6LIDn2iVy80DpMWXcunvAdF/9fIg256umpLr5NF2d3p8+tNuRWoA/X2jVJ6ygdWc62HtsyHIx7dAmUxCdKwXDTUmMUatkTPQNyqOb4aeQ01f8fQ1QRz9oQ3zeE+fONKOXCFlVYaeImMbkdEaBJWMhppeMcbLR07/TeAzlV+AB8tTA6bYq053233sLsG9fRWkZurJWVuJ1t+DhEQtS5P8sJitPLHeQJGxjYzsYPpMo/zV2C/G+WoV9HZb3AaPS/ClsHjZFHti5AlaLkx5a87Bd7wRiaCSkb8/lrAFaqzWMf6o66O6optHH9cjV0hZvyUUY+E1LObJXUYXJNB03uR0Xmdys8edgxtCVbS2DFFyrIPy4kYqSjvp6bKg9fcgf38sT20KISzCk9zNV+3iwiI8OXmk3W1wN+UcPC/3PD1dU195d6eZ93bVc7w2mbPlXdRV96DWyBkcGGXFah1BIQINtb0OZpxTOQd3BD2h7a9HolRKyd38GwF6JZVXVou+5qZ+yo7fmFNKB5rdXWV3XhNFxjbxNMx+5BQabwX9Jgt11b0Ob4pnyjq58KfjrbGx1oRa4xbL7G+H86w7+D/nPOku+O3WfxA4cUAVcQNgAAAAAElFTkSuQmCC';

/**
 * 把徽标写到临时目录（每次构建唯一文件名；不主动清理，交给系统 tmp 回收）。
 * 返回 null = 写不了（罕见）→ 拼图退化为「仅色条 + 时间戳」的排标识。
 */
function writeActionMarkerPng(): string | null {
  try {
    const path = join(tmpdir(), `dsh-qqbot-action-marker-${process.pid}-${Math.random().toString(36).slice(2, 8)}.png`);
    writeFileSync(path, Buffer.from(ACTION_MARKER_PNG_BASE64, 'base64'));
    return path;
  } catch {
    return null;
  }
}

/** 拼图选项：传动作特写段（≥2 帧）→ 双排布局；构建失败自动退回单网格 */
export interface ContactSheetOptions {
  action?: ReadonlyArray<{ t: number; path: string }> | null;
}

/** 双排布局里每一排的最多格数（宽度可控：6 × 源宽 ≈ 2000px 量级） */
const SHEET_ROW_MAX = 6;
/** 两排之间的分隔条高度（上排底部补出的深色条） */
const SHEET_SEPARATOR_H = 14;
/** 动作排顶部的青色边条高度（字体缺失时也靠它区分两排） */
const SHEET_ACTION_BAND_H = 6;

/** 用 ffprobe 读一张帧图的像素尺寸（错/缺 → null，调用方退回单网格） */
async function probeImageSize(
  path: string,
  run: CommandRunner,
): Promise<{ width: number; height: number } | null> {
  try {
    const out = await run(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
      10_000,
    );
    const m = /(\d+)\D+(\d+)/.exec(out.trim());
    if (m === null) return null;
    const width = Number(m[1]);
    const height = Number(m[2]);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

/** 拼 filter_complex 并落盘（两种布局共用的收尾） */
async function renderSheet(
  inputs: readonly string[],
  chains: readonly string[],
  outPath: string,
  run: CommandRunner,
): Promise<string | null> {
  try {
    await mkdir(join(outPath, '..'), { recursive: true });
  } catch {
    // 目录已存在
  }
  try {
    await run(
      'ffmpeg',
      [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        ...inputs,
        '-filter_complex', chains.join(';'),
        '-map', '[out]', '-frames:v', '1',
        outPath, '-y',
      ],
      FFMPEG_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
  const info = await stat(outPath).catch(() => null);
  return info?.isFile() && info.size > 0 ? outPath : null;
}

/**
 * 生成带时间戳的胶片条（contact sheet）。
 *
 * 默认单网格布局（`sheetLayout`）。传入 `options.action`（动作特写段，≥2 帧）
 * 时改用双排布局：上排 = 全片概览帧（黄色时间戳），下排 = 动作段连续帧
 * （「动作」徽标 + 青色时间戳 + 排顶青色边条），两排之间有深色分隔条 ——
 * 下排让人直接看出「相邻帧之间什么在动」（见文件头「动作特写段」一节）。
 *
 * 每个格子的左上角标该帧的时间点（如 `0.42s`），让她（和视觉模型）知道先后顺序。
 * 拼图本身也是给她直接看的产物 —— 一张图上能看到动作的整条时间线。
 *
 * 没有可用字体时退化为「不标注时间戳」的拼图：信息少一点，但比失败好。
 *
 * @returns 拼图路径；失败返回 null
 */
export async function buildContactSheet(
  frames: ReadonlyArray<{ t: number; path: string }>,
  outPath: string,
  options: ContactSheetOptions = {},
  run: CommandRunner = defaultCommandRunner,
): Promise<string | null> {
  if (frames.length === 0) return null;
  const action = options.action ?? [];
  if (action.length >= 2) {
    const twoRow = await buildTwoRowSheet(frames, action, outPath, run);
    if (twoRow !== null) return twoRow;
  }
  return buildGridSheet(frames, outPath, run);
}

/** 单网格布局（原版行为：6 帧 = 3×2，9 帧 = 3×3） */
async function buildGridSheet(
  frames: ReadonlyArray<{ t: number; path: string }>,
  outPath: string,
  run: CommandRunner,
): Promise<string | null> {
  const { cols, rows } = sheetLayout(frames.length);
  const font = findFontPath();

  const inputs: string[] = [];
  for (const f of frames) inputs.push('-i', f.path);

  const chains: string[] = [];
  const labels: string[] = [];
  frames.forEach((f, i) => {
    if (font === null) {
      chains.push(`[${i}]null[v${i}]`);
    } else {
      // 时间戳：保留两位小数，统一 eif 表达式（实测 %{pts:flt} 在 gif 输入上
      // 会给出 pts 而非秒，这里直接用我们算好的 t，最可靠）
      const label = `${f.t.toFixed(2)}s`;
      chains.push(
        `[${i}]drawtext=fontfile=${font}:text='${label}':x=8:y=8:fontsize=18:`
        + `fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=5[v${i}]`,
      );
    }
    labels.push(`[v${i}]`);
  });

  // 拼网格：先每行 hstack，再各行 vstack
  const rowLabels: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    const inRow = labels.slice(r * cols, (r + 1) * cols);
    if (inRow.length === 0) continue;
    if (inRow.length === 1) {
      chains.push(`${inRow[0]}null[row${r}]`);
    } else {
      chains.push(`${inRow.join('')}hstack=inputs=${inRow.length}[row${r}]`);
    }
    rowLabels.push(`[row${r}]`);
  }
  if (rowLabels.length === 1) {
    chains.push(`${rowLabels[0]}null[out]`);
  } else {
    chains.push(`${rowLabels.join('')}vstack=inputs=${rowLabels.length}[out]`);
  }

  return renderSheet(inputs, chains, outPath, run);
}

/**
 * 双排布局：上排概览 + 分隔条 + 下排动作连续帧。
 *
 * 每格先强制归一到同一尺寸（ffprobe 首帧拿基准），因为 vstack 只看宽度 ——
 * 两排格数不同时用 pad 补齐总宽，任何一格尺寸异常也不会让整张拼图失败。
 * 动作排的可辨识度不依赖字体：动作徽标（overlay 位图）、青色时间戳、
 * 排顶的青色边条，三重标记。
 */
async function buildTwoRowSheet(
  frames: ReadonlyArray<{ t: number; path: string }>,
  action: ReadonlyArray<{ t: number; path: string }>,
  outPath: string,
  run: CommandRunner,
): Promise<string | null> {
  const top = downSample([...frames], SHEET_ROW_MAX);
  const bottom = downSample([...action], SHEET_ROW_MAX);
  if (top.length === 0 || bottom.length === 0) return null;
  const cell = await probeImageSize(top[0]!.path, run);
  if (cell === null) return null;
  const cols = Math.max(top.length, bottom.length);
  const totalW = cols * cell.width;
  const font = findFontPath();
  const marker = writeActionMarkerPng();

  const inputs: string[] = [];
  for (const f of [...top, ...bottom]) inputs.push('-i', f.path);
  if (marker !== null) inputs.push('-i', marker);
  const markerIdx = top.length + bottom.length;

  const chains: string[] = [];
  const cellScale = `scale=${cell.width}:${cell.height},setsar=1`;
  const labelBox = 'box=1:boxcolor=black@0.7:boxborderw=5';
  // ⚠️ ffmpeg drawtext 实测坑（2026-11-12，逐变体验证过）：text 的值里含 CJK 时
  // 多处解析级损坏（详见 ACTION_MARKER_PNG_BASE64 注释）。所以这里 drawtext
  // 只画纯 ASCII 时间戳，CJK 徽标走 overlay 位图。
  const tsDraw = (ts: string, color: string, x: string): string =>
    `drawtext=fontfile=${font}:text='${ts}':x=${x}:y=8:fontsize=18:fontcolor=${color}:${labelBox}`;

  const emitCell = (i: number, kind: 'overview' | 'action', t: number): void => {
    const ts = `${t.toFixed(2)}s`;
    if (kind === 'overview') {
      // 概览格：黄色时间戳（左上）；没字体就没标注
      chains.push(
        font === null
          ? `[${i}]${cellScale}[c${i}]`
          : `[${i}]${cellScale},${tsDraw(ts, 'yellow', '8')}[c${i}]`,
      );
      return;
    }
    // 动作格：动作徽标（overlay，左上）+ 青色时间戳（右上）
    const k = i - top.length;
    const base = `[${i}]${cellScale}`;
    const withMarker = marker !== null
      ? `${base}[b${i}];[b${i}][m${k}]overlay=x=8:y=8`
      : base;
    chains.push(
      font === null
        ? `${withMarker}[c${i}]`
        : `${withMarker},${tsDraw(ts, '0x00E5FF', 'w-tw-8')}[c${i}]`,
    );
  };
  top.forEach((f, i) => emitCell(i, 'overview', f.t));
  bottom.forEach((f, i) => emitCell(top.length + i, 'action', f.t));
  // 徽标一份输入复制给每个动作格（filter graph 里一条流只能被消费一次）
  if (marker !== null) {
    chains.push(
      `[${markerIdx}]split=${bottom.length}${bottom.map((_, k) => `[m${k}]`).join('')}`,
    );
  }

  // 上排：hstack 后底部补出深色分隔条 + 右侧补齐总宽
  chains.push(
    `${top.map((_, i) => `[c${i}]`).join('')}hstack=inputs=${top.length}[topRaw]`,
    `[topRaw]pad=${totalW}:ih+${SHEET_SEPARATOR_H}:0:0:0x101010[top]`,
  );
  // 下排：顶部补出青色边条（不依赖字体的排标识）+ 右侧补齐总宽
  chains.push(
    `${bottom.map((_, i) => `[c${top.length + i}]`).join('')}hstack=inputs=${bottom.length}[botRaw]`,
    `[botRaw]pad=${totalW}:ih+${SHEET_ACTION_BAND_H}:0:${SHEET_ACTION_BAND_H}:0x00E5FF[bot]`,
  );
  chains.push(`[top][bot]vstack=inputs=2[out]`);

  return renderSheet(inputs, chains, outPath, run);
}

/** 清理抽帧临时目录（失败不影响主流程） */
export async function cleanupFrameDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** 读文件字节（留给上层判断/测试用，避免重复实现） */
export async function readBytes(path: string): Promise<Buffer> {
  return readFile(path);
}
