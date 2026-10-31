/**
 * 归属索引记录中间件（M21 补强）
 * ─────────────────────────────────────────────────────────────
 * 踩过的坑（2026-10-31 实测）：
 *
 * 最初把 `rememberForAttribution` 放在 handleInbound 里，结果只有
 * **穿过门禁、走到出站流程**的消息才会被记录。而群里绝大多数消息
 * （没 @她）在半路的 personaWakeGate 就被 `ctx.stop()` 拦掉了，
 * 根本没到 handleInbound —— 于是索引里只有"她自己说过的话"。
 *
 * 症状：引用小羽的话能认出「这是你自己之前说的」，
 *      引用 jmx 的话一律「某人」。用户原话：
 *      「转发里我的名字能带出来，别人就一律变成了"某人"」。
 *
 * 修法：把记录动作前移到门禁**之前**（紧跟 historyBuffer，同一策略），
 * 无论这条消息之后会不会唤醒她，都先记进索引。
 */
import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { rememberForAttribution } from '../features/attribution-index.ts';

export interface AttributionRecorderOptions {
  appId: string;
}

/** 只有群聊需要（私聊不涉及合并转发归属问题） */
export function attributionRecorder(options: AttributionRecorderOptions): Middleware {
  return async (ctx: MiddlewareContext, next) => {
    const msg = ctx.message;
    if (msg.kind !== 'group') return next();

    const groupId = msg.groupOpenid ?? msg.senderId;
    const text = (msg.content ?? '').trim();

    // 只存**文本**，不存图片本体：
    //  - 反查靠内容比对，图片没有可比对的文本（存 URL 也匹配不上引文）
    //  - 存图片或 base64 会吃光内存/磁盘（用户明确担心过这点）
    //  - 纯图片消息（content 为空）跳过即可，它本来也无从被"引用文字"命中
    if (groupId && text && msg.senderId) {
      rememberForAttribution(options.appId, groupId, {
        senderId: msg.senderId,
        senderName: msg.senderName,
        content: text,
      });
    }
    return next();
  };
}
