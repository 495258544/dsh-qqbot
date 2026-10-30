/**
 * ops · 运维巡检模块索引
 *
 * 与 persona 解耦：这里的东西不该依赖角色卡/记忆/会话，关掉 persona 也能单独跑。
 */
export { createUpstreamWatch, beijingParts, classifyCommit, parseKind, renderReport, makeBridgeNotifier } from './upstream-watch.ts';
export type {
  UpstreamWatchHandle,
  UpstreamWatchOptions,
  UpstreamWatchState,
  UpstreamStatus,
  ClassifiedCommit,
  ConflictPreview,
  FetchResult,
  Verdict,
  CommitCategory,
  NotifyInput,
} from './upstream-watch.ts';
