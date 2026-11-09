/**
 * Bilibili 平台模块 — 对外出口
 *
 * B 站的主体接入走官方 MCP（cordis.patch.yml 里配的 mcp-bili），不占本插件代码；
 * 这里只有**输出字段自检**（bili-health）：我们对字幕 from、pages title 这些字段
 * 有依赖，bili 升级改了输出时第一时间报警，而不是等她在聊天里露馅。
 *
 * 模块边界：聊天/日记/记忆都不依赖 bili，它挂了不该让她整个不能用。
 */
export { checkBiliHealth, formatHealthIssues, BILI_DEPS } from "./bili-health.js";
//# sourceMappingURL=index.js.map