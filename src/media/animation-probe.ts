/**
 * 动图探测 — 判断一个图片附件到底是静态图还是动图，以及有多少帧/多长。
 *
 * ## 为什么需要（2026-11-12 实测）
 *
 * 用户发了一张 42 帧的 GIF，管线只给她一行 `Image: /path/x.gif`，视觉模型按单图
 * 处理 → 只取首帧 → 42 帧里丢 41 帧。她的原话："比抽帧还糙……这中间做了什么动作
 * 我全不知道。" 根因不是抽帧参数不对，是**她根本不知道收到的是动图**。
 *
 * 这个模块只做一件事：零成本地把"这是动图，42 帧 / 1.75s / 334×250"读出来。
 *
 * ## 为什么不是每次都调 ffprobe（实测数据）
 *
 * 任务书里的估计是"ffprobe 读头部是毫秒级"，实测**不是**：
 *   · `execFileSync('ffprobe', …)` 单次墙钟 **115ms**（Node 起子进程的固定开销，
 *     与文件大小无关：937KB GIF 115.2ms，首帧 PNG 111.5ms）。
 *   · 每渲染一条带图消息就同步阻塞 115ms，这是真实可感的卡顿，不是"零成本"。
 *
 * 所以按格式分流：
 *   · JPEG / BMP         → 不可能动，**直接返回 null，零 I/O 之外的成本**
 *   · GIF / APNG / WebP  → 纯 JS 走容器结构（几十微秒，且比 ffprobe 更准：
 *     帧数就是真的帧数，不需要解码）
 *   · 其它（mp4/webm…）  → 才交给 ffprobe（带 2s 超时）
 *
 * ffprobe 仍然保留：未知容器、容器解析失败、或容器里读不到时长时用它兜底。
 * **任何一步失败都返回 null（= 按静态图渲染），绝不抛异常** —— 附件处理的
 * 失败会连累整条消息，宁可退化成老格式也不能挂。
 */
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

/** 动图元信息 */
export interface AnimationMeta {
  /** 总帧数（> 1 才代表这是动图） */
  frames: number;
  /** 时长（秒）；容器里读不到时为 0（调用方应省略时长而不是显示 0.00s） */
  duration: number;
  width: number;
  height: number;
  /** 元信息来自哪里，仅用于诊断（容器解析 / ffprobe） */
  source: 'container' | 'ffprobe';
}

/** 跑一个外部命令拿 stdout；失败/超时返回 null（不抛） */
export type ProbeRunner = (bin: string, args: readonly string[]) => string | null;

/** 容器解析最多读这么大的文件（视频走 ffprobe，别把 200MB 读进内存） */
const MAX_CONTAINER_PARSE_BYTES = 32 * 1024 * 1024;

/** ffprobe 超时（同步子进程必须有上限，否则卡死整个消息处理） */
export const FFPROBE_TIMEOUT_MS = 2000;

/** 缓存条目上限（同一批消息大量渲染时别无限涨） */
const CACHE_LIMIT = 512;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  meta: AnimationMeta | null;
}

const cache = new Map<string, CacheEntry>();

/** 测试用：清空缓存 */
export function resetAnimationProbeCacheForTest(): void {
  cache.clear();
}

/**
 * 默认的 ffprobe 执行器（同步，带超时）。
 *
 * 只有走到这里才起子进程 —— 见模块头注释：常见图片格式都不会到这一步。
 */
const defaultProbeRunner: ProbeRunner = (bin, args) => {
  try {
    const out = execFileSync(bin, [...args], {
      encoding: 'utf8',
      timeout: FFPROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    });
    return typeof out === 'string' ? out : null;
  } catch {
    // 不存在 / 超时 / 坏文件 —— 全部静默降级
    return null;
  }
};

/** 用 ffprobe 读流头部（不解码），拿帧数/尺寸/时长 */
function probeWithFfprobe(path: string, run: ProbeRunner): AnimationMeta | null {
  const out = run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_frames,width,height,duration',
    '-show_entries', 'format=duration',
    '-of', 'json',
    path,
  ]);
  if (out === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }
  const obj = parsed as {
    streams?: Array<{ nb_frames?: string; width?: number; height?: number; duration?: string }>;
    format?: { duration?: string };
  };
  const stream = obj.streams?.[0];
  if (stream === undefined) return null;

  const frames = Number.parseInt(stream.nb_frames ?? '', 10);
  const width = typeof stream.width === 'number' ? stream.width : 0;
  const height = typeof stream.height === 'number' ? stream.height : 0;
  const durationRaw = Number.parseFloat(stream.duration ?? obj.format?.duration ?? '');
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 0;

  // 没有 nb_frames（部分 mp4 不写）时无法判断是不是动图 → 认输
  if (!Number.isFinite(frames) || frames <= 0) return null;
  if (width <= 0 || height <= 0) return null;

  return { frames, duration, width, height, source: 'ffprobe' };
}

/**
 * GIF 容器解析：走块结构数「图像描述符」。
 *
 * 为什么不数 GCE（0x21 0xF9）：规范里 GCE 是可选的，数它可能少数帧；
 * 数字节 0x2C 会在 LZW 数据里撞上假阳性。只有按块长跳过才是准的。
 */
function parseGif(buf: Buffer): AnimationMeta | null {
  if (buf.length < 13) return null;
  const sig = buf.subarray(0, 6).toString('latin1');
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;

  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10] as number;

  let p = 13;
  if ((packed & 0x80) !== 0) p += 3 * (1 << ((packed & 0x07) + 1));

  /** 跳过一串数据子块（长度字节 + 数据，直到长度 0）；返回是否成功走到结束符 */
  const skipSubBlocks = (): boolean => {
    while (p < buf.length) {
      const len = buf[p] as number;
      p += 1;
      if (len === 0) return true;
      p += len;
    }
    return false;
  };

  let frames = 0;
  let delayCs = 0;

  while (p < buf.length) {
    const marker = buf[p] as number;
    if (marker === 0x3b) break; // trailer
    if (marker === 0x2c) {
      // 图像描述符：left(2) top(2) w(2) h(2) packed(1) = 9 字节
      if (p + 10 > buf.length) return null;
      const ipacked = buf[p + 9] as number;
      p += 10;
      if ((ipacked & 0x80) !== 0) p += 3 * (1 << ((ipacked & 0x07) + 1));
      if (p >= buf.length) return null;
      p += 1; // LZW 最小码长
      if (!skipSubBlocks()) return null;
      frames += 1;
      continue;
    }
    if (marker === 0x21) {
      // 扩展块：0x21 + label
      if (p + 2 > buf.length) return null;
      const label = buf[p + 1] as number;
      p += 2;
      if (label === 0xf9) {
        // 图形控制扩展：blockSize(=4) packed(1) delay(2) transparentIndex(1) terminator(1)
        if (p + 1 > buf.length) return null;
        const size = buf[p] as number;
        p += 1;
        if (size >= 4 && p + 4 <= buf.length) delayCs += buf.readUInt16LE(p + 1);
        p += size;
        skipSubBlocks();
        continue;
      }
      if (label === 0xff || label === 0x01) {
        // 应用扩展(11) / 纯文本扩展(12)：固定头 + 子块
        if (p + 1 > buf.length) return null;
        const size = buf[p] as number;
        p += 1 + size;
      }
      if (!skipSubBlocks()) return null;
      continue;
    }
    // 不认识的块 —— 不猜，交回调用方走 ffprobe
    return null;
  }

  // 单帧 GIF 是静态图，不是动图 —— 这个判据必须和下面是同一处，别漏
  if (frames <= 1) return null;
  return { frames, duration: delayCs / 100, width, height, source: 'container' };
}

/** APNG 容器解析：acTL 给帧数，fcTL 累加每帧延迟 */
function parseApng(buf: Buffer): AnimationMeta | null {
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return null;

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);

  let p = 8;
  let frames = 0;
  let duration = 0;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString('latin1');
    const dataStart = p + 8;
    if (dataStart + len + 4 > buf.length + 4) return null;
    if (type === 'acTL') {
      frames = buf.readUInt32BE(dataStart);
    } else if (type === 'fcTL') {
      // seq(4) w(4) h(4) x(4) y(4) delay_num(2) delay_den(2)
      if (dataStart + 22 <= buf.length) {
        const num = buf.readUInt16BE(dataStart + 20);
        const den = buf.readUInt16BE(dataStart + 22);
        duration += num / (den === 0 ? 100 : den);
      }
    } else if (type === 'IEND') {
      break;
    }
    p = dataStart + len + 4;
  }

  if (frames <= 1) return null; // 单帧 APNG = 静态图
  return { frames, duration, width, height, source: 'container' };
}

/** WebP 容器解析：VP8X 动画标志 + ANMF 帧数 + 每帧时长 */
function parseWebp(buf: Buffer): AnimationMeta | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 4).toString('latin1') !== 'RIFF') return null;
  if (buf.subarray(8, 12).toString('latin1') !== 'WEBP') return null;

  let p = 12;
  let animated = false;
  let frames = 0;
  let durationMs = 0;
  let width = 0;
  let height = 0;

  while (p + 8 <= buf.length) {
    const fourcc = buf.subarray(p, p + 4).toString('latin1');
    const size = buf.readUInt32LE(p + 4);
    const dataStart = p + 8;
    if (dataStart + size > buf.length) break;

    if (fourcc === 'VP8X') {
      const flags = buf[dataStart] as number;
      animated = (flags & 0x02) !== 0;
      if (dataStart + 10 <= buf.length) {
        width = 1 + (buf.readUIntLE(dataStart + 4, 3));
        height = 1 + (buf.readUIntLE(dataStart + 7, 3));
      }
    } else if (fourcc === 'ANMF') {
      frames += 1;
      // x(3) y(3) w-1(3) h-1(3) duration(3) flags(1)
      if (dataStart + 15 <= buf.length) durationMs += buf.readUIntLE(dataStart + 12, 3);
    }
    p = dataStart + size + (size % 2); // RIFF 块按偶数字节对齐
  }

  if (!animated || frames <= 1) return null;
  if (width <= 0 || height <= 0) return null;
  return { frames, duration: durationMs / 1000, width, height, source: 'container' };
}

/**
 * 容器解析的三态结果。
 *
 * `static` 和 `null` 必须分开：前者是「我认出这个容器了，它确实不动」——
 * 有了这个结论就不用再花 100ms 起 ffprobe 去确认；后者是「不归我管，你去问 ffprobe」。
 * 混在一起会让每张静态 GIF 都白跑一次子进程。
 */
type ContainerResult =
  | { kind: 'animation'; meta: AnimationMeta }
  | { kind: 'static' }
  | { kind: 'unknown' };

/** 按魔数分流到对应的容器解析器 */
function parseContainer(buf: Buffer): ContainerResult {
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString('latin1');
    if (sig === 'GIF87a' || sig === 'GIF89a') {
      const meta = parseGif(buf);
      return meta === null ? { kind: 'static' } : { kind: 'animation', meta };
    }
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    const meta = parseApng(buf);
    return meta === null ? { kind: 'static' } : { kind: 'animation', meta };
  }
  if (buf.length >= 12
    && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    const meta = parseWebp(buf);
    return meta === null ? { kind: 'static' } : { kind: 'animation', meta };
  }
  return { kind: 'unknown' };
}

/** 读文件头判断是否「绝不可能动」的格式（省掉后续所有工作） */
function isDefinitelyStatic(head: Buffer): boolean {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true; // JPEG
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return true; // BMP
  return false;
}

/** 同步探测一个本地文件是不是动图；静态图/失败一律返回 null */
export function probeAnimationSync(path: string, run: ProbeRunner = defaultProbeRunner): AnimationMeta | null {
  let info: ReturnType<typeof statSync> | undefined;
  try {
    info = statSync(path);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size === 0) return null;

  const cached = cache.get(path);
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.meta;
  }

  const meta = probeUncached(path, info.size, run);

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, meta });
  return meta;
}

function probeUncached(path: string, size: number, run: ProbeRunner): AnimationMeta | null {
  // 1) 先只看文件头：JPEG/BMP 不可能动，直接收工（绝大多数头像/截图走这里）
  let head: Buffer;
  try {
    const fd = openSync(path, 'r');
    try {
      head = Buffer.alloc(Math.min(16, size));
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  if (isDefinitelyStatic(head)) return null;

  // 2) 认识的容器格式：纯 JS 解析（实测 <2ms，不动子进程）
  if (size <= MAX_CONTAINER_PARSE_BYTES) {
    try {
      const buf = head.length === size ? head : readFileSync(path);
      const fromContainer = parseContainer(buf);
      if (fromContainer.kind === 'animation') return fromContainer.meta;
      if (fromContainer.kind === 'static') return null;
    } catch {
      // 读失败/解析炸了 → 继续走 ffprobe 兜底
    }
  }

  // 3) 未知格式：才起 ffprobe（带超时，失败静默）
  const fromFfprobe = probeWithFfprobe(path, run);
  if (fromFfprobe === null) return null;
  // ffprobe 对单帧图（jpg/png）也会报 1 帧，1 帧不算动图
  return fromFfprobe.frames > 1 ? fromFfprobe : null;
}

/**
 * 把元信息渲染成给人看的一小段，如 `动图 42 帧 / 1.75s / 334×250`。
 * 时长读不到时不写 0.00s（那是假信息）。
 */
export function formatAnimationMeta(meta: AnimationMeta): string {
  const parts = [`动图 ${meta.frames} 帧`];
  if (meta.duration > 0) parts.push(`${meta.duration.toFixed(2)}s`);
  if (meta.width > 0 && meta.height > 0) parts.push(`${meta.width}×${meta.height}`);
  return parts.join(' / ');
}
