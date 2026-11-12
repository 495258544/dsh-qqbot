/**
 * OpenDota 解析预热 —— 凌晨把昨天的比赛提前请求一遍
 * ─────────────────────────────────────────────────────────────
 * 为什么需要（2026-11-06 用户点破 + 当天实测验证）：
 *
 *   OpenDota 的比赛解析是**按需的**：一场比赛只有在第一次被请求后才会入队解析。
 *   这个群全打技能征召，白天的战绩查询/播报经常需要「这局拿了什么技能」，
 *   而 `ability_uses` / `teamfights` 恰恰是解析的最后一步 ——
 *   局后半天到一天内查，拿到的都是"半解析"数据（KDA 有、技能没有）。
 *   实锤案例：11-05 小周 PA 那局（9075953759）局后 12 小时还是半解析，
 *   第二天有人问起，工具拿不到技能段，她只能按英雄默认印象编了个
 *   "钩子拉得太准"——而那局根本没抽到肉钩。
 *
 *   解法：凌晨 3 点（用户指定）把所有人昨天打过的局逐场请求一遍。
 *   请求本身就会让 OpenDota 入队解析，到白天查询时数据就齐了。
 *
 * 2026-11-10 03:00 事故与本次加固：
 *   · 当晚 6 个人的 recentMatches 全部「超时 8000ms」，日志却照样打
 *     「预热完成 6 人 0 场（…白天查询就有完整技能/团战数据）」。
 *     → 超时改成预热专用 20s + 最多 2 次指数退避重试（群聊查询不受影响）；
 *     → `warmRecent()` 返回**真的请求成功的场数**，日志按成功数分级，
 *       0 场就明说 0 场，绝不承诺"有数据"。
 *   · 11-09 一天热重载 11 次，03:00 窗口内出现 4~5 轮「预热完成」。
 *     原来的 `running` / `lastDay` 是闭包变量，实例间不共享；
 *     bootstrap 的 `stop()` 只能停当前实例，旧 setInterval 还活着。
 *     → 改用**文件锁 + 落盘状态**，状态以数据目录为准，跨实例、跨进程都幂等。
 *   · 落盘按账号记成功/失败：整批抖动后只补失败的账号，不重复打已经成功的人；
 *     失败账号冷却 5 分钟后再自动重试（3 点窗口有 59 分钟，够重试很多次）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_TZ, dayInTz, hourInTz } from "../shared/clock.js";
const STEAM_ID64_BASE = 76561197960265728n;
const STATE_FILE = 'dota-warmup.json';
const LOCK_FILE = 'dota-warmup.lock';
/** 锁超过这么久没动 = 上个进程被杀留下的僵尸锁，可以抢 */
const LOCK_STALE_MS = 10 * 60_000;
export const DEFAULT_WARMUP_CONFIG = {
    enabled: true,
    hour: 3,
    withinHours: 30,
    tz: DEFAULT_TZ,
    timeoutMs: 20_000,
    retries: 2,
    retryBaseDelayMs: 500,
    retryCooldownMs: 5 * 60_000,
};
function blankState(day) {
    return { version: 1, day, people: {}, failed: {}, at: 0 };
}
function readState(file, day, logger) {
    try {
        const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1 || parsed.day !== day) {
            return blankState(day);
        }
        const people = {};
        const srcPeople = parsed.people;
        if (srcPeople !== null && typeof srcPeople === 'object') {
            for (const [key, value] of Object.entries(srcPeople)) {
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                    people[key] = Math.floor(value);
                }
            }
        }
        const failed = {};
        const srcFailed = parsed.failed;
        if (srcFailed !== null && typeof srcFailed === 'object') {
            for (const [key, value] of Object.entries(srcFailed)) {
                if (typeof value === 'string')
                    failed[key] = value.slice(0, 200);
            }
        }
        return {
            version: 1,
            day,
            people,
            failed,
            at: typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : 0,
        };
    }
    catch (err) {
        const code = err.code;
        if (code !== 'ENOENT') {
            logger.warn(`dota-warmup: 状态文件读取失败，按空处理（${err instanceof Error ? err.message : String(err)}）`);
        }
        return blankState(day);
    }
}
/** 原子写：先写 .tmp 再 rename，进程被杀也不会留半个 JSON */
function writeState(file, state, logger) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
        fs.renameSync(tmp, file);
    }
    catch (err) {
        logger.warn(`dota-warmup: 状态落盘失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/** 独占创建锁文件；僵尸锁（>10 分钟）清理后重抢一次 */
function acquireLock(lockFile, now, logger, depth = 0) {
    try {
        const fd = fs.openSync(lockFile, 'wx');
        try {
            fs.writeSync(fd, String(now));
        }
        finally {
            fs.closeSync(fd);
        }
        return true;
    }
    catch (err) {
        if (err.code !== 'EEXIST') {
            logger.warn(`dota-warmup: 抢锁失败（跳过本轮）: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
        if (depth >= 1)
            return false;
        try {
            const stat = fs.statSync(lockFile);
            // 锁的 mtime 是**真实时钟**，而 tick(nowTs) 在测试里可能传伪造时间；
            // 用真实 Date.now() 判僵尸，伪造时间不会误清别人的锁。
            if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
                fs.rmSync(lockFile, { force: true });
                return acquireLock(lockFile, now, logger, depth + 1);
            }
        }
        catch {
            return false;
        }
        return false;
    }
}
function releaseLock(lockFile) {
    try {
        fs.rmSync(lockFile, { force: true });
    }
    catch {
        // 删不掉也只是让下一轮抢不到锁，10 分钟后僵尸锁会自动清
    }
}
export function createDotaWarmup(deps) {
    // Partial 输入 + 内部兜底：上层（Schema / 旧 profile）少传字段不崩
    const cfg = {
        enabled: deps.config.enabled ?? DEFAULT_WARMUP_CONFIG.enabled,
        hour: deps.config.hour ?? DEFAULT_WARMUP_CONFIG.hour,
        withinHours: deps.config.withinHours ?? DEFAULT_WARMUP_CONFIG.withinHours,
        tz: deps.config.tz ?? DEFAULT_WARMUP_CONFIG.tz,
        timeoutMs: deps.config.timeoutMs ?? DEFAULT_WARMUP_CONFIG.timeoutMs,
        retries: deps.config.retries ?? DEFAULT_WARMUP_CONFIG.retries,
        retryBaseDelayMs: deps.config.retryBaseDelayMs ?? DEFAULT_WARMUP_CONFIG.retryBaseDelayMs,
        retryCooldownMs: deps.config.retryCooldownMs ?? DEFAULT_WARMUP_CONFIG.retryCooldownMs,
    };
    const dir = deps.dataDir !== undefined && deps.dataDir !== ''
        ? deps.dataDir
        : path.join(os.homedir(), '.dsh-qqbot', 'dota');
    const stateFile = path.join(dir, STATE_FILE);
    const lockFile = path.join(dir, LOCK_FILE);
    const policy = {
        timeoutMs: cfg.timeoutMs,
        retries: cfg.retries,
        retryBaseDelayMs: cfg.retryBaseDelayMs,
    };
    let timer;
    async function tick(nowTs) {
        if (!cfg.enabled)
            return { ran: false, people: 0, matches: 0, reason: 'disabled' };
        const now = Number(nowTs ?? Date.now()) || Date.now();
        if (hourInTz(new Date(now), cfg.tz) !== cfg.hour) {
            return { ran: false, people: 0, matches: 0, reason: 'not-window' };
        }
        const today = dayInTz(new Date(now), cfg.tz);
        // 同一个 steamId 只预热一次（主号+小号可能绑同一个 Steam，别重复打）
        const seen = new Set();
        const accounts = deps.bindings().filter((b) => {
            if (seen.has(b.steamId))
                return false;
            seen.add(b.steamId);
            return true;
        });
        const state = readState(stateFile, today, deps.logger);
        if (accounts.length === 0) {
            state.at = now;
            writeState(stateFile, state, deps.logger);
            deps.logger.info('dota-warmup: 今日预热完成 0 人 —— 没有绑定账号，无需触发解析');
            return { ran: true, people: 0, matches: 0 };
        }
        const pending = accounts.filter((a) => !(a.steamId in state.people));
        if (pending.length === 0) {
            return { ran: false, people: 0, matches: 0, reason: 'already-ran' };
        }
        const failedHere = accounts.filter((a) => a.steamId in state.failed).length;
        if (failedHere > 0 && now - state.at < cfg.retryCooldownMs) {
            return { ran: false, people: 0, matches: 0, reason: 'cooldown' };
        }
        if (!acquireLock(lockFile, now, deps.logger)) {
            return { ran: false, people: 0, matches: 0, reason: 'already-running' };
        }
        try {
            // 拿锁后重读：另一个实例可能刚好在抢锁前写完了状态
            const fresh = readState(stateFile, today, deps.logger);
            const todo = accounts.filter((a) => !(a.steamId in fresh.people));
            if (todo.length === 0) {
                return { ran: false, people: 0, matches: 0, reason: 'already-ran' };
            }
            // 同一场比赛被多个绑定群友打过时只触发一次解析：
            // 去重集合跨所有账号共享，日志里的场数也不再把同一场重复计 N 遍。
            const seenMatches = new Set();
            for (const a of todo) {
                try {
                    const accountId = Number(BigInt(a.steamId) - STEAM_ID64_BASE);
                    const n = await deps.service.warmRecent(accountId, cfg.withinHours, policy, seenMatches);
                    fresh.people[a.steamId] = n;
                    delete fresh.failed[a.steamId];
                }
                catch (err) {
                    // 单人失败不中断：预热是锦上添花，状态里留痕让下一轮只补他
                    const reason = err instanceof Error ? err.message : String(err);
                    fresh.failed[a.steamId] = reason;
                    deps.logger.warn(`dota-warmup: ${a.alias ?? a.steamId} 预热失败（留待重试）: ${reason}`);
                }
            }
            fresh.at = now;
            writeState(stateFile, fresh, deps.logger);
            const okPeople = accounts.filter((a) => a.steamId in fresh.people).length;
            const failedPeople = accounts.length - okPeople;
            const matches = accounts.reduce((n, a) => n + (fresh.people[a.steamId] ?? 0), 0);
            if (failedPeople > 0) {
                const mins = Math.max(1, Math.round(cfg.retryCooldownMs / 60_000));
                deps.logger.warn(`dota-warmup: 今日预热未完成 ${okPeople}/${accounts.length} 人成功、${failedPeople} 人失败；`
                    + `成功触发 ${matches} 场。失败账号的比赛今晚可能没被触发解析，白天查技能仍可能是半解析；`
                    + `${mins} 分钟后只补失败账号`);
            }
            else if (matches === 0) {
                deps.logger.info(`dota-warmup: 今日预热完成 ${okPeople} 人，最近 ${cfg.withinHours}h 内 0 场比赛`
                    + ' —— 无需触发解析（不是失败，也没有新数据可预热）');
            }
            else {
                deps.logger.info(`dota-warmup: 预热完成 ${okPeople} 人 ${matches} 场（按 match_id 去重后触发 OpenDota 解析，白天查询可拿到完整技能/团战数据）`);
            }
            return { ran: true, people: accounts.length, matches };
        }
        finally {
            releaseLock(lockFile);
        }
    }
    function start() {
        if (timer !== undefined)
            return;
        timer = setInterval(() => {
            void tick().catch((err) => {
                deps.logger.warn(`dota-warmup: tick 异常（忽略）: ${err instanceof Error ? err.message : String(err)}`);
            });
        }, 60_000);
    }
    function stop() {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    }
    return { tick, start, stop };
}
//# sourceMappingURL=warmup.js.map