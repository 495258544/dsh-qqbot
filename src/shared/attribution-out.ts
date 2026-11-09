/**
 * 她自己发出的话/图 → 归属索引
 * ──────────────────────────────────────────────────────────────
 * 为什么要单独一层：
 *
 * 归属索引的写入有三条来源，但**只有 outbound 那条**是完整的。
 *   1. outbound.rememberOwnWords —— 她正常回复的文本（已有）
 *   2. 斜杠命令的回复 —— 走 sendMarkdownChunked / SDK 的 sendCommandResult，
 *      **绕过 outbound**，以前完全不记（引用 /bot-help 的输出 → 「看不出是谁说的」）
 *   3. 她发的图/表情包 —— 走 sendMediaFile，**既不记文字也不记 imageMd5**
 *      （引用她的表情包 → 「看不出是谁说的」）
 *
 * 结果：她认不出自己发过的东西。这里把 2、3 补齐，并让 1 复用同一入口。
 *
 * 只在群聊记（私聊没有合并转发归属问题），失败静默不影响发送。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rememberForAttribution } from '../features/attribution-index.ts';

/**
 * 机器人自己的 openid 兜底值。
 *
 * 实测值：群里 @ 她自己时那个 openid。配置里的 persona.botOpenid 优先。
 * 放在这里是为了让 send-helper / send-media / commands 都能拿到同一个值，
 * 不再各写一份。
 */
export const BOT_SELF_ID_FALLBACK = 'B1FE2927B46C9AF15C464E62216395FF';

/** 她对外显示的名字（索引里记的 senderName） */
export const BOT_SELF_NAME = '小羽';

/** 解析机器人自己的 openid */
export function resolveBotSelfId(botOpenid?: string): string {
  return botOpenid || BOT_SELF_ID_FALLBACK;
}

/** 「她自己发出一条东西」的上下文 */
export interface OwnSendContext {
  appId: string;
  /** 群 openid；私聊传 undefined → 不记 */
  groupId?: string;
  senderId: string;
  senderName?: string;
}

/**
 * 把她自己发出的一条内容记进归属索引（群聊专属）。
 *
 * @param content 文字内容；纯图片时传空串 + imageMd5
 * @param imageMd5 图片指纹（QQ 图片文件名就是内容 MD5）
 */
export function rememberOwnSend(
  ctx: OwnSendContext,
  content: string,
  imageMd5?: string[],
): void {
  if (!ctx.groupId) return;
  const body = String(content ?? '').trim();
  if (!body && !(imageMd5?.length)) return;
  try {
    rememberForAttribution(ctx.appId, ctx.groupId, {
      senderId: ctx.senderId,
      ...(ctx.senderName ? { senderName: ctx.senderName } : {}),
      content: body || '[图片]',
      ...(imageMd5 && imageMd5.length > 0 ? { imageMd5 } : {}),
    });
  } catch {
    /* 记录归属失败不能影响发送 */
  }
}

/**
 * 从本地文件算内容 MD5（QQ 图片文件名就是内容 MD5，对齐才有意义）。
 *
 * 只在真正发出时算一次，代价可接受（表情包/图都很小）。
 * 读不到就返回 undefined（调用方按"没有指纹"处理，不阻塞发送）。
 */
export function md5OfFile(filePath: string): string | undefined {
  try {
    return createHash('md5').update(readFileSync(filePath)).digest('hex');
  } catch {
    return undefined;
  }
}
