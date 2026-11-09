/**
 * 凭据绑定编排 — setup/ 模块入口
 *
 * apply() 检测到凭据缺失时调用 ensureCredentials：
 * 1. 创建 BindingService（单例接管，HMR 双 fiber 安全）
 * 2. Web 宿主（dsh web / Desktop）注册端内绑定页路由
 *    —— 经 ctx.inject(['webServer'], ...) 可选注入：服务未就绪时插件
 *       照常加载（CLI profile），就绪/替换时自动（重）注册路由
 * 3. 按宿主形态挂呈现策略（终端 / 浏览器降级）
 * 4. 生命周期与 ctx fiber 绑定（dispose 时 abort 轮询、注销路由）
 *
 * 凭据已配置的 fiber 调用 registerBoundCredentialRoutes 注册常驻路由
 * （bound 状态回显 + 手动编辑），与扫码流程共用持久化路径。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import { BindingService } from './binding-service.ts';
import { registerBindRoutes, type WebServerLike } from './bind-routes.ts';
import { createBrowserPresenter, createTerminalPresenter, isDesktopHost } from './presenters.ts';
import { persistCredentialsToProfile, type SetupCredentials } from './persist.ts';
import { getProfileDir } from '../shared/index.ts';
import { clearCredentials, genQrSession, ngaStatus, renderQrPng } from '../persona/nga-capture.ts';
import { currentQrSession, forgetQrSession, pollQrSession, rememberQrSession, saveCredentials, QR_TTL_SEC } from '../persona/tools.ts';

export type { SetupCredentials } from './persist.ts';
export { persistCredentialsToProfile } from './persist.ts';
export { isDesktopHost } from './presenters.ts';

/** 进程内活动绑定服务（HMR 接管用） */
let activeService: BindingService | null = null;

/** ensureCredentials 参数 */
export interface EnsureCredentialsOptions {
  logger: Logger;
  /** 二维码 URL 的 source 标识 */
  source?: string;
  /** 当前生效配置（apply 时 loader 合并值；config 路由 GET 回显用） */
  config: Record<string, unknown>;
}

/**
 * 执行扫码绑定编排，返回凭据就绪的 Promise；失败/取消 resolve null。
 *
 * 【同步契约】函数体必须保持无 await——绑定编排（服务接管、路由注册、
 * 呈现策略、ctx 生命周期挂载）在调用后的同步阶段全部完成，随后返回
 * `service.start()` 的挂起 Promise。调用方（插件 apply）因此可以不等待
 * 扫码结果直接完成加载：boot 的 `loader.await()` 会等所有插件 fiber
 * settle，若 apply 无限期等待用户扫码，Host ready 会被阻塞
 * （Desktop 界面无法进入、Web URL 延迟输出）。
 *
 * 凭据持久化由调用方在 Promise 的 then 链中执行——成功写入
 * cordis.patch.yml 会触发 HMR 热重载，新 fiber 以凭据启动网关。
 */
export async function ensureCredentials(
  ctx: Context,
  options: EnsureCredentialsOptions,
): Promise<SetupCredentials | null> {
  const logger = options.logger;
  const source = options.source ?? 'dsh-qqbot';

  // 单例接管：HMR 双 fiber 窗口下，新实例终止旧实例的轮询
  const service = new BindingService({ source, logger });
  if (activeService !== null && activeService !== service) {
    activeService.dispose();
  }
  activeService = service;

  // 生命周期：fiber dispose 时 abort 轮询
  (ctx as unknown as { effect(fn: () => () => void, name?: string): void }).effect(() => () => {
    service.dispose();
    if (activeService === service) activeService = null;
  }, 'im-qqbot.binding');

  // 呈现策略：
  // - 终端通道（CLI / dsh web 运营者）；Desktop 无可见终端，跳过
  // - 浏览器降级通道（QQBOT_BIND_OPEN_BROWSER=1 显式启用）
  if (!isDesktopHost()) {
    service.attach(createTerminalPresenter());
  }
  if (process.env.QQBOT_BIND_OPEN_BROWSER === '1') {
    service.attach(createBrowserPresenter(logger));
  }

  // 端内绑定页路由：webServer 可选注入。
  // cordis 访问守卫要求服务经 inject 声明后方可访问；deps 未就绪时
  // 回调不运行但插件照常加载（CLI profile），服务就绪/替换时回调
  // 重跑（自动清理旧路由、注册新路由），与 webserver 的注入生命周期对齐。
  (ctx as unknown as {
    inject(deps: readonly string[], callback: (scoped: Context) => void): unknown;
  }).inject(['webServer'], (scoped) => {
    const webServer = (scoped as unknown as { webServer?: unknown }).webServer as WebServerLike | undefined;
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    const disposeRoutes = registerBindRoutes(webServer, service, logger, {
      // 未绑定流程中的手动提交：终止扫码轮询，走同一持久化路径
      onManualCredentials: (credentials) => {
        service.dispose();
        return persistCredentials(credentials, logger);
      },
      currentConfig: () => options.config,
    });
    // 回调作用域（服务卸载/替换、插件卸载）连带注销路由
    (scoped as unknown as { effect(fn: () => () => void, name?: string): void }).effect(() => {
      return disposeRoutes;
    }, 'im-qqbot.bind-routes');
  });

  return service.start();
}

/**
 * 凭据已配置的 fiber 注册常驻路由（状态回显 + 手动编辑/更换）。
 *
 * 在 apply 的 bootstrapGateway 之前调用；写入经同一 persist 路径，
 * 保存后触发 HMR 重载、新 fiber 以新凭据重启网关。
 *
 * ## 新能力（2026-11-06 设置面板扩展）
 *
 * - /models：bootstrap 前就可用 —— 直接用 ctx + config 现场建 ModelResolver
 *   （它自己走 ctx.llm 动态发现，不依赖网关里的任何东西）；
 * - /presets：同上，走 ctx.agentPresets（缺席时回调返回 503）；
 * - /status、/persona-runtime：依赖 bootstrap 里的 PersonaService，
 *   用 lateBind holder —— bootstrapGateway 完成后由调用方回填实现，
 *   回填前返回 503（面板显示"不可用"，不阻塞）。
 */
// 扫码会话表与 TTL 与 persona 工具**共用同一份**（见 persona/tools.ts 的说明）：
// 她在聊天里生成的二维码，主人在设置面板扫完之后，两边看到的是同一张。
export function registerBoundCredentialRoutes(ctx: Context, logger: Logger, appId: string, config: Record<string, unknown>): void {
  // bootstrap 完成后由 gateway 回填（persona 相关能力的延迟绑定）
  const late: {
    persona?: { read: () => Record<string, unknown>; write: (p: Record<string, unknown>) => { ok: boolean; error?: string } };
    status?: () => Record<string, unknown>;
  } = {};

  (ctx as unknown as {
    inject(deps: readonly string[], callback: (scoped: Context) => void): unknown;
  }).inject(['webServer'], (scoped) => {
    const webServer = (scoped as unknown as { webServer?: unknown }).webServer as WebServerLike | undefined;
    if (webServer === undefined || typeof webServer.register !== 'function') return;

    // 模型列表：每次请求现场建 resolver（轻量对象，listModels 内部容错，
    // llm 服务缺席时回退 settings.yaml 静态表）。放在回调里保证拿到的是
    // 当下生效的 ctx —— 服务替换/重载后回调重跑，不会攥着旧引用。
    const listModels = async (): Promise<Array<{ provider: string; id: string; name?: string }>> => {
      const { ModelResolver } = await import('../model/model-resolver.ts');
      const cfg = config as unknown as ConstructorParameters<typeof ModelResolver>[1];
      const resolver = new ModelResolver(ctx, cfg, logger);
      return resolver.listModels();
    };

    // preset 列表：agentPresets 服务（缺席 → 返回空数组，面板显示"无预置"）
    const listPresets = (): Array<{ id: string; name?: string }> => {
      try {
        const presets = (ctx as unknown as Record<string, unknown>).agentPresets as
          | { list?: () => Array<{ id: string; name?: string }> }
          | undefined;
        if (presets && typeof presets.list === 'function') return presets.list();
      } catch (err) {
        logger.debug(`im-qqbot: agentPresets 读取失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      return [];
    };

    const disposeRoutes = registerBindRoutes(webServer, null, logger, {
      boundAppId: () => appId,
      onManualCredentials: (credentials) => persistCredentials(credentials, logger),
      currentConfig: () => config,
      listModels,
      listPresets,
      readPersonaRuntime: () => {
        if (late.persona === undefined) throw new Error('网关尚未启动完成，稍后再试');
        return late.persona.read();
      },
      writePersonaRuntime: (patch) => {
        if (late.persona === undefined) return { ok: false, error: '网关尚未启动完成，稍后再试' };
        return late.persona.write(patch);
      },
      runtimeStatus: () => {
        if (late.status === undefined) throw new Error('网关尚未启动完成，稍后再试');
        return late.status();
      },
      // NGA 登录：纯 HTTP 扫码（不依赖浏览器，也不依赖网关是否起好）
      ngaStatus: () => ngaStatus(),
      ngaQr: async () => {
        // 每次生成都是**新 key**：复用旧 key 会让已经发出去的那个二维码立刻失效
        const session = await genQrSession();
        rememberQrSession(session);
        const qrDataUrl = await renderQrPng(session.content, 480);
        logger.info(`im-qqbot: NGA 登录二维码已生成（${session.qrkey.slice(0, 8)}…）`);
        return { ok: true, qrDataUrl, expiresInSec: QR_TTL_SEC };
      },
      ngaQrPoll: async () => {
        const session = currentQrSession();
        if (session === undefined) {
          return { status: 'expired' as const, message: '还没有可用的二维码，请先生成' };
        }
        // 本地也判一次过期：服务端可能一直回"未找到登录许可"，
        // 我们若无限轮询，用户会对着一个死码干等
        if (Date.now() - session.issuedAt > QR_TTL_SEC * 1000) {
          forgetQrSession();
          return { status: 'expired' as const, message: '二维码过期了，重新生成一个' };
        }
        const r = await pollQrSession(session);
        if (r.status === 'success' && r.credentials) {
          try {
            const file = saveCredentials(r.credentials);
            forgetQrSession();
            logger.info(`im-qqbot: NGA 登录成功（uid=${r.credentials.uid}）→ ${file}`);
            return {
              status: 'success' as const,
              uid: r.credentials.uid,
              ...(r.username ? { username: r.username } : {}),
              message: `已登录${r.username ? `：${r.username}` : ''}`,
            };
          } catch (err) {
            return {
              status: 'expired' as const,
              message: `拿到凭证但写盘失败：${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        if (r.status === 'expired') forgetQrSession();
        return {
          status: r.status,
          ...(r.username ? { username: r.username } : {}),
          message: r.message,
        };
      },
      ngaClear: () => {
        const removed = clearCredentials();
        if (removed) logger.info('im-qqbot: NGA 凭证已清除（回到游客态）');
        return removed;
      },
    });
    (scoped as unknown as { effect(fn: () => () => void, name?: string): void }).effect(() => {
      return disposeRoutes;
    }, 'im-qqbot.bind-routes');
  });

  return registerLateBinders(ctx, late);
}

/**
 * 「人格热区 / 状态」的延迟绑定登记表。
 *
 * registerBoundCredentialRoutes 跑在 bootstrapGateway **之前**（apply 流程），
 * 而 PersonaService 在 bootstrap 内才创建。gateway 启动完成后调用
 * `bindPersonaRuntimeProviders(ctx, providers)` 把实现回填进来。
 */
const LATE_BINDERS = new WeakMap<Context, {
  persona?: { read: () => Record<string, unknown>; write: (p: Record<string, unknown>) => { ok: boolean; error?: string } };
  status?: () => Record<string, unknown>;
}>();

function registerLateBinders(ctx: Context, late: {
  persona?: { read: () => Record<string, unknown>; write: (p: Record<string, unknown>) => { ok: boolean; error?: string } };
  status?: () => Record<string, unknown>;
}): void {
  LATE_BINDERS.set(ctx, late);
}

/** 供 gateway 回填：人格热区与状态的实现（bootstrap 完成后调用） */
export function bindPersonaRuntimeProviders(
  ctx: Context,
  providers: {
    persona: { read: () => Record<string, unknown>; write: (p: Record<string, unknown>) => { ok: boolean; error?: string } };
    status?: () => Record<string, unknown>;
  },
): void {
  const late = LATE_BINDERS.get(ctx);
  if (late === undefined) return;
  late.persona = providers.persona;
  if (providers.status !== undefined) late.status = providers.status;
}

/** 手动凭据持久化（失败时返回可展示的错误） */
function persistCredentials(credentials: SetupCredentials, logger: Logger): { persisted: boolean; error?: string } {
  const persisted = persistCredentialsToProfile(credentials, getProfileDir() ?? undefined, logger);
  return persisted
    ? { persisted: true }
    : { persisted: false, error: '无法定位 profile 目录或写入失败，请改用环境变量配置' };
}
