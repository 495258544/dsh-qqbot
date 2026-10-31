/**
 * dsh-im-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';

export interface AccessControlConfig {
  /** C2C 访问模式 */
  c2cMode: 'open' | 'allowlist' | 'disabled';
  /** C2C 白名单（user openid） */
  c2cAllow: string[];
  /** 群聊访问模式 */
  groupMode: 'open' | 'allowlist' | 'disabled';
  /** 群聊白名单（group openid） */
  groupAllow: string[];
}

export interface MediaConfig {
  /** 是否启用富媒体理解（图片/视频下载 + 工具分析） */
  enabled: boolean;
  /** 富媒体下载大小上限（MB），默认 200 */
  maxMB: number;
  /** 富媒体存活时长（小时，TTL），默认 24，0 = 永不过期 */
  ttlHours: number;
  /** 图片自动归档目录（空 = 不归档；用于把群聊里合适的图攒成表情素材） */
  archiveDir: string;
}

export interface VisionConfig {
  /** 是否启用视觉理解（qqbot_describe_image 工具） */
  enabled: boolean;
  /** 视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai） */
  provider: string;
  /** 视觉模型 id（如 qwen-vl-max） */
  model: string;
  /** 默认描述 prompt（调用未显式指定时使用） */
  defaultPrompt: string;
  /** 图片字节上限，默认 10MB */
  maxBytes: number;
  /** 输出 token 上限 */
  maxTokens: number;
  /** 视觉调用超时(ms) */
  timeoutMs: number;
}

/** 附件发送配置（qqbot_send_file 工具与 present 交付物投递共用） */
export interface SendFileConfig {
  /** 是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots；关闭则任意路径） */
  restrictPaths: boolean;
  /** 额外允许访问的根目录（media 和 agent cwd 始终默认允许） */
  extraRoots: string[];
  /** 是否把 present 声明的交付文件在轮末发送到当前会话 */
  sendPresentedFiles: boolean;
  /** 单轮最多投递的交付文件数 */
  maxFiles: number;
}

/**
 * 活人感（persona）配置 — 移植自 ai-companion-kit（MIT）
 * 角色卡 / 按人记忆 / 唤醒判定 / 拟人化发送 / 日记 / 静默自我时间 / 主动预算
 */
export interface PersonaConfig {
  /** 总开关 */
  enabled: boolean;
  /** 数据目录（默认 ~/.dsh-qqbot/persona） */
  dataDir: string;
  /** 角色卡文件路径（.md）；空 = 不注入人格 section */
  roleCardPath: string;
  /** 角色卡注入上限（字） */
  roleMaxChars: number;
  /** 唤醒判定开关（关 = 维持原 requireMention 行为） */
  wakeEnabled: boolean;
  /** 她的名字/昵称（消息里被叫到才醒） */
  names: string[];
  /** 关键词（命中即醒） */
  keywords: string[];
  /** 主人 openid 列表（发言必醒；own-life 静默投递给第一个） */
  ownerOpenids: string[];
  /** 群闲聊随机插话概率（0 = 纯潜水） */
  groupProbability: number;
  /** 兴趣命中时的基础唤醒概率（实际 = chattiness × 兴趣权重 × 本值） */
  interestBaseProbability: number;
  /** 拟人化发送开关（分条 + 停顿） */
  humanizeEnabled: boolean;
  /** 每字打字毫秒（ai-companion 作者实测真人值 110） */
  msPerChar: number;
  /** 一次最多分几条（官方被动回复限额，建议 ≤2） */
  burstMax: number;
  /** 条间停顿范围(ms) */
  gapMinMs: number;
  gapMaxMs: number;
  /** own-life 静默唤醒开关 */
  ownLifeEnabled: boolean;
  /** 静默唤醒间隔(ms) */
  ownLifeIntervalMs: number;
  /** 静默唤醒每天最多几次 */
  ownLifeMaxPerDay: number;
  /** 自主冲浪开关（低峰时段上网搜集她感兴趣的内容） */
  surfEnabled: boolean;
  /** 冲浪时段起（小时，默认3） */
  surfFromHour: number;
  /** 冲浪时段止（小时，默认7） */
  surfToHour: number;
  /** 每轮冲浪最多几个话题 */
  surfMaxTopics: number;
  /** 是否抓正文（深度模式，更慢但内容更实） */
  surfDeep: boolean;
  /** 看手机屏幕主动搭话（M7/R7）：默认关 */
  screenWatchEnabled: boolean;
  /** 允许观察的 App 包名白名单（空 = 不限制；支付/聊天/系统界面的硬黑名单始终生效） */
  screenWatchAllowedApps: string[];
  /** 观察间隔(ms)，默认 30 分钟 */
  screenWatchIntervalMs: number;
  /** 观察时段 [起, 止)（小时，默认 [9,23)，避免半夜打扰） */
  screenWatchActiveHours: [number, number];
  /** 主动消息：每 peer 每天上限 */
  maxProactivePerDay: number;
  /** 主动消息：两次之间最小间隔(ms) */
  proactiveMinGapMs: number;
}

/**
 * Steam 集成配置（`src/steam/`）—— 查群友状态与最近游戏。
 *
 * 三条硬约束（改配置也绕不过去）：
 *   1. 必须有 Steam Web API Key（https://steamcommunity.com/dev/apikey，免费）；
 *   2. 只能读**公开**资料 —— 对方把「游戏详情」设为仅好友/私密时，
 *      只能看到昵称与在线状态，gameid / 最近游戏全为空；
 *   3. GetRecentlyPlayedGames 只能一人一次，所以必须靠缓存压住调用量。
 */
export interface SteamConfig {
  /** 总开关（关 = 不注册任何 Steam 工具） */
  enabled: boolean;
  /** Steam Web API Key（空 = 工具会提示去申请，但绑定表与 SteamID 解析仍可用） */
  apiKey: string;
  /** 绑定表目录（默认 ~/.dsh-qqbot/steam） */
  dataDir: string;
  /** 预置绑定：QQ openid → SteamID64（管理员维护；每次启动同步，配置是权威） */
  friends: Record<string, string>;
  /** 在线状态/当前游戏缓存秒数（默认 60；批量接口一次可覆盖 100 人，可高频） */
  summaryTtlSec: number;
  /** 最近游戏缓存秒数（默认 900；一人一次调用，别压太短） */
  recentTtlSec: number;
  /** 查不到的账号（注销/ID 填错）的负缓存秒数（默认 600） */
  negativeTtlSec: number;
  /** 单次 API 请求超时(ms) */
  timeoutMs: number;
  /** 每人默认返回几条最近游戏 */
  maxRecentGames: number;
  /** 主动感知：把「谁在玩什么」注入 system prompt，让她能顺着话题接话 */
  proactiveEnabled: boolean;
  /** 主动感知注入文本的字符上限（防止把 prompt 撑大） */
  proactiveMaxChars: number;
}

/**
 * 运维巡检配置（`src/ops/`）。
 * 与 persona 完全解耦：persona 关掉、甚至没配置角色卡，这个模块照样能跑。
 * 全部默认关——巡检会碰 git 与网络，不该在用户不知情时自动启用。
 */
export interface OpsConfig {
  /** 上游同步巡检开关 */
  upstreamWatchEnabled: boolean;
  /** 被巡检仓库绝对路径（空=自动探测 dsh-qqbot 自身） */
  upstreamWatchRepo: string;
  /** git remote 名 */
  upstreamWatchRemote: string;
  /** 上游分支 */
  upstreamWatchBranch: string;
  /** 上游 slug（API 主通道；空=只用 git） */
  upstreamWatchApiRepo: string;
  /** 北京时间几点跑（IANA 换算，不依赖容器时区） */
  upstreamWatchRunHour: number;
  /** 窗口分钟数 */
  upstreamWatchWindowMinutes: number;
  /** 检查窗口的间隔(ms) */
  upstreamWatchTickMs: number;
  /** state/report 目录（空=默认 ~/.dsh-qqbot/ops/upstream-watch） */
  upstreamWatchStateDir: string;
  /** 需要人工处理时推手机通知 */
  upstreamWatchNotify: boolean;
  /** GitHub token（可选，提高 API 限额） */
  upstreamWatchToken: string;
}

export interface ImQQBotConfig {
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot AppSecret */
  appSecret: string;
  /** dsh LLM 提供商名称 */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /** Agent preset id */
  preset?: string;
  /** Agent 工作目录（缺省 ~/.dsh-qqbot/workspace，不随宿主进程 cwd） */
  cwd?: string;
  /** 是否启用群消息 @mention 门控 */
  requireMention: boolean;
  /** 群聊额外 system prompt */
  groupPrompt?: string;
  /** 私聊额外 system prompt */
  directPrompt?: string;
  /** 单条消息最大长度（QQ 限制约 5000 字符） */
  textChunkLimit: number;
  /** 是否启用流式输出（群聊始终不启用） */
  streaming: boolean;
  /** 每会话最大闲置时长(ms)，超时自动回收 */
  sessionIdleTimeout: number;
  /** 并发队列最大长度 */
  maxQueue: number;
  /** 处理超时(ms)，超时中断当前 LLM 调用 */
  processingTimeoutMs: number;
  /** 待答问题超时(ms)，超时自动拒绝并提示（ask_user_question） */
  askTimeoutMs: number;
  /** 群历史缓冲条数 */
  historyLimit: number;
  /** 访问控制 */
  access: AccessControlConfig;
  /** 是否展示工具调用成功结果（工具错误始终展示） */
  showToolResults: boolean;
  /** 调试模式 */
  debug: boolean;
  /** 富媒体理解（图片/视频） */
  media: MediaConfig;
  /** 视觉理解（qqbot_describe_image 工具，走 dsh llm + attachments） */
  vision: VisionConfig;
  /** 附件发送（qqbot_send_file 工具与交付物投递共用） */
  sendFile: SendFileConfig;
  /** 活人感 persona（ai-companion-kit 移植：角色卡/记忆/唤醒/拟人化/日记/自我时间） */
  persona: PersonaConfig;
  /** Steam 集成（查群友状态/最近游戏，只读公开资料） */
  steam: SteamConfig;
  /** 运维巡检（独立模块，与 persona 无关）：上游同步检查 */
  ops: OpsConfig;
}

/** 观察时段归一：取前两项、夹到 0~23、缺项回落默认 [9,23)。
 *  形状统一成 [number, number]，下游 inActiveHours 才不用到处判空。 */
function activeHoursOf(v: number[] | undefined): [number, number] {
  const clamp = (n: unknown, fallback: number): number => {
    const x = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback;
    return Math.max(0, Math.min(23, x));
  };
  return [clamp(v?.[0], 9), clamp(v?.[1], 23)];
}

/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema: Schema<AccessControlConfig> = Schema.object({
  c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('allowlist').description('C2C访问模式（默认白名单，空名单拒绝所有人）'),
  c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单（QQ OpenID）'),
  groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式（默认开放：群自带进群门槛 + @bot 触发）'),
  groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单（群 OpenID）'),
});

export const ConfigSchema: Schema<ImQQBotConfig> = Schema.object({
  appId: Schema.string().default('').description('QQ 机器人 AppID'),
  appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
  provider: Schema.string().description('LLM provider name'),
  model: Schema.string().description('Model name'),
  preset: Schema.string().description('Agent preset id'),
  cwd: Schema.string().description('Agent working directory (default ~/.dsh-qqbot/workspace)'),
  requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
  groupPrompt: Schema.string().description('群聊额外system prompt'),
  directPrompt: Schema.string().description('私聊额外system prompt'),
  textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
  streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）'),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)'),
  maxQueue: Schema.number().default(20).description('并发队列最大长度'),
  processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用'),
  askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
  historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
  access: AccessControlSchema.default({
    c2cMode: 'open',
    c2cAllow: [],
    groupMode: 'open',
    groupAllow: [],
  }).description('访问控制'),
  showToolResults: Schema.boolean().default(false).description('是否展示工具调用成功结果（错误始终展示）'),
  debug: Schema.boolean().default(false),
  media: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
    maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
    ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
    archiveDir: Schema.string().default('').description('群聊/私聊图片自动归档目录（留空=不归档；填表情库下的 _群聊收集 可攒表情素材，如 ~/stickers/_群聊收集 或 /sdcard/表情包/_群聊收集）'),
  }).default({
    enabled: true,
    maxMB: 200,
    ttlHours: 24,
    archiveDir: '',
  }).description('富媒体理解配置'),
  vision: Schema.object({
    enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）'),
    provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）'),
    model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）'),
    defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt'),
    maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限'),
    maxTokens: Schema.number().default(1024).description('输出 token 上限'),
    timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)'),
  }).default({
    enabled: false,
    provider: '',
    model: '',
    defaultPrompt: 'Describe this image in detail.',
    maxBytes: 10 * 1024 * 1024,
    maxTokens: 1024,
    timeoutMs: 120000,
  }).description('视觉理解配置'),
  sendFile: Schema.object({
    restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
    extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
    sendPresentedFiles: Schema.boolean().default(true).description('是否将 present 声明的交付文件发送到当前会话'),
    maxFiles: Schema.number().default(4).description('单轮最多投递的交付文件数'),
  }).default({
    restrictPaths: true,
    extraRoots: [],
    sendPresentedFiles: true,
    maxFiles: 4,
  }).description('附件发送配置'),
  persona: Schema.object({
    enabled: Schema.boolean().default(false).description('活人感总开关（角色卡/记忆/唤醒/拟人化/日记/自我时间）'),
    dataDir: Schema.string().default('').description('persona 数据目录（默认 ~/.dsh-qqbot/persona）'),
    roleCardPath: Schema.string().default('').description('角色卡 .md 路径（空=不注入人格）'),
    roleMaxChars: Schema.number().default(12000).description('角色卡注入上限(字)'),
    wakeEnabled: Schema.boolean().default(true).description('唤醒判定开关（关=维持 requireMention 行为）'),
    names: Schema.array(Schema.string()).default([]).description('她的名字/昵称（被叫到才醒）'),
    keywords: Schema.array(Schema.string()).default([]).description('关键词（命中即醒）'),
    ownerOpenids: Schema.array(Schema.string()).default([]).description('主人 openid（发言必醒；own-life 投递目标）'),
    groupProbability: Schema.number().default(0).description('群闲聊随机插话概率（0=纯潜水）'),
    interestBaseProbability: Schema.number().default(0.5).description('兴趣命中时的基础唤醒概率（实际=chattiness×权重×本值）'),
    humanizeEnabled: Schema.boolean().default(true).description('拟人化发送（分条+停顿）'),
    msPerChar: Schema.number().default(110).description('每字打字毫秒（真人实测约110）'),
    burstMax: Schema.number().default(2).description('一次最多分几条（官方被动回复限额，建议≤2）'),
    gapMinMs: Schema.number().default(700).description('条间停顿下限(ms)'),
    gapMaxMs: Schema.number().default(2600).description('条间停顿上限(ms)'),
    ownLifeEnabled: Schema.boolean().default(false).description('own-life 静默唤醒（给她自己的时间）'),
    ownLifeIntervalMs: Schema.number().default(2.5 * 3600 * 1000).description('静默唤醒间隔(ms)，默认 2.5h'),
    ownLifeMaxPerDay: Schema.number().default(6).description('静默唤醒每天最多几次'),
    surfEnabled: Schema.boolean().default(false).description('自主冲浪：低峰时段上网搜集她感兴趣的内容'),
    surfFromHour: Schema.number().default(3).description('冲浪时段起（小时，默认3点）'),
    surfToHour: Schema.number().default(7).description('冲浪时段止（小时，默认7点）'),
    surfMaxTopics: Schema.number().default(2).description('每轮冲浪最多几个兴趣话题'),
    surfDeep: Schema.boolean().default(false).description('冲浪时抓正文（更慢但内容更实）'),
    screenWatchEnabled: Schema.boolean().default(false).description('看手机屏幕主动搭话（M7/R7：只读控件树，绝不截图/点击；默认关）'),
    screenWatchAllowedApps: Schema.array(Schema.string()).default([]).description('允许观察的 App 包名白名单（支持 com.example.* 通配；空=不限制。支付/聊天/系统界面的硬黑名单始终生效，不可放宽）'),
    screenWatchIntervalMs: Schema.number().default(30 * 60 * 1000).description('观察间隔(ms)，默认 30 分钟'),
    screenWatchActiveHours: Schema.transform(Schema.array(Schema.number()), (v) => activeHoursOf(v)).default([9, 23] as [number, number]).description('观察时段 [起,止)（小时），默认 [9,23)：半夜不看'),
    maxProactivePerDay: Schema.number().default(2).description('主动消息每 peer 每天上限'),
    proactiveMinGapMs: Schema.number().default(2 * 3600 * 1000).description('主动消息两次之间最小间隔(ms)'),
  }).default({
    enabled: false,
    dataDir: '',
    roleCardPath: '',
    roleMaxChars: 12000,
    wakeEnabled: true,
    names: [],
    keywords: [],
    ownerOpenids: [],
    groupProbability: 0,
    interestBaseProbability: 0.5,
    humanizeEnabled: true,
    msPerChar: 110,
    burstMax: 2,
    gapMinMs: 700,
    gapMaxMs: 2600,
    ownLifeEnabled: false,
    ownLifeIntervalMs: 2.5 * 3600 * 1000,
    ownLifeMaxPerDay: 6,
    surfEnabled: false,
    surfFromHour: 3,
    surfToHour: 7,
    surfMaxTopics: 2,
    surfDeep: false,
    screenWatchEnabled: false,
    screenWatchAllowedApps: [],
    screenWatchIntervalMs: 30 * 60 * 1000,
    screenWatchActiveHours: [9, 23],
    maxProactivePerDay: 2,
    proactiveMinGapMs: 2 * 3600 * 1000,
  }).description('活人感 persona 配置（移植自 ai-companion-kit，默认关）'),
  steam: Schema.object({
    enabled: Schema.boolean().default(true).description('Steam 集成总开关（关=不注册 Steam 工具）'),
    apiKey: Schema.string().default('').description('Steam Web API Key（https://steamcommunity.com/dev/apikey 免费申请；空=只能绑定不能查询）'),
    dataDir: Schema.string().default('').description('绑定表目录（默认 ~/.dsh-qqbot/steam）'),
    friends: Schema.dict(Schema.string()).default({}).description('预置绑定：QQ openid → SteamID64（每次启动同步，配置是权威；群友也可自助绑定）'),
    summaryTtlSec: Schema.natural().default(60).description('在线状态/当前游戏缓存秒数（默认 60）'),
    recentTtlSec: Schema.natural().default(900).description('最近游戏缓存秒数（默认 900；一人一次调用，别设太小）'),
    negativeTtlSec: Schema.natural().default(600).description('查不到的账号的负缓存秒数（默认 600，避免对错误 ID 反复打 API）'),
    timeoutMs: Schema.natural().default(8000).description('单次 API 请求超时(ms)'),
    maxRecentGames: Schema.natural().default(5).description('每人默认返回几条最近游戏'),
    proactiveEnabled: Schema.boolean().default(true).description('主动感知：把「谁在玩什么」注入 system prompt，让她能顺着游戏话题接话'),
    proactiveMaxChars: Schema.natural().default(600).description('主动感知注入文本的字符上限'),
  }).default({
    enabled: true,
    apiKey: '',
    dataDir: '',
    friends: {},
    summaryTtlSec: 60,
    recentTtlSec: 900,
    negativeTtlSec: 600,
    timeoutMs: 8000,
    maxRecentGames: 5,
    proactiveEnabled: true,
    proactiveMaxChars: 600,
  }).description('Steam 集成配置（查群友状态/最近游戏；只读公开资料，需自备 API Key）'),
  ops: Schema.object({
    upstreamWatchEnabled: Schema.boolean().default(false).description('上游同步巡检（只读：只报告，不自动合并）'),
    upstreamWatchRepo: Schema.string().default('').description('被巡检仓库绝对路径（空=自动探测 dsh-qqbot 自身）'),
    upstreamWatchRemote: Schema.string().default('upstream').description('git remote 名'),
    upstreamWatchBranch: Schema.string().default('main').description('上游分支'),
    upstreamWatchApiRepo: Schema.string().default('tencent-connect/dsh-qqbot').description('上游 slug（API 主通道，如 owner/repo；空=只用 git）'),
    upstreamWatchRunHour: Schema.number().default(5).description('北京时间几点跑（默认 5；按 IANA Asia/Shanghai 换算，不受容器时区影响）'),
    upstreamWatchWindowMinutes: Schema.number().default(45).description('窗口分钟数：只在 [runHour:00, runHour:window) 内触发'),
    upstreamWatchTickMs: Schema.number().default(300 * 1000).description('检查窗口的间隔(ms)，默认 5min'),
    upstreamWatchStateDir: Schema.string().default('').description('state/report 目录（默认 ~/.dsh-qqbot/ops/upstream-watch；绝不要放在被巡检仓库里）'),
    upstreamWatchNotify: Schema.boolean().default(true).description('需要人工处理时推手机通知（走 DSHA 3090 桥）'),
    upstreamWatchToken: Schema.string().default('').description('GitHub token（可选，提高 API 限额；未认证 60/h 容易撞限流）'),
  }).default({
    upstreamWatchEnabled: false,
    upstreamWatchRepo: '',
    upstreamWatchRemote: 'upstream',
    upstreamWatchBranch: 'main',
    upstreamWatchApiRepo: 'tencent-connect/dsh-qqbot',
    upstreamWatchRunHour: 5,
    upstreamWatchWindowMinutes: 45,
    upstreamWatchTickMs: 300 * 1000,
    upstreamWatchStateDir: '',
    upstreamWatchNotify: true,
    upstreamWatchToken: '',
  }).description('运维巡检配置（上游同步；默认关）'),
});
