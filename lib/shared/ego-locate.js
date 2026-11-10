/**
 * ego 浏览器（agent 浏览器）的定位 —— 可选依赖，缺失时优雅降级
 * ─────────────────────────────────────────────────────────────
 * ## 为什么单独一个文件
 *
 * `surf.ts` 里原来把 ego 的路径**硬编码**成
 *   `/root/.dsh/profiles/web/node_modules/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs`
 * 那是 Linux 部署位置的快照，不是依赖声明：profile 名一改、换 DSH_HOME、
 * 或者跑在 Windows 上，这行路径就指向不存在的文件，而且是**静默失败**。
 *
 * `dsh-ego-browser` 是装进 profile 的宿主插件，与我们是平级邻居，
 * 不是本插件的依赖（`require.resolve` 从本包解析不到）。所以正确做法是：
 *   1. 用 `getProfileDir()` 找到 profile 目录；
 *   2. 从 profile 的 `package.json` 起 `createRequire` 解析包的真实路径
 *      （用模块解析而不是拼 `node_modules/...`，pnpm 嵌套/软链布局都能过）；
 *   3. 拿不到就返回 `undefined`，让调用方自己决定降级行为。
 *
 * ## 这个包是**可选**的
 *
 * 没有它，聊天、日记、记忆、B 站、Steam/Dota 全都照常工作；
 * 受影响的只有「深度抓正文」（surf Layer 2）。
 * 因此不能写成硬依赖，也不能在缺席时抛 ENOENT。
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProfileDir } from "./utils.js";
/** 包内的两个关键文件（相对包根） */
const BIN_REL = 'runtime/ego-linux/bin/ego-browser.mjs';
const CHROME_REL = 'bin/ego-chrome-wrapper.sh';
/** 进程内缓存：解析一次就够了，profile 不会在运行期搬家 */
let cached;
/**
 * 找到 ego 浏览器。
 *
 * @param opts.profileDir 指定 profile（测试用）；缺省走 `getProfileDir()`
 * @param opts.fresh  true = 不走缓存
 * @returns 找不到时返回 `undefined`（**不是抛错** —— 这是可选能力）
 */
export function locateEgo(opts = {}) {
    if (!opts.fresh && cached !== undefined)
        return cached ?? undefined;
    const found = doLocate(opts.profileDir);
    cached = found ?? null;
    return found;
}
/** 清空缓存（测试/诊断用；也用于 profile 切换后重新探测） */
export function resetEgoCache() {
    cached = undefined;
}
function doLocate(explicitProfileDir) {
    const profileDir = explicitProfileDir ?? getProfileDir();
    if (!profileDir)
        return undefined;
    // 从 profile 的 package.json 起解析 —— profile 可能没有 package.json（全新），
    // 那就退回用 profile 目录本身当基准，node 也会从 node_modules 往上找
    const anchor = existsSync(resolve(profileDir, 'package.json'))
        ? resolve(profileDir, 'package.json')
        : profileDir;
    let pkgJson;
    try {
        const req = createRequire(anchor);
        pkgJson = req.resolve('dsh-ego-browser/package.json');
    }
    catch {
        return undefined;
    }
    // pkgJson = <root>/package.json，求包根
    const root = resolve(pkgJson, '..');
    const bin = resolve(root, BIN_REL);
    const chrome = resolve(root, CHROME_REL);
    // 两个文件都必须真实存在：只有 package.json 但 runtime 没铺好也算没装好
    if (!existsSync(bin) || !existsSync(chrome))
        return undefined;
    return { bin, chrome, root };
}
/** 人类可读的「为什么没有」—— 让上层能说清是没装还是没配 */
export function egoUnavailableHint() {
    return '没找到 dsh-ego-browser（agent 浏览器）。它在这个插件里是**可选**依赖：'
        + '装上它之后「深度冲浪抓正文」才可用；'
        + '不装也不影响聊天、日记、记忆、B 站与 Steam/Dota 查询。';
}
//# sourceMappingURL=ego-locate.js.map