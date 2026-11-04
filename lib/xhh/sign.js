/**
 * 小黑盒 Web 端请求签名（hkey/_time/nonce）
 * ─────────────────────────────────────────────────────────────
 * 算法改写自 `fbbDirge/dsh-xiaoheihe` 的 `lib/index.js`（MIT），
 * 上游又标注「照抄 heybox src/api/signature.ts，字节级一致」。
 *
 * ⚠️ 不要"优化"这里的任何一个函数。
 *   这些看起来可以简化（比如 `av` 里的取模、`interleave` 里的截断、
 *   `km` 里三角色异或转一圈），但服务端就是按这个逐字节校验的。
 *   改动会得到一个语法正确、服务端一律拒绝的 hkey —— 表现为
 *   `{"status":"show_captcha"}` 或 `hkey 不能为空`，
 *   从错误信息看不出是签名错，排查成本很高。
 *
 * 已在本机实测与 `AaronZ345/xiaoheihe-cli` 的 Python 实现逐字节一致
 * （同一 timestamp/nonce 两边都得到 `7X3XY98`），可作为交叉校验。
 */
import { createHash } from 'node:crypto';
/** 服务端固定字母表（顺序不能改） */
const ALPHABET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';
function md5hex(input) {
    return createHash('md5').update(input, 'utf8').digest('hex');
}
/** GF(2^8) 上的 xtime，约简多项式 0x1b（AES 那套） */
function xtime(e) {
    return (128 & e) !== 0 ? 255 & ((e << 1) ^ 27) : e << 1;
}
function q(e) {
    return xtime(e) ^ e;
}
function r(e) {
    return q(xtime(e));
}
function y(e) {
    return r(q(xtime(e)));
}
function g(e) {
    return y(e) ^ r(e) ^ q(e);
}
/** 四元混合：逐位吸收，写回入参数组（原实现就是原地改） */
function km(e) {
    const t = [0, 0, 0, 0];
    t[0] = g(e[0]) ^ y(e[1]) ^ r(e[2]) ^ q(e[3]);
    t[1] = q(e[0]) ^ g(e[1]) ^ y(e[2]) ^ r(e[3]);
    t[2] = r(e[0]) ^ q(e[1]) ^ g(e[2]) ^ y(e[3]);
    t[3] = y(e[0]) ^ r(e[1]) ^ q(e[2]) ^ g(e[3]);
    e[0] = t[0];
    e[1] = t[1];
    e[2] = t[2];
    e[3] = t[3];
    return e;
}
/** 取字母表前 |offset| 位做映射（offset 为负） */
function av(text, alphabet, offset) {
    let result = '';
    const sliced = alphabet.slice(0, offset);
    for (let i = 0; i < text.length; i += 1) {
        result += sliced[text.charCodeAt(i) % sliced.length];
    }
    return result;
}
/** 按整张字母表映射 */
function sv(text, alphabet) {
    let result = '';
    for (let i = 0; i < text.length; i += 1) {
        result += alphabet[text.charCodeAt(i) % alphabet.length];
    }
    return result;
}
/** 三路交错（时间戳 / 路径 / nonce），长度不等时短的先耗尽 */
function interleave(arr) {
    let result = '';
    const maxLen = Math.max(...arr.map((s) => s.length));
    for (let i = 0; i < maxLen; i += 1) {
        for (const s of arr) {
            if (i < s.length)
                result += s[i];
        }
    }
    return result;
}
/**
 * 生成 hkey。
 * @param path 接口路径，如 `/bbs/app/api/general/search/v1`（头尾斜杠会被归一）
 */
export function hkeyOf(path, timestamp, nonce) {
    const normalizedPath = `/${path.split('/').filter((s) => s).join('/')}/`;
    const encT = av(String(timestamp), ALPHABET, -2);
    const encP = sv(normalizedPath, ALPHABET);
    const encN = sv(nonce, ALPHABET);
    const interleaved = interleave([encT, encP, encN]).slice(0, 20);
    const hash = md5hex(interleaved);
    const last6 = hash
        .slice(-6)
        .split('')
        .map((ch) => ch.charCodeAt(0));
    const transformed = km([...last6]);
    let checksum = String(transformed.reduce((sum, val) => sum + val, 0) % 100);
    if (checksum.length < 2)
        checksum = `0${checksum}`;
    return av(hash.substring(0, 5), ALPHABET, -4) + checksum;
}
/**
 * 生成一组签名。
 * 注意：`hkey` 用的是 `timestamp + 1`（上游原样如此），`_time` 用的是 `timestamp`。
 * 看起来像 off-by-one，但它是协议的一部分，不是 bug。
 */
export function signatureOf(path, now = Date.now(), entropy = Math.random().toString()) {
    const timestamp = Math.floor(now / 1000);
    const nonce = md5hex(timestamp + entropy).toUpperCase();
    return { hkey: hkeyOf(path, timestamp + 1, nonce), _time: timestamp, nonce };
}
//# sourceMappingURL=sign.js.map