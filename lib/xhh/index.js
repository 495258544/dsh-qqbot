import { XhhClient, XhhError, hashFromShareUrl, normalizePostRef, parseRichText } from "./client.js";
/** 配置默认值（上层 Schema 直接复用，避免两处写死不同数字） */
export const DEFAULT_XHH_CONFIG = {
    enabled: true,
    timeoutMs: 10_000,
    throttleWindowMs: 10 * 60_000,
    throttleMaxCalls: 5,
    defaultLimit: 8,
    maxLimit: 20,
    commentLimit: 12,
};
/** 补齐缺省字段（逐字段兜底，显式 undefined 也回落默认） */
export function resolveXhhConfig(partial) {
    const src = partial ?? {};
    const pick = (key) => {
        const value = src[key];
        return value === undefined ? DEFAULT_XHH_CONFIG[key] : value;
    };
    return {
        enabled: pick('enabled'),
        timeoutMs: pick('timeoutMs'),
        throttleWindowMs: pick('throttleWindowMs'),
        throttleMaxCalls: pick('throttleMaxCalls'),
        defaultLimit: pick('defaultLimit'),
        maxLimit: pick('maxLimit'),
        commentLimit: pick('commentLimit'),
    };
}
/** 工厂 */
export function createXhhClient(config, logger) {
    const c = resolveXhhConfig(config);
    return new XhhClient({
        logger,
        timeoutMs: c.timeoutMs,
        throttleWindowMs: c.throttleWindowMs,
        throttleMaxCalls: c.throttleMaxCalls,
    });
}
export { registerXhhTools } from "./tools.js";
export { XhhClient, XhhError, hashFromShareUrl, normalizePostRef, parseRichText, };
//# sourceMappingURL=index.js.map