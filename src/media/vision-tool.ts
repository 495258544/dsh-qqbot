/**
 * 内置 qqbot_describe_image 视觉工具。
 *
 * 复用 dsh 生态的 llm + attachments 服务：
 *   1. 加载图片（本地绝对路径 / http URL）→ magic bytes 嗅探 mediaType
 *   2. attachments.saveImage → ImageAttachmentRef（字节不进 session log）
 *   3. createUserMessage(ImageBlock + text) → llm.stream → BlockAssembler 收集文本
 *
 * 手写 ToolDefinition（标准 JSON Schema），避免引入 dsh-tools 的 8 个 peer 依赖。
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';
import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  ImageBlock,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { VisionConfig } from '../config.ts';
import type { Logger } from '../types.ts';

/** 通过 dsh-llm 的 ImageBlock 间接引用 dsh-attachment 类型，避免直接依赖 dsh-attachment */
type ImageAttachmentRef = ImageBlock['attachment'];
export type ImageMediaType = ImageAttachmentRef['mediaType'];

/** attachments 服务最小接口 */
export interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef>;
}

/** llm 服务最小接口 */
export interface LlmRuntimeLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

/** tools 服务最小接口 */
interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

/**
 * 裸视觉调用器：给一段图片字节 + 一句 prompt，返回模型的一段文字。
 *
 * 抽出来是为了让「调视觉模型」这件事只有一个入口 —— qq_watch_animation
 * 的逐帧描述需要同一套能力，但不经过 qqbot_describe_image 的工具外壳。
 */
export type VisionCaller = (
  data: Uint8Array,
  mediaType: ImageMediaType,
  prompt: string,
  signal: AbortSignal,
) => Promise<string>;

/** 多图调用的一张输入 */
export interface VisionImageInput {
  data: Uint8Array;
  mediaType: ImageMediaType;
}

/**
 * 多图视觉调用器：一次调用带 N 张图（相邻帧对用 N=2）。
 *
 * 「挥动/抽打」这类动作的证据是同一物体在相邻帧里的**位置变化**，单帧描述
 * 天然看不到（2026-11-12 实测：单帧 + 星形打击特效必被读成「拿着针管」）。
 * 一次调用两张图让模型自己对比，比两次单帧描述再拼文本强得多。
 */
export type MultiVisionCaller = (
  images: readonly VisionImageInput[],
  prompt: string,
  signal: AbortSignal,
) => Promise<string>;

/** qqbot_describe_image 的合法参数 */
interface DescribeImageArgs {
  image: string;
  prompt?: string;
}

/** 工具名（qqbot 前缀避免与外部 describe-image 包的同名工具冲突） */
export const DESCRIBE_IMAGE_TOOL_NAME = 'qqbot_describe_image';

const DESCRIPTION =
  'Inspect one image and return the text the user needs. The image is a local absolute path '
  + '(downloaded by the QQ bot) or an http(s) URL. Use this when the user references an image, '
  + 'or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, translation of '
  + 'image text, or photo understanding. Always pass an explicit `prompt` with a precise '
  + 'instruction (e.g. "transcribe all text", "extract the table as CSV", "translate the text '
  + 'into Chinese") instead of relying on the generic default.';

/** 图片 magic bytes 嗅探 → 标准 MIME（不信声明，安全底线） */
function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  // WEBP: 52 49 46 46 .. 57 45 42 50
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

/** 加载图片字节（本地路径 / http URL），校验大小 + 嗅探 MIME */
async function loadImageBytes(
  image: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ data: Uint8Array; mediaType: ImageMediaType }> {
  let data: Uint8Array;
  if (/^https?:\/\//i.test(image)) {
    const resp = await fetch(image, { signal, redirect: 'error' });
    if (!resp.ok) throw new Error(`qqbot_describe_image: download failed (HTTP ${resp.status})`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`qqbot_describe_image: image too large (${buf.length} bytes)`);
    data = new Uint8Array(buf);
  } else {
    const info = await stat(image).catch(() => null);
    if (!info?.isFile()) throw new Error(`qqbot_describe_image: image file not found: ${image}`);
    if (info.size > maxBytes) throw new Error(`qqbot_describe_image: image too large (${info.size} bytes)`);
    data = new Uint8Array(await readFile(image));
  }

  const mediaType = sniffImageMediaType(data);
  if (mediaType === null) throw new Error('qqbot_describe_image: unrecognized image format (png/jpeg/gif/webp only)');
  return { data, mediaType };
}

/** 将终端 finish reason 转成辅助调用失败 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new Error(finish.failure.message);
    default:
      return undefined;
  }
}

/**
 * 调视觉模型描述图片，返回纯文本。支持一次带多张图（相邻帧对比）。
 *
 * 导出给 qq_watch_animation 复用（逐帧描述走的是**同一条** llm + attachments
 * 链路，见 animation-tool.ts）—— 视觉调用只有一处实现，模型/超时/失败处理
 * 才不会两边漂移。
 */
export async function callVisionMulti(
  llm: LlmRuntimeLike,
  vision: VisionConfig,
  prompt: string,
  refs: readonly ImageAttachmentRef[],
  signal: AbortSignal,
): Promise<string> {
  // v4 producer-owned source kind（迁移器同款改写）；本地 dsh-llm 类型尚为 v3 联合，做类型桥接
  const visionSource = { kind: 'plugin:dsh-im-qqbot' } as unknown as { kind: 'plugin'; plugin: string };

  const message = createUserMessage({
    content: [
      ...refs.map((attachment) => ({ type: 'image' as const, attachment })),
      { type: 'text', text: prompt },
    ],
    source: visionSource,
  });

  const options: GenerateOptions = {
    provider: vision.provider,
    model: vision.model,
    messages: [message],
    maxTokens: vision.maxTokens,
    signal,
  };

  const assembler = new BlockAssembler();
  for await (const chunk of llm.stream(options)) {
    assembler.push(chunk);
  }
  const terminalError = finishError(assembler.finish);
  if (terminalError !== undefined) throw terminalError;

  const text = assembler.blocks()
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim();
  if (text.length === 0) throw new Error('qqbot_describe_image: vision model returned no text');
  return text;
}

/**
 * 单图版（老签名，向后兼容）：{@link callVisionMulti} 的 1 张图特例。
 */
export async function callVision(
  llm: LlmRuntimeLike,
  vision: VisionConfig,
  prompt: string,
  imageRef: ImageAttachmentRef,
  signal: AbortSignal,
): Promise<string> {
  return callVisionMulti(llm, vision, prompt, [imageRef], signal);
}

/**
 * 用 dsh 的 llm + attachments 服务造一个 {@link VisionCaller}。
 *
 * qq_watch_animation 用这个拿「能调视觉模型」的能力，而不必自己拼
 * attachments.saveImage → createUserMessage → llm.stream 那一套 —— 那条
 * 链路只有 callVision 一份实现，模型/超时/失败语义两边不会漂移。
 *
 * 服务缺失（没装 vision、llm/attachments 未就绪）返回 null：调用方据此
 * 跳过逐帧描述、只出拼图和时间轴，而不是让整个工具失败。
 */
export function createVisionCaller(
  ctx: Context,
  vision: VisionConfig,
  logger: Logger,
): VisionCaller | null {
  if (!vision.enabled) return null;
  if (!vision.provider || !vision.model) return null;

  const llm = ctx.get('llm') as LlmRuntimeLike | undefined;
  const attachments = ctx.get('attachments') as AttachmentStoreLike | undefined;
  if (!llm?.stream || !attachments?.saveImage) {
    logger.warn('im-qqbot: tools/llm/attachments 服务不可用，逐帧视觉描述已跳过');
    return null;
  }

  return async (data, mediaType, prompt, signal) => {
    const ref = await attachments.saveImage({ data, mediaType });
    return callVision(llm, vision, prompt, ref, signal);
  };
}

/**
 * 用 dsh 的 llm + attachments 服务造一个 {@link MultiVisionCaller}。
 *
 * 与 {@link createVisionCaller} 同一套服务与降级语义（缺服务返回 null），
 * 区别只在一次调用可以带多张图 —— qq_watch_animation 的相邻帧对比走这里，
 * 每张图各存一次附件，再作为一个 message 里的多个 image block 发出。
 */
export function createMultiVisionCaller(
  ctx: Context,
  vision: VisionConfig,
  logger: Logger,
): MultiVisionCaller | null {
  if (!vision.enabled) return null;
  if (!vision.provider || !vision.model) return null;

  const llm = ctx.get('llm') as LlmRuntimeLike | undefined;
  const attachments = ctx.get('attachments') as AttachmentStoreLike | undefined;
  if (!llm?.stream || !attachments?.saveImage) {
    logger.warn('im-qqbot: tools/llm/attachments 服务不可用，逐帧视觉描述已跳过');
    return null;
  }

  return async (images, prompt, signal) => {
    const refs: ImageAttachmentRef[] = [];
    for (const image of images) {
      refs.push(await attachments.saveImage({ data: image.data, mediaType: image.mediaType }));
    }
    return callVisionMulti(llm, vision, prompt, refs, signal);
  };
}

/** 展开 `~`/`~/`/`~\` 前缀 */
function expandHomePath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * 解析 DSH_HOME 的优先级与跨平台处理：
 * 显式配置 > `$DSH_HOME`（空/空白视为未设置）> `~/.dsh`，展开 `~` 后 resolve 为绝对路径。
 */
function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0
    ? fromEnv
    : join(homedir(), '.dsh');
  return resolve(expandHomePath(selected));
}

/**
 * 启动时检查 settings.yaml 里 vision 模型的 input 模态是否声明了 image。
 *
 * 模型配置界面不暴露 `input` 字段，用户通过界面配置的视觉模型默认是纯文本，
 * 会导致 pi-ai adapter 拒绝图片输入。这里在启动时兜底：未声明 image 时自动补 `[text, image]`。
 *
 * 写入遵循与 setup/persist.ts 相同的约束（该文件是宿主用户级配置，多写者共存）：
 * - 文档保真：eemeli/yaml Document API 原地编辑，注释/锚点/其他配置原样保留；
 * - 原子写：同目录临时文件 + rename，崩溃不留半份文件；
 * - 乐观校验：写入窗口内文件被外部改动则放弃本次补写（幂等，下次启动再补）；
 * - fail-closed：解析失败仅 warn 不阻断启动（视觉功能可另行手动配置）。
 * 幂等：已声明 image 则不写（不触 mtime，不引发宿主重载）。
 */
export function ensureVisionInputModal(vision: VisionConfig, logger: Logger): void {
  if (!vision.enabled || !vision.provider || !vision.model) return;

  const settingsPath = resolve(resolveDshHome(), 'settings.yaml');

  try {
    if (!existsSync(settingsPath)) return;

    // YAML 禁止 tab 缩进（配置界面/编辑器可能写入），读入时把行首 tab 规范化为空格
    const before = readFileSync(settingsPath, 'utf8');
    const normalized = before.replace(/^\t+/gm, (tabs) => '  '.repeat(tabs.length));

    // intAsBigInt：整数不经 double 中转，避免回写时把用户其他配置里的大整数
    // （安装 id、时间戳等）截断到 2^53 精度
    const doc = parseDocument(normalized, { intAsBigInt: true });
    if (doc.errors.length > 0) throw new Error(`settings.yaml 解析失败: ${doc.errors[0]?.message ?? 'unknown'}`);

    const root = doc.contents;
    if (!isMap(root)) throw new Error('settings.yaml 顶层不是映射');

    // 逐层定位 llm-pi-ai.providers.{provider}.models（原地遍历，保留原文）
    const piAi = root.get('llm-pi-ai', true);
    if (!isMap(piAi)) {
      logger.warn(`im-qqbot: settings.yaml 未找到 llm-pi-ai，请手动确认 vision 模型已声明 image 输入`);
      return;
    }
    const providers = piAi.get('providers', true);
    if (!isMap(providers)) {
      logger.warn(`im-qqbot: settings.yaml 未找到 llm-pi-ai.providers.${vision.provider}，请手动确认 vision 模型已声明 image 输入`);
      return;
    }
    const provider = providers.get(vision.provider, true);
    if (!isMap(provider)) {
      logger.warn(`im-qqbot: settings.yaml 未找到 llm-pi-ai.providers.${vision.provider}，请手动确认 vision 模型已声明 image 输入`);
      return;
    }
    const models = provider.get('models', true);
    if (!isSeq(models)) {
      logger.warn(`im-qqbot: settings.yaml 未找到 llm-pi-ai.providers.${vision.provider}.models，请手动确认 vision 模型已声明 image 输入`);
      return;
    }
    const model = models.items.find(
      (item): item is NonNullable<typeof item> => isMap(item) && isScalar(item.get('id', true)) && String(item.get('id', true)) === vision.model,
    );
    if (model === undefined || !isMap(model)) {
      logger.warn(`im-qqbot: settings.yaml 未找到 vision 模型 ${vision.model}，请手动确认已声明 image 输入`);
      return;
    }

    // 幂等：已声明 image 则不写（不触 mtime）
    const input = model.get('input', true);
    if (isSeq(input) && input.items.some((i) => isScalar(i) && i.value === 'image')) return;

    // 原地补写 input: [text, image]，其余内容（注释/锚点/格式）原样保留
    model.set('input', ['text', 'image']);
    const next = doc.toString({ lineWidth: 0 });

    // 乐观校验：写入窗口内被外部改动（宿主设置流程）则放弃，下次启动幂等重试
    if (readFileSync(settingsPath, 'utf8') !== before) {
      logger.warn('im-qqbot: settings.yaml 在写入窗口内被外部修改，跳过 vision input 补写（下次启动重试）');
      return;
    }

    // 原子写：同目录临时文件 + rename
    const tmpPath = `${settingsPath}.imqqbot.tmp`;
    try {
      writeFileSync(tmpPath, next, 'utf8');
      renameSync(tmpPath, settingsPath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* 临时文件可能不存在 */ }
      throw err;
    }
    logger.info(`im-qqbot: 已为 vision 模型补充 input: [text, image] (${vision.provider}/${vision.model})`);
  } catch (err) {
    logger.warn(`im-qqbot: 检查 settings.yaml vision input 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 注册 qqbot_describe_image 工具（服务缺失时优雅降级，不阻断插件启动） */
export function registerDescribeImageTool(ctx: Context, vision: VisionConfig, logger: Logger): void {
  if (!vision.enabled) return;
  if (!vision.provider || !vision.model) {
    logger.warn('im-qqbot: vision.provider/model 未配置，qqbot_describe_image 工具未注册');
    return;
  }

  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  const llm = ctx.get('llm') as LlmRuntimeLike | undefined;
  const attachments = ctx.get('attachments') as AttachmentStoreLike | undefined;
  if (!tools?.register || !llm?.stream || !attachments?.saveImage) {
    logger.warn('im-qqbot: tools/llm/attachments 服务不可用，qqbot_describe_image 工具未注册');
    return;
  }

  const definition = {
    name: DESCRIBE_IMAGE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Absolute path to a local image file, or an http(s) URL of the image.',
        },
        prompt: {
          type: 'string',
          description: 'Your precise instruction for the vision model about this image.',
        },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          model: { type: 'string' },
          image: { type: 'string' },
          mimeType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
          bytes: { type: 'integer' },
        },
        required: ['text', 'model', 'image', 'mimeType', 'bytes'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args: unknown, exec: { signal: AbortSignal }): Promise<Record<string, unknown>> {
      const { image, prompt } = args as DescribeImageArgs;
      if (typeof image !== 'string' || image.length === 0) {
        throw new Error('qqbot_describe_image: `image` must be a non-empty string');
      }

      const loaded = await loadImageBytes(image, vision.maxBytes, exec.signal);
      const ref = await attachments.saveImage({
        data: loaded.data,
        mediaType: loaded.mediaType,
        name: /^https?:\/\//i.test(image) ? undefined : basename(image),
      });
      const text = await callVision(llm, vision, prompt ?? vision.defaultPrompt, ref, exec.signal);
      return { text, model: vision.model, image, mimeType: loaded.mediaType, bytes: loaded.data.length };
    },
  };

  tools.register(definition);
  logger.info(`im-qqbot: qqbot_describe_image 工具已注册 (provider=${vision.provider} model=${vision.model})`);
}

/**
 * 逐帧描述一张动图的关键帧，拼成动作序列。
 *
 * 抽帧/拼图在 `animation-frames.ts`（qq_watch_animation 用），这里只管「把 N
 * 个画面问一遍视觉模型」。抽出来是为了让视觉调用只有一处实现 —— 和
 * qqbot_describe_image 走完全相同的 llm + attachments 链路。
 *
 * ## 为什么要送「相邻帧对」而不是全部单帧
 *
 * 单帧描述拿到的是"这一帧画面里有什么"——但鞭子、尾巴这类细长物体只有几像素
 * 宽，单帧 + 打击特效会被读成"拿着针管/工具"（2026-11-12 实测误读）。动作的
 * 证据是**相邻帧之间的位置变化**，只有把两帧放进同一次调用让模型对比才成立。
 * 所以带 `second` 的帧走多图调用（问"两帧之间发生了什么变化"），离散的概览帧
 * 维持单帧描述。
 *
 * ## 为什么不全送、也不是把拼图整张丢进去问一次
 *
 * 拼图整张问一次确实更省：一次调用。但实测下来它会**按格子念图**（"第一格
 * 如图，第二格如图……"），而且小格子里的细节（眨眼、尾巴角度）在那个缩放比下
 * 已经糊了。逐帧/逐对问拿到的是局部、可拼的时间线。
 *
 * 代价是 N 次调用，所以调用方的总调用数有上限（animation-tool.ts 的
 * planVisionRequests / MAX_VISION_FRAMES）—— 不是每帧都问。
 *
 * @param call   单图调用器（概览帧、以及 multi 缺失时帧对的退化路径）
 * @param frames 待描述的画面；`second` 存在表示相邻帧对
 * @param focus  调用方想关注的点（可选），会拼进每帧的 prompt
 * @param multi  多图调用器（可选）：帧对优先走它；缺省时帧对退化为两次单帧
 *               描述再拼接 —— 多一道拼缝，但时间轴不至于缺一段
 */
export async function describeFramesWithVision(
  call: VisionCaller,
  frames: ReadonlyArray<FrameDescribeRequest>,
  focus: string | undefined,
  signal: AbortSignal,
  multi?: MultiVisionCaller | null,
): Promise<Array<{ t: number; note: string }>> {
  const out: Array<{ t: number; note: string }> = [];
  for (const frame of frames) {
    // ── 相邻帧对：一次调用两张图，问「变化」──
    const { second } = frame;
    if (second !== undefined) {
      const pair = await describeImagePair(call, { ...frame, second }, focus, signal, multi);
      if (pair !== null) out.push({ t: frame.t, note: pair.replace(/\s+/g, ' ').trim() });
      continue;
    }

    // ── 单帧（概览帧 / 原路径，行为不变）──
    const bytes = await readFile(frame.path).catch(() => null);
    if (bytes === null) continue;
    const data = new Uint8Array(bytes);
    const mediaType = sniffImageMediaType(data);
    if (mediaType === null) continue;

    const ask = singleFrameAsk(frame.t, focus);
    try {
      const note = await call(data, mediaType, ask, signal);
      out.push({ t: frame.t, note: note.replace(/\s+/g, ' ').trim() });
    } catch {
      // 单帧失败跳过（别让一帧坏掉毁掉整条时间轴）
    }
  }
  return out;
}

/** 一次视觉描述的输入：单帧，或带 `second` 的相邻帧对 */
export interface FrameDescribeRequest {
  /** 帧的时间点（秒）；帧对时取较早一帧 */
  t: number;
  /** 帧图路径 */
  path: string;
  /** 相邻的第二帧（存在 → 两帧一组送视觉） */
  second?: { t: number; path: string };
}

/** 单帧动作引导（细长物体的位置 + 打击特效的语义），per-frame prompt 都带 */
const MOTION_HINT =
  '注意画面中的细长物体（鞭子、尾巴、触手、手持工具）的位置——'
  + '星形/闪光特效通常标记打击、碰撞或强调的瞬间。';

/** 单帧 prompt（保持「正在发生什么」的问法，逼它说动作而不是罗列物体） */
function singleFrameAsk(t: number, focus: string | undefined): string {
  const focusPart = focus !== undefined && focus.trim() !== '' ? `${focus.trim()}。` : '';
  return `这是动图的一个画面（第 ${t.toFixed(2)} 秒）。${focusPart}`
    + '只回答这一帧里「正在发生什么 / 和前后比变了什么」，一句话，不要罗列画面元素。'
    + MOTION_HINT;
}

/** 帧对 prompt：明确要求对比两帧，从位置变化里读出动作方向 */
function framePairAsk(t1: number, t2: number, focus: string | undefined): string {
  const focusPart = focus !== undefined && focus.trim() !== '' ? `${focus.trim()}。` : '';
  return `这是动图里时间上相邻的两帧（第 ${t1.toFixed(2)} 秒 → 第 ${t2.toFixed(2)} 秒）。${focusPart}`
    + '对比两帧：细长物体（鞭子、尾巴、触手、手持工具）的位置变化就是动作本身——'
    + '它的移动方向就是动作方向；星形/闪光特效通常标记打击、碰撞或强调的瞬间。'
    + '只回答这两帧之间发生了什么变化（什么在动、朝哪个方向、有没有打到或碰到什么），'
    + '一两句话，不要罗列画面元素。';
}

/** 描述一对相邻帧；multi 缺失时退化为两次单帧描述拼接。失败返回 null */
async function describeImagePair(
  call: VisionCaller,
  frame: FrameDescribeRequest & { second: { t: number; path: string } },
  focus: string | undefined,
  signal: AbortSignal,
  multi?: MultiVisionCaller | null,
): Promise<string | null> {
  const both = [frame, frame.second];
  const loaded: Array<{ data: Uint8Array; mediaType: ImageMediaType } | null> = [];
  for (const f of both) {
    const bytes = await readFile(f.path).catch(() => null);
    if (bytes === null) { loaded.push(null); continue; }
    const data = new Uint8Array(bytes);
    const mediaType = sniffImageMediaType(data);
    loaded.push(mediaType === null ? null : { data, mediaType });
  }
  // 两帧有一帧读不到 → 至少把读得到的那帧按单帧问，别整段丢
  if (loaded.some((l) => l === null)) {
    const notes: string[] = [];
    for (let i = 0; i < both.length; i += 1) {
      const img = loaded[i] ?? null;
      if (img === null) continue;
      try {
        notes.push(await call(img.data, img.mediaType, singleFrameAsk(both[i]!.t, focus), signal));
      } catch {
        // 单帧失败跳过
      }
    }
    return notes.length > 0 ? notes.join('；') : null;
  }

  const imgs = loaded.filter((l): l is { data: Uint8Array; mediaType: ImageMediaType } => l !== null);
  const ask = framePairAsk(frame.t, frame.second.t, focus);

  if (multi !== undefined && multi !== null) {
    try {
      return await multi(imgs, ask, signal);
    } catch {
      return null; // 帧对失败跳过（别让一段坏掉毁掉整条时间轴）
    }
  }
  // 只有单图调用器（测试注入 / 老链路）：两帧各按单帧问法问一次再拼 ——
  // 「对比两帧」的问法只给一张图会让模型困惑，退化时必须换回单帧问法
  const notes: string[] = [];
  for (let i = 0; i < imgs.length; i += 1) {
    try {
      notes.push(await call(imgs[i]!.data, imgs[i]!.mediaType, singleFrameAsk(both[i]!.t, focus), signal));
    } catch {
      // 单帧失败跳过
    }
  }
  return notes.length > 0 ? notes.join('；') : null;
}
