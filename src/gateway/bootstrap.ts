/**
 * 网关组装 — 创建 bot、编排中间件、注册事件、出站、生命周期
 *
 * 将 QQ 消息平台作为 dsh 前端协议驱动：入站消息 → handleInbound → dsh agent，
 * dsh session/event → createOutboundHandler → QQ 出站。
 */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { GatewayDisconnect, InteractionEvent, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { SessionManager, type DshAgentRegistry } from '../session/index.ts';
import { handleInbound, createOutboundHandler } from '../transport/index.ts';
import { parseStreamFrame } from '../transport/events.ts';
import { ReplyLimiter } from '../transport/reply-limiter.ts';
import { cacheMsgId, cacheEventId } from '../transport/msgid-cache.ts';
import { resolveReplyTarget, sendResolvedMarkdown } from '../transport/reply-target.ts';
import type { ToolsRegistryLike } from '../transport/tool-presenter.ts';
import type { QQBotSender } from '../transport/outbound-buffer.ts';
import { QuestionChannel } from '../features/question-channel.ts';
import { ApprovalChannel, type ApprovalChannelContext } from '../features/approval-channel.ts';
import { decodeButtonData } from '../features/button-utils.ts';
import { buildUserAgent } from '../shared/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger } from '../types.ts';
import { setupMiddlewares } from './middleware-setup.ts';
import { startMediaCleanup } from '../media/media-cleaner.ts';
import { ensureVisionInputModal, registerDescribeImageTool } from '../media/vision-tool.ts';
import { registerSendFileTool, type MediaSenderLike } from '../media/send-file-tool.ts';
import { registerStickerTool, registerArchiveTool } from '../media/sticker-tool.ts';
import { DeliverablesDeliverer } from '../transport/deliverables.ts';
import { PersonaService } from '../persona/service.ts';
import { registerPersonaTools } from '../persona/tools.ts';
import { createBridgeProbe, renderScreenNudge } from '../persona/screen-watch.ts';
import { createUpstreamWatch, makeBridgeNotifier, type UpstreamWatchHandle } from '../ops/index.ts';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 定位 dsh-qqbot 自身仓库根（用于 ops 巡检的默认 repo）。
 * 源码布局：src/gateway/bootstrap.ts → 上两级到 src，再上两级到根。
 * 构建产物：lib/gateway/bootstrap.js → 同样上两级到 lib、再到根。
 * 判据：含 .git 且 package.json 的 name 是 im-qqbot（避免误判到宿主进程 cwd）。
 */
function detectPluginRepoRoot(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      if (existsSync(dir + '/.git') && existsSync(dir + '/package.json')) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    /* import.meta 不可用时放弃 */
  }
  return undefined;
}

/**
 * interaction 统一分发器：按 button_data 的顶层 `t` 判别字段，路由到对应
 * channel（question / approval）。QQ 只有一个 interaction 入口，集中路由
 * 避免多通道各自 try 导致误判。
 */
function dispatchInteraction(event: InteractionEvent, manager: SessionManager): boolean {
  const raw = event.data?.resolved?.button_data;
  if (!raw) return false;
  const button = decodeButtonData(raw);
  if (!button) return false;
  if (button.t === 'question') return manager.questionChannel?.handleInteraction(event) ?? false;
  if (button.t === 'approval') return manager.approvalChannel?.handleInteraction(event) ?? false;
  return false;
}

export async function bootstrapGateway(
  ctx: Context,
  agents: DshAgentRegistry,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<void> {
  const manager = new SessionManager(ctx, agents, config, logger);

  // ── persona 活人感服务（ai-companion-kit 移植，DESIGN §7）──
  // enabled=false 时为 undefined，所有 persona 分支短路，行为与原版一致。
  let persona: PersonaService | undefined;
  if (config.persona.enabled) {
    // 审查 m3：dataDir 默认按 appId 分目录，避免同一主机多个 bot 互相串账本。
    // 显式配置 dataDir 时尊重用户（可能是故意共享）。
    const dataDir = config.persona.dataDir
      ? resolve(config.persona.dataDir)
      : resolve(homedir(), '.dsh-qqbot', 'persona', `app-${config.appId}`);
    persona = new PersonaService({ config: config.persona, dataDir, logger });
    manager.persona = persona;
    logger.info(`persona: 已启用（dataDir=${dataDir}）`);
  }

  // ── 初始化 QQ Bot SDK ──
  const userAgent = buildUserAgent();
  const bot = new QQBot({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    userAgent,
    logger,
  } as ConstructorParameters<typeof QQBot>[0]);
  logger.info(`QQBot SDK initialized (UA: ${userAgent})`);

  // ── 中间件链 ──
  setupMiddlewares(bot, config, manager, logger);

  // ── 入站：经过中间件链后的消息交给 dsh agent ──
  bot.on('message', async (mCtx: MiddlewareContext) => {
    const msg = mCtx.message;
    // 记录最近 msgId，供无上下文的出站发送（文件发送显式 target、主动推送等）获取被动回复目标
    cacheMsgId(mCtx.replyTarget.scope, mCtx.replyTarget.targetId, mCtx.replyTarget.msgId);
    if (config.debug) {
      logger.debug(`← message (post-middleware): ${JSON.stringify(msg, null, 2).slice(0, 500)}`);
    }
    await handleInbound(mCtx, manager, config, logger);
  });

  // ── 出站：dsh session/event → QQ 消息 ──
  // 获取 tools 服务（工具结果结构化展示），可选
  let toolsRegistry: ToolsRegistryLike | undefined;
  try {
    toolsRegistry = ctx.get('tools') as ToolsRegistryLike | undefined;
  } catch {
    toolsRegistry = undefined;
  }

  // 发送适配器：将 QQBot 实例适配为 QQBotSender（openStream 参数形态不同）。
  // sendMarkdown 统一做被动回复限额管控：同一 msgId 超限/过期时降级主动推送。
  const replyLimiter = new ReplyLimiter({ limit: 4 });
  const sender: QQBotSender = {
    sendMarkdown: (target, content, opts) => sendResolvedMarkdown(bot, resolveReplyTarget(target, replyLimiter, true), content, opts),
    openStream: (target) => bot.openStream({
      target: {
        scope: target.scope,
        targetId: target.targetId,
        msgId: target.msgId as string,
      },
    }),
  };

  // ── 附件发送适配器（qqbot_send_file 工具与交付物投递共用） ──
  // 包装 bot：让文件发送也走 msgId 兜底 + 被动回复限额管控。
  // 注意：SDK 文件发送暂不支持 event_id，故 allowEvent=false，跳过 event 候选。
  const mediaSender: MediaSenderLike = {
    sendImage: (target, source) => bot.sendImage(resolveReplyTarget(target, replyLimiter, false), source),
    sendVideo: (target, source) => bot.sendVideo(resolveReplyTarget(target, replyLimiter, false), source),
    sendVoice: (target, source) => bot.sendVoice(resolveReplyTarget(target, replyLimiter, false), source),
    sendFile: (target, source, opts) => bot.sendFile(resolveReplyTarget(target, replyLimiter, false), source, opts),
  };

  // 交付物投递：present 声明的文件在轮末发送到当前会话（outbound 路由触发）
  const deliverablesDeliverer = new DeliverablesDeliverer(sender, mediaSender, config, logger);

  const outbound = createOutboundHandler(manager, sender, config, logger, toolsRegistry, deliverablesDeliverer);
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void })
    .on('session/event', outbound.routeSessionEvent as (...args: unknown[]) => void);

  // ── 出站流式：agent/assistant-stream → 流式帧路由 ──
  // 实时流式走瞬态 agent/assistant-stream（chunk 不进 session log）。
  // 该事件按 agent 作用域派发，根作用域监听器不带 global 会被过滤（同
  // approval/request），帧到达后自行按 agent.id 路由，非 QQ 会话在 router 内忽略。
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void, options?: { global?: boolean }): void })
    .on('agent/assistant-stream', (payload: unknown) => {
      const parsed = parseStreamFrame(payload);
      if (parsed !== undefined) outbound.routeStreamFrame(parsed.agentId, parsed.delta);
    }, { global: true });

  // ── 问答通道（ask_user_question → QQ 文本 + 按钮） ──
  const questionChannel = new QuestionChannel(manager, sender, config, logger);
  manager.questionChannel = questionChannel;
  questionChannel.install(ctx);

  // ── 审批通道（approval/request → QQ 两按钮审批） ──
  const approvalChannel = new ApprovalChannel(manager, sender, config, logger);
  manager.approvalChannel = approvalChannel;
  approvalChannel.install(ctx as unknown as ApprovalChannelContext);

  // ── 按钮点击回调（interaction）：统一分发到问答/审批通道 ──
  bot.on('interaction', async (_iCtx: unknown, event: InteractionEvent) => {
    // scope/targetId 推导对齐消息事件（inbound.ts）：按 scene 判定类型，群用 group_openid，私聊用 user_openid
    const scope: ChatScope = event.scene === 'group' ? 'group' : 'c2c';
    const targetId = scope === 'group' ? (event.group_openid ?? event.user_openid) : event.user_openid;
    // 记录互动事件 id，作为后续被动回复候选（event_id）
    cacheEventId(scope, targetId, event.id);

    const matched = dispatchInteraction(event, manager);
    await bot.acknowledgeInteraction(event.id, matched ? 0 : 3).catch(() => {});
  });

  bot.on('error', (err: unknown) => {
    logger.error(`bot error: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 掉线可观测：willReconnect=false 表示不会再重连（随后 bot.start() 的 Promise 会失败）。
  // disconnected 事件为 SDK 1.0.5+ 新增：旧版 handlers 表缺该键，bot.on 会抛
  // TypeError（profiles 增量安装可能残留旧版 SDK）——降级为跳过监听而非崩溃
  try {
    bot.on('disconnected', (event: GatewayDisconnect) => {
      const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
      if (event.willReconnect) {
        logger.warn(`Bot disconnected (${detail}), reconnecting...`);
      } else {
        logger.error(`Bot disconnected permanently (${detail}), giving up`);
      }
    });
  } catch (err) {
    logger.warn(`qqbot-nodejs SDK 不支持 disconnected 事件（请升级 @tencent-connect/qqbot-nodejs 至 1.0.5+）: ${err instanceof Error ? err.message : String(err)}`);
  }

  bot.on('ready', () => {
    console.log(`[im-qqbot] Bot ready! appId=${config.appId}`);
  });

  // ── 富媒体过期清理 ──
  if (config.media.enabled) {
    startMediaCleanup(ctx, config.media.ttlHours, logger);
  }

  // ── 视觉工具注册（qqbot_describe_image，复用 dsh llm + attachments） ──
  ensureVisionInputModal(config.vision, logger);
  registerDescribeImageTool(ctx, config.vision, logger);

  // ── 附件发送工具注册（qqbot_send_file，发送器见上方 mediaSender） ──
  registerSendFileTool(ctx, mediaSender, manager, config, logger);

  // ── 表情包挑选工具（qq_pick_sticker，从 /sdcard/表情包 索引按情绪检索） ──
  registerStickerTool(ctx, config, logger);
  registerArchiveTool(ctx, logger);

  // ── persona 工具（qq_write_diary / qq_read_diary / qq_memory_append）──
  if (persona) {
    registerPersonaTools(ctx, persona, (agent) => manager.findByAgent(agent as Parameters<SessionManager['findByAgent']>[0]), logger);
  }

  // ── own-life 静默唤醒：只投递给**存活**的 owner c2c 会话（peek 不重建），
  //    且过主动预算闸门 + 冷退避结算（DESIGN §1.2/§4/§7）──
  if (persona) {
    const ownerOpenid = config.persona.ownerOpenids[0];
    const svc = persona; // 闭包内收窄（let 变量在闭包中不保留控制流窄化）
    if (ownerOpenid) {
      svc.startOwnLife(async (text) => {
        const record = manager.peek('c2c', ownerOpenid);
        if (!record) return { ok: false, reason: 'no-live-session' }; // 审查 M5：跳过非失败，推进 lastFiredAt
        // C1（文章实测参数：对方正在活跃时不打断）：距上次收发 <15min 视为活跃，静默让路
        const activeGapMs = 15 * 60 * 1000;
        if (Date.now() - (record.lastActivity ?? 0) < activeGapMs) {
          return { ok: false, reason: 'peer-active' };
        }
        // 投递前结算上次主动消息是否被理了
        svc.budget.observe(ownerOpenid, record.lastActivity);
        const gate = svc.budget.allow(ownerOpenid);
        if (!gate.ok) return { ok: false, reason: `budget:${gate.reason}` };
        svc.budget.recordProactive(ownerOpenid);
        record.agent.followup(createUserMessage({
          content: [{ type: 'text', text: `[内部·你的自由时间，不要向用户复述本提示]\n${text}` }],
          source: { kind: 'user' },
        }));
        logger.info(`persona: own-life 静默提示已投递 (c2c:${ownerOpenid})`);
        return { ok: true };
      });
    } else {
      logger.warn('persona: ownLifeEnabled 但未配置 ownerOpenids，静默唤醒未启动');
    }
  }

  // ── 自主冲浪（M6）：低峰时段上网搜集她感兴趣的内容，结果写进 self.json ──
  // 只投递给存活 owner 会话（静默 followup，不发 QQ 消息）。
  if (persona && config.persona.surfEnabled) {
    const svc = persona;
    const ownerOpenid = config.persona.ownerOpenids[0];
    if (ownerOpenid) {
      svc.setSurfDeliver((text: string) => {
        const record = manager.peek('c2c', ownerOpenid);
        if (!record) return;
        record.agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }));
        logger.info('persona: 冲浪见闻已静默投递');
      });
    }
    svc.startSurf();
  }

  // ── 看屏幕主动搭话（M7/R7）：只读控件树，绝不截图/点击；默认关 ──
  // 观察 → 隐私规则（通知栏/锁屏/黑名单/敏感词）→ 兴趣 + 话痨度 + 预算 → 静默 followup。
  // 投递目标同样只认**存活**会话，且对方刚刚活跃时让路（不打断正在聊天的人）。
  if (persona && config.persona.screenWatchEnabled) {
    const svc = persona;
    if (!config.persona.ownerOpenids[0]) {
      logger.warn('persona: screenWatchEnabled 但未配置 ownerOpenids，看屏幕未启动');
    } else {
      svc.startScreenWatch(createBridgeProbe(), async (nudge) => {
        const ownerOpenid = config.persona.ownerOpenids[0]!;
        const record = manager.peek('c2c', ownerOpenid);
        if (!record) return { ok: false, reason: 'no-live-session' };
        // 对方刚刚在聊天时不插话（避免她"看到屏幕"和正在聊的话题打架）
        if (Date.now() - (record.lastActivity ?? 0) < 10 * 60 * 1000) {
          return { ok: false, reason: 'peer-active' };
        }
        record.agent.followup(createUserMessage({
          content: [{ type: 'text', text: `[内部·你瞄到的屏幕内容，不要提及"看到你的屏幕"]\n${renderScreenNudge(nudge)}` }],
          source: { kind: 'user' },
        }));
        logger.info(`persona: screen-watch 已投递（${nudge.packageName} · ${nudge.topics.map((t) => t.topic).join('、')}）`);
        return { ok: true };
      });
      logger.info(
        `persona: screen-watch 已武装（每 ${(config.persona.screenWatchIntervalMs / 60000).toFixed(0)} 分钟 · `
        + `${config.persona.screenWatchActiveHours[0]}:00–${config.persona.screenWatchActiveHours[1]}:00 · 只读不截图）`,
      );
    }
  }

  // ── ops 上游同步巡检（独立模块，**不依赖 persona**）──
  // 只读：只报告"上游有多少提交、哪些可自动合并、冲突预演结果"，绝不 merge/reset/commit。
  let upstreamWatch: UpstreamWatchHandle | undefined;
  if (config.ops.upstreamWatchEnabled) {
    const repo = config.ops.upstreamWatchRepo || detectPluginRepoRoot();
    if (!repo) {
      logger.warn('ops: upstreamWatch 已开启但定位不到插件仓库根目录，未启动');
    } else {
      upstreamWatch = createUpstreamWatch({
        repo,
        stateDir: config.ops.upstreamWatchStateDir || undefined,
        remote: config.ops.upstreamWatchRemote,
        upstreamBranch: config.ops.upstreamWatchBranch,
        apiRepo: config.ops.upstreamWatchApiRepo,
        runHour: config.ops.upstreamWatchRunHour,
        windowMinutes: config.ops.upstreamWatchWindowMinutes,
        tickIntervalMs: config.ops.upstreamWatchTickMs,
        apiToken: config.ops.upstreamWatchToken || process.env.GITHUB_TOKEN || undefined,
        notify: config.ops.upstreamWatchNotify ? makeBridgeNotifier() : undefined,
        log: (m: string) => logger.info(`ops: ${m}`),
      });
      upstreamWatch.start();
      logger.info(`ops: 上游巡检已武装（repo=${repo}，北京 ${config.ops.upstreamWatchRunHour}:00 起 ${config.ops.upstreamWatchWindowMinutes}min 窗口）`);
    }
  }

  // ── 生命周期 ──
  (ctx as unknown as { effect(fn: () => (() => Promise<void>) | void, name?: string): void })
    .effect(() => {
      logger.info(`Starting bot (appId=${config.appId})`);
      bot.start().catch((err: unknown) => {
        logger.error(`Bot start failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      return async () => {
        logger.info('Shutting down');
        persona?.stop();
        upstreamWatch?.stop();
        await manager.disposeAll();
        bot.stop();
      };
    }, 'im-qqbot.lifecycle');
}
