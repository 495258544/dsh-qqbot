/**
 * ops/upstream-watch CLI —— profile.d 兜底入口
 * ─────────────────────────────────────────────────────────────
 * 为什么要它：插件内的 setInterval 只在**进程活着**时有效。容器无 cron/systemd，
 * 若宿主长时间不启动/机器人掉线，巡检就断了。这个 CLI 复用**同一套模块逻辑**
 * （不是再抄一份 shell），由 `/etc/profile.d` 在登录时拉起一个常驻循环。
 *
 * 与插件的关系：
 *   - 两者共用同一个 stateDir 与同一把 `.lock` → **不会重复巡检**
 *   - `stateDir/state.json` 的 `lastRunDay` 是"今天跑过没"的唯一判据
 *   - 插件在跑时 CLI 的 tick 只会返回 locked / already-ran-today
 *
 * 用法：
 *   node lib/ops/cli.js --once                 # 立刻跑一次（手动触发，忽略窗口）
 *   node lib/ops/cli.js --watch                # 常驻循环（自判断北京 05:00 窗口）
 *   node lib/ops/cli.js --snapshot             # 只读：打印当前状态
 *   node lib/ops/cli.js --once --notify=0      # 不推通知
 */
import { createUpstreamWatch, makeBridgeNotifier, renderReport } from "./upstream-watch.js";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
function arg(name, dflt = '') {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
}
function flag(name) {
    return process.argv.includes(`--${name}`);
}
const repo = arg('repo') || process.env.UW_REPO || '/root/Documents/deepseek-harness/default-workspace/dsh-qqbot';
const stateDir = arg('state-dir') || process.env.UW_STATE_DIR || path.join(os.homedir(), '.dsh-qqbot', 'ops', 'upstream-watch');
const notifyOn = arg('notify', '1') !== '0';
const opts = {
    repo,
    stateDir,
    apiRepo: arg('api-repo', 'tencent-connect/dsh-qqbot'),
    runHour: Number(arg('run-hour', '5')),
    windowMinutes: Number(arg('window', '45')),
    apiToken: process.env.GITHUB_TOKEN ?? '',
    notify: notifyOn ? makeBridgeNotifier() : undefined,
    log: (m) => console.log(`[${new Date().toISOString()}] [upstream-watch]`, m),
};
const w = createUpstreamWatch(opts);
if (flag('snapshot')) {
    const s = w.snapshot();
    console.log(JSON.stringify(s, null, 2));
    process.exit(0);
}
if (flag('once')) {
    const s = await w.runNow();
    console.log(`\n报告: ${s.reportPath}`);
    console.log(fs.readFileSync(s.reportPath, 'utf8'));
    process.exit(s.ok ? 0 : 1);
}
if (flag('watch')) {
    // 常驻：只做窗口判定，不 sleep 死等；tick 内部有 flock 语义的 mkdir 锁
    const everyMs = Number(arg('every-ms', String(5 * 60 * 1000)));
    console.log(`[upstream-watch] 常驻启动 repo=${repo} state=${stateDir} 每 ${everyMs / 1000}s 看一次窗口`);
    w.start();
    const keepAlive = setInterval(() => {
        /* 保持进程存活 */
    }, 60 * 1000);
    const stop = () => {
        clearInterval(keepAlive);
        w.stop();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
else {
    console.log('用法: --once | --watch | --snapshot');
    process.exit(2);
}
// 让 renderReport 保持被引用（避免 tree-shake 掉 CLI 里的报告用法）
void renderReport;
//# sourceMappingURL=cli.js.map