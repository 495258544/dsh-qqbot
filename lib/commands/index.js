import { newCommand, compactCommand } from "./session.js";
import { modelCommand } from "./model.js";
import { presetCommand } from "./preset.js";
import { statusCommand } from "./status.js";
import { helpCommand } from "./help.js";
import { pingCommand, versionCommand, stopCommand, meCommand } from "./misc.js";
import { BOT_SELF_NAME, rememberOwnSend, resolveBotSelfId } from "../shared/attribution-out.js";
import { getScopePeer } from "../shared/index.js";
/**
 * 构建标准命令列表
 *
 * ── 归属记录（2026-11-10 补齐）──────────────────────────────────
 * 命令的返回字符串由 SDK 的 sendCommandResult 直接 sendText，**绕过 outbound**
 * 路由，所以以前从不进归属索引 → 引用 /bot-ping 的输出时她只能看到
 * 「看不出这句是谁说的」，等于认不出自己说过的话。这里统一包装：
 * handler 返回字符串 = 这条一定会被发送（SDK 在 handler 之后立即发送），
 * 所以在返回前记一条。走 sendMarkdownChunked 的命令自己记（逐 chunk、
 * 只记送达的），返回 noop 不经过这条路径。
 */
export function buildCommandList(deps) {
    const attribution = {
        appId: deps.config.appId,
        botOpenid: deps.config.persona?.botOpenid,
    };
    /** 给「返回字符串」的命令补上归属记录 */
    const withAttribution = (cmd) => ({
        ...cmd,
        handler: async (ctx) => {
            const result = await cmd.handler(ctx);
            if (typeof result === 'string' && result.trim() !== '') {
                const { scope, peerId } = getScopePeer(ctx);
                rememberOwnSend({
                    appId: attribution.appId,
                    groupId: scope === 'group' ? peerId : undefined,
                    senderId: resolveBotSelfId(attribution.botOpenid),
                    senderName: BOT_SELF_NAME,
                }, result);
            }
            return result;
        },
    });
    const commands = [
        // 通用能力（底层 agent）
        withAttribution(newCommand(deps)),
        withAttribution(compactCommand(deps)),
        withAttribution(modelCommand(deps)),
        withAttribution(presetCommand(deps)),
        withAttribution(stopCommand(deps)),
        // QQBot 特有
        withAttribution(pingCommand()),
        withAttribution(versionCommand(deps)),
        withAttribution(meCommand(deps)),
        withAttribution(statusCommand(deps)),
    ];
    // help 需要访问完整列表（含自身），通过闭包惰性引用
    commands.push(helpCommand(deps, () => commands));
    return commands;
}
//# sourceMappingURL=index.js.map