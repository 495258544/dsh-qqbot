/**
 * GIF 动图抽帧回归用例。
 *
 * 背景：2026-11-09 群里一张 62 帧动图被当成静态图（只落首帧）描述成「挥手送别」。
 * 这里锁住：多帧必须抽成 PNG 联系表、抽样含首尾、解码失败必须静默回退。
 */
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  gifToContactSheet,
  sampleFrameIndices,
  animatedImagePrompt,
  ANIMATED_FALLBACK_PROMPT,
  GIF_SAMPLE_COUNT,
} from './gif-frames.ts';

/** 4 帧 8x8 GIF，每帧主色不同（红/绿/蓝/黄），由 Pillow 生成 */
const FOUR_FRAME_GIF = Buffer.from(
  'R0lGODlhCAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAACAAIAAAIGAABCBxIsODAAAgDEEyo8GDChQ8NSiQYEAAh+QQACgAAACwAAAAACAAIAIEA/wAAAAAAAAAAAAAIGAABCBxIsODAAAgDEEyo8GDChQ8NSiQYEAAh+QQACgAAACwAAAAACAAIAIEAAP8AAAAAAAAAAAAIGAABCBxIsODAAAgDEEyo8GDChQ8NSiQYEAAh+QQACgAAACwAAAAACAAIAIH//wAAAAAAAAAAAAAIGAABCBxIsODAAAgDEEyo8GDChQ8NSiQYEAA7',
  'base64',
);
/** 单帧 GIF（不该走抽帧，按静态图处理即可） */
const SINGLE_FRAME_GIF = Buffer.from(
  'R0lGODdhCAAIAIEAAP8AAAAAAAAAAAAAACwAAAAACAAIAAAIGAABCBxIsODAAAgDEEyo8GDChQ8NSiQYEAA7',
  'base64',
);

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 解我们自己的 PNG（只用 filter=0），用来断言抽出来的几帧确实不同 */
function decodePng(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  let p = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (p + 12 <= png.length) {
    const len = new DataView(png.buffer, png.byteOffset + p, 4).getUint32(0);
    const type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = v.getUint32(0);
      height = v.getUint32(4);
    }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const total = idat.reduce((s, d) => s + d.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const d of idat) { joined.set(d, o); o += d.length; }
  const raw = new Uint8Array(inflateSync(joined));
  const stride = width * 3;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    expect(raw[rowStart]).toBe(0); // 我们只写 filter=0
    rgb.set(raw.subarray(rowStart + 1, rowStart + 1 + stride), y * stride);
  }
  return { width, height, rgb };
}

function pixel(rgb: Uint8Array, width: number, x: number, y: number): number[] {
  const p = (y * width + x) * 3;
  return [rgb[p] ?? 0, rgb[p + 1] ?? 0, rgb[p + 2] ?? 0];
}

describe('sampleFrameIndices', () => {
  it('含首帧与末帧，不重复且递增', () => {
    expect(sampleFrameIndices(62, 4)).toEqual([0, 20, 41, 61]);
    expect(sampleFrameIndices(2, 4)).toEqual([0, 1]);
    expect(sampleFrameIndices(1, 4)).toEqual([0]);
    expect(sampleFrameIndices(5, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('默认抽样数不超过总数', () => {
    const s = sampleFrameIndices(3, GIF_SAMPLE_COUNT);
    expect(s.length).toBeLessThanOrEqual(3);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(2);
  });
});

describe('gifToContactSheet', () => {
  it('多帧 GIF → PNG 联系表，抽到的帧内容各不相同', () => {
    const sheet = gifToContactSheet(new Uint8Array(FOUR_FRAME_GIF));
    expect(sheet).not.toBeNull();
    expect(sheet!.totalFrames).toBe(4);
    expect(sheet!.sampledFrames).toEqual([0, 1, 2, 3]);
    expect([...sheet!.data.subarray(0, 8)]).toEqual(PNG_MAGIC);

    const img = decodePng(sheet!.data);
    // 4 帧 × 8px + 3 条 6px 灰缝 = 50px 宽
    expect(img.width).toBe(50);
    expect(img.height).toBe(8);
    const colors = [0, 1, 2, 3].map((k) => pixel(img.rgb, img.width, k * 14, 0).join(','));
    expect(new Set(colors).size).toBe(4);
    // 分隔条是浅灰底
    expect(pixel(img.rgb, img.width, 10, 0)).toEqual([0xf2, 0xf2, 0xf2]);
  });

  it('限制抽样数时只抽指定帧数', () => {
    const sheet = gifToContactSheet(new Uint8Array(FOUR_FRAME_GIF), { samples: 2 });
    expect(sheet!.sampledFrames).toEqual([0, 3]);
    expect(decodePng(sheet!.data).width).toBe(22);
  });

  it('单帧 GIF / 非 GIF / 截断数据都返回 null（回退，不抛错）', () => {
    expect(gifToContactSheet(new Uint8Array(SINGLE_FRAME_GIF))).toBeNull();
    expect(gifToContactSheet(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(gifToContactSheet(new Uint8Array(FOUR_FRAME_GIF.subarray(0, 40)))).toBeNull();
    expect(gifToContactSheet(new Uint8Array())).toBeNull();
  });

  it('超宽拼图会被等比缩小到 maxWidth 以内', () => {
    const sheet = gifToContactSheet(new Uint8Array(FOUR_FRAME_GIF), { maxWidth: 20 });
    expect(sheet!.width).toBe(20);
    const img = decodePng(sheet!.data);
    expect(img.width).toBe(20);
  });
});

describe('动图 prompt 护栏', () => {
  it('说明帧序号与顺序，并明确禁止把单帧编成剧情', () => {
    const p = animatedImagePrompt({ data: new Uint8Array(), totalFrames: 62, sampledFrames: [0, 20, 41, 61], width: 50, height: 8 });
    expect(p).toContain('62 帧');
    expect(p).toContain('1、21、42、62');
    expect(p).toContain('从左到右');
    expect(p).toContain('不要');
    expect(p).toContain('挥手');
  });

  it('解码失败的兜底护栏同样禁止脑补动作', () => {
    expect(ANIMATED_FALLBACK_PROMPT).toContain('动图');
    expect(ANIMATED_FALLBACK_PROMPT).toContain('不要');
  });
});
