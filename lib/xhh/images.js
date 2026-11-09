/**
 * 小黑盒图片 → 表情库
 * ─────────────────────────────────────────────────────────────
 * 需求：正文和评论里常有梗图/表情包，她觉得合适就收进库，之后能被
 * `qq_pick_sticker` 检索到。
 *
 * 复用现有那一套，不另起炉灶：
 *   - 图片落盘仍用 `media/sticker-tool.ts` 的 `adoptIntoLibrary`（MD5 去重）
 *   - 索引仍写同一个 `_index.json`（`upsertIndex`）
 *   - 发图仍只走 `qqbot_send_file`
 * 所以"收进来的图"和"群聊里收到的图"在库里是同一种东西，检索逻辑不用改。
 *
 * 几个必须自己把住的关（都不依赖上游库）：
 *   1. **只下 https**，并且**域名必须属于小黑盒 CDN**。
 *      帖子正文里的 img url 是用户可控内容——任何人都能在帖子里填一个自己的地址。
 *      不设白名单，她逛一次小黑盒就等于帮人做了任意 URL 下载。
 *   2. **内容按字节判断是不是图**（magic bytes），不信 content-type 也不信 URL 后缀。
 *      贴里的图经常是 `.../thumb.jpeg?...&format=webp`，后缀和实际格式对不上。
 *   3. **大小上限**，默认 4MB。表情包用不着原图，太大直接丢。
 *   4. **MD5 去重**：同一张图在多个帖子里出现很常见，库里只留一份。
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adoptIntoLibrary, upsertIndex } from "../media/sticker-tool.js";
import { imageExtension } from "../transport/attachment.js";
/** 小黑盒图 CDN 域名白名单（后缀匹配，含子域） */
const ALLOWED_HOST_SUFFIXES = ['max-c.com', 'xiaoheihe.cn'];
/** 图片落到库里时的子目录（与群聊收集分开，便于她分辨来源） */
export const XHH_STICKER_DIR = '_小黑盒';
/** 默认上限：表情包用不着原图 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** 下载超时 */
const DOWNLOAD_TIMEOUT_MS = 15_000;
/** URL 是否属于允许的图床（纯函数，可单测） */
export function isAllowedImageUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        return false;
    }
    if (u.protocol !== 'https:')
        return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}
/**
 * 下载一张图并收进表情库。
 *
 * 注意：这个函数**不做语义判断**（"这图适不适合当表情包"是她的判断），
 * 只保证"下载安全 + 落库不重复 + 索引写对了"。
 */
export async function fetchIntoStickerLibrary(url, libraryRoot, meta, logger, opts = {}) {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const fetchImpl = opts.fetchImpl ?? fetch;
    if (!isAllowedImageUrl(url)) {
        return {
            ok: false,
            reason: url.startsWith('http:') ? 'not-https' : 'host-not-allowed',
            detail: '只接受小黑盒图床（*.max-c.com / *.xiaoheihe.cn）的 https 图片地址。',
        };
    }
    let buf;
    try {
        const resp = await fetchImpl(url, {
            headers: { Referer: 'https://www.xiaoheihe.cn/', 'User-Agent': 'Mozilla/5.0 Chrome/131' },
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        if (!resp.ok) {
            return { ok: false, reason: 'download-failed', detail: `HTTP ${resp.status}` };
        }
        // 先看声明长度，能省一次完整下载
        const declared = Number(resp.headers.get('content-length') ?? 0);
        if (declared > maxBytes) {
            return {
                ok: false,
                reason: 'too-large',
                detail: `图片 ${Math.round(declared / 1024)}KB，超过上限 ${Math.round(maxBytes / 1024)}KB。`,
            };
        }
        buf = Buffer.from(await resp.arrayBuffer());
    }
    catch (err) {
        return {
            ok: false,
            reason: 'download-failed',
            detail: err instanceof Error ? err.message : String(err),
        };
    }
    if (buf.length > maxBytes) {
        return {
            ok: false,
            reason: 'too-large',
            detail: `图片 ${Math.round(buf.length / 1024)}KB，超过上限 ${Math.round(maxBytes / 1024)}KB。`,
        };
    }
    // 按字节判断，不信 content-type / URL 后缀
    const ext = imageExtension(buf);
    if (!ext) {
        return { ok: false, reason: 'not-an-image', detail: '下的不是可识别的图片格式（gif/png/jpg/webp/bmp）。' };
    }
    let tmp;
    try {
        // 临时文件必须落在**库根之外**。
        // adoptIntoLibrary 遇到"已在库内"的路径会原样返回、不复制，
        // 如果把 tmp 建在 libraryRoot 里，索引就会指向一个临时文件（重启后被清掉 = 死链）。
        const tmpDir = join(tmpdir(), 'dsh-qqbot-xhh');
        mkdirSync(tmpDir, { recursive: true });
        tmp = join(tmpDir, `xhh_${Date.now()}${ext}`);
        writeFileSync(tmp, buf);
        // 文件名必须**只由内容决定**，但别把完整 MD5 塞进 stem：
        // adoptIntoLibrary 的目标名已经是 `md5前12位_stem.ext`，去重靠 `existsSync(dest)`。
        //   - stem 掺进 URL 主干/时间戳 → 同图换 URL 就是新文件，去重失效（测试抓到过）
        //   - stem 再放一次完整 MD5   → 名字变成 `md5前12_完整md5.jpg`，冗余且难认
        // 所以：去重由 adoptIntoLibrary 那 12 位前缀保证，stem 只负责可读性、用固定值。
        const localPath = adoptIntoLibrary(tmp, libraryRoot, logger, XHH_STICKER_DIR, 'xhh');
        const entry = {
            path: localPath,
            use: meta.timing,
            emo: meta.emotion ?? [],
            desc: meta.desc,
            text: meta.text ?? '',
            scene: XHH_STICKER_DIR,
            priority: 0,
        };
        const ok = upsertIndex(entry, libraryRoot, logger);
        if (!ok) {
            return { ok: false, reason: 'write-failed', detail: '图片已落盘但索引写入失败，检索不到。' };
        }
        logger.info(`im-qqbot: 小黑盒图片入库 ${localPath} use=${meta.timing.join(',')}`);
        return { ok: true, path: localPath, bytes: buf.length, ext };
    }
    catch (err) {
        return {
            ok: false,
            reason: 'write-failed',
            detail: err instanceof Error ? err.message : String(err),
        };
    }
    finally {
        // 只在确实产出临时文件时删；删不掉不算失败（系统 tmp 会自己清）
        if (tmp) {
            try {
                unlinkSync(tmp);
            }
            catch {
                /* 已被 adoptIntoLibrary 换名或本就不存在 */
            }
        }
    }
}
/** 内容 MD5（供去重/日志用；纯函数） */
export function contentMd5(buf) {
    return createHash('md5').update(buf).digest('hex');
}
/** 从一批 URL 里挑出合法的（给工具层做预筛，避免逐个报错） */
export function filterAllowedImageUrls(urls) {
    const ok = [];
    const rejected = [];
    for (const u of urls) {
        (isAllowedImageUrl(u) ? ok : rejected).push(u);
    }
    return { ok, rejected };
}
/** 从本地读取图片字节（测试/校验用，避免重复实现嗅探） */
export function readImageExt(path) {
    try {
        return imageExtension(readFileSync(path));
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=images.js.map