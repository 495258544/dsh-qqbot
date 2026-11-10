/**
 * B 站 CLI 调用层（平台模块 src/bili/ 的内部实现）
 * ─────────────────────────────────────────────────────────────
 * 2026-11-10 从 persona/tools.ts 整块搬出，代码逐字未改。
 * 聊天核心不再 import 本文件；接线只在 bootstrap.ts。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * 找 bili 可执行文件。
 *
 * 为什么不能只依赖 PATH：`pip install bili-agent` 装出来的脚本落在
 * Python 的 `Scripts` 目录里，而 WorkBuddy 内置的那个 Python 目录
 * **默认不在 PATH**（实测 `C:\Users\...\.workbuddy\binaries\python\versions\3.13.12\Scripts`）。
 * 宿主进程的 PATH 又是启动时的快照，加了也不用，只能重启。
 *
 * 所以这里主动扫一遍常见位置；成功的结果缓存（免每轮 stat 一堆路径），
 * 失败不缓存 —— 这样**装完 bili 下一句话就能用，不用重启**。
 */
function biliCommand() {
    if (cachedBili !== undefined)
        return cachedBili;
    const exe = process.platform === 'win32' ? 'bili.exe' : 'bili';
    const candidates = [];
    const envBin = process.env.BILI_BIN;
    if (envBin)
        candidates.push(envBin);
    // WorkBuddy 内置 Python：版本号不固定，扫一遍
    const wbPy = join(homedir(), '.workbuddy', 'binaries', 'python', 'versions');
    try {
        for (const v of readdirSync(wbPy))
            candidates.push(join(wbPy, v, 'Scripts', exe));
    }
    catch { /* 没这个目录就算了 */ }
    candidates.push(join(homedir(), 'AppData', 'Roaming', 'Python', 'Scripts', exe), 'C:\\Python315\\Scripts\\' + exe, 'C:\\Python314\\Scripts\\' + exe, 'C:\\Python313\\Scripts\\' + exe, join(homedir(), '.local', 'bin', exe));
    for (const c of candidates) {
        try {
            if (c && existsSync(c)) {
                cachedBili = c;
                return c;
            }
        }
        catch { /* 权限问题就跳过 */ }
    }
    // 找不到就交给 PATH，让 execFileSync 抛 ENOENT → 上层报 no_bili
    return 'bili';
}
let cachedBili;
export function runBili(argv, timeoutMs = 60_000) {
    try {
        const out = execFileSync(biliCommand(), argv, {
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
        });
        try {
            return JSON.parse(out);
        }
        catch {
            return { ok: false, error: { code: 'bad_json', message: 'bili 返回的不是合法 JSON' } };
        }
    }
    catch (err) {
        // 命令不存在 / 超时 / 非零退出：都不抛，让调用方走"拿不到内容"分支。
        // bili 失败时也会输出 JSON（{ok:false,error}），但 execFileSync 对非零退出抛异常，
        // 所以这里要把 stdout 再捞一次。
        const e = err;
        if (e?.stdout) {
            try {
                return JSON.parse(e.stdout);
            }
            catch { /* 不是 JSON */ }
        }
        // 分不清"bili 没装"和"视频不存在"是最坑的：上层只能说"没查到"，
        // 模型于是自己编。这里把三种情况分开，让上层能说人话。
        let code = 'spawn_failed';
        if (e?.code === 'ENOENT')
            code = 'no_bili';
        else if (e?.killed || e?.signal)
            code = 'timeout';
        const message = code === 'no_bili'
            ? 'bili 命令不存在（没安装，或不在 PATH 里）'
            : code === 'timeout'
                ? `bili 超时（${Math.round(timeoutMs / 1000)}s）`
                : String(e?.message ?? '执行失败');
        return { ok: false, error: { code, message } };
    }
}
/** 把 BiliResult 的失败翻译成"她能照着说"的一句话；成功返回空串 */
export function biliFailure(r, what) {
    const code = String(r.error?.code ?? '');
    const msg = String(r.error?.message ?? '');
    if (code === 'no_bili')
        return `${what}不了：这台机器上没装 bili（B 站命令行工具）。不是你搜得不对，是工具不可用 —— 直接说明查不了，别编。`;
    if (code === 'not_logged_in' || /-101|账号未登录/.test(msg)) {
        return `${what}需要登录 B 站（这台机器还没扫码登录）。跟他说"这个得先登录才能看"，别自己编内容。`;
    }
    if (code === 'timeout')
        return `${what}超时了（${msg}），过一会儿再试。`;
    if (code === 'bad_json')
        return `${what}失败：返回格式不对（bili 版本可能变了）。`;
    return `${what}失败：${code || '未知错误'}${msg ? ` - ${msg}` : ''}`;
}
//# sourceMappingURL=cli.js.map