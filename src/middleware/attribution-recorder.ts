/**
 * 归属索引记录中间件（M21 补强）
 * ─────────────────────────────────────────────────────────────
 * 踩过的坑（2026-10-31 实测）：
 *
 * 最初把 `rememberForAttribution` 放在 handleInbound 里，结果只有
 * **穿过门禁、走到出站流程**的消息才会被记录。而群里绝大多数消息
 * （没 @她）在半路的 personaWakeGate 就被 `ctx.stop()` 拦掉了，
 * 根本没到 handleInbound —— 于是索引里只有"她自己说过的话"。
 *
 * 症状：引用小羽的话能认出「这是你自己之前说的」，
 *      引用 jmx 的话一律「某人」。用户原话：
 *      「转发里我的名字能带出来，别人就一律变成了"某人"」。
 *
 * 修法：把记录动作前移到门禁**之前**（紧跟 historyBuffer，同一策略），
 * 无论这条消息之后会不会唤醒她，都先记进索引。
 */
import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { appendFileSync } from 'node:fs';
import { rememberForAttribution } from '../features/attribution-index.ts';

/**
 * 从消息里提取图片指纹。
 *
 * QQ 给的图片文件名就是内容 MD5（实测与归档文件的实际 md5 逐字节一致），
 * 这是"引用一张图是谁发的"唯一可靠的线索：URL 会过期，视觉模型还要下载。
 */
function extractImageMd5(msg: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v !== 'string') return;
    // 32 位十六进制即 MD5
    const m = v.match(/^([A-Fa-f0-9]{32})(?:\.[a-z0-9]+)?$/i);
    if (m && m[1]) out.push(m[1].toLowerCase());
  };
  const atts = (msg as { attachments?: Array<{ filename?: string; url?: string }> })?.attachments;
  if (Array.isArray(atts)) {
    for (const a of atts) {
      push(a?.filename);
      // URL 里也可能带 fileid，但不可靠，只用文件名
    }
  }
  return out;
}

export interface AttributionRecorderOptions {
  appId: string;
}

/** 只有群聊需要（私聊不涉及合并转发归属问题） */
export function attributionRecorder(options: AttributionRecorderOptions): Middleware {
  return async (ctx: MiddlewareContext, next) => {
    const msg = ctx.message;
    if (msg.kind !== 'group') return next();

    const groupId = msg.groupOpenid ?? msg.senderId;
    const text = (msg.content ?? '').trim();

    // 只存**文本**，不存图片本体：
    //  - 反查靠内容比对，图片没有可比对的文本（存 URL 也匹配不上引文）
    //  - 存图片或 base64 会吃光内存/磁盘（用户明确担心过这点）
    //  - 纯图片消息（content 为空）跳过即可，它本来也无从被"引用文字"命中
    const imageMd5 = extractImageMd5(msg);

    // 诊断：图片归属最容易在这里丢线索。
    // 记录**每条**群消息的关键字段（含是否有附件），才能分辨
    // "消息没到 recorder" 还是 "到了但 attachments 为空"。
    try {
      const rawAtts = (msg as { attachments?: unknown[] })?.attachments;
      const line = JSON.stringify({
        t: new Date().toISOString(),
        senderId: msg.senderId,
        senderName: msg.senderName,
        content: text.slice(0, 60),
        attachmentsCount: Array.isArray(rawAtts) ? rawAtts.length : -1,
        attachments: Array.isArray(rawAtts) ? rawAtts.slice(0, 2) : undefined,
        extractedMd5: imageMd5,
      });
      appendFileSync('/root/.dsh-qqbot/debug-attribution.jsonl', `${line}\n`);
    } catch (err) {
      // 诊断失败要能看见，不能静默吞掉
      console.error('[attribution] 诊断写入失败:', err instanceof Error ? err.message : String(err));
    }
    // 纯图片无文字：用占位内容记一条，让它能被"引用这张图"命中
    const body = text || (imageMd5.length > 0 ? '[图片]' : '');

    if (groupId && body && msg.senderId) {
      rememberForAttribution(options.appId, groupId, {
        senderId: msg.senderId,
        senderName: msg.senderName,
        content: body,
        ...(imageMd5.length > 0 ? { imageMd5 } : {}),
      });
    }
    return next();
  };
}
