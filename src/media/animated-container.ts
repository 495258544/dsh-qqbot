/**
 * 动图容器识别（magic bytes + 结构块），零依赖、只读字节。
 *
 * 为什么需要：chat-completions 的图片通道对动图只落首帧。GIF 已能自己解码抽帧，
 * 但 APNG（PNG 里的 acTL 块）和动画 WebP（RIFF 里的 ANIM / ANMF 块）同样是动图，
 * 之前被当成普通静态 PNG/WebP 送进去，模型照样把首帧脑补成完整动作。
 * 这两类暂时没有解码器，识别出来后走「只看到首帧」的降级护栏，至少不让她编剧情。
 *
 * 只做容器层判定，不解码像素；结构不合法时返回 null（宁可漏判，不可误判静态图为动图）。
 */
export type AnimatedKind = 'gif' | 'apng' | 'webp' | null;

function u32be(b: Uint8Array, p: number): number {
  return ((b[p] ?? 0) << 24) | ((b[p + 1] ?? 0) << 16) | ((b[p + 2] ?? 0) << 8) | (b[p + 3] ?? 0);
}

function u32le(b: Uint8Array, p: number): number {
  return (b[p] ?? 0) | ((b[p + 1] ?? 0) << 8) | ((b[p + 2] ?? 0) << 16) | ((b[p + 3] ?? 0) << 24);
}

function fourCC(b: Uint8Array, p: number): string {
  return String.fromCharCode(b[p] ?? 0, b[p + 1] ?? 0, b[p + 2] ?? 0, b[p + 3] ?? 0);
}

/** PNG chunk 里出现 acTL 即 APNG；acTL 必须在 IDAT 之前，扫到 IDAT 还没见就判静态 */
function hasApngControl(b: Uint8Array): boolean {
  let p = 8;
  while (p + 12 <= b.length) {
    const len = u32be(b, p);
    const type = fourCC(b, p + 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    if (len > b.length - p - 12) return false;
    p += 12 + len;
  }
  return false;
}

/** RIFF/WEBP chunk 里出现 ANIM 或 ANMF 即动画 WebP */
function hasWebpAnimation(b: Uint8Array): boolean {
  let p = 12;
  while (p + 8 <= b.length) {
    const type = fourCC(b, p);
    const size = u32le(b, p + 4);
    if (type === 'ANIM' || type === 'ANMF') return true;
    if (size > b.length - p - 8) return false;
    p += 8 + size + (size & 1); // RIFF chunk 按偶数字节对齐
  }
  return false;
}

/** 识别动图容器；静态 PNG/WebP、非图片、截断数据一律返回 null */
export function detectAnimatedContainer(data: Uint8Array): AnimatedKind {
  if (data.length < 12) return null;
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'gif';
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return hasApngControl(data) ? 'apng' : null;
  }
  if (fourCC(data, 0) === 'RIFF' && fourCC(data, 8) === 'WEBP') {
    return hasWebpAnimation(data) ? 'webp' : null;
  }
  return null;
}
