/**
 * persona ↔ 宿主 web 搜索的接线（2026-11-05 修的根因所在）。
 *
 * ## 为什么要单独成文件
 *
 * 这个 bug 之前"修好过"一次却上线即失效，原因是三件事一起错：
 *   ① 用 `(ctx as Record<string,unknown>).web` 直接摸属性 —— cordis 的访问守卫
 *      要求服务**声明在 inject 里**才允许读 ctx 属性，否则抛，而外面还套了
 *      `try/catch` 把抛吞成 undefined；
 *   ② 顶层 `export const inject = ['agents']` 里没有 'web'，所以守卫必然抛；
 *      但把 'web' 塞进顶层 inject 又不行 —— 那是**硬依赖**，服务缺席时插件整只
 *      停在 PENDING、apply 不跑（仓库自带 cordis.yml 没有 web 行 → bot 起不来）；
 *   ③ bootstrap 是 async，web 服务的激活时机不保证早于它。
 *
 * 正确解是 cordis 的**软注入** `ctx.inject(['web'], cb)`：服务就绪、被替换时
 * 重跑 cb，服务卸载时跑 cb 里注册的清理。本文件把这段抽出来，好让单测能直接
 * 拿真实 cordis Context 测它，而不是再靠手写假对象自证。
 */
import type { Context } from '@deepseek-ai/cordis';
import { surfWiringDbg, type WebSearchLike } from './surf.ts';

/** 接线回调：web 就绪时给服务，卸载时给 undefined */
export type AttachWeb = (web: WebSearchLike | undefined) => void;

/** cordis 里我们用到的那一小撮形状（只声明要用的，避免 import 宿主包） */
interface InjectableContext {
  inject(deps: readonly string[], callback: (scoped: Context) => void): unknown;
}

interface EffectScope {
  effect(fn: () => () => void, name?: string): void;
}

/**
 * 把宿主 web 搜索软注入给 persona。
 *
 * - web 已就绪 → 回调立即跑，立刻 attach；
 * - web 晚到 / 被替换 → 回调再跑一次，重新 attach；
 * - web 卸载 → 回调作用域结束，跑 effect 清理把引用置回 undefined
 *   （不能让 surf 攥着一个已 dispose 的 provider 继续用）。
 *
 * 返回 undefined（fire-and-forget）：接线不该阻塞网关启动，也不该因为 web
 * 缺席而让整个 bot 起不来 —— 缺席时就是原来的 Bing RSS 兜底行为。
 */
export function bindPersonaWeb(ctx: Context, attach: AttachWeb): void {
  const injectable = ctx as unknown as InjectableContext;
  // 静默 return 是这个函数最危险的分支：以前它连一行痕迹都不留，
  // 排查时无法区分「没走到这」「inject 不可用」「web 一直不就绪」。
  if (typeof injectable.inject !== 'function') {
    surfWiringDbg('no-inject', { reason: 'ctx.inject 不是函数' });
    return;
  }
  surfWiringDbg('inject-registered', {});
  injectable.inject(['web'], (scoped) => {
    surfWiringDbg('inject-callback', {});
    const web = (scoped as unknown as { get(name: string): unknown }).get('web') as
      | WebSearchLike
      | undefined;
    attach(web);
    (scoped as unknown as EffectScope).effect(() => () => attach(undefined), 'im-qqbot.persona-web');
  });
}
