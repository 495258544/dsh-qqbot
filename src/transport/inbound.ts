/**
 * 入站处理器 — 经 SDK 中间件链处理后的消息 → dsh Agent followup
 *
 * 内容组装逻辑：
 * - Layer 1: userContent（文本 + 语音转录）
 * - Layer 2: quotePart（引用消息块）
 * - Layer 3: userMessage（带发送者标签）
 * - Layer 4: dynamicCtx（媒体元数据）
 * - Layer 5: agentBody（history + base 拼合）
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger, QuotedAttachment, RawAttachment, ReplyTarget } from '../types.ts';
import {
  classifyContentType,
  isVoiceContentType,
  type DownloadedFile,
  type DownloadedForwardFile,
  type MediaKind,
} from './attachment.ts';
import { clearGroupHistory } from '../features/history-store.ts';
import { recordGroupActivity } from '../features/group-activity.ts';
import { lookupAttribution, lookupByImageMd5, lookupRefSender } from '../features/attribution-index.ts';
import { stashPendingAttachments, takePendingAttachments, pendingKey } from '../features/pending-attachments.ts';

import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

// ── 类型定义 ──

interface ProcessedMessage {
  rawEventType: string;
  kind: 'c2c' | 'group';
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  groupOpenid?: string;
  msgType?: number;
  attachments?: RawAttachment[];
  [key: string]: unknown;
}

interface ResolvedQuote {
  text?: string;
  entry?: { senderId?: string; senderName?: string; content?: string; isBot?: boolean };
  /** 被引用消息的 msgIdx（归属索引直查用，权威高于内容反查） */
  refKey?: string;
  attachments?: QuotedAttachment[];
}

interface HistoryEntry {
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
  messageId: string;
}

interface MentionState {
  wasMentioned?: boolean;
}

interface MiddlewareState {
  quote?: ResolvedQuote;
  history?: HistoryEntry[];
  envelope?: string;
  mention?: MentionState;
  processedAttachments?: ProcessedAttachment[];
  downloadedFiles?: DownloadedFile[];
  downloadedQuoteFiles?: DownloadedFile[];
  /** 合并转发内下载成功的图（带「第几条消息」编号） */
  downloadedForwardFiles?: DownloadedForwardFile[];
  [key: string]: unknown;
}

interface ProcessedAttachment {
  type: 'voice' | 'image' | 'video' | 'file' | 'unknown';
  filename?: string;
  url?: string;
  localPath?: string;
  voiceText?: string;
  voiceSource?: 'stt' | 'asr' | 'fallback';
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
}

// ── 主处理函数 ──

/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export async function handleInbound(
  ctx: MiddlewareContext,
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<void> {
  const msg = ctx.message as unknown as ProcessedMessage;
  const mwState = ctx.state as MiddlewareState;
  const { bot } = ctx;

  const scope: ChatScope = msg.kind === 'group' ? 'group' : 'c2c';
  const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;

  const replyTarget: ReplyTarget = {
    scope,
    targetId: peerId,
    msgId: msg.messageId,
  };

  // persona 的唤醒判定与社交记账已前移到 middleware/persona-wake-gate.ts
  // （审查 M2：未醒消息不得穿过附件下载/斜杠命令）。此处仅取服务实例备用。
  const persona = manager.persona;

  // ── 只收图模式（非唤醒的带附件消息）──
  // 附件已在 attachmentProcessor 里下载并归档到 media.archiveDir。
  // 这里把它们存进"待领缓存"，等同一人随后唤醒 bot 时一并交给 agent
  // （手机端无法同时 @ + 发图，用户常先发图再补一句 @）。
  // 同时不进入 agent 回复流程，避免小羽对每张图都回话（用户要求：不打扰）。
  if ((mwState as Record<string, unknown>).collectOnly === true) {
    const files = mwState.downloadedFiles ?? [];
    if (files.length > 0) {
      stashPendingAttachments(pendingKey(scope, peerId, msg.senderId), files);
    }
    logger.info(`收集模式: scope=${scope} peerId=${peerId} 附件 ${files.length} 个已归档待领`);
    return;
  }

  // ── 唤醒消息：领走同一人刚发但没被唤醒的图（"先发图、后 @" 场景）──
  let carriedFiles: DownloadedFile[] = [];
  {
    carriedFiles = takePendingAttachments(pendingKey(scope, peerId, msg.senderId));
    if (carriedFiles.length > 0) {
      mwState.downloadedFiles = [...(mwState.downloadedFiles ?? []), ...carriedFiles];
      logger.info(`领走先前 ${carriedFiles.length} 个待领附件 → 本次唤醒一并交给 agent`);
    }
  }

  // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供） ──
  const gid = msg.groupOpenid ?? msg.senderId;
  let agentBody = assembleAgentBody(
    msg, mwState, scope, logger, undefined, config.persona?.botOpenid,
    scope === 'group'
      ? (text) => {
          const hit = lookupAttribution(config.appId, gid, text);
          return hit ? { id: hit.senderId, name: hit.senderName } : {};
        }
      : undefined,
    scope === 'group'
      ? (md5s) => {
          const hit = lookupByImageMd5(config.appId, gid, md5s);
          return hit ? { id: hit.senderId, name: hit.senderName } : {};
        }
      : undefined,
    // msgIdx → 发送者直查（quoteRef 的 enrichEntry 记的，权威高于内容反查）
    scope === 'group'
      ? (refKey?: string) => {
          const hit = lookupRefSender(refKey);
          return hit ? { id: hit.senderId, name: hit.senderName } : {};
        }
      : undefined,
    config.persona?.ownerOpenids,
    config.vision.enabled,
  );

  // 把"先发的图"补进 agentBody，否则 agent 不知道这几张图的存在
  if (carriedFiles.length > 0) {
    const lines = carriedFiles.map((f) => `- image: ${f.localPath}`).join('\n');
    const note = `[对方在你被唤醒前刚发的图片]\n${lines}\n`;
    agentBody = agentBody === null ? note : `${note}${agentBody}`;
  }

  if (!agentBody) return;

  // 群活跃度埋点：只记聚合指标（时间戳 / 关键词命中 / 发言者），不留原文。
  // 用途是「Dota 战绩播报该发哪个群」的相关度评分，未配置时静默忽略。
  if (scope === 'group') recordGroupActivity(peerId, msg.senderId, agentBody);

  logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);

  // ── 诊断：把进来的消息（含附件/下载结果）追加到调试文件，便于排查"图片收不到" ──
  try {
    // 原来写死 /root/...（Linux 路径），Windows 上 append 直接抛错被下面的 catch 吞掉，
    // 于是"图片到底有没有作为附件进来"永远查不到。和 debug-wakegate.jsonl 放同一目录。
    const dbg = join(homedir(), '.dsh-qqbot', 'debug-inbound.jsonl');
    const atts = (msg.attachments ?? []).map((a) => ({
      content_type: a.content_type,
      filename: a.filename,
      size: a.size,
      url: (a.url ?? '').slice(0, 120),
    }));
    appendFileSync(
      dbg,
      `${JSON.stringify({
        t: new Date().toISOString(),
        scope,
        peerId,
        senderId: msg.senderId,
        content: (msg.content ?? '').slice(0, 120),
        msgType: msg.msgType,
        attachments: atts,
        attachmentsCount: atts.length,
        msgElements: (msg as unknown as Record<string, unknown>).msgElements ?? null,
        messageScene: (msg as unknown as Record<string, unknown>).messageScene ?? null,
        downloaded: (mwState.downloadedFiles ?? []).map((d) => d.localPath),
        bodyHead: agentBody.slice(0, 400),
      })}\n`,
    );
  } catch {
    /* 诊断失败不影响主流程 */
  }

  // ── 获取或创建会话 ──
  let record;
  try {
    record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
  } catch (err) {
    logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
    // 兜底回复：会话创建失败时告知用户，避免静默无响应
    try {
      await bot.sendMarkdown(replyTarget, '⚠️ 处理消息时出现异常，请稍后重试。');
    } catch (sendErr) {
      logger.error(`fallback reply failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
    }
    return;
  }

  // ── 构建 UserMessage → followup ──
  const content: ContentBlock[] = [{ type: 'text' as const, text: agentBody }];

  const message = createUserMessage({
    content,
    source: { kind: 'user' as const },
  });

  // persona 记账：暂存本轮用户消息，outbound turn/end 时与回复配对写入流水
  if (persona) {
    const humanText = (msg.content ?? '').trim();
    persona.noteUserTurn(record.sessionId, humanText, msg.senderName ?? msg.senderId);
    // M11：判定她上一句是否被这条消息"接住"（正样本采集）
    persona.judgeVoice(record.sessionId, humanText);
  }

  record.agent.followup(message);
  logger.info(`→ followup sent: key=${scope}:${peerId}`);

  // 群消息回复后清空历史缓存（避免下次 @ 时重复组包）
  if (scope === 'group') {
    clearGroupHistory(config.appId, msg.groupOpenid ?? msg.senderId);
  }

  // 阻塞等待本轮 turn 收敛，避免后续消息在 turn 运行期间被 followup 打断
  try {
    await record.agent.whenIdle();
  } catch (err) {
    logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ══════════════════════════════════════════════════════════════
// Body Assembly（5 层组装）
// ══════════════════════════════════════════════════════════════

/**
 * 组装 agentBody — AI 实际看到的完整上下文
 */
function assembleAgentBody(
  msg: ProcessedMessage,
  state: MiddlewareState,
  scope: ChatScope,
  logger: Logger,
  anchor?: string,
  botOpenid?: string,
  /** 按内容反查引文发送者（独立归属索引，不受群历史清空影响） */
  lookupSender?: (quotedText: string) => { id?: string; name?: string },
  /** 按图片 MD5 反查（QQ 的图片文件名就是内容 MD5，无需下载图片） */
  lookupImage?: (md5s: string[]) => { id?: string; name?: string },
  /** 按消息 id（msgIdx）直查发送者（quoteRef 的 enrichEntry 记的，权威） */
  lookupRef?: (refKey?: string) => { id?: string; name?: string },
  /** 主人 openid 列表（命中时说话人标签带「·主人」—— 否则主人用小号说话她认不出来） */
  ownerIds?: readonly string[],
  /** vision.enabled 开着才提示她用看图工具，避免指向一个没注册的工具 */
  visionEnabled = false,
): string | null {
  const isGroup = scope === 'group';
  const wasMentioned = state.mention?.wasMentioned ?? false;

  const userContent = buildUserContent(msg, state, logger);

  if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned)) return null;

  const quotePart = buildQuotePart(
    state.quote,
    state.history,
    botOpenid || detectBotSelfId(state.history),
    lookupSender,
    lookupImage,
    lookupRef,
    (state.downloadedForwardFiles ?? []).map(d => d.nodeIndex),
  );
  const userMessage = buildUserMessage(userContent, quotePart, msg.senderId, msg.senderName, isGroup, wasMentioned, ownerIds);

  const dynamicCtx = buildDynamicCtx(msg, state, visionEnabled);

  const base = dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
  // A+B：群历史只留近 10 分钟、且剔掉她自己的发言。
  // selfIds 用解析后的 selfId（config.persona.botOpenid 或从历史探测到的）；
  // 主人自己的 openid 也一并剔除——他发的话属于"群聊上下文"，但会和白名单上的
  // "在问她"重复，且偶尔被他自己的群昵称干扰（见 knownNames 那轮修复）。
  const selfIds = new Set<string>();
  const resolvedSelf = botOpenid || detectBotSelfId(state.history);
  if (resolvedSelf) selfIds.add(resolvedSelf);
  const agentBody = buildAgentBody(base, state.history, isGroup, wasMentioned, anchor, { selfIds });

  return agentBody;
}

/**
 * 判断消息是否为空：无文本/语音/附件，且非群聊 @。
 * 群聊被 @ 视为有效触发信号，即使内容为空也保留给 agent。
 */
function isEmptyMessage(
  userContent: string,
  attachments: RawAttachment[] | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
): boolean {
  if (userContent) return false;
  if (attachments && attachments.length > 0) return false;
  if (isGroup && wasMentioned) return false;
  return true;
}

/**
 * Layer 1: 用户文本内容 + 语音转录 + 附件类型标签（媒体路径由 buildDynamicCtx 提供）
 */
function buildUserContent(msg: ProcessedMessage, state: MiddlewareState, logger: Logger): string {
  const parts: string[] = [];

  const text = (msg.content ?? '').trim();
  if (text) {
    parts.push(text);
  }

  const voiceTexts = extractVoiceTexts(msg.attachments, state.processedAttachments, logger);
  if (voiceTexts.length > 0) {
    for (const vt of voiceTexts) {
      const durationTag = vt.duration ? ` (${vt.duration}s)` : '';
      parts.push(`[Voice message${durationTag}] ${vt.text}`);
    }
  }

  // 附件类型标签（媒体路径由 buildDynamicCtx 提供，这里只提示「带了什么」）
  const attachmentTags = buildAttachmentTags(msg.attachments);
  if (attachmentTags) {
    parts.push(attachmentTags);
  }

  return parts.join('\n');
}

/**
 * 从当前消息里认出机器人自己的 openid。
 *
 * QQ 群的 @ 在文本里表现为 `<@OPENID>`；那条"@小羽"的消息就是
 * `<@B1FE2927B46C9AF15C464E62216395FF>` —— 那就是她自己。
 * 拿到它，才能判断一段引文是不是"她自己说过的话"。
 */
function detectBotSelfId(history?: HistoryEntry[]): string | undefined {
  if (!history?.length) return undefined;
  for (const h of history) {
    const m = String(h.content ?? '').match(/<@([A-Fa-f0-9]{20,})>/);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Layer 2: 引用消息块
 *
 * 关键：**必须带发送者归属**。
 * 之前这里只拼引文正文、不拼是谁说的，模型看到的是
 *   [Quoted message begins] 卡了就别催了 [Quoted message ends]
 *   [Current message] [……] (@you)
 * 两条都没有署名 → 模型认为引文也是"你"说的，于是出现
 * 「刚不是你那边卡了」这种把别人的话算到用户头上的错。
 *
 * 另外合并转发（msgType=103）本身带「=== 消息 N ===」编号，但编号同样没有署名，
 * 需要逐条标注。已知小羽自己发的运维提示（⚠️ 本轮异常结束）不应参与对话，
 * 这里一并过滤，避免它被当成聊天素材复述。
 */
export function buildQuotePart(
  quote?: ResolvedQuote,
  history?: HistoryEntry[],
  botSelfId?: string,
  lookupSender?: (quotedText: string) => { id?: string; name?: string },
  lookupImage?: (md5s: string[]) => { id?: string; name?: string },
  /** 按消息 id（msgIdx）直查发送者——比内容反查权威，短消息/截断预览也能命中 */
  lookupRef?: (refKey?: string) => { id?: string; name?: string },
  /** 已下载成功的转发图所在条号（1-based）；有图时在占位符上挂 #N 锚点 */
  forwardImageNumbers?: readonly number[],
): string {
  if (!quote?.text && !quote?.entry?.content) return '';

  const raw = quote.text || quote.entry?.content || 'Original content unavailable';

  /** 运维提示的正判据：内容本身长得像运行状态播报（不能只看 isBot） */
  const OPS_NOTICE = /(\u26a0\ufe0f\s*本轮异常结束|RATE_LIMIT|MISSING_CREDENTIAL|NO_ADAPTER|UNSUPPORTED_REASONING|SERVER:|超限|本轮异常)/;

  /** 归一化：去合并转发头、去标签、压空白，用于内容比对 */
  const norm = (t: string): string =>
    t.replace(/^===.*===$/gm, '')
      .replace(/\[消息类型\][^\n]*/g, '')
      .replace(/\[消息内容\]/g, '')
      .replace(/\s+/g, '')
      .trim();

  /**
   * 按内容反查发送者。
   *
   * QQ 的合并转发（msgType=103）只给内容、**不给每条消息的发送者**，
   * 且 ref_msg_idx 常是 `TMP_xxx` 临时 id（store 必查不到）→ 只会得到"未知"，
   * 模型于是瞎猜归属。历史缓冲里有 senderId/senderName/content，可以反查。
   *
   * 注意：必须**逐条**反查。合并转发里每条可能来自不同的人，
   * 整块套用一个人正是这次事故的同类错误。
   */
  const lookup = (text: string): { id?: string; name?: string } => {
    // 优先用独立归属索引（不受群历史清空影响，能覆盖"引用上一轮说过的话"）
    const fromIndex = lookupSender?.(text);
    if (fromIndex && (fromIndex.id || fromIndex.name)) return fromIndex;
    const probe = norm(text);
    if (probe.length < 2 || !history?.length) return {};
    // 短引文（<4 字）只做完全一致匹配，避免「嗯」命中任何含「嗯」的话
    for (const h of [...history].reverse()) {
      const body = norm(String(h.content ?? ''));
      if (!body || body.length < 2) continue;
      if (probe.length < 4) {
        if (body === probe) return { id: h.senderId, name: h.senderName };
        continue;
      }
      if (probe.includes(body) || (body.length >= 8 && body.includes(probe))) {
        return { id: h.senderId, name: h.senderName };
      }
    }
    return {};
  };

  /** 这个人是不是"她自己"（用于把"别人说的"和"她自己说过的"区分开） */
  const isSelf = (id?: string): boolean => Boolean(botSelfId && id && id === botSelfId);

  /**
   * 单条引文的发送者。权威优先级：
   *   1. QQ store 的 entry（被引用消息本尊的发送者）
   *   2. refKey 按 msgIdx 直查（短消息/被截断的预览也能命中）
   *   3. 内容反查（归属索引 → 群历史）
   *
   * 合并转发绝不能走这条路：store/refKey 指向的是「转发这条合并消息的人」，
   * 不是每条内容的作者。返回 undefined 表示确实查不到。
   */
  const resolveSingle = (text: string): { id?: string; name?: string } | undefined => {
    if (quote?.entry?.senderId || quote?.entry?.senderName) {
      return { id: quote.entry.senderId, name: quote.entry.senderName };
    }
    const byRef = lookupRef?.(quote?.refKey);
    if (byRef && (byRef.id || byRef.name)) return byRef;
    const byContent = lookup(text);
    return (byContent.id || byContent.name) ? byContent : undefined;
  };

  /** 合并转发逐条的归属短语：只认内容反查，绝不把转发者套到每条上 */
  const labelOf = (text: string): string => {
    const found = lookup(text);
    const name = found.name ?? (found.id ? shortSenderId(found.id) : undefined);
    if (!name) return '某人';
    if (isSelf(found.id)) return `这是你自己之前说的「${name}」`;
    return `${name}${found.id ? ` (${found.id})` : ''}`;
  };

  // ── 合并转发：逐条归属 + 剥离运维提示 ──
  if (raw.includes('=== 消息')) {
    const headers: string[] = [];
    for (const m of raw.matchAll(/^===\s*消息\s*\d+\s*===\s*$/gm)) headers.push(m[0].trim());
    const parts = raw.split(/^===\s*消息\s*\d+\s*===\s*$/m).slice(1);

    const lines: string[] = [];
    let kept = 0;
    parts.forEach((part, i) => {
      const content = part.trim().replace(/^\[消息内容\]\s*/, '').replace(/\[消息类型\][^\n]*/g, '').trim();
      if (!content) return;
      const head = headers[i] ?? `=== 消息 ${i + 1} ===`;
      if (OPS_NOTICE.test(content)) {
        // 系统播报：整条略去，不留可被复述的素材
        lines.push(`${head}\n[消息内容] （系统提示，已略去）`);
        return;
      }
      kept += 1;
      // 纯附件条目（"[附件1] 类型:图片 文件名:xxx URL:..."）：
      // 满屏技术细节既占上下文，又会让模型照着念"文件名""URL 没带上"。
      // 换成一句人能看懂的说明，具体图片由 attachmentProcessor 另走视觉识别。
      // 块可能以 [消息类型] 开头（"引用消息"标签），附件标记在其后
      const hasAttachment = /\[附件\d+\]/.test(content);
      if (hasAttachment && !content.includes('[消息内容]')) {
        // 类型字段直接就是中文（"类型:图片"），不是英文 image/video
        const kind = content.match(/类型:([^\s]+)/)?.[1] ?? '';
        // QQ 的动图是「类型:动图」，要和静态图片分开说 —— 否则她会把一帧当成整张图
        const zh = /动图/.test(kind) ? '动图'
          : /图/.test(kind) ? '图片'
            : /视频/.test(kind) ? '视频'
              : /文件/.test(kind) ? '文件' : '附件';

        // 图片归属：文件名就是内容 MD5 → 直接对索引，不需要下载（URL 会过期）
        const md5s = [...content.matchAll(/文件名:([A-Fa-f0-9]{32})/g)].map((m) => m[1]!.toLowerCase());
        const byImage = md5s.length > 0 ? lookupImage?.(md5s) : undefined;
        // 图片归属：先用 MD5 精确匹配
        let who: string;
        if (byImage?.id || byImage?.name) {
          // MD5 命中就是硬证据，可以直接说
          who = isSelf(byImage.id)
            ? '你自己'
            : (byImage.name ?? shortSenderId(byImage.id!));
        } else {
          // MD5 没命中。**不要**拿 fallbackOwner 套上去：
          // 同一转发里能查到某条属于 A，不代表别的条目也属于 A
          // —— 实测过这会造成"全标成我自己"的过度推断。
          who = labelOf(content);
        }

        // 下载成功的图挂一个 #N 锚点，和下方 [Forward images] 里的编号对应。
        // 转发里常有多张不同消息/不同场次的图，没有编号模型会把它们混着说。
        const nodeNo = Number(head.match(/消息\s*(\d+)/)?.[1]) || i + 1;
        const anchor = forwardImageNumbers?.includes(nodeNo) === true ? ` #${nodeNo}` : '';
        lines.push(`${head}\n[消息内容] （${who}发了一张${zh}）[${zh}${anchor}]`);
        return;
      }

      let label = labelOf(content);
      // 过短的内容（如单个"1"）达不到反查门槛，只会落到"某人"。
      // 同一合并转发里其他条目若能确定发送者，就归给此人。
      //
      // 措辞原则：**这是给模型看的提示，不是给用户的报告**。
      // 不要写"推测""未知"这类官僚腔，否则她会照着复述成
      // 「前后两条都标着'某人'，认不出是谁」——那是在念系统提示，不是活人说话。
      // 注意：这里**不再**用 fallbackOwner 兜底。
      // 实测（2026-11-01 02:27）：同一转发里只要能查到一条属于她，
      // 就把查不到的条目全归成"你自己" —— 这是过度推断，比"某人"更糟
      // （用户看到的正是"这两张图现在都标成我自己发的了"）。
      // 宁可承认"看不出"，也不要瞎猜。
      lines.push(`${head}\n[消息内容] （${label}）${content}`);
    });

    const body = lines.join('\n\n');
    if (kept === 0) {
      return '[Quoted message begins]\n（下面引用的全是系统代你发出的运行状态提示，不是在跟任何人聊天）\n'
        + body + '\n[Quoted message ends]\n[Current message]\n';
    }
    // 顶部说明：如果只有她自己说的内容，就别用"不是你正在对话的那个人"这种措辞
    const selfOnly = !lines.some((l) => !l.includes('你自己之前说的') && !l.includes('已略去'));
    return `[Quoted message begins]\n（下面是合并转发，逐条标了是谁说的${
      selfOnly ? '' : '；不是你正在对话的那个人就按那个人理解'
    }）\n`
      + body + '\n[Quoted message ends]\n[Current message]\n';
  }

  // ── 单条引文 ──
  if (OPS_NOTICE.test(raw)) {
    return '[Quoted message begins]\n（这是系统代你发出的运行状态提示，不是别人在跟你聊天）\n[消息内容] （系统提示，已略去）\n[Quoted message ends]\n[Current message]\n';
  }

  // 发送者解析：store → refKey → 内容反查；文字查不到再试图片指纹
  // （她发的表情包以前从不进索引 → 引用她的图只会「看不出是谁说的」）
  let author = resolveSingle(raw);
  if (!author) {
    const md5s = (quote?.attachments ?? [])
      .map((a) => a.filename ?? '')
      .filter((f) => /^[A-Fa-f0-9]{32}/.test(f))
      .map((f) => f.slice(0, 32).toLowerCase());
    const byImage = md5s.length > 0 ? lookupImage?.(md5s) : undefined;
    if (byImage && (byImage.id || byImage.name)) author = byImage;
  }

  const selfHit = Boolean(author?.id && isSelf(author.id));
  const name = author?.name ?? (author?.id ? shortSenderId(author.id) : undefined);
  const attribution = selfHit
    ? '[Quoted message begins]\n（这是你自己之前说过的话）\n'
    : !name
      ? '[Quoted message begins]\n（看不出这句是谁说的）\n'
      : `[Quoted message begins]\n（这是「${name}」说的）\n`;

  return `${attribution}${raw}\n[Quoted message ends]\n[Current message]\n`;
}

/**
 * Layer 3: 带发送者标签的用户消息
 */
function buildUserMessage(
  userContent: string,
  quotePart: string,
  senderId: string,
  senderName: string | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
  ownerIds: readonly string[] = [],
): string {
  if (!isGroup) {
    return `${quotePart}${userContent}`;
  }

  const mentionTag = wasMentioned ? ' (@you)' : '';
  const displayName = senderName ?? shortSenderId(senderId);
  // 主人标注：主人可能用小号在群里说话，而模型只看得到群昵称 ——
  // 昵称不帶"江铭鑫"三个字时，她就把主人的小号当普通群友（2026-11-05 实测）。
  // openid 本来就在标签里，但没有任何地方告诉模型哪个 openid 是主人。
  const ownerTag = ownerIds.includes(senderId) ? '·主人' : '';
  const senderTag = `[${displayName}${ownerTag} (${senderId})]`;
  return `${quotePart}${senderTag} ${userContent}${mentionTag}`;
}

/**
 * Layer 4: 媒体元数据上下文（图片/视频/文件本地路径 + 语音 ASR + 引用附件）
 */
function buildDynamicCtx(
  msg: ProcessedMessage,
  state: MiddlewareState,
  visionEnabled: boolean,
): string {
  const lines: string[] = [];

  if (msg.attachments && msg.attachments.length > 0) {
    const downloadedByFilename = new Map((state.downloadedFiles ?? []).map(d => [d.filename, d]));
    const voices: RawAttachment[] = [];

    // 一次遍历归类 + 生成媒体行
    for (const att of msg.attachments) {
      const kind = classifyContentType(att.content_type);
      if (kind === 'voice') {
        voices.push(att);
        continue;
      }
      const d = downloadedByFilename.get(att.filename);
      lines.push(`- ${renderMediaLine(kind, att.filename, d?.localPath, att.url, att.size)}`);
    }

    // 语音：有 ASR 文本才带文本，否则只带链接（纯文本模型无法消费音频）
    if (voices.length > 0) {
      const asrTexts = voices.map(a => a.asr_refer_text).filter(Boolean);
      if (asrTexts.length > 0) {
        lines.push(`- ASR: ${asrTexts.join(' | ')}`);
      } else {
        const urls = voices.map(a => a.url).filter(Boolean);
        if (urls.length > 0) lines.push(`- Voice: ${urls.join(', ')}`);
      }
    }
  }

  // 引用消息的附件（独立于当前消息媒体，不受上一步为空影响）
  const quoteAttachments = state.quote?.attachments;
  if (quoteAttachments && quoteAttachments.length > 0) {
    const downloadedQuote = new Map((state.downloadedQuoteFiles ?? []).map(d => [d.filename, d]));
    lines.push('[Reference attachments]');
    for (const qa of quoteAttachments) {
      const kind = classifyContentType(qa.contentType);
      const d = downloadedQuote.get(qa.filename ?? '');
      if (kind === 'voice') {
        if (qa.asrText) lines.push(`  - Voice: ${qa.asrText}`);
        continue;
      }
      lines.push(`  - ${renderMediaLine(kind, qa.filename, d?.localPath, qa.url, undefined)}`);
    }
  }

  // 合并转发内的图：按「第几条」编号列出，和引文占位符上的 #N 对应。
  // 一条转发里常有多张来自不同消息的图（例如几场不同的战绩截图），
  // 平铺成一串路径会让模型把 A 图的内容安到 B 图上 —— 显式分开 + 写清护栏。
  const forwardFiles = state.downloadedForwardFiles ?? [];
  if (forwardFiles.length > 0) {
    lines.push('[Forward images]');
    let hasGif = false;
    for (const f of [...forwardFiles].sort((a, b) => a.nodeIndex - b.nodeIndex)) {
      // 下载时已按文件字节判定动图容器（GIF / APNG / 动画 WebP），扩展名只作兜底
      const animated = f.animated === true || /\.gif$/i.test(f.localPath);
      if (animated) hasGif = true;
      lines.push(`  #${f.nodeIndex}: Image: ${f.localPath}${animated ? '（动图）' : ''}`);
    }
    lines.push('（# 编号对应上面合并转发里的图片；不同 # 是不同消息、不同的图，不要混在一起描述）');
    if (hasGif) {
      lines.push('（标了「动图」的是会动的图，不是静态截图；看图工具会抽帧并给出每帧时刻，别把某一帧说成整张动图，也别猜角色名或编剧情）');
    }
  }

  // 图片进上下文的是「本地路径」这行文字，不是像素。要真看懂，得让她主动把路径
  // 交给看图工具；否则模型只会照着文件名/占位符猜（群里那些「看不到」多半就是这么来的）。
  // 只有 vision.enabled 开着、工具确实注册了才给这条提示。
  if (visionEnabled && lines.some(l => l.includes('Image: '))) {
    lines.push('[看图] 要看清图里的内容就调用 qqbot_describe_image，image 传上面的本地绝对路径；别只凭文件名或占位符猜。');
    // 对所有图片都给这条：APNG / 动画 WebP 没有 .gif 后缀，旧的 `.gif` 专属提示覆盖不到。
    lines.push('（看图工具会按文件字节识别动图：GIF 抽 8 帧拼成网格并给出帧号与时刻；'
      + 'APNG/动画 WebP 暂只能看到首帧，会明确标注「未完整解析」。'
      + '描述时只说画面里实际可见的内容，不要猜角色名、作品名或剧情，也不要把某一帧当成整张动图）');
  }

  return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}

/**
 * 渲染单个媒体附件（image/video/file）的上下文行内容，不含列表前缀。
 * 当前消息与引用消息共用，保证附件格式统一。语音不在此处理（见 buildDynamicCtx）。
 */
function renderMediaLine(
  kind: Exclude<MediaKind, 'voice'>,
  filename: string | undefined,
  localPath: string | undefined,
  url: string | undefined,
  size: number | undefined,
): string {
  switch (kind) {
    case 'image':
      return localPath
        ? `Image: ${localPath}`
        : `Image: ${url ?? filename ?? 'image'}`;
    case 'video':
      return localPath
        ? `Video: ${localPath}`
        : `Video: ${filename ?? 'video'} (download failed)`;
    case 'file':
      return localPath
        ? `File: ${localPath}`
        : `File: ${filename ?? 'file'} (${formatFileSize(size ?? 0)})`;
  }
}

/**
 * 群历史注入的时间窗（A）：超过这个时长的旧聊天不注入。
 *
 * 为什么需要：`historyBuffer` 只在"回复之后"才清空（inbound 末尾）——她没被唤醒
 * 的那些群消息只进缓冲、不清空，于是一小时后 @ 她，缓冲里还挂着上个小时的闲聊，
 * 她连带着别人的旧话题一起回答（2026-11-05 实测：@ 她问一句，她把 10 条别的
 * 对话全带上）。时间窗把"翻旧账"这条路关掉，同时保留近期追问的上下文。
 */
export const GROUP_HISTORY_WINDOW_MS = 10 * 60 * 1000;

/**
 * 从群历史里挑出"该注入"的那几条：只留窗口内的，且剔掉她自己的发言（B）。
 *
 * 剔自己的话为什么要紧：`appendBotHistory` 把她的回复也写进了群历史（为的是
 * 引用她自己的话时能认出来），但这些条目下一轮会被当成"群聊上下文"再喂回去，
 * 她看到 `[小羽 (...)] ...` 混在别人的对话里，会分不清哪句是她自己说的。
 *
 * 引用场景不受影响：引用她的话由 quote 链路（归属索引）单独处理，不走这里。
 *
 * @param selfId 她自己（或主人）的 openid；命中即剔除
 * @param now    当前时间（测试可注入）
 */
export function selectHistoryForPrompt(
  history: HistoryEntry[] | undefined,
  selfIds: ReadonlySet<string>,
  now: number = Date.now(),
  windowMs: number = GROUP_HISTORY_WINDOW_MS,
): HistoryEntry[] {
  if (!history || history.length === 0) return [];
  const out: HistoryEntry[] = [];
  for (const h of history) {
    // B：她自己的话不进"群聊上下文"
    if (selfIds.has(h.senderId)) continue;
    // A：超出时间窗的旧消息不注入（timestamp 缺失的条目按"旧"处理，宁可少带）
    const at = typeof h.timestamp === 'number' ? h.timestamp : 0;
    if (at <= 0 || now - at > windowMs) continue;
    out.push(h);
  }
  return out;
}

/**
 * Layer 5: 最终 agentBody 拼合
 */
export function buildAgentBody(
  base: string,
  history: HistoryEntry[] | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _anchor?: string,
  // A+B 的筛选参数：selfIds 要剔的自己人；now 便于测试注入
  opts: { selfIds?: ReadonlySet<string>; now?: number; windowMs?: number } = {},
): string {
  // 注意：anchor 不再拼进 user message。
  // 拼进去会污染上下文，且模型可能复述出"你是小羽…"这类系统指令（思考泄漏）。
  // 改为在 system prompt 层以最后 order 注入（见 service.buildSections）。
  if (!isGroup || !wasMentioned || !history || history.length === 0) {
    return base;
  }

  // A+B：只留窗口内、且不是她自己说的话
  const picked = selectHistoryForPrompt(history, opts.selfIds ?? new Set(), opts.now, opts.windowMs);

  // 筛完为空 → 不带历史段（避免给她一个空的 [Chat history begins] 反而误导）
  if (picked.length === 0) return base;

  const historyLines = picked.map(h => {
    const name = h.senderName ?? shortSenderId(h.senderId);
    return `[${name} (${h.senderId})] ${h.content}`;
  });

  return [
    '[Chat history begins]',
    ...historyLines,
    '',
    '[Chat history ends]',
    '[Current message]',
    base,
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════
// 辅助函数
// ══════════════════════════════════════════════════════════════

interface VoiceText {
  text: string;
  duration?: number;
  source: 'stt' | 'asr' | 'fallback';
}

function extractVoiceTexts(
  attachments?: RawAttachment[],
  processed?: ProcessedAttachment[],
  _logger?: Logger,
): VoiceText[] {
  const results: VoiceText[] = [];

  if (processed) {
    for (const pa of processed) {
      if (pa.type === 'voice' && pa.voiceText) {
        results.push({
          text: pa.voiceText,
          duration: pa.duration,
          source: pa.voiceSource ?? 'stt',
        });
      }
    }
  }

  if (results.length === 0 && attachments) {
    for (const att of attachments) {
      if (isVoiceContentType(att.content_type) && att.asr_refer_text) {
        results.push({
          text: att.asr_refer_text.trim(),
          source: 'asr',
        });
      }
    }
  }

  return results;
}

/**
 * 附件类型标签（Layer 1 用户消息主体里的轻量提示）。
 * 只标注「带了什么类型的附件」，去重；媒体本地路径在 buildDynamicCtx 提供。
 */
function buildAttachmentTags(attachments?: RawAttachment[]): string {
  if (!attachments || attachments.length === 0) return '';

  const labels: Record<string, string> = {
    image: '[图片]',
    video: '[视频]',
    file: '[文件]',
  };

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const att of attachments) {
    const kind = classifyContentType(att.content_type);
    if (kind === 'voice' || seen.has(kind)) continue;
    seen.add(kind);
    const label = labels[kind];
    if (label) tags.push(label);
  }

  return tags.join(' ');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 发送者短标识长度（openid 前 N 位，无昵称时兜底） */
const SENDER_SHORT_ID_LEN = 8;

/** 无昵称时用 openid 前 N 位作为匿名标识 */
function shortSenderId(senderId: string): string {
  return senderId.slice(0, SENDER_SHORT_ID_LEN);
}
