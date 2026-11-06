import { DEFAULT_TZ, dayInTz, hourInTz } from "../persona/clock.js";
export const DEFAULT_WARMUP_CONFIG = {
    enabled: true,
    hour: 3,
    withinHours: 30,
    tz: DEFAULT_TZ,
};
export function createDotaWarmup(deps) {
    // Partial 输入 + 内部兜底：上层（Schema / 旧 profile）少传字段不崩
    const cfg = {
        enabled: deps.config.enabled ?? true,
        hour: deps.config.hour ?? 3,
        withinHours: deps.config.withinHours ?? 30,
        tz: deps.config.tz ?? DEFAULT_TZ,
    };
    let timer;
    let running = false;
    /** 当天已跑过就不再跑（内存即可：重启最多重复一遍，请求幂等） */
    let lastDay = '';
    async function tick(nowTs) {
        if (!cfg.enabled)
            return { ran: false, people: 0, matches: 0, reason: 'disabled' };
        if (running)
            return { ran: false, people: 0, matches: 0, reason: 'already-running' };
        const now = Number(nowTs ?? Date.now()) || Date.now();
        if (hourInTz(new Date(now), cfg.tz) !== cfg.hour) {
            return { ran: false, people: 0, matches: 0, reason: 'not-window' };
        }
        const today = dayInTz(new Date(now), cfg.tz);
        if (lastDay === today)
            return { ran: false, people: 0, matches: 0, reason: 'already-ran' };
        running = true;
        try {
            // 同一个 steamId 只预热一次（一个 QQ 号只绑一个 Steam；万一有重复绑定也不多打）
            const seen = new Set();
            const accounts = deps.bindings().filter((b) => {
                if (seen.has(b.steamId))
                    return false;
                seen.add(b.steamId);
                return true;
            });
            let matches = 0;
            for (const a of accounts) {
                const accountId = Number(BigInt(a.steamId) - 76561197960265728n);
                try {
                    matches += await deps.service.warmRecent(accountId, cfg.withinHours);
                }
                catch (err) {
                    // 单人失败不中断：预热是锦上添花，别因为一个账号把整批拖死
                    deps.logger.warn(`dota-warmup: ${a.alias ?? a.steamId} 预热失败（跳过）: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            lastDay = today;
            deps.logger.info(`dota-warmup: 预热完成 ${accounts.length} 人 ${matches} 场（触发 OpenDota 解析，白天查询就有完整技能/团战数据）`);
            return { ran: true, people: accounts.length, matches };
        }
        finally {
            running = false;
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