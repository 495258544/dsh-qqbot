/**
 * 斜杠命令注册中心
 *
 * 每个命令拆分为独立文件，此处仅编排。工厂函数注入依赖，统一导出命令列表。
 *
 * 命令按 category 分两类：
 *   - agent：底层 dsh agent 通用能力（new/compact/model/stop）
 *   - qqbot：插件自身特有（ping/version/status/help）
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { newCommand, compactCommand } from './session.ts';
import { modelCommand } from './model.ts';
import { presetCommand } from './preset.ts';
import { statusCommand } from './status.ts';
import { helpCommand } from './help.ts';
import { pingCommand, versionCommand, stopCommand, meCommand } from './misc.ts';
import { BOT_SELF_NAME, rememberOwnSend, resolveBotSelfId } from '../shared/attribution-out.ts';
import { getScopePeer } from '../shared/index.ts';

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
export function buildCommandList(deps: CommandDeps): CategorizedCommand[] {
  const attribution = {
    appId: deps.config.appId,
    botOpenid: deps.config.persona?.botOpenid,
  };

  /** 给「返回字符串」的命令补上归属记录 */
  const withAttribution = (cmd: CategorizedCommand): CategorizedCommand => ({
    ...cmd,
    handler: async (ctx) => {
      const result = await cmd.handler(ctx);
      if (typeof result === 'string' && result.trim() !== '') {
        const { scope, peerId } = getScopePeer(ctx);
        rememberOwnSend(
          {
            appId: attribution.appId,
            groupId: scope === 'group' ? peerId : undefined,
            senderId: resolveBotSelfId(attribution.botOpenid),
            senderName: BOT_SELF_NAME,
          },
          result,
        );
      }
      return result;
    },
  });

  const commands: CategorizedCommand[] = [
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
