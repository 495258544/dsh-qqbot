function u32be(b, p) {
    return ((b[p] ?? 0) << 24) | ((b[p + 1] ?? 0) << 16) | ((b[p + 2] ?? 0) << 8) | (b[p + 3] ?? 0);
}
function u32le(b, p) {
    return (b[p] ?? 0) | ((b[p + 1] ?? 0) << 8) | ((b[p + 2] ?? 0) << 16) | ((b[p + 3] ?? 0) << 24);
}
function fourCC(b, p) {
    return String.fromCharCode(b[p] ?? 0, b[p + 1] ?? 0, b[p + 2] ?? 0, b[p + 3] ?? 0);
}
/** PNG chunk 里出现 acTL 即 APNG；acTL 必须在 IDAT 之前，扫到 IDAT 还没见就判静态 */
function hasApngControl(b) {
    let p = 8;
    while (p + 12 <= b.length) {
        const len = u32be(b, p);
        const type = fourCC(b, p + 4);
        if (type === 'acTL')
            return true;
        if (type === 'IDAT' || type === 'IEND')
            return false;
        if (len > b.length - p - 12)
            return false;
        p += 12 + len;
    }
    return false;
}
/** RIFF/WEBP chunk 里出现 ANIM 或 ANMF 即动画 WebP */
function hasWebpAnimation(b) {
    let p = 12;
    while (p + 8 <= b.length) {
        const type = fourCC(b, p);
        const size = u32le(b, p + 4);
        if (type === 'ANIM' || type === 'ANMF')
            return true;
        if (size > b.length - p - 8)
            return false;
        p += 8 + size + (size & 1); // RIFF chunk 按偶数字节对齐
    }
    return false;
}
/** 识别动图容器；静态 PNG/WebP、非图片、截断数据一律返回 null */
export function detectAnimatedContainer(data) {
    if (data.length < 12)
        return null;
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38)
        return 'gif';
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
        return hasApngControl(data) ? 'apng' : null;
    }
    if (fourCC(data, 0) === 'RIFF' && fourCC(data, 8) === 'WEBP') {
        return hasWebpAnimation(data) ? 'webp' : null;
    }
    return null;
}
//# sourceMappingURL=animated-container.js.map