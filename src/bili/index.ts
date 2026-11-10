/**
 * Bilibili 平台模块 — 对外出口
 *
 * 模块边界（2026-11-10）：B 站是平台扩展，不属于聊天人格。
 * 聊天核心（persona/）不 import 这里；唯一的接线点是 bootstrap。
 * 与 xiaoyu 分支的差别：那边 B 站主体走官方 MCP（只留字段自检），
 * 本分支保留本地 bili CLI 的厚实现（watch 优先 / frames / subtitleOutline /
 * 结构化 bvid），这是用户明确要求保留的能力，不能换成薄壳。
 */
export { registerBiliTools } from './tools.ts';
export { runBili, biliFailure, type BiliResult } from './cli.ts';
export { mmss, condenseSubtitlesByMinute } from './subtitles.ts';
export { checkBiliHealth, formatHealthIssues, BILI_DEPS } from './bili-health.ts';
export type { BiliFieldDep, BiliHealthIssue, BiliHealthOptions } from './bili-health.ts';
