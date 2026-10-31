import { HERO_COUNT, HERO_IDS, heroName, heroNameEn, isKnownHero } from "./heroes.js";
import { OpenDotaApi, OpenDotaError, accountIdToSteamId, isWin, rankTierText, steamIdToAccountId, } from "./opendota.js";
import { DotaService, } from "./service.js";
import { registerDotaTools } from "./tools.js";
/** 配置默认值（上层 Schema 可直接复用，避免两处写死不同数字） */
export const DEFAULT_DOTA_CONFIG = {
    enabled: true,
    cacheTtlSec: 180,
    timeoutMs: 8000,
    defaultLimit: 5,
    maxLimit: 20,
    rateLimitPerMin: 50,
    includeWinLoss: true,
};
/** 补齐缺省字段：容许上层只传部分配置（Schema 演化时不会因为少一个字段就崩） */
export function resolveDotaConfig(partial) {
    const src = partial ?? {};
    // 逐字段兜底而不是 {...默认, ...partial}：后者遇到显式 undefined 会把默认值也覆盖掉
    const pick = (key) => {
        const value = src[key];
        return value === undefined ? DEFAULT_DOTA_CONFIG[key] : value;
    };
    return {
        enabled: pick('enabled'),
        cacheTtlSec: pick('cacheTtlSec'),
        timeoutMs: pick('timeoutMs'),
        defaultLimit: pick('defaultLimit'),
        maxLimit: pick('maxLimit'),
        rateLimitPerMin: pick('rateLimitPerMin'),
        includeWinLoss: pick('includeWinLoss'),
    };
}
/** 工厂：上层拿到 config.dota 后直接 createDotaService(config.dota, logger) */
export function createDotaService(config, logger) {
    return new DotaService({ config: resolveDotaConfig(config), logger });
}
// ── 账号换算（实现在 opendota.ts，这里只是统一出口） ─────────
export { steamIdToAccountId, accountIdToSteamId };
export { DotaService, registerDotaTools, heroName, heroNameEn, isKnownHero, HERO_IDS, HERO_COUNT, OpenDotaApi, OpenDotaError, isWin, rankTierText, };
//# sourceMappingURL=index.js.map