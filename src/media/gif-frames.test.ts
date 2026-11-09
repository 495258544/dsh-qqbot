/**
 * GIF 动图抽帧回归用例。
 *
 * 背景：2026-11-09 群里一张 62 帧动图被当成静态图（只落首帧）描述成「挥手送别」；
 * 第二轮实测发现 4 帧均匀采样间隔 0.86s 仍会漏掉短暂动作，改为 8 帧网格 + 差分补帧；
 * 第三轮（17:10 真实群聊）确认抽帧本身有效、错在提示词诱导认角色，于是护栏前置通用化、
 * 拼图改「无空格 + 几乎不缩放」选列、补总时长与背景色恢复。这里锁住这些行为。
 */
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  gifToContactSheet,
  sampleFrameIndices,
  selectSampledFrames,
  chooseSheetColumns,
  animatedImagePrompt,
  ANIMATED_FALLBACK_PROMPT,
  ANIMATED_GUARD_PROMPT,
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

describe('selectSampledFrames', () => {
  it('默认送 8 帧（均匀基线 + 差分补空隙）', () => {
    expect(GIF_SAMPLE_COUNT).toBe(8);
    const s = selectSampledFrames(62, new Array<number>(62).fill(0), GIF_SAMPLE_COUNT);
    expect(s.length).toBe(8);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(61);
    expect(s).toEqual([...s].sort((a, b) => a - b));
    expect(new Set(s).size).toBe(s.length);
  });

  it('帧间变化峰值会被补进均匀采样的空隙', () => {
    const diffs = new Array<number>(62).fill(0);
    diffs[30] = 100; // 不在 6 帧均匀基线里
    const s = selectSampledFrames(62, diffs, 8);
    expect(s).toContain(30);
    expect(s.length).toBe(8);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(61);
  });

  it('峰值紧贴已有采样点时被最小间隔挡掉，不扎堆', () => {
    const diffs = new Array<number>(62).fill(0);
    diffs[1] = 100; // 紧贴首帧
    const s = selectSampledFrames(62, diffs, 8);
    expect(s).not.toContain(1);
    expect(s.length).toBe(8);
  });

  it('抽样数不超过均匀基线时退化为纯均匀', () => {
    expect(selectSampledFrames(62, new Array<number>(62).fill(1), 4)).toEqual([0, 20, 41, 61]);
  });

  it('整段几乎不动也能凑够帧数，时间覆盖不塌', () => {
    const s = selectSampledFrames(62, new Array<number>(62).fill(0), 8);
    expect(s.length).toBe(8);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(61);
  });
});

describe('chooseSheetColumns', () => {
  it('8 帧 300x383：选 4 列 × 2 行，无空格且几乎不缩放（旧逻辑是 3×3 留空格）', () => {
    // 3 列 × 3 行 = 9 格，右下留空；4 列 × 2 行只需缩到 0.985
    expect(chooseSheetColumns(8, 300, 383, 1200, 1200)).toBe(4);
  });

  it('4 帧小图：默认选 2×2；宽上限太小时改 1 列竖排以避开整体缩放', () => {
    expect(chooseSheetColumns(4, 8, 8, 1200, 1200)).toBe(2);
    expect(chooseSheetColumns(4, 8, 8, 20, 1200)).toBe(1);
  });

  it('高度上限很小时优先「几乎不缩放」的横排方案', () => {
    expect(chooseSheetColumns(4, 8, 8, 1200, 10)).toBe(4);
  });

  it('平分时取更宽（更符合时间轴阅读顺序）', () => {
    expect(chooseSheetColumns(2, 8, 8, 1200, 1200)).toBe(2);
  });
});

describe('gifToContactSheet', () => {
  it('多帧 GIF → PNG 网格联系表，抽到的帧内容各不相同', () => {
    const sheet = gifToContactSheet(new Uint8Array(FOUR_FRAME_GIF));
    expect(sheet).not.toBeNull();
    expect(sheet!.totalFrames).toBe(4);
    expect(sheet!.sampledFrames).toEqual([0, 1, 2, 3]);
    expect(sheet!.columns).toBe(2);
    expect(sheet!.sampledTimes).toHaveLength(4);
    expect(sheet!.sampledTimes![0]).toBe(0);
    expect(sheet!.durationSeconds).toBeGreaterThan(0);
    expect([...sheet!.data.subarray(0, 8)]).toEqual(PNG_MAGIC);

    const img = decodePng(sheet!.data);
    // 2 列 × 2 行：每格 8px + 6px 灰缝 → 22x22
    expect(img.width).toBe(22);
    expect(img.height).toBe(22);
    const colors = [0, 1, 2, 3].map((k) => pixel(
      img.rgb, img.width, (k % 2) * 14, Math.floor(k / 2) * 14,
    ).join(','));
    expect(new Set(colors).size).toBe(4);
    // 水平灰缝仍是浅灰底
    expect(pixel(img.rgb, img.width, 10, 0)).toEqual([0xf2, 0xf2, 0xf2]);
  });

  it('限制抽样数时只抽指定帧数', () => {
    const sheet = gifToContactSheet(new Uint8Array(FOUR_FRAME_GIF), { samples: 2 });
    expect(sheet!.sampledFrames).toEqual([0, 3]);
    expect(sheet!.columns).toBe(2);
    expect(decodePng(sheet!.data).width).toBe(22);
  });

  it('单行会超宽时自动换成多行网格，单帧不被整体缩小', () => {
    const sheet = gifToContactSheet(new Uint8Array(FOUR_FRAME_GIF), { maxWidth: 20 });
    expect(sheet!.columns).toBe(1);
    const img = decodePng(sheet!.data);
    // 4 帧竖排：8 x (4*8 + 3*6) = 8x50，无需整体降采样
    expect(img.width).toBe(8);
    expect(img.height).toBe(50);
  });

  it('高度上限很小时改横排，直接避开整体缩放（单帧保持 8x8）', () => {
    const sheet = gifToContactSheet(new Uint8Array(FOUR_FRAME_GIF), { maxHeight: 10 });
    expect(sheet!.columns).toBe(4);
    const img = decodePng(sheet!.data);
    expect(img.width).toBe(50);
    expect(img.height).toBe(8);
  });

  it('宽高都被卡死时仍等比缩小到上限内', () => {
    const sheet = gifToContactSheet(new Uint8Array(FOUR_FRAME_GIF), { maxWidth: 10, maxHeight: 10 });
    expect(sheet!.width).toBe(10);
    expect(sheet!.height).toBe(10);
    expect(decodePng(sheet!.data).width).toBe(10);
  });

  it('单帧 GIF / 非 GIF / 截断数据都返回 null（回退，不抛错）', () => {
    expect(gifToContactSheet(new Uint8Array(SINGLE_FRAME_GIF))).toBeNull();
    expect(gifToContactSheet(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(gifToContactSheet(new Uint8Array(FOUR_FRAME_GIF.subarray(0, 40)))).toBeNull();
    expect(gifToContactSheet(new Uint8Array())).toBeNull();
  });
});

describe('动图 prompt 护栏', () => {
  it('说明帧序号/时刻/格数/总时长与网格顺序，不再写死上一张图的特化动作', () => {
    const p = animatedImagePrompt({
      data: new Uint8Array(),
      totalFrames: 62,
      sampledFrames: [0, 12, 24, 37, 49, 61],
      sampledTimes: [0, 0.5, 1.0, 1.54, 2.04, 2.54],
      durationSeconds: 2.62,
      columns: 3,
      width: 50,
      height: 50,
    });
    expect(p).toContain('62 帧');
    expect(p).toContain('2.62 秒');
    expect(p).toContain('共 6 格');
    expect(p).toContain('第 38 帧');
    expect(p).toContain('1.54s');
    expect(p).toContain('从左到右、从上到下');
    expect(p).toContain('每行 3 张');
    expect(p).toContain('多数帧');
    expect(p).toContain('少数帧');
    expect(p).toContain('关键物件');
    // 通用护栏，不能残留上一张女仆动图的特化词
    expect(p).not.toContain('挥手');
    expect(p).not.toContain('送别');
    expect(p).not.toContain('拍打');
  });

  it('没有时刻信息时仍给帧序号，不编造秒数', () => {
    const p = animatedImagePrompt({
      data: new Uint8Array(),
      totalFrames: 4,
      sampledFrames: [0, 1, 2, 3],
      durationSeconds: 0,
      columns: 2,
      width: 22,
      height: 22,
    });
    expect(p).toContain('第 1 帧');
    expect(p).not.toContain('秒');
  });

  it('前置通用护栏明确禁止猜角色/作品名，并要求看不清就直说', () => {
    expect(ANIMATED_GUARD_PROMPT).toContain('优先于下面所有指令');
    expect(ANIMATED_GUARD_PROMPT).toContain('角色名');
    expect(ANIMATED_GUARD_PROMPT).toContain('作品名');
    expect(ANIMATED_GUARD_PROMPT).toContain('看不清');
  });

  it('解码失败的兜底护栏禁止脑补动作与身份', () => {
    expect(ANIMATED_FALLBACK_PROMPT).toContain('动图');
    expect(ANIMATED_FALLBACK_PROMPT).toContain('未完整解析');
    expect(ANIMATED_FALLBACK_PROMPT).toContain('不要');
    expect(ANIMATED_FALLBACK_PROMPT).not.toContain('挥手');
  });
});
