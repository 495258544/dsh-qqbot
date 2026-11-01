/**
 * Steam 集成（查群友状态 / 最近游戏）
 * ─────────────────────────────────────────────────────────────
 * 只读 Web API，不登录任何 Steam 账号，不碰密码与 Steam Guard。
 * 数据边界由对方隐私设置决定：Steam 把「游戏详情」默认设为「仅好友」，
 * 这类账号只能看到昵称和在线状态，看不到在玩什么 —— 这是设计，不是故障。
 */
export { SteamService } from "./service.js";
export { registerSteamTools } from "./tools.js";
export { BindingStore } from "./bindings.js";
export { SteamApi, SteamApiError, personaStateText } from "./steam-api.js";
export { parseSteamInput, isSteamId64, steam64ToSteam2, steam64ToSteam3, steamProfileUrl, steamGameIconUrl, } from "./steam-id.js";
//# sourceMappingURL=index.js.map