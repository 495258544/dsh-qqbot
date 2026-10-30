export function personaWakeGate(persona, logger) {
    return async (ctx, next) => {
        const msg = ctx.message;
        const scope = msg.kind === 'group' ? 'group' : 'c2c';
        const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;
        const key = `${scope}:${peerId}`;
        // 社交层记账：任何来自对方的消息都算"理你了"（含未唤醒的群闲聊）
        persona.budget.markReplied(peerId);
        if (msg.senderId !== peerId)
            persona.budget.markReplied(msg.senderId);
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
                : { wake: true, reason: 'c2c' };
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
//# sourceMappingURL=persona-wake-gate.js.map