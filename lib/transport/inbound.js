import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendFileSync } from 'node:fs';
import { classifyContentType, isVoiceContentType, } from "./attachment.js";
import { clearGroupHistory } from "../features/history-store.js";
import { lookupAttribution, lookupByImageMd5 } from "../features/attribution-index.js";
import { stashPendingAttachments, takePendingAttachments, pendingKey } from "../features/pending-attachments.js";
// ── 主处理函数 ──
/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export async function handleInbound(ctx, manager, config, logger) {
    const msg = ctx.message;
    const mwState = ctx.state;
    const { bot } = ctx;
    const scope = msg.kind === 'group' ? 'group' : 'c2c';
    const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;
    const replyTarget = {
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
    if (mwState.collectOnly === true) {
        const files = mwState.downloadedFiles ?? [];
        if (files.length > 0) {
            stashPendingAttachments(pendingKey(scope, peerId, msg.senderId), files);
        }
        logger.info(`收集模式: scope=${scope} peerId=${peerId} 附件 ${files.length} 个已归档待领`);
        return;
    }
    // ── 唤醒消息：领走同一人刚发但没被唤醒的图（"先发图、后 @" 场景）──
    let carriedFiles = [];
    {
        carriedFiles = takePendingAttachments(pendingKey(scope, peerId, msg.senderId));
        if (carriedFiles.length > 0) {
            mwState.downloadedFiles = [...(mwState.downloadedFiles ?? []), ...carriedFiles];
            logger.info(`领走先前 ${carriedFiles.length} 个待领附件 → 本次唤醒一并交给 agent`);
        }
    }
    // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供） ──
    const gid = msg.groupOpenid ?? msg.senderId;
    let agentBody = assembleAgentBody(msg, mwState, scope, logger, undefined, config.persona?.botOpenid, scope === 'group'
        ? (text) => {
            const hit = lookupAttribution(config.appId, gid, text);
            return hit ? { id: hit.senderId, name: hit.senderName } : {};
        }
        : undefined, scope === 'group'
        ? (md5s) => {
            const hit = lookupByImageMd5(config.appId, gid, md5s);
            return hit ? { id: hit.senderId, name: hit.senderName } : {};
        }
        : undefined);
    // 把"先发的图"补进 agentBody，否则 agent 不知道这几张图的存在
    if (carriedFiles.length > 0) {
        const lines = carriedFiles.map((f) => `- image: ${f.localPath}`).join('\n');
        const note = `[对方在你被唤醒前刚发的图片]\n${lines}\n`;
        agentBody = agentBody === null ? note : `${note}${agentBody}`;
    }
    if (!agentBody)
        return;
    logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);
    // ── 诊断：把进来的消息（含附件/下载结果）追加到调试文件，便于排查"图片收不到" ──
    try {
        const dbg = '/root/.dsh-qqbot/debug-inbound.jsonl';
        const atts = (msg.attachments ?? []).map((a) => ({
            content_type: a.content_type,
            filename: a.filename,
            size: a.size,
            url: (a.url ?? '').slice(0, 120),
        }));
        appendFileSync(dbg, `${JSON.stringify({
            t: new Date().toISOString(),
            scope,
            peerId,
            senderId: msg.senderId,
            content: (msg.content ?? '').slice(0, 120),
            msgType: msg.msgType,
            attachments: atts,
            attachmentsCount: atts.length,
            msgElements: msg.msgElements ?? null,
            messageScene: msg.messageScene ?? null,
            downloaded: (mwState.downloadedFiles ?? []).map((d) => d.localPath),
            bodyHead: agentBody.slice(0, 400),
        })}\n`);
    }
    catch {
        /* 诊断失败不影响主流程 */
    }
    // ── 获取或创建会话 ──
    let record;
    try {
        record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
    }
    catch (err) {
        logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
        // 兜底回复：会话创建失败时告知用户，避免静默无响应
        try {
            await bot.sendMarkdown(replyTarget, '⚠️ 处理消息时出现异常，请稍后重试。');
        }
        catch (sendErr) {
            logger.error(`fallback reply failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
        }
        return;
    }
    // ── 构建 UserMessage → followup ──
    const content = [{ type: 'text', text: agentBody }];
    const message = createUserMessage({
        content,
        source: { kind: 'user' },
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
    }
    catch (err) {
        logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
}
// ══════════════════════════════════════════════════════════════
// Body Assembly（5 层组装）
// ══════════════════════════════════════════════════════════════
/**
 * 组装 agentBody — AI 实际看到的完整上下文
 */
function assembleAgentBody(msg, state, scope, logger, anchor, botOpenid, 
/** 按内容反查引文发送者（独立归属索引，不受群历史清空影响） */
lookupSender, 
/** 按图片 MD5 反查（QQ 的图片文件名就是内容 MD5，无需下载图片） */
lookupImage) {
    const isGroup = scope === 'group';
    const wasMentioned = state.mention?.wasMentioned ?? false;
    const userContent = buildUserContent(msg, state, logger);
    if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned))
        return null;
    const quotePart = buildQuotePart(state.quote, state.history, botOpenid || detectBotSelfId(state.history), lookupSender, lookupImage);
    const userMessage = buildUserMessage(userContent, quotePart, msg.senderId, msg.senderName, isGroup, wasMentioned);
    const dynamicCtx = buildDynamicCtx(msg, state);
    const base = dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
    const agentBody = buildAgentBody(base, state.history, isGroup, wasMentioned, anchor);
    return agentBody;
}
/**
 * 判断消息是否为空：无文本/语音/附件，且非群聊 @。
 * 群聊被 @ 视为有效触发信号，即使内容为空也保留给 agent。
 */
function isEmptyMessage(userContent, attachments, isGroup, wasMentioned) {
    if (userContent)
        return false;
    if (attachments && attachments.length > 0)
        return false;
    if (isGroup && wasMentioned)
        return false;
    return true;
}
/**
 * Layer 1: 用户文本内容 + 语音转录 + 附件类型标签（媒体路径由 buildDynamicCtx 提供）
 */
function buildUserContent(msg, state, logger) {
    const parts = [];
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
function detectBotSelfId(history) {
    if (!history?.length)
        return undefined;
    for (const h of history) {
        const m = String(h.content ?? '').match(/<@([A-Fa-f0-9]{20,})>/);
        if (m)
            return m[1];
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
export function buildQuotePart(quote, history, botSelfId, lookupSender, lookupImage) {
    if (!quote?.text && !quote?.entry?.content)
        return '';
    const raw = quote.text || quote.entry?.content || 'Original content unavailable';
    /** 运维提示的正判据：内容本身长得像运行状态播报（不能只看 isBot） */
    const OPS_NOTICE = /(\u26a0\ufe0f\s*本轮异常结束|RATE_LIMIT|MISSING_CREDENTIAL|NO_ADAPTER|UNSUPPORTED_REASONING|SERVER:|超限|本轮异常)/;
    /** 归一化：去合并转发头、去标签、压空白，用于内容比对 */
    const norm = (t) => t.replace(/^===.*===$/gm, '')
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
    const lookup = (text) => {
        // 优先用独立归属索引（不受群历史清空影响，能覆盖"引用上一轮说过的话"）
        const fromIndex = lookupSender?.(text);
        if (fromIndex && (fromIndex.id || fromIndex.name))
            return fromIndex;
        const probe = norm(text);
        if (probe.length < 4 || !history?.length)
            return {};
        for (const h of [...history].reverse()) {
            const body = norm(String(h.content ?? ''));
            if (!body || body.length < 4)
                continue;
            if (probe.includes(body) || (body.length >= 8 && body.includes(probe))) {
                return { id: h.senderId, name: h.senderName };
            }
        }
        return {};
    };
    /** 这个人是不是"她自己"（用于把"别人说的"和"她自己说过的"区分开） */
    const isSelf = (id) => Boolean(botSelfId && id && id === botSelfId);
    /** 一段引文的归属短语 */
    const labelOf = (text, storeId, storeName) => {
        const found = (storeId || storeName) ? { id: storeId, name: storeName } : lookup(text);
        const name = found.name ?? (found.id ? shortSenderId(found.id) : undefined);
        if (!name)
            return '某人';
        if (isSelf(found.id))
            return `这是你自己之前说的「${name}」`;
        return `${name}${found.id ? ` (${found.id})` : ''}`;
    };
    // ── 合并转发：逐条归属 + 剥离运维提示 ──
    if (raw.includes('=== 消息')) {
        const headers = [];
        for (const m of raw.matchAll(/^===\s*消息\s*\d+\s*===\s*$/gm))
            headers.push(m[0].trim());
        const parts = raw.split(/^===\s*消息\s*\d+\s*===\s*$/m).slice(1);
        // 先扫一遍：这条合并转发里能确定的发送者（用于给过短的条目做弱推断）
        let fallbackOwner;
        for (const part of parts) {
            const c = part.trim().replace(/^\[消息内容\]\s*/, '').replace(/\[消息类型\][^\n]*/g, '').trim();
            if (!c)
                continue;
            const hit = lookup(c);
            if (hit.name || hit.id) {
                const nm = hit.name ?? (hit.id ? shortSenderId(hit.id) : '');
                // 不再排除"她自己"：合并转发里如果只有她说的话，
                // 过短的条目同样大概率是她的（排除掉反而只能落"某人"）
                if (nm) {
                    fallbackOwner = nm;
                    break;
                }
            }
        }
        const lines = [];
        let kept = 0;
        parts.forEach((part, i) => {
            const content = part.trim().replace(/^\[消息内容\]\s*/, '').replace(/\[消息类型\][^\n]*/g, '').trim();
            if (!content)
                return;
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
                const zh = /图/.test(kind) ? '图片' : /视频/.test(kind) ? '视频' : /文件/.test(kind) ? '文件' : '附件';
                // 图片归属：文件名就是内容 MD5 → 直接对索引，不需要下载（URL 会过期）
                const md5s = [...content.matchAll(/文件名:([A-Fa-f0-9]{32})/g)].map((m) => m[1].toLowerCase());
                const byImage = md5s.length > 0 ? lookupImage?.(md5s) : undefined;
                let who = byImage?.name
                    ?? (byImage?.id ? shortSenderId(byImage.id) : undefined)
                    ?? labelOf(content, quote.entry?.senderId, quote.entry?.senderName);
                if (byImage?.id && isSelf(byImage.id))
                    who = '你自己';
                else if (who === '某人' && fallbackOwner)
                    who = fallbackOwner === '小羽' ? '你自己' : fallbackOwner;
                lines.push(`${head}\n[消息内容] （${who}发了一张${zh}）[${zh}]`);
                return;
            }
            let label = labelOf(content, quote.entry?.senderId, quote.entry?.senderName);
            // 过短的内容（如单个"1"）达不到反查门槛，只会落到"某人"。
            // 同一合并转发里其他条目若能确定发送者，就归给此人。
            //
            // 措辞原则：**这是给模型看的提示，不是给用户的报告**。
            // 不要写"推测""未知"这类官僚腔，否则她会照着复述成
            // 「前后两条都标着'某人'，认不出是谁」——那是在念系统提示，不是活人说话。
            if (label === '某人' && fallbackOwner) {
                label = fallbackOwner === '小羽'
                    ? '大概率是你自己'
                    : fallbackOwner;
            }
            lines.push(`${head}\n[消息内容] （${label}）${content}`);
        });
        const body = lines.join('\n\n');
        if (kept === 0) {
            return '[Quoted message begins]\n（下面引用的全是系统代你发出的运行状态提示，不是在跟任何人聊天）\n'
                + body + '\n[Quoted message ends]\n[Current message]\n';
        }
        // 顶部说明：如果只有她自己说的内容，就别用"不是你正在对话的那个人"这种措辞
        const selfOnly = !lines.some((l) => !l.includes('你自己之前说的') && !l.includes('已略去'));
        return `[Quoted message begins]\n（下面是合并转发，逐条标了是谁说的${selfOnly ? '' : '；不是你正在对话的那个人就按那个人理解'}）\n`
            + body + '\n[Quoted message ends]\n[Current message]\n';
    }
    // ── 单条引文 ──
    if (OPS_NOTICE.test(raw)) {
        return '[Quoted message begins]\n（这是系统代你发出的运行状态提示，不是别人在跟你聊天）\n[消息内容] （系统提示，已略去）\n[Quoted message ends]\n[Current message]\n';
    }
    const label = labelOf(raw, quote.entry?.senderId, quote.entry?.senderName);
    const found = lookup(raw);
    const attribution = found.id && isSelf(found.id)
        ? '[Quoted message begins]\n（这是你自己之前说过的话）\n'
        : label === '某人'
            ? '[Quoted message begins]\n（看不出这句是谁说的）\n'
            : `[Quoted message begins]\n（这是「${label}」说的）\n`;
    return `${attribution}${raw}\n[Quoted message ends]\n[Current message]\n`;
}
/**
 * Layer 3: 带发送者标签的用户消息
 */
function buildUserMessage(userContent, quotePart, senderId, senderName, isGroup, wasMentioned) {
    if (!isGroup) {
        return `${quotePart}${userContent}`;
    }
    const mentionTag = wasMentioned ? ' (@you)' : '';
    const displayName = senderName ?? shortSenderId(senderId);
    const senderTag = `[${displayName} (${senderId})]`;
    return `${quotePart}${senderTag} ${userContent}${mentionTag}`;
}
/**
 * Layer 4: 媒体元数据上下文（图片/视频/文件本地路径 + 语音 ASR + 引用附件）
 */
function buildDynamicCtx(msg, state) {
    const lines = [];
    if (msg.attachments && msg.attachments.length > 0) {
        const downloadedByFilename = new Map((state.downloadedFiles ?? []).map(d => [d.filename, d]));
        const voices = [];
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
            }
            else {
                const urls = voices.map(a => a.url).filter(Boolean);
                if (urls.length > 0)
                    lines.push(`- Voice: ${urls.join(', ')}`);
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
                if (qa.asrText)
                    lines.push(`  - Voice: ${qa.asrText}`);
                continue;
            }
            lines.push(`  - ${renderMediaLine(kind, qa.filename, d?.localPath, qa.url, undefined)}`);
        }
    }
    return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}
/**
 * 渲染单个媒体附件（image/video/file）的上下文行内容，不含列表前缀。
 * 当前消息与引用消息共用，保证附件格式统一。语音不在此处理（见 buildDynamicCtx）。
 */
function renderMediaLine(kind, filename, localPath, url, size) {
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
 * Layer 5: 最终 agentBody 拼合
 */
function buildAgentBody(base, history, isGroup, wasMentioned, 
// eslint-disable-next-line @typescript-eslint/no-unused-vars
_anchor) {
    // 注意：anchor 不再拼进 user message。
    // 拼进去会污染上下文，且模型可能复述出"你是小羽…"这类系统指令（思考泄漏）。
    // 改为在 system prompt 层以最后 order 注入（见 service.buildSections）。
    if (!isGroup || !wasMentioned || !history || history.length === 0) {
        return base;
    }
    const historyLines = history.map(h => {
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
function extractVoiceTexts(attachments, processed, _logger) {
    const results = [];
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
function buildAttachmentTags(attachments) {
    if (!attachments || attachments.length === 0)
        return '';
    const labels = {
        image: '[图片]',
        video: '[视频]',
        file: '[文件]',
    };
    const seen = new Set();
    const tags = [];
    for (const att of attachments) {
        const kind = classifyContentType(att.content_type);
        if (kind === 'voice' || seen.has(kind))
            continue;
        seen.add(kind);
        const label = labels[kind];
        if (label)
            tags.push(label);
    }
    return tags.join(' ');
}
function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
/** 发送者短标识长度（openid 前 N 位，无昵称时兜底） */
const SENDER_SHORT_ID_LEN = 8;
/** 无昵称时用 openid 前 N 位作为匿名标识 */
function shortSenderId(senderId) {
    return senderId.slice(0, SENDER_SHORT_ID_LEN);
}
//# sourceMappingURL=inbound.js.map