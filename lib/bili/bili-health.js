/**
 * bili CLI 输出字段自检（M36）
 * ─────────────────────────────────────────────────────────────
 * ## 解决什么问题
 *
 * 我们对 `bili` 的**输出字段**有依赖。比如字幕靠 `data.items[].from`（时间轴），
 * 合集靠 `data.pages[].title`。`bili` 升级时如果字段改名或删掉，
 * 我们会**静默拿到 undefined** —— 功能悄悄坏掉，日志里什么都没有。
 *
 * 这个仓库已经因为"静默失效"吃过太多次亏：
 *   · `decayInterests` 写了从没被调用
 *   · `isToolMissing` 把"命令没找到"当"工具不存在"静默掉
 *   · 时区注释说"容器没 tzdata"，实际只是没设 TZ
 * 共同点是**坏了以后不响**。自检的目的就是让它响。
 *
 * ## 设计取舍
 *
 * · **不阻塞启动**：检查失败只记 warn，不抛异常、不阻止插件加载。
 *   理由：bili 挂了不该让她整个不能用（聊天/日记/记忆都不依赖它）。
 * · **检查的是"字段还在不在"，不是"值对不对"**：
 *   值随视频变，字段名是契约。
 * · **空数组算通过**：很多视频没弹幕（实测 10.5 小时的教学合集只有 15 条且时间轴全 0），
 *   `peaks: []` 是正常结果，不是字段缺失。
 * · **`run` 可注入**：测试不用真的调 bili，也不依赖网络。
 */
import { execFileSync } from 'node:child_process';
/**
 * 检查用的样本视频。
 *
 * 选 `BV1ednc6jE3j`：它有 AI 字幕（实测 165 句）、有弹幕时间轴（60/66），
 * 是这三个样本里唯一同时具备的。
 * 用固定 BV 是因为自检要**可复现** —— 随机取热门视频会时快时慢、时有时无。
 */
const SAMPLE_BV = 'BV1ednc6jE3j';
/** 默认依赖清单 */
export const BILI_DEPS = [
    {
        // 最关键的一项：字幕的时间轴
        // 没有它，"哪几分钟讲到东西"就退化成"整段倒出来"——那正是用户抱怨的东西
        what: '字幕逐句时间轴（items[].from / content）',
        args: ['video', 'subtitle', SAMPLE_BV],
        probe: (data) => {
            const items = data?.items;
            if (!Array.isArray(items) || items.length === 0)
                return undefined;
            const first = items[0];
            if (first?.from === undefined || first?.content === undefined)
                return undefined;
            return items.length;
        },
    },
    {
        // 集目录：四十集看不过来时的第一层答案
        what: '视频分 P 目录（pages[].title / duration）',
        args: ['video', 'info', SAMPLE_BV],
        probe: (data) => {
            const d = data;
            if (d?.title === undefined)
                return undefined;
            const pages = d.pages;
            if (!Array.isArray(pages) || pages.length === 0)
                return undefined;
            const p = pages[0];
            if (p?.title === undefined || p?.duration === undefined)
                return undefined;
            return pages.length;
        },
    },
    {
        // AI 总结的分章提纲（带秒级时间点）—— 有就直接用，质量最好
        // 注意：不是所有视频都有 AI 总结，所以这里只查"字段形状"，
        // `not_found` 是正常结果，不该算失败（由 probe 返回 undefined 表示"没这个字段"）
        what: 'AI 总结（summary）',
        args: ['video', 'summary', SAMPLE_BV],
        probe: (data) => {
            const s = data?.summary;
            return typeof s === 'string' && s.length > 0 ? s.length : undefined;
        },
    },
    {
        // 弹幕高能时刻：**是数组就算通过**，空数组也通过（很多视频没弹幕）
        what: '弹幕 peaks（peaks 数组）',
        args: ['video', 'danmaku', SAMPLE_BV, '--peaks', '5'],
        probe: (data) => {
            const peaks = data?.peaks;
            return Array.isArray(peaks) ? peaks.length : undefined;
        },
    },
];
/** 默认执行器 */
function makeRunner(timeoutMs) {
    return (args) => {
        const out = execFileSync('bili', args, {
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
        });
        return JSON.parse(out);
    };
}
/**
 * 跑一遍全部检查。
 *
 * **永不抛异常**：任何一项失败只影响它自己，其它项照常检查。
 * 返回空数组 = 全部正常。
 */
export function checkBiliHealth(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const run = opts.run ?? makeRunner(timeoutMs);
    const issues = [];
    for (const dep of BILI_DEPS) {
        try {
            const res = run(dep.args);
            if (res === undefined || res === null || typeof res !== 'object') {
                issues.push({ what: dep.what, args: dep.args, reason: 'command-failed', detail: '没有返回 JSON' });
                continue;
            }
            if (res.ok === false) {
                // bili 的失败是结构化的：{ok:false, error:{code,message,hint}}
                issues.push({
                    what: dep.what,
                    args: dep.args,
                    reason: 'not-ok',
                    detail: String(res.error?.message ?? 'ok=false'),
                });
                continue;
            }
            const v = dep.probe(res.data);
            if (v === undefined) {
                issues.push({
                    what: dep.what,
                    args: dep.args,
                    reason: 'missing-field',
                    detail: '字段不存在或形状变了（bili 可能升级改了输出）',
                });
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isTimeout = /ETIMEDOUT|timed? ?out|SIGTERM/i.test(msg);
            issues.push({
                what: dep.what,
                args: dep.args,
                reason: isTimeout ? 'timeout' : 'command-failed',
                detail: msg.slice(0, 200),
            });
        }
    }
    return issues;
}
/** 给日志用的一句话摘要 */
export function formatHealthIssues(issues) {
    if (!issues.length)
        return '';
    return issues
        .map((i) => `[${i.reason}] ${i.what}：${i.detail}`)
        .join('；');
}
//# sourceMappingURL=bili-health.js.map