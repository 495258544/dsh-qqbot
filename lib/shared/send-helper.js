import { chunkMarkdownText } from "../transport/chunker.js";
import { BOT_SELF_NAME, rememberOwnSend, resolveBotSelfId } from "./attribution-out.js";
import { getScopePeer } from "./scope.js";
/**
 * 分块发送 markdown（长内容自动切分），并把她自己的话记进归属索引。
 */
export async function sendMarkdownChunked(cmdCtx, content, chunkLimit, attribution) {
    const bot = cmdCtx.bot;
    const replyTarget = cmdCtx.replyTarget;
    const chunks = chunkMarkdownText(content, chunkLimit);
    // 群聊才记（私聊没有合并转发归属问题）
    const { scope, peerId } = getScopePeer(cmdCtx);
    const selfId = resolveBotSelfId(attribution?.botOpenid);
    const ownSend = attribution
        ? {
            appId: attribution.appId,
            groupId: scope === 'group' ? peerId : undefined,
            senderId: selfId,
            senderName: BOT_SELF_NAME,
        }
        : undefined;
    for (const chunk of chunks) {
        await bot.sendMarkdown(replyTarget, chunk);
        if (ownSend)
            rememberOwnSend(ownSend, chunk);
    }
}
//# sourceMappingURL=send-helper.js.map