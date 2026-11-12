import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendFileSync } from 'node:fs';
import { formatAnimationMeta, probeAnimationSync } from "../media/animation-probe.js";
import { classifyContentType, isVoiceContentType, } from "./attachment.js";
import { clearGroupHistory } from "../features/history-store.js";
import { lookupAttribution, lookupByImageMd5, lookupRefSender } from "../features/attribution-index.js";
import { recordGroupActivity } from "../features/group-activity.js";
import { stashPendingAttachments, takePendingAttachments, pendingKey } from "../features/pending-attachments.js";
const DEFAULT_GROUP_DEBOUNCE_MS = 500;
const DEFAULT_GROUP_DEBOUNCE_MAX_WAIT_MS = 2000;
const DEFAULT_GROUP_DEBOUNCE_MAX_BATCH = 3;
/** 缓冲 key = scope + peerId + senderId（同一群多人同时连发互不干扰） */
const pendingBatches = new Map();
/**
 * 同一 peer 的处理串行链。
 *
 * 为什么要它：聚合后 handleInbound 会**提前返回**（把真正的工作交给定时器），
 * SDK 的 concurrencyGuard（middleware-setup 第 9 步，key = scope:targetId）
 * 因此在这一轮立刻释放锁 —— 而它存在的意义正是避免同一个群同时开两条
 * stream_messages 把平台打成 500。这里按 peer 补一条串行链，保住那个不变量。
 */
const peerChains = new Map();
/**
 * 仅供测试：清空聚合缓冲与串行链。
 *
 * 这两个 Map 是模块级的（跨消息存在），测试里不清理会从上一个用例串到下一个
 * ——比如"攒满 3 条"的用例留下未 flush 的批次，后面"关闭聚合"的用例就会
 * 数到意外的 followup 次数。生产代码不调用它。
 */
export function resetGroupDebounceForTest() {
    for (const batch of pendingBatches.values()) {
        if (batch.timer)
            clearTimeout(batch.timer);
    }
    pendingBatches.clear();
    peerChains.clear();
}
/** 从配置读窗口参数；缺项、非法值一律回落默认（配置改错不该让 bot 不开口） */
function resolveGroupDebounce(config) {
    const persona = config.persona;
    const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
    const windowMs = num(persona?.groupDebounceMs, DEFAULT_GROUP_DEBOUNCE_MS);
    const rawMaxWait = num(persona?.groupDebounceMaxWaitMs, DEFAULT_GROUP_DEBOUNCE_MAX_WAIT_MS);
    const rawMaxBatch = num(persona?.groupDebounceMaxBatch, DEFAULT_GROUP_DEBOUNCE_MAX_BATCH);
    return {
        windowMs,
        // maxWait 为 0 时按窗口处理：窗口本身已经是"静止多久才开口"，再叠 0 没有意义
        maxWaitMs: rawMaxWait > 0 ? rawMaxWait : windowMs,
        maxBatch: Math.max(1, Math.floor(rawMaxBatch)),
    };
}
/** 聚合 key：同群同人 */
function debounceKey(scope, peerId, senderId) {
    return `${scope}:${peerId}:${senderId}`;
}
/**
 * 把这一条塞进缓冲；到点（静止 / 攒满 / 等超时）就交给 processInbound。
 *
 * 注意这是同步函数、不 await：真正的处理在定时器/立即 flush 里发生，
 * 所以 handleInbound 会先返回（见上面 peerChains 的注释）。
 */
function bufferGroupMessage(ctx, manager, config, logger, opts) {
    const msg = ctx.message;
    const peerId = msg.groupOpenid ?? msg.senderId;
    const key = debounceKey('group', peerId, msg.senderId);
    const now = Date.now();
    let batch = pendingBatches.get(key);
    if (!batch) {
        batch = { items: [], timer: null, startedAt: now, manager, config, logger };
        pendingBatches.set(key, batch);
    }
    batch.items.push({ ctx, msg, state: ctx.state });
    // 上限①：攒满了立刻处理（"先到先处理"）
    if (batch.items.length >= opts.maxBatch) {
        logger.debug(`debounce: ${key} 攒满 ${batch.items.length} 条 → 立即处理`);
        flushBatch(key);
        return;
    }
    // 上限②：从第一条算起等太久了
    const elapsed = now - batch.startedAt;
    if (elapsed >= opts.maxWaitMs) {
        logger.debug(`debounce: ${key} 已等 ${elapsed}ms ≥ ${opts.maxWaitMs}ms → 立即处理`);
        flushBatch(key);
        return;
    }
    // 滑动窗口：每来一条就重置计时；但不得超过 maxWait 的剩余时间
    const delay = Math.min(opts.windowMs, opts.maxWaitMs - elapsed);
    if (batch.timer)
        clearTimeout(batch.timer);
    batch.timer = setTimeout(() => flushBatch(key), delay);
    // 项目惯例：定时器不阻止进程退出（见 persona/own-life.ts）
    batch.timer.unref?.();
}
/** 取出缓冲、按顺序拼成一条，再交给下游（同一 peer 串行） */
function flushBatch(key) {
    const batch = pendingBatches.get(key);
    if (!batch)
        return;
    pendingBatches.delete(key);
    if (batch.timer) {
        clearTimeout(batch.timer);
        batch.timer = null;
    }
    if (batch.items.length === 0)
        return;
    const { manager, config, logger } = batch;
    const merged = mergeBatch(batch.items, logger);
    // 同 peer 串行：上一批的 turn 收敛后再跑这一批
    const prev = peerChains.get(merged.peerKey) ?? Promise.resolve();
    const run = prev.then(() => processInbound(merged.ctx, manager, config, logger), 
    // 上一批自己失败了也不能卡住后面的人（finally 那一路同样要吞掉异常，
    // 否则会变成 unhandled rejection 把进程搞崩）
    () => processInbound(merged.ctx, manager, config, logger)).catch((err) => {
        logger.error(`debounce: 处理失败 peer=${merged.peerKey}: ${err instanceof Error ? err.message : String(err)}`);
    });
    peerChains.set(merged.peerKey, run);
    void run.then(() => {
        if (peerChains.get(merged.peerKey) === run)
            peerChains.delete(merged.peerKey);
    });
}
/**
 * 把一批同人消息合成一条。
 *
 * 三条硬要求：
 *   1. **按顺序**拼正文（换行分隔），一条都不能丢；
 *   2. 附件/下载结果全部带过去（一批里混了带图的、纯图的，图不能消失）；
 *   3. 只动"本批最后一条"那个 ctx（它也提供最新 msgId 作被动回复目标），
 *      其余 ctx 只读。
 *
 * 为什么用最后一条做载体：被动回复窗口绑在 msgId 上，取最新的那条，
 * 5 分钟有效期才最宽。前几条的 msgId 也已被 bootstrap 里的 cacheMsgId 记着，
 * 出站侧仍能取到。
 */
function mergeBatch(items, logger) {
    const carrier = items[items.length - 1];
    const ctx = carrier.ctx;
    const msg = carrier.msg;
    const state = carrier.state;
    const peerId = msg.groupOpenid ?? msg.senderId;
    if (items.length === 1) {
        return { ctx, peerKey: `group:${peerId}` };
    }
    const texts = [];
    const attachments = [];
    const downloadedFiles = [];
    const downloadedQuoteFiles = [];
    const processedAttachments = [];
    let wasMentioned = false;
    let implicit = false;
    let anyWoken = false;
    let quote;
    for (const item of items) {
        const text = (item.msg.content ?? '').trim();
        if (text)
            texts.push(text);
        if (item.msg.attachments && item.msg.attachments.length > 0) {
            attachments.push(...item.msg.attachments);
        }
        const df = item.state.downloadedFiles;
        if (df && df.length > 0)
            downloadedFiles.push(...df);
        const dqf = item.state.downloadedQuoteFiles;
        if (dqf && dqf.length > 0)
            downloadedQuoteFiles.push(...dqf);
        const pa = item.state.processedAttachments;
        if (pa && pa.length > 0)
            processedAttachments.push(...pa);
        if (item.state.mention?.wasMentioned === true)
            wasMentioned = true;
        if (item.state.mention?.implicit === true)
            implicit = true;
        if (item.state.collectOnly !== true)
            anyWoken = true;
        // 引用块：取本批里第一个真正的引用（最后一条常常是「？」这种空引用追问，
        // 丢掉前一条的引用就丢掉了"她在回应哪句话"这个关键归属）
        if (!quote && (item.state.quote?.text || item.state.quote?.entry?.content)) {
            quote = item.state.quote;
        }
    }
    // ── 正文按原顺序拼接 ──
    msg.content = texts.join('\n');
    // ── 附件全量带过去（按到达顺序，与正文对齐）──
    if (attachments.length > 0)
        msg.attachments = attachments;
    if (downloadedFiles.length > 0)
        state.downloadedFiles = downloadedFiles;
    if (downloadedQuoteFiles.length > 0)
        state.downloadedQuoteFiles = downloadedQuoteFiles;
    if (processedAttachments.length > 0)
        state.processedAttachments = processedAttachments;
    // ── 唤醒状态：本批任一条醒过就算醒（否则纯收集模式会吞掉正文）──
    state.mention = { ...(state.mention ?? {}), wasMentioned, implicit };
    // ── 引用块补齐 ──
    if (quote && !state.quote)
        state.quote = quote;
    // ── 只收图模式：整批都是"只收集"才沿用，混进唤醒消息就正常回话 ──
    state.collectOnly = !anyWoken;
    logger.info(`debounce: 聚合 ${items.length} 条 → scope=group peerId=${peerId} sender=${msg.senderId} `
        + `text="${texts.join(' / ').slice(0, 120)}" attachments=${attachments.length}`);
    return { ctx, peerKey: `group:${peerId}` };
}
// ── 主处理函数 ──
/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）。
 *
 * 群聊走「同人连发聚合窗口」（见文件上部那段长注释），私聊立即处理。
 */
export async function handleInbound(ctx, manager, config, logger) {
    const msg = ctx.message;
    const scope = msg.kind === 'group' ? 'group' : 'c2c';
    const debounce = resolveGroupDebounce(config);
    // 私聊 / 关闭聚合（groupDebounceMs: 0）→ 原来的立即处理路径，一行不差
    if (scope === 'group' && debounce.windowMs > 0) {
        bufferGroupMessage(ctx, manager, config, logger, debounce);
        return;
    }
    await processInbound(ctx, manager, config, logger);
}
/** 真正干活的部分：组装 agentBody → 会话 → followup → 等 turn 收敛 */
async function processInbound(ctx, manager, config, logger) {
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
        : undefined, 
    // msgIdx → 发送者直查（quoteRef 的 enrichEntry 记的；短消息/截断预览也能命中）
    scope === 'group'
        ? (refKey) => {
            const hit = lookupRefSender(refKey);
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
    // 群活跃度埋点：只记聚合指标（时间戳 / 关键词命中 / 发言者），不留原文。
    // 用途是「Dota 战绩播报该发哪个群」的相关度评分，未配置时静默忽略。
    if (scope === 'group')
        recordGroupActivity(peerId, msg.senderId, agentBody);
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
lookupImage, 
/** 按消息 id（msgIdx）直查发送者（quoteRef 的 enrichEntry 记的，权威） */
lookupRef) {
    const isGroup = scope === 'group';
    const wasMentioned = state.mention?.wasMentioned ?? false;
    const userContent = buildUserContent(msg, state, logger);
    if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned))
        return null;
    const quotePart = buildQuotePart(state.quote, state.history, botOpenid || detectBotSelfId(state.history), lookupSender, lookupImage, lookupRef);
    const userMessage = buildUserMessage(userContent, quotePart, msg.senderId, msg.senderName, isGroup, wasMentioned);
    const dynamicCtx = buildDynamicCtx(msg, state);
    const base = dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
    // A+B：群历史只留近 10 分钟、且剔掉她自己的发言。
    // selfIds 用解析后的 selfId（config.persona.botOpenid 或从历史探测到的）；
    // 主人自己的 openid 也一并剔除——他发的话属于"群聊上下文"，但会和白名单上的
    // "在问她"重复，且偶尔被他自己的群昵称干扰（见 knownNames 那轮修复）。
    const selfIds = new Set();
    const resolvedSelf = botOpenid || detectBotSelfId(state.history);
    if (resolvedSelf)
        selfIds.add(resolvedSelf);
    const agentBody = buildAgentBody(base, state.history, isGroup, wasMentioned, anchor, { selfIds });
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
export function buildQuotePart(quote, history, botSelfId, lookupSender, lookupImage, 
/** 按消息 id（msgIdx）直查发送者——比内容反查权威，短消息/截断预览也能命中 */
lookupRef) {
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
        if (probe.length < 2 || !history?.length)
            return {};
        // 短引文（<4 字）只做完全一致匹配，避免「嗯」命中任何含「嗯」的话
        for (const h of [...history].reverse()) {
            const body = norm(String(h.content ?? ''));
            if (!body || body.length < 2)
                continue;
            if (probe.length < 4) {
                if (body === probe)
                    return { id: h.senderId, name: h.senderName };
                continue;
            }
            if (probe.includes(body) || (body.length >= 8 && body.includes(probe))) {
                return { id: h.senderId, name: h.senderName };
            }
        }
        return {};
    };
    /** 这个人是不是"她自己"（用于把"别人说的"和"她自己说过的"区分开） */
    const isSelf = (id) => Boolean(botSelfId && id && id === botSelfId);
    /**
     * 单条引文的发送者。权威优先级：
     *   1. QQ store 的 entry（被引用消息本尊的发送者）
     *   2. refKey 按 msgIdx 直查（2026-11-10：短消息/被截断的预览也能命中）
     *   3. 内容反查（归属索引 → 群历史）
     *
     * **合并转发绝不能走这条路**：store/refKey 指向的是"转发这条合并消息的人"，
     * 不是每条内容的作者——整块套一个人正是 2026-11-01 事故的同类错误。
     * 返回 undefined 表示"确实查不到"，而不是空对象。
     */
    const resolveSingle = (text) => {
        if (quote.entry?.senderId || quote.entry?.senderName) {
            return { id: quote.entry.senderId, name: quote.entry.senderName };
        }
        const byRef = lookupRef?.(quote.refKey);
        if (byRef && (byRef.id || byRef.name))
            return byRef;
        const byContent = lookup(text);
        return (byContent.id || byContent.name) ? byContent : undefined;
    };
    /**
     * 合并转发逐条的归属短语：只认内容反查。
     *
     * 2026-11-10 修正：以前这里会把 `quote.entry?.senderId`（=转发者）传进来，
     * 导致转发包里**她自己说的话被标成转发者的名字**——正是"把自己的话
     * 当成别人说的"在合并转发场景的复活。
     */
    const labelOf = (text) => {
        const found = lookup(text);
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
                // 图片归属：先用 MD5 精确匹配
                let who;
                if (byImage?.id || byImage?.name) {
                    // MD5 命中就是硬证据，可以直接说
                    who = isSelf(byImage.id)
                        ? '你自己'
                        : (byImage.name ?? shortSenderId(byImage.id));
                }
                else {
                    // MD5 没命中。**不要**拿 fallbackOwner 套上去：
                    // 同一转发里能查到某条属于 A，不代表别的条目也属于 A
                    // —— 实测过这会造成"全标成我自己"的过度推断。
                    who = labelOf(content);
                }
                lines.push(`${head}\n[消息内容] （${who}发了一张${zh}）[${zh}]`);
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
        return `[Quoted message begins]\n（下面是合并转发，逐条标了是谁说的${selfOnly ? '' : '；不是你正在对话的那个人就按那个人理解'}）\n`
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
        const md5s = (quote.attachments ?? [])
            .map((a) => a.filename ?? '')
            .filter((f) => /^[A-Fa-f0-9]{32}/.test(f))
            .map((f) => f.slice(0, 32).toLowerCase());
        const byImage = md5s.length > 0 ? lookupImage?.(md5s) : undefined;
        if (byImage && (byImage.id || byImage.name))
            author = byImage;
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
 *
 * ## 动图标注（2026-11-12）
 *
 * 以前这里只输出 `Image: /path/x.gif`，视觉模型按单图处理 → 只取首帧，
 * 42 帧的动图丢掉 41 帧。她的原话："这中间做了什么动作我全不知道……
 * 所以这张图给我的信息量，其实和一张截图差不多。"
 *
 * 根因是她**不知道收到的是动图**，不是不会抽帧。所以这里只加一行零成本的
 * 元信息（帧数/时长/尺寸 + 想看动作用哪个工具），不自动抽帧 —— 抽帧要视觉
 * 调用，成本和延迟都该由她自己决定要不要付（见 qq_watch_animation）。
 *
 * 静态图输出**一个字符都不变**。探测任何异常都静默退化（见 animation-probe）。
 */
function renderMediaLine(kind, filename, localPath, url, size) {
    switch (kind) {
        case 'image': {
            if (!localPath)
                return `Image: ${url ?? filename ?? 'image'}`;
            const anim = safeProbeAnimation(localPath);
            if (anim === null)
                return `Image: ${localPath}`;
            // 时长读不到时 formatAnimationMeta 会省略，不会写出假的 0.00s
            return `Image: ${localPath} (${formatAnimationMeta(anim)} —— 你可能只看到第一帧，`
                + `想看动作用 qq_watch_animation)`;
        }
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
 * 动图探测的**兜底封装**：任何异常都退回「不知道」（= 按静态图渲染）。
 *
 * 为什么要这一层：附件行渲染在消息主路径上，它抛异常会连累整条消息进不来。
 * probeAnimationSync 自己已经全部 catch 过，这里再兜一次是防未来改动
 * （比如有人在里面加了个会抛的调用）—— 渲染失败绝不能比看不懂动图更严重。
 */
function safeProbeAnimation(localPath) {
    try {
        return probeAnimationSync(localPath);
    }
    catch {
        return null;
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
export function selectHistoryForPrompt(history, selfIds, now = Date.now(), windowMs = GROUP_HISTORY_WINDOW_MS) {
    if (!history || history.length === 0)
        return [];
    const out = [];
    for (const h of history) {
        // B：她自己的话不进"群聊上下文"
        if (selfIds.has(h.senderId))
            continue;
        // A：超出时间窗的旧消息不注入（timestamp 缺失的条目按"旧"处理，宁可少带）
        const at = typeof h.timestamp === 'number' ? h.timestamp : 0;
        if (at <= 0 || now - at > windowMs)
            continue;
        out.push(h);
    }
    return out;
}
/**
 * Layer 5: 最终 agentBody 拼合
 */
export function buildAgentBody(base, history, isGroup, wasMentioned, 
// eslint-disable-next-line @typescript-eslint/no-unused-vars
_anchor, 
// A+B 的筛选参数：selfIds 要剔的自己人；now 便于测试注入
opts = {}) {
    // 注意：anchor 不再拼进 user message。
    // 拼进去会污染上下文，且模型可能复述出"你是小羽…"这类系统指令（思考泄漏）。
    // 改为在 system prompt 层以最后 order 注入（见 service.buildSections）。
    if (!isGroup || !wasMentioned || !history || history.length === 0) {
        return base;
    }
    // A+B：只留窗口内、且不是她自己说的话
    const picked = selectHistoryForPrompt(history, opts.selfIds ?? new Set(), opts.now, opts.windowMs);
    // 筛完为空 → 不带历史段（避免给她一个空的 [Chat history begins] 反而误导）
    if (picked.length === 0)
        return base;
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