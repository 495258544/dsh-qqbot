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
import { appendFileSync } from 'node:fs';
/** 诊断：记录每条群/私聊消息的唤醒判定 + 附件情况（排查"图片收不到"） */
function logWakeDbg(sp, key, msg, decision, extra) {
    try {
        const atts = (msg.attachments ?? []);
        appendFileSync('/root/.dsh-qqbot/debug-wakegate.jsonl', `${JSON.stringify({
            t: new Date().toISOString(),
            stage: sp,
            key,
            kind: msg.kind,
            content: String(msg.content ?? '').slice(0, 100),
            msgType: msg.msgType,
            attachmentsCount: atts.length,
            attachments: atts.map((a) => ({
                ct: a.content_type,
                fn: a.filename,
                size: a.size,
                url: String(a.url ?? '').slice(0, 100),
            })),
            decision,
            extra,
        })}\n`);
    }
    catch {
        /* 诊断失败不影响主流程 */
    }
}
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
            logWakeDbg('decision', key, msg, decision, `mentioned=${ctx.state.mention?.wasMentioned === true} implicit=${ctx.state.mention?.implicit === true}`);
            // 带附件的消息：只有在"明确冲着 bot 来"时才放行，避免把群友闲聊的图也收进库。
            // 判定口径（与唤醒口径一致）：
            //   - c2c 私聊：恒算（decision.wake 已为 true）
            //   - 群聊：@了小羽 / 文本含"小羽" / 回复小羽的消息 / 提问
            // 纯图片消息 content 为空，shouldWake 只按文本判会误判"潜水"→ctx.stop()→附件不下载→
            // agent 永远收不到图。所以这里用"是否冲 bot 说"作为放行条件，而不是"有附件就放"。
            const addressedToBot = decision.wake
                || (ctx.state.mention?.wasMentioned === true)
                || (ctx.state.mention?.implicit === true);
            if (!addressedToBot) {
                logger.debug(`persona: wake-gate stop ${key}`);
                ctx.stop(`persona:not-woken`);
                return;
            }
            if (decision.wake === false) {
                logger.debug(`persona: wake-gate pass ${key} reason=addressed-to-bot`);
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