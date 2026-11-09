/**
 * GIF 动图 → 抽帧拼成一张 PNG 联系表，再交给视觉模型。
 *
 * 为什么要自己解码：chat-completions 的图片通道只吃静态栅格图。把 .gif 整份塞进去，
 * 模型通常只拿得到第一帧，于是"在动什么"全靠脑补。
 * 2026-11-09 群里实锤：一张 62 帧女仆动图被描述成「挥手送别」；改成 4 帧均匀采样后
 * 又因 [0,20,41,61] 全落在举手相位（相位共振）仍判挥手，最终定为
 * 6 帧均匀基线 + 2 帧帧间差分峰值补空隙 + 网格排版。
 *
 * 第三轮（同日 17:10，新方案上线后的真实群聊）：37 帧课堂动图的抽帧链路完全正常，
 * f31（露出隔壁手机）也被差分补帧选中，但视觉模型仍把角色硬认成「希儿/布洛妮娅」、
 * 把手机当成文具盒、把整段编成「翻书」。复盘会话日志：主模型自己在 prompt 里索取
 * 「画的是什么角色」，而护栏拼在其后且只禁「挥手/拍打」（上一张图的特化）。
 * 结论：抽帧解决"看不到"，解决不了"看错"；通用护栏必须前置并禁止猜身份。
 *
 * 纯 JS + node:zlib，不引原生图像依赖：宿主 asar 与插件 node_modules 都没有 GIF 解码器，
 * Python/ffmpeg 也不保证在插件进程里可用。任何解析失败一律返回 null，调用方回退原图。
 */
import { deflateSync } from 'node:zlib';

/** 默认送进模型的总帧数（含首、末） */
export const GIF_SAMPLE_COUNT = 8;
/** 其中按时间均匀取的基线帧数，保证短暂动作区间至少被覆盖到 */
export const GIF_UNIFORM_COUNT = 6;
/** 拼图最大宽/高：超了会被模型整体降采样到看不清，故改网格排版 */
export const GIF_SHEET_MAX_WIDTH = 1200;
export const GIF_SHEET_MAX_HEIGHT = 1200;
/** 格间灰条宽度 */
const SHEET_GAP = 6;
/** 缩放不低于该比例即视为「几乎不缩放」，选列时优先保住单帧原始尺寸 */
const NEAR_NATIVE_SCALE = 0.95;
/** GIF delay <= 2/100s 时，浏览器惯例按 100ms 处理 */
const DEFAULT_FRAME_DELAY = 0.1;
/** 帧数与画布上限，防止超大动图把内存吃满（超限直接回退） */
const MAX_FRAMES = 240;
const MAX_PIXELS = 4_000_000;

export interface GifFrameSheet {
  /** PNG 字节（拼好的联系表） */
  data: Uint8Array;
  /** 动图总帧数 */
  totalFrames: number;
  /** 实际抽到的帧序号（0-based，按时间顺序） */
  sampledFrames: number[];
  /** 各抽样帧在原动图里的时刻（秒）；可用时 prompt 会带上，便于判断短暂动作 */
  sampledTimes?: number[];
  /** 动图总时长（秒，各帧 delay 之和，异常值已兜底） */
  durationSeconds: number;
  /** 拼图每行放几帧（prompt 要靠它说明阅读顺序） */
  columns: number;
  width: number;
  height: number;
}

/** 顺序读字节，越界即抛（调用方转成 null 回退） */
class Reader {
  private p = 0;
  constructor(private readonly b: Uint8Array) {}
  get pos(): number { return this.p; }
  u8(): number {
    if (this.p >= this.b.length) throw new Error('truncated gif');
    return this.b[this.p++]!;
  }
  u16(): number {
    const lo = this.u8();
    return lo | (this.u8() << 8);
  }
  take(n: number): Uint8Array {
    if (n < 0 || this.p + n > this.b.length) throw new Error('truncated gif');
    const out = this.b.slice(this.p, this.p + n);
    this.p += n;
    return out;
  }
}

/** GIF 的「一堆子块」拼成连续字节，读到长度 0 结束 */
function readSubBlocks(r: Reader): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const n = r.u8();
    if (n === 0) break;
    const part = r.take(n);
    parts.push(part);
    total += part.length;
  }
  return concatBytes(parts, total);
}

function concatBytes(parts: Uint8Array[], total?: number): Uint8Array {
  const size = total ?? parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

interface GifFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  interlaced: boolean;
  colorTable: Uint8Array;
  minCodeSize: number;
  lzw: Uint8Array;
  disposal: number;
  transparentIndex: number | null;
  /** 该帧停留时长（秒），来自 GCE；用来在 prompt 里给每帧标时间位置 */
  delay: number;
}

interface ParsedGif {
  width: number;
  height: number;
  frames: GifFrame[];
  /** 逻辑屏幕背景色（GCT 里的 background index）；disposal=2 时用来恢复 */
  backgroundColor: [number, number, number] | null;
  backgroundIndex: number;
}

/** 只解析结构，不解码像素 —— 用来先知道总帧数，避免为每一帧都留一份画布快照 */
function parseGif(data: Uint8Array): ParsedGif {
  const r = new Reader(data);
  const header = String.fromCharCode(...r.take(6));
  if (header !== 'GIF87a' && header !== 'GIF89a') throw new Error('not a gif');

  const width = r.u16();
  const height = r.u16();
  if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) throw new Error('gif canvas too large');
  const packed = r.u8();
  const backgroundIndex = r.u8();
  r.u8(); // pixel aspect ratio
  let gct: Uint8Array = new Uint8Array(0);
  if ((packed & 0x80) !== 0) gct = r.take(3 * (2 << (packed & 0x07)));
  const bg = backgroundIndex * 3;
  const backgroundColor: [number, number, number] | null = bg + 2 < gct.length
    ? [gct[bg] ?? 0, gct[bg + 1] ?? 0, gct[bg + 2] ?? 0]
    : null;

  let gceDisposal = 0;
  let gceTransparent: number | null = null;
  let gceDelay = 0;
  const frames: GifFrame[] = [];

  while (r.pos < data.length) {
    const marker = r.u8();
    if (marker === 0x3b) break; // trailer
    if (marker === 0x21) {
      const label = r.u8();
      if (label === 0xf9) {
        const size = r.u8();
        const gce = r.take(size);
        const flags = gce[0] ?? 0;
        gceDisposal = (flags >> 2) & 0x07;
        gceTransparent = (flags & 0x01) !== 0 ? (gce[3] ?? 0) : null;
        // GCE delay 单位 1/100 秒；异常值（0 或超大）交调用方兜底
        gceDelay = ((gce[1] ?? 0) | ((gce[2] ?? 0) << 8)) / 100;
        r.u8(); // block terminator
      } else {
        readSubBlocks(r); // application / comment / plain text
      }
      continue;
    }
    if (marker === 0x2c) {
      const left = r.u16();
      const top = r.u16();
      const w = r.u16();
      const h = r.u16();
      const localPacked = r.u8();
      const localTable = (localPacked & 0x80) !== 0
        ? r.take(3 * (2 << (localPacked & 0x07)))
        : gct;
      const minCodeSize = r.u8();
      const lzw = readSubBlocks(r);
      frames.push({
        left,
        top,
        width: w,
        height: h,
        interlaced: (localPacked & 0x40) !== 0,
        colorTable: localTable,
        minCodeSize,
        lzw,
        disposal: gceDisposal,
        transparentIndex: gceTransparent,
        delay: gceDelay,
      });
      gceDisposal = 0;
      gceTransparent = null;
      gceDelay = 0;
      if (frames.length > MAX_FRAMES) throw new Error('too many gif frames');
      continue;
    }
    // 不认识的块：不猜，直接放弃
    throw new Error(`unexpected gif block 0x${marker.toString(16)}`);
  }
  if (frames.length === 0) throw new Error('gif has no frames');
  return { width, height, frames, backgroundColor, backgroundIndex };
}

/** GIF 变长 LZW 解码（LSB-first 码流），返回索引色数组 */
function decodeLzw(lzw: Uint8Array, minCodeSize: number, expected: number): Uint8Array {
  if (minCodeSize < 2 || minCodeSize > 8) throw new Error('bad lzw min code size');
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out = new Uint8Array(expected);
  let outPos = 0;
  let bitPos = 0;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict: Array<Uint8Array | undefined> = new Array<Uint8Array | undefined>(4096);
  let prev: Uint8Array | null = null;

  const resetDict = (): void => {
    dict = new Array<Uint8Array | undefined>(4096);
    for (let i = 0; i < clear; i += 1) dict[i] = Uint8Array.of(i);
    codeSize = minCodeSize + 1;
    next = eoi + 1;
    prev = null;
  };
  resetDict();

  const readCode = (): number => {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const byte = lzw[bitPos >> 3];
      if (byte === undefined) return eoi; // 截断就当结束，能保住已解出的部分
      code |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos += 1;
    }
    return code;
  };

  for (;;) {
    const code = readCode();
    if (code === eoi) break;
    if (code === clear) {
      resetDict();
      continue;
    }
    let entry: Uint8Array | undefined;
    if (code < next) entry = dict[code];
    else if (code === next && prev !== null) {
      entry = new Uint8Array(prev.length + 1);
      entry.set(prev);
      entry[prev.length] = prev[0] ?? 0;
    }
    if (entry === undefined || entry.length === 0) break;
    for (let i = 0; i < entry.length && outPos < expected; i += 1) out[outPos++] = entry[i]!;
    if (prev !== null && next < 4096) {
      const added = new Uint8Array(prev.length + 1);
      added.set(prev);
      added[prev.length] = entry[0] ?? 0;
      dict[next++] = added;
      if (next === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    prev = entry;
  }
  return out.subarray(0, outPos);
}

/** 交织 GIF 的行顺序还原成自上而下 */
function deinterlace(indices: Uint8Array, w: number, h: number): Uint8Array {
  const rowOrder: number[] = [];
  for (let y = 0; y < h; y += 8) rowOrder.push(y);
  for (let y = 4; y < h; y += 8) rowOrder.push(y);
  for (let y = 2; y < h; y += 4) rowOrder.push(y);
  for (let y = 1; y < h; y += 2) rowOrder.push(y);
  const out = new Uint8Array(w * h);
  for (let sy = 0; sy < h; sy += 1) {
    const dy = rowOrder[sy] ?? sy;
    const row = indices.subarray(sy * w, sy * w + w);
    if (dy * w + row.length <= out.length) out.set(row, dy * w);
  }
  return out;
}

/** 均匀抽样，必定含首帧与末帧 */
export function sampleFrameIndices(total: number, count: number): number[] {
  if (total <= 1) return [0];
  const n = Math.max(2, Math.min(count, total));
  const out: number[] = [0];
  for (let k = 1; k < n - 1; k += 1) out.push(Math.round(((total - 1) * k) / (n - 1)));
  out.push(total - 1);
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * 选帧：均匀基线（含首末）+ 帧间变化峰值补空隙。
 *
 * 差分只作辅助：峰值周期性出现，单独按峰值选会让采样点全挤在动作切换点上、丢掉
 * 时间覆盖；实测配均匀基线后能补进 f3/f15 这类短暂动作帧，打破采样相位共振。
 * minSpacing 保证补帧既不贴着已有采样点，也不互相扎堆；候选不够时退回均匀补齐。
 */
export function selectSampledFrames(total: number, diffs: number[], count: number): number[] {
  if (total <= 1) return [0];
  const n = Math.max(2, Math.min(count, total));
  const uniformCount = Math.min(GIF_UNIFORM_COUNT, n);
  const chosen = [...sampleFrameIndices(total, uniformCount)];
  const minSpacing = Math.max(2, Math.floor(total / (n * 2)));
  const candidates = diffs
    .map((value, index) => ({ index, value }))
    .filter(({ index }) => index > 0 && index < total - 1)
    .sort((a, b) => b.value - a.value || a.index - b.index);
  for (const { index } of candidates) {
    if (chosen.length >= n) break;
    if (chosen.some((s) => Math.abs(s - index) < minSpacing)) continue;
    chosen.push(index);
  }
  if (chosen.length < n) {
    for (const index of sampleFrameIndices(total, n)) {
      if (chosen.length >= n) break;
      if (!chosen.includes(index)) chosen.push(index);
    }
  }
  return [...new Set(chosen)].sort((a, b) => a - b);
}

/**
 * disposal=2：把上一帧的矩形恢复成逻辑屏幕背景色。
 * 之前一律清成透明、再由拼图合成浅灰底，遇到非灰背景的局部刷新动图会露馅；
 * 若该帧的透明色索引正好等于背景色索引，则按规范语义恢复成透明。
 */
function restoreBackground(
  canvas: Uint8Array,
  canvasW: number,
  canvasH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  background: [number, number, number] | null,
  transparent: boolean,
): void {
  const x0 = Math.max(0, Math.min(canvasW, x));
  const y0 = Math.max(0, Math.min(canvasH, y));
  const x1 = Math.max(0, Math.min(canvasW, x + w));
  const y1 = Math.max(0, Math.min(canvasH, y + h));
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      const p = (yy * canvasW + xx) * 4;
      if (transparent || background === null) {
        canvas[p] = 0;
        canvas[p + 1] = 0;
        canvas[p + 2] = 0;
        canvas[p + 3] = 0;
      } else {
        canvas[p] = background[0];
        canvas[p + 1] = background[1];
        canvas[p + 2] = background[2];
        canvas[p + 3] = 255;
      }
    }
  }
}

/** 两张 RGBA 画布的平均绝对差（每 4 个像素取 1 个，够用且省 CPU） */
function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let p = 0; p + 2 < a.length && p + 2 < b.length; p += 16) {
    sum += Math.abs((a[p] ?? 0) - (b[p] ?? 0))
      + Math.abs((a[p + 1] ?? 0) - (b[p + 1] ?? 0))
      + Math.abs((a[p + 2] ?? 0) - (b[p + 2] ?? 0));
    n += 3;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * 逐帧合成一遍。传 diffs 时只算帧间差异（不存快照）；传 sampled 时只留选中帧的
 * 完整画布。分两遍跑：选帧依赖 diffs，而把每一帧的完整快照都留着会吃内存。
 */
function composeFrames(gif: ParsedGif, sampled: number[], diffs?: number[]): Uint8Array[] {
  const { width, height, frames } = gif;
  const canvas = new Uint8Array(width * height * 4);
  const snapshots: Uint8Array[] = [];
  let restore: Uint8Array | null = null;
  let prevAfter: Uint8Array | null = null;
  const sampleSet = new Set(sampled);

  for (let i = 0; i < frames.length; i += 1) {
    const prevFrame = i > 0 ? frames[i - 1] : undefined;
    if (prevFrame?.disposal === 3 && restore !== null) {
      canvas.set(restore);
    } else if (prevFrame?.disposal === 2) {
      restoreBackground(
        canvas, width, height,
        prevFrame.left, prevFrame.top, prevFrame.width, prevFrame.height,
        gif.backgroundColor,
        prevFrame.transparentIndex !== null && prevFrame.transparentIndex === gif.backgroundIndex,
      );
    }

    const before = canvas.slice();
    const frame = frames[i]!;
    const expected = frame.width * frame.height;
    let indices = decodeLzw(frame.lzw, frame.minCodeSize, expected);
    if (indices.length < expected) {
      const padded = new Uint8Array(expected);
      padded.set(indices);
      indices = padded;
    }
    if (frame.interlaced) indices = deinterlace(indices, frame.width, frame.height);

    const table = frame.colorTable;
    for (let y = 0; y < frame.height; y += 1) {
      const cy = frame.top + y;
      if (cy < 0 || cy >= height) continue;
      for (let x = 0; x < frame.width; x += 1) {
        const cx = frame.left + x;
        if (cx < 0 || cx >= width) continue;
        const idx = indices[y * frame.width + x]!;
        if (frame.transparentIndex !== null && idx === frame.transparentIndex) continue;
        const c = idx * 3;
        const p = (cy * width + cx) * 4;
        canvas[p] = table[c] ?? 0;
        canvas[p + 1] = table[c + 1] ?? 0;
        canvas[p + 2] = table[c + 2] ?? 0;
        canvas[p + 3] = 255;
      }
    }

    if (sampleSet.has(i)) snapshots.push(canvas.slice());
    if (diffs !== undefined) {
      const after = canvas.slice();
      diffs.push(prevAfter === null ? 0 : meanAbsDiff(prevAfter, after));
      prevAfter = after;
    }
    restore = before;
  }
  return snapshots;
}

/**
 * 选列优先级：几乎不缩放 → 空格最少 → 拼图接近方形 → 缩放后单格最大；平分取更宽。
 *
 * 旧逻辑按 maxWidth 硬算 maxCols，8 帧 300px 宽只能排 3 列 × 3 行，右下留 1 个空格，
 * 模型容易把空格当成第 9 帧；改 4 列 × 2 行只需缩小 1.5%，既无空格也几乎不掉细节。
 * 反过来，4 帧 8px 的小图在 maxHeight=10 时选 4 列 × 1 行即可完全避开整体缩放。
 */
export function chooseSheetColumns(
  count: number,
  frameW: number,
  frameH: number,
  maxWidth: number,
  maxHeight: number,
): number {
  let best = 1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const sheetW = cols * frameW + (cols - 1) * SHEET_GAP;
    const sheetH = rows * frameH + (rows - 1) * SHEET_GAP;
    const scale = Math.min(1, maxWidth / sheetW, maxHeight / sheetH);
    const nearNative = scale >= NEAR_NATIVE_SCALE ? 1 : 0;
    const empty = rows * cols - count;
    const squareness = Math.min(sheetW, sheetH) / Math.max(sheetW, sheetH);
    const score = (nearNative * 100 - empty) * 100 + squareness * 10 + scale * scale;
    if (score >= bestScore) {
      bestScore = score;
      best = cols;
    }
  }
  return best;
}

/** 抽样帧按网格拼成 RGB 位图，格间留灰条，透明合成到浅灰底 */
function composeSheet(
  snapshots: Uint8Array[],
  frameW: number,
  frameH: number,
  maxWidth: number,
  maxHeight: number,
): { rgb: Uint8Array; width: number; height: number; columns: number } {
  const columns = chooseSheetColumns(snapshots.length, frameW, frameH, maxWidth, maxHeight);
  const rows = Math.ceil(snapshots.length / columns);
  const sheetW = columns * frameW + (columns - 1) * SHEET_GAP;
  const sheetH = rows * frameH + (rows - 1) * SHEET_GAP;
  const rgb = new Uint8Array(sheetW * sheetH * 3);
  rgb.fill(0xf2);

  for (let k = 0; k < snapshots.length; k += 1) {
    const snap = snapshots[k]!;
    const offsetX = (k % columns) * (frameW + SHEET_GAP);
    const offsetY = Math.floor(k / columns) * (frameH + SHEET_GAP);
    for (let y = 0; y < frameH; y += 1) {
      for (let x = 0; x < frameW; x += 1) {
        const s = (y * frameW + x) * 4;
        const a = snap[s + 3] ?? 0;
        const d = ((offsetY + y) * sheetW + offsetX + x) * 3;
        if (a === 0) continue; // 底色已是浅灰
        if (a === 255) {
          rgb[d] = snap[s] ?? 0;
          rgb[d + 1] = snap[s + 1] ?? 0;
          rgb[d + 2] = snap[s + 2] ?? 0;
        } else {
          const t = a / 255;
          rgb[d] = Math.round((snap[s] ?? 0) * t + 0xf2 * (1 - t));
          rgb[d + 1] = Math.round((snap[s + 1] ?? 0) * t + 0xf2 * (1 - t));
          rgb[d + 2] = Math.round((snap[s + 2] ?? 0) * t + 0xf2 * (1 - t));
        }
      }
    }
  }
  return { rgb, width: sheetW, height: sheetH, columns };
}

/** 最近邻等比缩小，保证拼图宽高都不超过模型能看清的范围 */
function downscale(
  rgb: Uint8Array,
  w: number,
  h: number,
  maxWidth: number,
  maxHeight: number,
): { rgb: Uint8Array; width: number; height: number } {
  const scale = Math.min(1, maxWidth / w, maxHeight / h);
  if (scale >= 1) return { rgb, width: w, height: h };
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(nw * nh * 3);
  for (let y = 0; y < nh; y += 1) {
    const sy = Math.min(h - 1, Math.floor((y * h) / nh));
    for (let x = 0; x < nw; x += 1) {
      const sx = Math.min(w - 1, Math.floor((x * w) / nw));
      const s = (sy * w + sx) * 3;
      const d = (y * nw + x) * 3;
      out[d] = rgb[s] ?? 0;
      out[d + 1] = rgb[s + 1] ?? 0;
      out[d + 2] = rgb[s + 2] ?? 0;
    }
  }
  return { rgb: out, width: nw, height: nh };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGB 位图 → PNG（8bit, colorType=2, 每行 filter=0） */
function encodePng(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), rowStart + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return concatBytes([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * 动图 → 抽帧 PNG 联系表。单帧 GIF / 解析失败 / 超上限时返回 null（调用方按静态图处理）。
 */
export function gifToContactSheet(
  data: Uint8Array,
  options: { samples?: number; maxWidth?: number; maxHeight?: number } = {},
): GifFrameSheet | null {
  try {
    const gif = parseGif(data);
    if (gif.frames.length < 2) return null;
    const maxWidth = options.maxWidth ?? GIF_SHEET_MAX_WIDTH;
    const maxHeight = options.maxHeight ?? GIF_SHEET_MAX_HEIGHT;
    // 第一遍只算帧间差异，第二遍才留完整快照，避免把全帧画布都堆在内存里
    const diffs: number[] = [];
    composeFrames(gif, [], diffs);
    const sampled = selectSampledFrames(gif.frames.length, diffs, options.samples ?? GIF_SAMPLE_COUNT);
    const snapshots = composeFrames(gif, sampled);
    if (snapshots.length < 2) return null;

    // 每帧起始时刻（秒）；delay<=20ms 按浏览器惯例兜底 100ms，保证时间戳单调递增
    const times: number[] = [];
    let acc = 0;
    for (const frame of gif.frames) {
      times.push(acc);
      acc += frame.delay > 0.02 && frame.delay < 10 ? frame.delay : DEFAULT_FRAME_DELAY;
    }
    const durationSeconds = Math.round(acc * 100) / 100;
    const sampledTimes = sampled.map((i) => Math.round((times[i] ?? 0) * 100) / 100);

    const sheet = composeSheet(snapshots, gif.width, gif.height, maxWidth, maxHeight);
    const scaled = downscale(sheet.rgb, sheet.width, sheet.height, maxWidth, maxHeight);
    return {
      data: encodePng(scaled.rgb, scaled.width, scaled.height),
      totalFrames: gif.frames.length,
      sampledFrames: sampled,
      sampledTimes,
      durationSeconds,
      columns: sheet.columns,
      width: scaled.width,
      height: scaled.height,
    };
  } catch {
    return null;
  }
}

/**
 * 抽帧成功时追加给视觉模型的「拼图结构说明」。
 * 通用护栏由 ANIMATED_GUARD_PROMPT 前置给出，这里只讲格子怎么排、每格是哪个时刻。
 */
export function animatedImagePrompt(sheet: GifFrameSheet): string {
  const positions = sheet.sampledFrames
    .map((i, k) => {
      const t = sheet.sampledTimes?.[k];
      return `第 ${i + 1} 帧${t === undefined ? '' : `（约 ${t.toFixed(2)}s）`}`;
    })
    .join('、');
  const duration = sheet.durationSeconds ?? 0;
  const durationText = duration > 0 ? `、约 ${duration.toFixed(2)} 秒` : '';
  const layout = sheet.columns > 1
    ? `按从左到右、从上到下排列，每行 ${sheet.columns} 张`
    : '从左到右排列';
  return [
    `这是一张动图的抽帧拼图：原图共 ${sheet.totalFrames} 帧${durationText}；`
    + `拼图共 ${sheet.sampledFrames.length} 格，${layout}，依次是 ${positions}，格子之间有灰色分隔条。`,
    '请按帧顺序逐格描述画面主体、可见的姿态/动作变化、出现或消失的物件与文字；能看出"在动什么"就说，看不出就直说看不出。',
    '多数帧里重复的同一姿势不代表整段动作就是它；请特别留意只在少数帧出现的关键物件、手部动作、遮挡/藏匿、进出画面的东西。',
    '不要把其中某一帧当成整张动图的全部，也不要把若干帧串成一个画面里并未出现的剧情；只描述你实际看到的。',
  ].join('\n');
}

/**
 * 看图通用护栏：必须放在用户/主模型的具体指令之前。
 * 2026-11-09 17:10 群里翻车的直接原因就是主模型在 prompt 里索取「画的是什么角色」，
 * 视觉模型于是硬认成「希儿/布洛妮娅」；护栏若拼在后面，会被当成可有可无的补充。
 */
export const ANIMATED_GUARD_PROMPT = [
  '【看图护栏，优先于下面所有指令】只描述画面里实际可见的内容。',
  '不要根据人物外貌、服装、画风猜测角色名、作品名、游戏名或剧情；图上没有明确文字佐证的身份、意图一律不要断言。',
  '小物件或文字看不清就写「看不清」或列出几种可能，不要选一种当成确定结论；不要用常识把画面补成完整故事。',
].join('\n');

/** 动图但没能抽帧时的兜底护栏：至少禁止把首帧脑补成动作 */
export const ANIMATED_FALLBACK_PROMPT =
  '这是一张动图，但图片通道可能只给到你第一帧，动作没能完整解析。'
  + '请只描述这一帧里实际可见的静态画面，并明确说明动图内容未完整解析；'
  + '不要推断动作变化、剧情、角色身份或人物意图。';
