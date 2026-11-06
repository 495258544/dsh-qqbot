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
import { bindPersonaWeb } from '../persona/web-wiring.ts';
import { registerPersonaTools } from '../persona/tools.ts';
import { bindPersonaRuntimeProviders } from '../setup/index.ts';
import { checkBiliHealth, formatHealthIssues } from '../persona/bili-health.ts';
import { SteamService, registerSteamTools } from '../steam/index.ts';
import { createDotaService, registerDotaTools, type DotaService } from '../dota/index.ts';
import { createXhhClient, registerXhhTools } from '../xhh/index.ts';
import { createBridgeProbe, renderScreenNudge } from '../persona/screen-watch.ts';
import { createDotaDigest } from '../persona/dota-digest.ts';
import { configureGroupActivity, pickBestGroup } from '../features/group-activity.ts';
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
    // 宿主 web 搜索服务（dsh-free-search 注册的 provider 都挂在它后面）。
    // 给到 persona 之后，冲浪与 qq_browse 走 27 个引擎 + 空结果自动 fallback，
    // 不再被 Bing 的中文断词坑影响（实测「手冲咖啡的细节参数」→ 10 条全是「手」的字典页）。
    //
    // ⚠️ 2026-11-05 修的根因：这里原来是
    //   `(ctx as unknown as Record<string, unknown>).web`
    // 而 `export const inject` 里只有 'agents' —— cordis 的访问守卫要求服务
    // **声明在 inject 里**才允许读 ctx 属性，所以这个属性读每次都抛、被 catch
    // 吞成 undefined → persona 永远拿不到 web → 冲浪永远走 Bing RSS 兜底。
    // 诊断日志 debug-surf.jsonl 里一串 `{"stage":"no-web","hasWeb":false}` 就是它。
    //
    // 改走 cordis 的软注入：`ctx.inject(['web'], cb)` 在服务就绪/替换时跑 cb、
    // 卸载时清理，且**服务缺席不会把插件卡在 PENDING**（顶层 inject 是硬依赖，
    // 仓库自带的 cordis.yml 没有 web 行，硬依赖会让 bot 整个起不来）。
    persona = new PersonaService({ config: config.persona, dataDir, logger });
    manager.persona = persona;
    logger.info(`persona: 已启用（dataDir=${dataDir}）`);

    // 闭包内收窄（persona 是 let，闭包里不保留控制流窄化）
    const svc = persona;
    bindPersonaWeb(ctx, (web) => svc.attachWeb(web));
  }

  // ── Steam 集成（查群友状态/最近游戏）──
  // enabled=false 时完全不创建，不注册工具，也不碰网络。
  // 没有 apiKey 也照样创建：绑定表（SteamID64 直填）不依赖 Key，
  // 缺 Key 只影响"查状态"和"解析自定义 ID"。
  let steam: SteamService | undefined;
  if (config.steam.enabled) {
    try {
      steam = new SteamService({ config: config.steam, logger });
      manager.steam = steam;
    } catch (err) {
      // 绑定表目录不可写之类的问题不该让整个 bot 起不来
      logger.warn(`steam: 初始化失败，功能已跳过: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Dota2 战绩（OpenDota，免 key）──
  // 和 Steam 段完全解耦：不依赖 Steam API Key，只用 account_id（SteamID64 换算而来）。
  let dota: DotaService | undefined;
  if (config.dota.enabled) {
    try {
      dota = createDotaService(config.dota, logger);
    } catch (err) {
      logger.warn(`dota: 初始化失败，功能已跳过: ${err instanceof Error ? err.message : String(err)}`);
    }
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
  setupMiddlewares(bot, config, manager, logger, steam);

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
    // 设置面板扩展：回填「人格热区 / 状态快照」的延迟绑定实现。
    // registerBoundCredentialRoutes 跑在本函数之前，PersonaService 那时还不存在，
    // 所以用 bindPersonaRuntimeProviders 在这里回填（见 setup/index.ts 的说明）。
    //
    // ## 读写都要考虑「基线 + 追加」双层结构（2026-11-06 修）
    //
    // runtime.json 是**追加层**，profile patch（config.persona）是**基线**，
    // 唤醒闸门的实际生效值 = 基线 ∪ 追加（见 service.ts 的 setNameProvider）。
    // 面板若只显示追加层，用户看到的会是全空 —— 而她的 names=['小羽']、
    // keywords=['小羽'] 一直在 profile 里好好的（用户："之前配置过的怎么没显示"）。
    //
    // 读：回显**合并后的生效值**（基线 ∪ 追加，去重保序）；
    // 写：只把**基线里没有的条目**写进追加层。若把基线条目也复制进 runtime.json，
    //     之后改 profile 的基线时，追加层里会残留旧副本，两边漂移。
    // selfIds 的回显再并入 ownerOpenids ∪ botOpenid —— 定义就是"自己人"
    // （wake-gate 的 excludeIds 就是这三个来源的并集），不显示会让用户以为没配置过。
    try {
      const baselineNames = config.persona?.names ?? [];
      const baselineKeywords = config.persona?.keywords ?? [];
      const baselineOtherNames = config.persona?.otherNames ?? [];
      const baselineSelfIds = [
        ...(config.persona?.ownerOpenids ?? []),
        ...(config.persona?.botOpenid && config.persona.botOpenid !== '' ? [config.persona.botOpenid] : []),
      ];
      const merge = (baseline: string[], extra: string[]): string[] =>
        [...new Set([...baseline, ...extra])];
      bindPersonaRuntimeProviders(ctx, {
        persona: {
          read: () => ({
            names: merge(baselineNames, persona?.runtime.names() ?? []),
            keywords: merge(baselineKeywords, persona?.runtime.keywords() ?? []),
            otherNames: merge(baselineOtherNames, persona?.runtime.otherNames() ?? []),
            selfIds: merge(baselineSelfIds, persona?.runtime.selfIds() ?? []),
          }),
          write: (patch) => {
            if (persona === undefined) return { ok: false, error: 'persona 未启用' };
            try {
              // 差集写入：面板提交的是"合并后的期望值"，落盘时剥掉基线已有的条目
              // （基线归 profile 管，追加层只收真正新增的）。
              const diff = (submitted: string[] | undefined, baseline: string[]): string[] | undefined =>
                submitted === undefined ? undefined
                  : submitted.map((s) => s.trim()).filter((s) => s !== '' && !baseline.includes(s));
              persona.runtime.update({
                names: diff(patch.names as string[] | undefined, baselineNames),
                keywords: diff(patch.keywords as string[] | undefined, baselineKeywords),
                otherNames: diff(patch.otherNames as string[] | undefined, baselineOtherNames),
                selfIds: diff(patch.selfIds as string[] | undefined, baselineSelfIds),
              });
              return { ok: true };
            } catch (err) {
              return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
          },
        },
        status: () => ({
          qqConnected: true, // 能执行到这里说明 bot ready 已触发
          appId: config.appId,
          activeSessions: manager.size,
          webSearchAvailable: persona?.hasWeb() ?? false,
          fallbackRoutes: (config.persona?.fallbackRoutes ?? []).map((r) => `${r.provider}/${r.model}`),
          notifyOwnerOnFailover: config.persona?.notifyOwnerOnFailover ?? true,
        }),
      });
    } catch (err) {
      logger.warn(`设置面板扩展回填失败（面板上对应区会显示不可用）: ${err instanceof Error ? err.message : String(err)}`);
    }
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
  registerArchiveTool(ctx, config, logger);

  // ── persona 工具（qq_write_diary / qq_read_diary / qq_memory_append）──
  if (persona) {
    registerPersonaTools(ctx, persona, (agent) => manager.findByAgent(agent as Parameters<SessionManager['findByAgent']>[0]), logger);

    // M36：bili 输出字段自检。
    //
    // 我们对 bili 的输出字段有依赖（字幕的 from、pages 的 title…），
    // 升级改了字段我们会静默拿到 undefined，功能悄悄坏掉。
    // 这里启动时验一次，坏了大喊一声 —— **不阻塞启动**，
    // 因为聊天/日记/记忆都不依赖 bili，它挂了不该让她整个不能用。
    //
    // 异步跑：自检要起 4 个 Python 进程，别拖慢启动。
    setTimeout(() => {
      try {
        const issues = checkBiliHealth();
        if (issues.length) {
          logger.warn(`im-qqbot: bili 字段自检发现 ${issues.length} 处问题（升级可能改了输出）：${formatHealthIssues(issues)}`);
        } else {
          logger.info('im-qqbot: bili 字段自检通过');
        }
      } catch (err) {
        // 自检自己挂了也不能影响主流程
        logger.debug(`im-qqbot: bili 自检异常: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 15_000).unref?.();
  }

  // ── Steam 工具（qq_steam_bind / forget / lookup / friends / owner）──
  // 主人账号（qq_steam_owner）只有主人能改。QQ 的 openid 按 bot/appid + 会话类型(群/私聊)
  // 隔离，所以把「私聊白名单」和「persona 主人 openid」合并判断，任一处填了都算主人。
  if (steam) {
    const ownerOpenids = [...new Set([...config.access.c2cAllow, ...config.persona.ownerOpenids])];
    registerSteamTools(ctx, steam, manager, logger, ownerOpenids);
    // 异步探一次网络与 Key：失败只写日志，不影响启动
    void steam.selfCheck().catch(() => {});
  }

  // ── Dota2 工具（qq_dota_recent）──
  if (dota) {
    registerDotaTools(ctx, dota, logger);
  }

  // ── 小黑盒只读工具（qq_xhh_search / qq_xhh_read / qq_xhh_save_sticker）──
  // 匿名接口，不需要账号与 Cookie；所以这里没有"凭据没配就跳过"的分支，
  // 只要开关开着就一定注册（失败也只影响单次调用，不影响启动）。
  if (config.xhh?.enabled) {
    try {
      registerXhhTools(ctx, createXhhClient(config.xhh, logger), config, logger);
    } catch (err) {
      logger.warn(`xhh: 初始化失败，小黑盒功能已跳过: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── own-life 静默唤醒：只投递给**存活**的 owner c2c 会话（peek 不重建），
  //    且过主动预算闸门 + 冷退避结算（DESIGN §1.2/§4/§7）──
  if (persona) {
    const ownerOpenid = config.persona.ownerOpenids[0];
    const svc = persona; // 闭包内收窄（let 变量在闭包中不保留控制流窄化）
    if (ownerOpenid) {
      svc.startOwnLife(async (text) => {
        // 用 ensureForProactive 而不是 peek：私聊空闲 30min 就被回收，
        // peek 只查内存 → 永远 undefined → 她一次自由时间也跑不起来。
        // 这里会话不在就拉起一个（只在真要投递时才付这个开销）。
        const existing = manager.peek('c2c', ownerOpenid);
        // M33：活跃时间必须在 ensureForProactive **之前**取。
        //
        // 踩过的坑（复核 8a94319 时发现，这条链当时是死的）：
        // ensureForProactive 新建会话时写 `lastActivity = Date.now()`
        // （session-manager.ts:705），而私聊 30min 就被回收、own-life 间隔 4h，
        // 于是每次投递时 lastActivity 都"刚刚"更新过 →
        // observePeer 里 `lastActivityAt > lastProactiveAt` 恒真 →
        // `wasAnswered` 恒 true → onIgnored **永不执行**；
        // 连带 unansweredStreak 永不增长，ProactiveBudget 的
        // 3天/14天冷却与永久静默**一起失效**。
        //
        // 正确语义是"投递那一刻**之前**对方最后活跃是什么时候"：
        // 会话还活着 → 用它的 lastActivity；已被回收 → 对方至少空闲了
        // sessionIdleTimeout，用 0 表示"这轮肯定没理"。
        const prevActivity = existing?.lastActivity ?? 0;
        const record = await manager.ensureForProactive('c2c', ownerOpenid, ownerOpenid);
        if (!record) return { ok: false, reason: 'no-live-session' }; // 审查 M5：跳过非失败，推进 lastFiredAt

        // 对方正在活跃时不打断：距上次收发 < 15min 视为活跃，静默让路。
        // 15min 是经验值（人在这个间隔内连续说话算同一轮对话），
        // 不是实验测出来的 —— 早期注释标了个"文章实测参数 C1"，
        // 但仓库里从来没有那篇文章的记录，无法追溯，已去掉这个假出处。
        //
        // 注意：只对**本来就在线的会话**做这个判断。
        // 新拉起的会话 lastActivity 是刚写的 Date.now()，拿它比会必然判成 peer-active
        // → 又把投递挡掉（等于白发一次会话）。所以这里用 existing 判断：
        // 会话原本不存在 = 对方显然不在线 = 不该算"活跃"。
        const activeGapMs = 15 * 60 * 1000;
        if (existing && Date.now() - (existing.lastActivity ?? 0) < activeGapMs) {
          return { ok: false, reason: 'peer-active' };
        }
        // 投递前结算上次主动消息是否被理了
        // 走 PersonaService 的包装而不是 budget.observe 直调 ——
        // 它会在结算的同时写一次情绪（"主动说了话没人接 → 失落"）
        svc.observePeer(ownerOpenid, prevActivity);
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

  // ── Dota 战绩隔夜播报：凌晨「自由活动」查 → 次日 10:00-12:00 不打扰时段发群 ──
  // 两阶段用落盘摘要衔接（断电重启不丢），天然实现「隔夜」与「一天只发一次」。
  // 目标群按「Dota 相关度」挑（聊过 dota > 有战绩当事人 > 最近活跃），可手工指定。
  if (persona && dota && config.persona.dotaDigestEnabled) {
    const svc = persona;
    const dotaSvc = dota;
    const digestDir = config.persona.dataDir
      ? resolve(config.persona.dataDir)
      : resolve(homedir(), '.dsh-qqbot', 'persona', `app-${config.appId}`);

    // 群活跃度埋点：transport/inbound.ts 每条群消息会 record 一次（只记聚合指标，不留原文）
    const activity = configureGroupActivity({
      dataDir: digestDir,
      log: (m) => logger.info(m),
      keywords: config.persona.dotaKeywords,
    });

    const boundList = (): Array<{ openid: string; alias?: string; steamId: string }> => {
      if (!steam) return [];
      return steam.bindings.list().map((b) => ({
        openid: b.openid,
        ...(b.binding.alias !== undefined ? { alias: b.binding.alias } : {}),
        steamId: b.binding.steamId,
      }));
    };

    const digest = createDotaDigest({
      config: {
        enabled: true,
        queryHours: config.persona.dotaDigestQueryHours,
        deliverHours: config.persona.dotaDigestDeliverHours,
        maxItems: config.persona.dotaDigestMaxItems,
        maxPerDay: config.persona.dotaDigestMaxPerDay,
        matchLimit: config.persona.dotaDigestMatchLimit,
        recentHours: config.persona.dotaDigestRecentHours,
        tz: 'Asia/Shanghai',
      },
      dataDir: digestDir,
      logger,
      bindings: boundList,
      queryForm: (accountId, limit) => dotaSvc.recentForm(accountId, limit),
      pickGroup: () => {
        // 1) 手工指定优先（明确要发哪个群）
        const fixed = config.persona.dotaDigestGroupId.trim();
        if (fixed !== '') return fixed;
        const bound = boundList().map((b) => b.openid);
        // 2) 自动：优先在**存活**的群会话里挑，死群发了没人接
        const candidates = manager.listLiveGroups().map((g) => g.groupId);
        if (candidates.length > 0) {
          const picked = pickBestGroup(activity, candidates, bound);
          if (picked !== null) return picked;
        }
        // 3) 兜底：内存里没有活会话（重启之后群里还一直没人说话）→ 退回持久化的活跃群记录。
        //
        //    没有这一条的话，整个投递窗口每分钟都在 2) 处返回 null，一次也发不出去，
        //    而且这条分支不写日志，从外面看就是"今天没播报"（2026-11-02 就是这么空的）。
        //    群不在内存里没关系，deliver 会把会话拉起来。
        const remembered = activity.entries()
          .filter((e) => e.groupId !== '' && e.lastAt > 0)
          .sort((a, b) => b.lastAt - a.lastAt)
          .map((e) => e.groupId);
        if (remembered.length === 0) return null;
        return pickBestGroup(activity, remembered, bound);
      },
      deliver: async (groupId, text) => {
        const live = manager.peek('group', groupId);
        // 群里久没人说话时内存里没有会话 —— 主动拉起一个。
        // 这和 own-life 11-01 踩的是同一个坑（peek 只看内存，会话早被回收），
        // 不拉的话 peek 永远为空，播报一次也发不出去。
        const record = live ?? await manager.ensureForProactive('group', groupId, config.persona.ownerOpenids[0] ?? '');
        if (record === undefined) return { ok: false, reason: 'no-live-session' };
        // 「对方刚在聊天时不插话」只对**本来就在**的会话判：
        // 刚拉起的会话 lastActivity 就是 now，拿它判会把每一次播报都判成 peer-active。
        if (live !== undefined && Date.now() - (live.lastActivity ?? 0) < 10 * 60 * 1000) {
          return { ok: false, reason: 'peer-active' };
        }
        const gate = svc.budget.allow(groupId);
        if (!gate.ok) return { ok: false, reason: `budget:${gate.reason}` };
        svc.budget.recordProactive(groupId);
        record.agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }));
        logger.info(`dota-digest: 战绩播报已投递群 ${groupId}`);
        return { ok: true };
      },
    });
    digest.start();

    const kwCount = config.persona.dotaKeywords.length;
    logger.info(
      `dota-digest: 已武装（查 ${config.persona.dotaDigestQueryHours[0]}:00-${config.persona.dotaDigestQueryHours[1]}:00`
      + ` → 次日 ${config.persona.dotaDigestDeliverHours[0]}:00-${config.persona.dotaDigestDeliverHours[1]}:00`
      + `，关键词 ${kwCount > 0 ? `${kwCount} 个（自定义）` : '内置默认（含「打刀」）'}）`,
    );
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
