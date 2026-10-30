/**
 * persona 唤醒门中间件（审查 M2 修复）
 * ─────────────────────────────────────────────────────────────
 * 问题：mentionGate passthrough 让未 @ 的群消息穿过整条链——附件被真实下载、
 * 斜杠命令可被任何人无 @ 触发（越权回归）。
 * 修法：Waker 判定前移到 attachmentProcessor/slashCommand 之前，未醒直接
 * ctx.stop()，下游成本与攻击面归零。inbound 不再重复判定（无门则醒）。
 *
 * 记账语义（审查 m1 收敛）：
 * - budget.markReplied 保持对全部消息生效（社交层"理你了"不限于唤醒消息）
 * - memory.touch（涨 interactions、建账）只在醒后执行，防虚高
 */
import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { PersonaService } from '../persona/service.ts';
import type { Logger } from '../types.ts';

export function personaWakeGate(
  persona: PersonaService,
  logger: Logger,
): Middleware {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const msg = ctx.message;
    const scope = msg.kind === 'group' ? 'group' : 'c2c';
    const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;
    const key = `${scope}:${peerId}`;

    // 社交层记账：任何来自对方的消息都算"理你了"（含未唤醒的群闲聊）
    persona.budget.markReplied(peerId);
    if (msg.senderId !== peerId) persona.budget.markReplied(msg.senderId);

    const waker = persona.waker;
    if (waker) {
      // c2c 恒醒（与原版"私聊每条都理"一致，也保住 mentionGate 对 c2c 的语义）
      const decision = scope === 'group'
        ? waker.shouldWake({
            key,
            userId: msg.senderId,
            name: msg.senderName,
            text: msg.content ?? '',
            isAtMe: ctx.state.mention?.wasMentioned === true,
          })
        : { wake: true, reason: 'c2c' as string };
      if (!decision.wake) {
        logger.debug(`persona: wake-gate stop ${key}`);
        ctx.stop(`persona:not-woken`);
        return;
      }
      logger.debug(`persona: wake-gate pass ${key} reason=${decision.reason}`);
      // 醒后才涨互动计数（m1①），并记录本次唤醒（潜水状态机消费 lastWakeAt）
      persona.memory.touch(msg.senderId, { name: msg.senderName });
      waker.wake(key);
    }

    await next();
  };
}
