/**
 * 共享工具层
 */
export { getProfileDir, resolveEnv, formatRelativeTime, buildUserAgent, PLUGIN_VERSION } from "./utils.js";
export { getScopePeer } from "./scope.js";
export { PLUGIN_HOME, resolveAgentCwd } from "./dirs.js";
export { sendMarkdownChunked } from "./send-helper.js";
export { BOT_SELF_ID_FALLBACK, BOT_SELF_NAME, resolveBotSelfId, rememberOwnSend, md5OfFile } from "./attribution-out.js";
export { locateEgo, resetEgoCache, egoUnavailableHint } from "./ego-locate.js";
//# sourceMappingURL=index.js.map