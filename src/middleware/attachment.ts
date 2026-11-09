/**
 * 富媒体下载中间件 — 在中间件链中下载 image/video/file 附件
 *
 * 结果写入 ctx.state.downloadedFiles / downloadedQuoteFiles / downloadedForwardFiles，
 * 供 handleInbound 读取。下载失败不阻断消息（记录告警后放行）。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import {
  downloadMediaAttachments,
  extractForwardAttachmentRefs,
  type DownloadedForwardFile,
} from '../transport/attachment.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger, QuotedAttachment, RawAttachment } from '../types.ts';

export function attachmentProcessor(config: ImQQBotConfig, logger: Logger) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const msg = ctx.message as { attachments?: RawAttachment[] };

    try {
      // 当前消息附件
      const downloaded = await downloadMediaAttachments(msg.attachments, config.media, logger);
      ctx.state.downloadedFiles = downloaded;

      // 引用消息附件：转成 RawAttachment 结构复用下载（voice 由 downloadMediaAttachments 自动跳过）
      const quoteAttachments = (ctx.state as { quote?: { attachments?: QuotedAttachment[] } }).quote?.attachments;
      if (quoteAttachments && quoteAttachments.length > 0) {
        const rawQuote = quoteAttachments
          .filter(a => a.url)
          .map((a): RawAttachment => ({
            content_type: a.contentType ?? '',
            filename: a.filename ?? '',
            size: 0,
            url: a.url as string,
          }));
        const downloadedQuote = await downloadMediaAttachments(rawQuote, config.media, logger);
        ctx.state.downloadedQuoteFiles = downloadedQuote;
      }

      // ── 合并转发（msgType=103）内的图片 ──
      // QQ 不把转发内的图放进 msg.attachments / quote.attachments，只把它们拍平成
      //   [附件1] 类型:图片 文件名:xxx.png 尺寸:... URL:https://...
      // 这些 URL 以前被 inbound 的「（某人发了一张图片）」占位符直接丢掉，
      // 于是群里转发图永远"收不到"。这里从转发原文捞回来下载，
      // 并保留「第几条消息」的编号，避免多张图/多场比赛混在一起说。
      const state = ctx.state as {
        quote?: { rawContent?: string; text?: string };
        downloadedForwardFiles?: DownloadedForwardFile[];
      };
      const rawMsg = msg as { msgElements?: Array<{ content?: string }> };
      // 三处都可能有全文，取最完整的一份（quoteRef 只在有 refMsgIdx 时才填 state.quote）
      const forwardText = [
        rawMsg.msgElements?.[0]?.content ?? '',
        state.quote?.rawContent ?? '',
        state.quote?.text ?? '',
      ].reduce((a, b) => (b.length > a.length ? b : a), '');
      const forwardRefs = extractForwardAttachmentRefs(forwardText);
      if (forwardRefs.length > 0) {
        const rawForward = forwardRefs.map((r): RawAttachment => ({
          content_type: r.contentType,
          filename: r.filename,
          size: 0,
          url: r.url,
        }));
        const downloadedForward = await downloadMediaAttachments(rawForward, config.media, logger);
        const nodeByFilename = new Map(forwardRefs.map(r => [r.filename, r.nodeIndex]));
        state.downloadedForwardFiles = downloadedForward.map(d => ({
          ...d,
          nodeIndex: nodeByFilename.get(d.filename) ?? 1,
        }));
        logger.info(
          `im-qqbot: 合并转发附件 解析 ${forwardRefs.length} 个 / 下载 ${downloadedForward.length} 个`,
        );
      }
    } catch (err) {
      logger.warn(`im-qqbot: attachment download failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    await next();
  };
}
