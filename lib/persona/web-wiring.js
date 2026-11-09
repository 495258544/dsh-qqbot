import { surfWiringDbg } from "./surf.js";
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
export function bindPersonaWeb(ctx, attach) {
    const injectable = ctx;
    // 静默 return 是这个函数最危险的分支：以前它连一行痕迹都不留，
    // 排查时无法区分「没走到这」「inject 不可用」「web 一直不就绪」。
    if (typeof injectable.inject !== 'function') {
        surfWiringDbg('no-inject', { reason: 'ctx.inject 不是函数' });
        return;
    }
    surfWiringDbg('inject-registered', {});
    injectable.inject(['web'], (scoped) => {
        surfWiringDbg('inject-callback', {});
        const web = scoped.get('web');
        attach(web);
        scoped.effect(() => () => attach(undefined), 'im-qqbot.persona-web');
    });
}
//# sourceMappingURL=web-wiring.js.map