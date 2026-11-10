/**
 * 兼容旧路径 —— 时区工具正本已下沉到 shared/clock.ts。
 *
 * 2026-11-10 模块边界整改：dota/warmup.ts 需要 dayInTz/hourInTz，
 * 但它属于平台层，不能 import persona/。把纯函数移到 shared/ 后，
 * persona 内部所有 `./clock.ts` 的 import 保持不动，靠这里 re-export。
 */
export * from "../shared/clock.js";
//# sourceMappingURL=clock.js.map