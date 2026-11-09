/**
 * 分块发送 markdown 工具
 *
 * 长内容自动按 QQ 消息限制切分后逐条发送。
 *
 * ── 归属记录（2026-11-10 补齐）───────────────────────────────────
 * 斜杠命令的回复走这里，而**不经过 outbound 路由**，所以以前从来不记
 * 归属索引 → 用户引用 /bot-help 的输出时，她只能看到「看不出这句是谁说的」，
 * 等于认不出自己说过的话。现在每个真正送达的 chunk 都记进索引。
 */
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { chunkMarkdownText } from '../transport/chunker.ts';
import { BOT_SELF_NAME, rememberOwnSend, resolveBotSelfId } from './attribution-out.ts';
import { getScopePeer } from './scope.ts';

/** 归属记录需要的最小信息 */
export interface SendMarkdownAttribution {
  appId: string;
  botOpenid?: string;
}

/**
 * 分块发送 markdown（长内容自动切分），并把她自己的话记进归属索引。
 */
export async function sendMarkdownChunked(
  cmdCtx: SlashCommandHandlerContext,
  content: string,
  chunkLimit: number,
  attribution?: SendMarkdownAttribution,
): Promise<void> {
  const bot = (cmdCtx as unknown as Record<string, unknown>).bot as { sendMarkdown(target: unknown, content: string): Promise<unknown> };
  const replyTarget = (cmdCtx as unknown as Record<string, unknown>).replyTarget;
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
    if (ownSend) rememberOwnSend(ownSend, chunk);
  }
}
