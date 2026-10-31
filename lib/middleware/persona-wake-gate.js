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
/** 「被嫌吵」的抱怨特征词 */
const COMPLAINT_RE = /太吵|别刷屏|刷屏了|安静点|安静些|闭嘴|别发了|少说点|烦死了|别吵|能不能别发|话太多/;
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
        // ── 硬门禁：不处理其他机器人发来的消息（防 A↔B 无限互聊）──
        // 场景：群里可能接了多个 robot。两个 bot 都会在"活跃期"里接对方的话，
        // 于是 A 回 B、B 回 A，无限循环，刷屏且烧钱。
        // SDK 的 author.bot 会标出来（senderIsBot），但 messageFilter 没有这个开关，
        // 所以必须自己挡，而且要在**任何记账/唤醒之前**挡掉。
        const fromBot = msg.senderIsBot === true;
        if (fromBot) {
            logger.debug('persona: 忽略其他机器人发来的消息');
            ctx.stop('from-bot');
            return;
        }
        const scope = msg.kind === 'group' ? 'group' : 'c2c';
        const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;
        const key = `${scope}:${peerId}`;
        // 社交层记账：任何来自对方的消息都算"理你了"（含未唤醒的群闲聊）
        persona.budget.markReplied(peerId);
        if (msg.senderId !== peerId)
            persona.budget.markReplied(msg.senderId);
        // ── 被嫌吵检测（M5）：命中抱怨词 → 降低话痨度，之后少接话但仍读会话 ──
        const content = String(msg.content ?? '');
        if (content && COMPLAINT_RE.test(content)) {
            const now = persona.self.registerComplaint();
            logger.info(`persona: 被嫌吵「${content.slice(0, 20)}」→ chattiness=${now.toFixed(2)}`);
        }
        else if (content && msg.senderId !== peerId && /在吗|小羽|hi|hello/i.test(content)) {
            // 对方主动找她说话 → 稍微回暖
            persona.self.warmUp(0.2);
        }
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
                    // 活跃期内按概率接话，避免变成应答器
                    inActiveWindow: waker.isActive(key),
                })
                : { wake: true, reason: 'c2c' };
            logWakeDbg('decision', key, msg, decision, `mentioned=${ctx.state.mention?.wasMentioned === true} implicit=${ctx.state.mention?.implicit === true}`);
            // 「是不是冲 bot 说的」判定。手机端无法同时 @ + 发图，纯图片消息 content 为空，
            // shouldWake 只按文本判会误判"潜水"→ctx.stop()→附件不下载→agent 永远收不到图。
            // 因此叠加一条「对话窗口」规则：某个会话最近被唤醒过（默认 15 分钟内），
            // 同一会话里后续的带附件消息就算冲 bot 来的——用户先 @ / 喊小羽一句，
            // 小羽回复后，紧接着单独发图即可被收下。
            // 活跃对话期（被 @ 后 10 分钟）：期间即使没 @ 也照常对话，不打断话头
            const inChatWindow = waker.isActive(key);
            const hasAttachments = (msg.attachments?.length ?? 0) > 0;
            const addressedToBot = decision.wake
                || (ctx.state.mention?.wasMentioned === true)
                || (ctx.state.mention?.implicit === true)
                // 活跃期内（刚跟她说上话）→ 继续对话
                || inChatWindow
                // 对话窗口内 + 带附件：视为正在跟 bot 交流时发的图
                || (inChatWindow && hasAttachments);
            // 关键：带附件的消息一律放行（让 attachmentProcessor 下载并归档），
            // 但"非唤醒"的打上 collectOnly 标记，下游只归档不回复（用户选择：不打扰）。
            // 同时把下载结果存进待领缓存，供"先发图、后 @ 我"场景在唤醒时一并领走。
            const stopIt = !addressedToBot && !hasAttachments;
            if (stopIt) {
                logger.debug(`persona: wake-gate stop ${key}`);
                ctx.stop(`persona:not-woken`);
                return;
            }
            if (decision.wake === false) {
                const st = ctx.state;
                st.collectOnly = true;
                st.awaitAttachmentFetch = true; // 交给下游：下载完后存进待领缓存
                logger.debug(`persona: wake-gate pass ${key} reason=collect-only`);
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