/**
 * GIF 动图 → 抽帧拼成一张 PNG 联系表，再交给视觉模型。
 *
 * 为什么要自己解码：chat-completions 的图片通道只吃静态栅格图。把 .gif 整份塞进去，
 * 模型通常只拿得到第一帧（甚至把它当成普通静态图），于是"在动什么"全靠脑补。
 * 2026-11-09 群里实锤：一张 62 帧的女仆动图被描述成「挥手送别」，而帧间其实还有
 * 拍/摇怀里小人的动作 —— 群里直接吐槽「动图解析有问题吧」。
 *
 * 做法：解码 GIF（LZW + 局部帧 + disposal + 交织），按序合成完整帧，抽首/中/末若干帧
 * 横向拼成 PNG。模型一次就能看到动作变化；配合 prompt 护栏，不许把某一帧编成完整剧情。
 *
 * 纯 JS + node:zlib，不引原生图像依赖：宿主 asar 与插件 node_modules 都没有 GIF 解码器，
 * Python/ffmpeg 也不保证在插件进程里可用。任何解析失败一律返回 null，调用方回退原 GIF，
 * 绝不让看图工具因为动图而整体失败。
 */
import { deflateSync } from 'node:zlib';
/** 默认抽几帧（含首、末） */
export const GIF_SAMPLE_COUNT = 4;
/** 拼图最大宽度：太宽会被模型降采样到看不清 */
export const GIF_SHEET_MAX_WIDTH = 1200;
/** 帧数与画布上限，防止超大动图把内存吃满（超限直接回退） */
const MAX_FRAMES = 240;
const MAX_PIXELS = 4_000_000;
/** 顺序读字节，越界即抛（调用方转成 null 回退） */
class Reader {
    b;
    p = 0;
    constructor(b) {
        this.b = b;
    }
    get pos() { return this.p; }
    u8() {
        if (this.p >= this.b.length)
            throw new Error('truncated gif');
        return this.b[this.p++];
    }
    u16() {
        const lo = this.u8();
        return lo | (this.u8() << 8);
    }
    take(n) {
        if (n < 0 || this.p + n > this.b.length)
            throw new Error('truncated gif');
        const out = this.b.slice(this.p, this.p + n);
        this.p += n;
        return out;
    }
}
/** GIF 的「一堆子块」拼成连续字节，读到长度 0 结束 */
function readSubBlocks(r) {
    const parts = [];
    let total = 0;
    for (;;) {
        const n = r.u8();
        if (n === 0)
            break;
        const part = r.take(n);
        parts.push(part);
        total += part.length;
    }
    return concatBytes(parts, total);
}
function concatBytes(parts, total) {
    const size = total ?? parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}
/** 只解析结构，不解码像素 —— 用来先知道总帧数，避免为每一帧都留一份画布快照 */
function parseGif(data) {
    const r = new Reader(data);
    const header = String.fromCharCode(...r.take(6));
    if (header !== 'GIF87a' && header !== 'GIF89a')
        throw new Error('not a gif');
    const width = r.u16();
    const height = r.u16();
    if (width <= 0 || height <= 0 || width * height > MAX_PIXELS)
        throw new Error('gif canvas too large');
    const packed = r.u8();
    r.u8(); // background color index
    r.u8(); // pixel aspect ratio
    let gct = new Uint8Array(0);
    if ((packed & 0x80) !== 0)
        gct = r.take(3 * (2 << (packed & 0x07)));
    let gceDisposal = 0;
    let gceTransparent = null;
    const frames = [];
    while (r.pos < data.length) {
        const marker = r.u8();
        if (marker === 0x3b)
            break; // trailer
        if (marker === 0x21) {
            const label = r.u8();
            if (label === 0xf9) {
                const size = r.u8();
                const gce = r.take(size);
                const flags = gce[0] ?? 0;
                gceDisposal = (flags >> 2) & 0x07;
                gceTransparent = (flags & 0x01) !== 0 ? (gce[3] ?? 0) : null;
                r.u8(); // block terminator
            }
            else {
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
            });
            gceDisposal = 0;
            gceTransparent = null;
            if (frames.length > MAX_FRAMES)
                throw new Error('too many gif frames');
            continue;
        }
        // 不认识的块：不猜，直接放弃
        throw new Error(`unexpected gif block 0x${marker.toString(16)}`);
    }
    if (frames.length === 0)
        throw new Error('gif has no frames');
    return { width, height, frames };
}
/** GIF 变长 LZW 解码（LSB-first 码流），返回索引色数组 */
function decodeLzw(lzw, minCodeSize, expected) {
    if (minCodeSize < 2 || minCodeSize > 8)
        throw new Error('bad lzw min code size');
    const clear = 1 << minCodeSize;
    const eoi = clear + 1;
    const out = new Uint8Array(expected);
    let outPos = 0;
    let bitPos = 0;
    let codeSize = minCodeSize + 1;
    let next = eoi + 1;
    let dict = new Array(4096);
    let prev = null;
    const resetDict = () => {
        dict = new Array(4096);
        for (let i = 0; i < clear; i += 1)
            dict[i] = Uint8Array.of(i);
        codeSize = minCodeSize + 1;
        next = eoi + 1;
        prev = null;
    };
    resetDict();
    const readCode = () => {
        let code = 0;
        for (let i = 0; i < codeSize; i += 1) {
            const byte = lzw[bitPos >> 3];
            if (byte === undefined)
                return eoi; // 截断就当结束，能保住已解出的部分
            code |= ((byte >> (bitPos & 7)) & 1) << i;
            bitPos += 1;
        }
        return code;
    };
    for (;;) {
        const code = readCode();
        if (code === eoi)
            break;
        if (code === clear) {
            resetDict();
            continue;
        }
        let entry;
        if (code < next)
            entry = dict[code];
        else if (code === next && prev !== null) {
            entry = new Uint8Array(prev.length + 1);
            entry.set(prev);
            entry[prev.length] = prev[0] ?? 0;
        }
        if (entry === undefined || entry.length === 0)
            break;
        for (let i = 0; i < entry.length && outPos < expected; i += 1)
            out[outPos++] = entry[i];
        if (prev !== null && next < 4096) {
            const added = new Uint8Array(prev.length + 1);
            added.set(prev);
            added[prev.length] = entry[0] ?? 0;
            dict[next++] = added;
            if (next === (1 << codeSize) && codeSize < 12)
                codeSize += 1;
        }
        prev = entry;
    }
    return out.subarray(0, outPos);
}
/** 交织 GIF 的行顺序还原成自上而下 */
function deinterlace(indices, w, h) {
    const rowOrder = [];
    for (let y = 0; y < h; y += 8)
        rowOrder.push(y);
    for (let y = 4; y < h; y += 8)
        rowOrder.push(y);
    for (let y = 2; y < h; y += 4)
        rowOrder.push(y);
    for (let y = 1; y < h; y += 2)
        rowOrder.push(y);
    const out = new Uint8Array(w * h);
    for (let sy = 0; sy < h; sy += 1) {
        const dy = rowOrder[sy] ?? sy;
        const row = indices.subarray(sy * w, sy * w + w);
        if (dy * w + row.length <= out.length)
            out.set(row, dy * w);
    }
    return out;
}
/** 均匀抽样，必定含首帧与末帧 */
export function sampleFrameIndices(total, count) {
    if (total <= 1)
        return [0];
    const n = Math.max(2, Math.min(count, total));
    const out = [0];
    for (let k = 1; k < n - 1; k += 1)
        out.push(Math.round(((total - 1) * k) / (n - 1)));
    out.push(total - 1);
    return [...new Set(out)].sort((a, b) => a - b);
}
/** 把 RGBA 画布矩形清成透明（disposal=2 用） */
function clearRect(canvas, canvasW, canvasH, x, y, w, h) {
    const x0 = Math.max(0, Math.min(canvasW, x));
    const y0 = Math.max(0, Math.min(canvasH, y));
    const x1 = Math.max(0, Math.min(canvasW, x + w));
    const y1 = Math.max(0, Math.min(canvasH, y + h));
    for (let yy = y0; yy < y1; yy += 1)
        canvas.fill(0, (yy * canvasW + x0) * 4, (yy * canvasW + x1) * 4);
}
/** 逐帧合成，只保留被抽样帧的完整画布快照 */
function composeSampledFrames(gif, sampled) {
    const { width, height, frames } = gif;
    const canvas = new Uint8Array(width * height * 4);
    const snapshots = [];
    let restore = null;
    const sampleSet = new Set(sampled);
    for (let i = 0; i < frames.length; i += 1) {
        const prevFrame = i > 0 ? frames[i - 1] : undefined;
        if (prevFrame?.disposal === 3 && restore !== null) {
            canvas.set(restore);
        }
        else if (prevFrame?.disposal === 2) {
            clearRect(canvas, width, height, prevFrame.left, prevFrame.top, prevFrame.width, prevFrame.height);
        }
        const before = canvas.slice();
        const frame = frames[i];
        const expected = frame.width * frame.height;
        let indices = decodeLzw(frame.lzw, frame.minCodeSize, expected);
        if (indices.length < expected) {
            const padded = new Uint8Array(expected);
            padded.set(indices);
            indices = padded;
        }
        if (frame.interlaced)
            indices = deinterlace(indices, frame.width, frame.height);
        const table = frame.colorTable;
        for (let y = 0; y < frame.height; y += 1) {
            const cy = frame.top + y;
            if (cy < 0 || cy >= height)
                continue;
            for (let x = 0; x < frame.width; x += 1) {
                const cx = frame.left + x;
                if (cx < 0 || cx >= width)
                    continue;
                const idx = indices[y * frame.width + x];
                if (frame.transparentIndex !== null && idx === frame.transparentIndex)
                    continue;
                const c = idx * 3;
                const p = (cy * width + cx) * 4;
                canvas[p] = table[c] ?? 0;
                canvas[p + 1] = table[c + 1] ?? 0;
                canvas[p + 2] = table[c + 2] ?? 0;
                canvas[p + 3] = 255;
            }
        }
        if (sampleSet.has(i))
            snapshots.push(canvas.slice());
        restore = before;
    }
    return snapshots;
}
/** 抽样帧横向拼成 RGB 位图，帧间留灰条，透明合成到浅灰底 */
function composeSheet(snapshots, frameW, frameH) {
    const gap = 6;
    const sheetW = frameW * snapshots.length + gap * (snapshots.length - 1);
    const sheetH = frameH;
    const rgb = new Uint8Array(sheetW * sheetH * 3);
    rgb.fill(0xf2);
    for (let k = 0; k < snapshots.length; k += 1) {
        const snap = snapshots[k];
        const offsetX = k * (frameW + gap);
        for (let y = 0; y < frameH; y += 1) {
            for (let x = 0; x < frameW; x += 1) {
                const s = (y * frameW + x) * 4;
                const a = snap[s + 3] ?? 0;
                const d = (y * sheetW + offsetX + x) * 3;
                if (a === 0)
                    continue; // 底色已是浅灰
                if (a === 255) {
                    rgb[d] = snap[s] ?? 0;
                    rgb[d + 1] = snap[s + 1] ?? 0;
                    rgb[d + 2] = snap[s + 2] ?? 0;
                }
                else {
                    const t = a / 255;
                    rgb[d] = Math.round((snap[s] ?? 0) * t + 0xf2 * (1 - t));
                    rgb[d + 1] = Math.round((snap[s + 1] ?? 0) * t + 0xf2 * (1 - t));
                    rgb[d + 2] = Math.round((snap[s + 2] ?? 0) * t + 0xf2 * (1 - t));
                }
            }
        }
    }
    return { rgb, width: sheetW, height: sheetH };
}
/** 最近邻等比缩小，保证拼图不超过模型能看清的宽度 */
function downscale(rgb, w, h, maxWidth) {
    if (w <= maxWidth)
        return { rgb, width: w, height: h };
    const scale = maxWidth / w;
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
        for (let k = 0; k < 8; k += 1)
            c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf)
        c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i += 1)
        out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}
/** RGB 位图 → PNG（8bit, colorType=2, 每行 filter=0） */
function encodePng(rgb, width, height) {
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
export function gifToContactSheet(data, options = {}) {
    try {
        const gif = parseGif(data);
        if (gif.frames.length < 2)
            return null;
        const sampled = sampleFrameIndices(gif.frames.length, options.samples ?? GIF_SAMPLE_COUNT);
        const snapshots = composeSampledFrames(gif, sampled);
        if (snapshots.length < 2)
            return null;
        const sheet = composeSheet(snapshots, gif.width, gif.height);
        const scaled = downscale(sheet.rgb, sheet.width, sheet.height, options.maxWidth ?? GIF_SHEET_MAX_WIDTH);
        return {
            data: encodePng(scaled.rgb, scaled.width, scaled.height),
            totalFrames: gif.frames.length,
            sampledFrames: sampled,
            width: scaled.width,
            height: scaled.height,
        };
    }
    catch {
        return null;
    }
}
/** 抽帧成功时追加给视觉模型的说明：让它知道这是动图的多个时刻，而不是一张静态图 */
export function animatedImagePrompt(sheet) {
    const positions = sheet.sampledFrames.map((i) => i + 1).join('、');
    return [
        `这是一张动图的抽帧拼图：原图共 ${sheet.totalFrames} 帧，从左到右依次是第 ${positions} 帧，帧与帧之间有灰色竖条分隔。`,
        '请按帧顺序描述画面主体、可见的动作/姿态变化与文字；能看出"在动什么"就说，看不出就直说看不出。',
        '不要把其中某一帧当成整张动图的全部，也不要凭一帧编出完整剧情、送别/挥手/告别之类的意图；只描述你实际看到的。',
    ].join('\n');
}
/** 解码失败时的兜底护栏：至少禁止她把首帧脑补成动作 */
export const ANIMATED_FALLBACK_PROMPT = '这是一张动图（GIF），图片通道可能只给到你第一帧。不要把单帧画面脑补成完整动作或剧情，'
    + '也不要断言人物在挥手/送别/做什么；只描述实际看到的静态画面，并说明动图内容没能完整解析。';
//# sourceMappingURL=gif-frames.js.map