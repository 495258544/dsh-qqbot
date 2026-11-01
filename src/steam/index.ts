/**
 * Steam 集成（查群友状态 / 最近游戏）
 * ─────────────────────────────────────────────────────────────
 * 只读 Web API，不登录任何 Steam 账号，不碰密码与 Steam Guard。
 * 数据边界由对方隐私设置决定：Steam 把「游戏详情」默认设为「仅好友」，
 * 这类账号只能看到昵称和在线状态，看不到在玩什么 —— 这是设计，不是故障。
 */
export { SteamService } from './service.ts';
export type { PersonStatus, SteamLookupOptions, SteamLookupResult } from './service.ts';
export { registerSteamTools } from './tools.ts';
export { BindingStore } from './bindings.ts';
export type { SteamBinding, BindingHit } from './bindings.ts';
export { SteamApi, SteamApiError, personaStateText } from './steam-api.ts';
export type { PlayerSummary, RecentGame, SteamErrorKind } from './steam-api.ts';
export {
  parseSteamInput,
  isSteamId64,
  steam64ToSteam2,
  steam64ToSteam3,
  steamProfileUrl,
  steamGameIconUrl,
} from './steam-id.ts';
export type { SteamIdParse } from './steam-id.ts';
