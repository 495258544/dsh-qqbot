/**
 * 看手机屏幕主动搭话（M7 / R7）
 * ─────────────────────────────────────────────────────────────
 * 让她偶尔瞄一眼手机屏幕，看到与自己的兴趣相关的东西时主动找人聊一句。
 *
 * ## 成本分层（逐条来自真机实测，别重新测）
 *
 * | 层 | 手段 | 成本 |
 * |---|---|---|
 * | ① 最廉价筛查 | `GET /app/device`（`screen` / `app_foreground`） | 3ms / 210B |
 * | ② 前台 App | `adb-shell dumpsys window` + 本地解析 `mFocusedApp` | 0.25s |
 * | ③ 屏幕文字 | `GET /app/ui/dump`（语义控件树，含全部可见文字） | 30–99ms / 21–36KB |
 * | ④ 截图 | `GET /app/ui/screenshot` | 0.5–2.5s / 1–2MB |
 *
 * **本模块只用 ①②③，绝不调 ④**：控件树比截图省 91 倍体积且更快，
 * 而且截图在息屏时会**假报成功**（返回 `{"ok":true}` 但图纯黑、恒定 18,948 字节）——
 * 唯一可靠的防呆是第 ① 层的 `screen==off` 硬门禁。
 *
 * ## 硬性隐私规则（硬编码，**不可通过配置放宽**）
 *
 * 1. **R5 息屏硬门禁**：`screen==off` → 整轮跳过，连 dumpsys 都不跑。
 * 2. **R4 锁屏**：`KeyguardServiceDelegate showing=true`（或 `isKeyguardShowing=true`）→ 跳过。
 * 3. **通知栏盲区（实测事故）**：展开通知栏时 `/app/ui/dump` 的
 *    `target.packageName` 会是 `com.android.systemui`（看着人畜无害），
 *    但 `nodes` 里是**完整的银行短信 / 私信 / 社交流推送**。
 *    因此：读内容**之前**，先看 `mCurrentFocus` 是否含 `NotificationShade`
 *    或包名为 `com.android.systemui` → 直接跳过，不读 nodes/text、更不截图。
 *    dump 返回的 `target.packageName` 若是 systemui、或与 `mFocusedApp` 不一致
 *    （= 有窗口遮挡），同样丢弃已读到的内容。
 * 4. **R6 系统界面**：`com.android.systemui` / `com.miui.home`（桌面）→ 跳过。
 * 5. **R1 包名黑名单**：支付/金融、密码认证、聊天工具 → 命中即跳过。
 * 6. **R2 Activity 名关键词**：`Password|Passcode|Auth|Login|Verify|Pay|Payment|`
 *    `Wallet|Transfer|RedPacket|Confirm|Unlock|Setup`。
 * 7. **R3 控件树文字特征**：`付款|支付|确认支付|输入密码|验证码|指纹|面容|余额|`
 *    `转账|收款|红包|银行卡|实名|身份证`。
 * 8. **焦点分叉**：`mCurrentFocus` 与 `mFocusedApp` 分叉 = 有窗口盖在前面 → 跳过。
 *
 * 刻意收紧的地方：`Confirm|Setup|Unlock` 这类词在正常 App 里也很常见，
 * 宁可少搭话也不误读隐私页——**隐私优先于召回率**。
 *
 * ## 只读
 * 本模块**不点屏幕、不启动 App、不按按键、不截图**。唯一的设备动作是三条读接口。
 *
 * ## 流程
 * ```
 * 每 intervalMs（默认 30 分钟）：
 *   ① /app/device      screen==off / app_foreground==false → 跳过
 *   ② dumpsys window   mFocusedApp → 隐私黑名单 / 白名单
 *   ③ dump             通知栏·锁屏·敏感词 → 跳过
 *   ④ 兴趣匹配 + chattiness>0.5 + 预算闸 → deliver（由 bootstrap 注入）
 * ```
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';

// ─────────────────────────── 隐私规则（硬编码） ───────────────────────────

/** 支付/金融：命中即跳过（含支付宝、银联、微信支付、常见银行） */
const PAYMENT_PACKAGES = new Set([
  'com.eg.android.AlipayGphone',
  'com.unionpay',
  'com.tencent.mm', // 微信：支付 + 聊天，双重黑名单
]);

/**
 * 支付/银行的包名特征（大小写不敏感）。
 * 三道判据：① 包名里带 bank/pay/wallet 段；② 品牌词（支付宝/云闪付/微信支付/PayPal…）；
 * ③ 常见银行主体（工建中农招浦发民生…，含 `cmbchina.app` 这类不带 `com.` 前缀的写法）。
 * 宁可错拦（少搭一次话），也不要漏读一次账单。
 */
const PAYMENT_PACKAGE_PATTERNS: RegExp[] = [
  /^\S+\.(?:bank|banking|pay|payment|wallet)\b/i,
  /\b(?:bank|pay|wallet)\b/i,
  /\b(?:alipay|wechatpay|tenpay|unionpay|paypal|wallet)\b/i,
  /^(?:com|cn|net)?\.?(?:icbc|ccb|boc|abchina|cmbchina|spdb|cebbank|psbc|bankcomm|cib|cmbc|pingan|cmb)\b/i,
];

/** 密码/认证类包名与 Activity（`*authenticator*` / `*Password*` / `*Login*` / `*Verify*`） */
const AUTH_PATTERN = /(?:authenticator|password|passcode|login|verify)/i;

/** 聊天工具：私聊内容一律不读 */
const CHAT_PACKAGES = new Set([
  'com.tencent.mobileqq',
  'com.tencent.mm',
  'com.sina.weibo',
  'com.tencent.tim',
]);

/** 系统界面 / 桌面：不是"用户在看的内容" */
const SYSTEM_PACKAGES = new Set([
  'com.android.systemui',
  'com.miui.home',
  'com.android.launcher',
  'com.android.launcher3',
]);

/** R2 Activity 名关键词（只作用于 Activity 类名，不作用于包名） */
const ACTIVITY_KEYWORDS =
  /(?:Password|Passcode|Auth|Login|Verify|Pay|Payment|Wallet|Transfer|RedPacket|Confirm|Unlock|Setup)/i;

/** R3 控件树文字特征（命中即整轮丢弃，内容不进上下文） */
const SENSITIVE_TEXT =
  /(?:付款|支付|确认支付|输入密码|验证码|指纹|面容|余额|转账|收款|红包|银行卡|实名|身份证|password|verification code|passcode)/i;

/** 白名单里的包名支持通配（如 `com.example.*`），也支持精确包名 */
function appAllowed(pkg: string, allowedApps: readonly string[]): boolean {
  if (allowedApps.length === 0) return true; // 空白名单 = 不限制（黑名单仍然生效）
  return allowedApps.some((rule) => {
    const r = rule.trim();
    if (!r) return false;
    if (!r.includes('*')) return r === pkg;
    const re = new RegExp(`^${r.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    return re.test(pkg);
  });
}

/** 包名黑名单判定结果 */
export interface PrivacyVerdict {
  ok: boolean;
  /** 命中原因（ok=false 时给日志用；也是测试断言的稳定标识） */
  reason?:
    | 'system-ui'
    | 'payment'
    | 'chat'
    | 'auth'
    | 'activity-keyword'
    | 'not-whitelisted'
    | 'unknown-focus'
    | 'focus-diverged'
    | 'notification-shade'
    | 'keyguard'
    | 'screen-off'
    | 'app-not-foreground'
    | 'sensitive-text'
    | 'target-mismatch';
}

/**
 * 包名/Activity 黑名单判定（R1/R2/R6）。
 * @param pkg      mFocusedApp 的包名
 * @param cls      mFocusedApp 的 Activity 类名（可缺省）
 * @param allowed  白名单（空 = 不限制）
 */
export function checkForegroundApp(
  pkg: string,
  cls: string | undefined,
  allowed: readonly string[] = [],
): PrivacyVerdict {
  const bare = pkg.trim();
  if (!bare) return { ok: false, reason: 'unknown-focus' };
  if (SYSTEM_PACKAGES.has(bare)) return { ok: false, reason: 'system-ui' };
  if (PAYMENT_PACKAGES.has(bare)) return { ok: false, reason: 'payment' };
  if (PAYMENT_PACKAGE_PATTERNS.some((re) => re.test(bare))) return { ok: false, reason: 'payment' };
  if (CHAT_PACKAGES.has(bare)) return { ok: false, reason: 'chat' };
  if (AUTH_PATTERN.test(bare)) return { ok: false, reason: 'auth' };
  // Activity 级：先认出"支付/确认/解锁"这类页面，再兜底认证类命名
  if (cls && ACTIVITY_KEYWORDS.test(cls)) return { ok: false, reason: 'activity-keyword' };
  if (cls && AUTH_PATTERN.test(cls)) return { ok: false, reason: 'auth' };
  if (!appAllowed(bare, allowed)) return { ok: false, reason: 'not-whitelisted' };
  return { ok: true };
}

/** R3：控件树文字里的敏感特征 */
export function containsSensitiveText(text: string): boolean {
  return SENSITIVE_TEXT.test(text);
}

/** 通知栏 / 状态栏遮挡判定（读内容**之前**必须过这一关） */
export function isNotificationShade(focus: WindowFocus): boolean {
  const win = focus.currentFocusWindow ?? '';
  if (/NotificationShade|StatusBar/i.test(win)) return true;
  if (focus.currentFocusPackage === 'com.android.systemui') return true;
  if (focus.focusedAppPackage === 'com.android.systemui') return true;
  return false;
}

/** 焦点分叉：mCurrentFocus 与 mFocusedApp 的包名不同 = 有窗口盖在前面 */
export function focusDiverged(focus: WindowFocus): boolean {
  const a = focus.focusedAppPackage;
  const b = focus.currentFocusPackage;
  if (!a || !b) return false; // 缺一边就不拿它当证据
  return a !== b;
}

// ─────────────────────────── 设备探针（可注入 mock） ───────────────────────────

/** ① `/app/device` 的解析结果 */
export interface DeviceOverview {
  screen: 'on' | 'off';
  appForeground: boolean;
}

/** ② `dumpsys window` 的解析结果（Android 16 没有 mResumedActivity，只能用这两个） */
export interface WindowFocus {
  /** mFocusedApp 的包名（反映真实 App） */
  focusedAppPackage?: string;
  /** mFocusedApp 的 Activity 类名 */
  focusedAppClass?: string;
  /** mCurrentFocus 的窗口名（能识别通知栏/锁屏遮挡） */
  currentFocusWindow?: string;
  /** mCurrentFocus 的包名 */
  currentFocusPackage?: string;
  /** mCurrentFocus 的 Activity 类名 */
  currentFocusClass?: string;
  /** KeyguardServiceDelegate showing=true（锁屏中） */
  keyguardShowing: boolean;
}

/** ③ `/app/ui/dump` 的内容 */
export interface DumpContent {
  /** dump 自己报告的窗口包名（用于和 mFocusedApp 交叉校验） */
  packageName?: string;
  /** 控件树里所有可见文字（已去重、已去掉"窗口应用"抬头） */
  text: string;
  /** 节点数（控件树有 200 节点上限，到顶说明被截断） */
  nodeCount: number;
  /** 是否触到 200 节点上限（截断 → 内容不完整） */
  truncated: boolean;
}

/** 设备观察能力（默认实现走 DSHA 3090 桥 + adb-shell；测试注入 mock） */
export interface ScreenProbe {
  /** ① 3ms 概览；失败返回 null */
  deviceOverview(): Promise<DeviceOverview | null>;
  /** ② 0.25s 前台窗口；失败返回 null */
  windowFocus(): Promise<WindowFocus | null>;
  /** 无障碍服务是否开着（dsha 每次重启都会关掉） */
  accessibilityEnabled(): Promise<boolean | null>;
  /** ③ 30–99ms 屏幕文字；失败返回 null */
  screenText(): Promise<DumpContent | null>;
}

// ─────────────────────────── 纯解析函数（可单测） ───────────────────────────

/** 从桥返回体里取 `result` 字段（桥会把真正的回包再 JSON 编码一层） */
export function unwrapBridgeResult(body: string | null | undefined): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { result?: unknown };
    if (typeof parsed.result === 'string') return parsed.result;
    if (parsed.result !== undefined && typeof parsed.result === 'object') {
      return JSON.stringify(parsed.result);
    }
  } catch {
    /* 不是 JSON，就当纯文本 */
  }
  return body;
}

/** 解析 `/app/device` 的 `key=value` 文本 */
export function parseDeviceOverview(text: string): DeviceOverview | null {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) map.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const screen = map.get('screen');
  if (screen === 'off') return { screen: 'off', appForeground: false };
  if (screen !== 'on') return null;
  return { screen: 'on', appForeground: map.get('app_foreground') === 'true' };
}

/** 从 `Window{...}` / `ActivityRecord{...}` 的内层取 `pkg/cls` */
function extractComponent(inner: string): { pkg?: string; cls?: string; token?: string } {
  const tokens = inner.trim().split(/\s+/);
  // 形如 `Window{6b5b540 u0 com.qidian.QDReader/...}` / `ActivityRecord{97128880 u0 ... t21387}`
  const hit = tokens.find((t) => t.includes('/')) ?? tokens.find((t) => /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(t) && !/^u\d+$/.test(t));
  if (!hit) return {};
  const slash = hit.indexOf('/');
  if (slash < 0) return { token: hit, pkg: hit };
  // 简写类名（`.ui.MainActivity`）保留前导点，方便按后缀识别；全名直接去掉分隔符
  const cls = hit.slice(slash + 1);
  return { pkg: hit.slice(0, slash), cls: cls.startsWith('.') ? cls : cls };
}

/** 解析 `dumpsys window`（**只认 mFocusedApp / mCurrentFocus**，Android 16 没有 mResumedActivity） */
export function parseWindowFocus(dumpsys: string): WindowFocus {
  const out: WindowFocus = { keyguardShowing: false };
  for (const line of dumpsys.split('\n')) {
    const focused = line.match(/mFocusedApp=ActivityRecord\{([^}]*)\}/);
    if (focused?.[1]) {
      const c = extractComponent(focused[1]);
      if (c.pkg) out.focusedAppPackage = c.pkg;
      if (c.cls) out.focusedAppClass = c.cls;
      continue;
    }
    const current = line.match(/mCurrentFocus=Window\{([^}]*)\}/);
    if (current?.[1]) {
      const c = extractComponent(current[1]);
      if (c.token && !c.cls) out.currentFocusWindow = c.token;
      if (c.pkg) out.currentFocusPackage = c.pkg;
      if (c.cls) out.currentFocusClass = c.cls;
      continue;
    }
  }
  // 锁屏：KeyguardServiceDelegate 的 showing=true，或 isKeyguardShowing=true
  const guardBlock = dumpsys.match(/KeyguardServiceDelegate\s*\n[\s\S]*?(?=\n\s{4}\S|\n\s{2}\S|$)/);
  if (guardBlock?.[0] && /showing=true/.test(guardBlock[0])) out.keyguardShowing = true;
  if (/isKeyguardShowing=true/.test(dumpsys)) out.keyguardShowing = true;
  return out;
}

/** 解析 `/app/ui/dump` 的回包（`ok` / `code` / `text` / `nodes` / `target`） */
export function parseDumpContent(resultText: string): DumpContent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(resultText);
  } catch {
    // 老版本桥可能直接回纯文本
    return { text: resultText.replace(/\s+/g, ' ').trim(), nodeCount: 0, truncated: false };
  }
  const p = payload as {
    ok?: boolean;
    code?: string;
    text?: string;
    nodes?: Array<{ text?: string; description?: string }>;
    target?: { packageName?: string };
    visited?: number;
  };
  if (p.ok === false) return null;
  if (p.code && p.code !== 'SCREEN_COMPLETED') return null;

  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined): void => {
    const s = (raw ?? '').replace(/\s+/g, ' ').trim();
    if (!s || seen.has(s)) return;
    if (/^窗口应用[:：]/.test(s)) return; // 抬头，不是内容
    seen.add(s);
    lines.push(s);
  };
  for (const n of p.nodes ?? []) {
    push(n.text);
    push(n.description);
  }
  // 桥自己给的 text 已经是一行行语义摘要，补进去（nodes 可能被 200 节点上限截断）
  for (const line of (p.text ?? '').split('\n')) {
    const stripped = line.replace(/^\[\d+\]\s*/, '');
    const quoted = stripped.match(/^"([^"]*)"/);
    push(quoted?.[1] ?? stripped);
  }

  const nodeCount = p.visited ?? p.nodes?.length ?? 0;
  return {
    packageName: p.target?.packageName,
    text: lines.join(' / ').slice(0, 500),
    nodeCount,
    truncated: nodeCount >= 200, // 控件树 200 节点上限
  };
}

// ─────────────────────────── 兴趣匹配 ───────────────────────────

/** 与 self.json interests 的匹配结果（按权重降序，最多 3 条） */
export interface InterestMatch {
  topic: string;
  weight: number;
}

/** 纯函数：屏幕文字里是否出现了她感兴趣的话题（大小写不敏感的子串匹配） */
export function matchInterests(
  text: string,
  interests: ReadonlyArray<{ topic: string; weight: number }>,
): InterestMatch[] {
  const hay = text.toLowerCase();
  const hits: InterestMatch[] = [];
  for (const it of interests) {
    const topic = (it.topic ?? '').trim();
    if (!topic || topic.length < 2) continue; // 单字话题噪声太大
    if (hay.includes(topic.toLowerCase())) hits.push({ topic, weight: it.weight });
  }
  return hits.sort((a, b) => b.weight - a.weight).slice(0, 3);
}

/** 观察时段：默认 [9,23)，支持跨零点区间 */
export function inActiveHours(now: Date, hours: readonly [number, number]): boolean {
  const h = now.getHours();
  const [from, to] = hours;
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

// ─────────────────────────── 搭话内容 ───────────────────────────

/** 一次"该搭话了"的决定 */
export interface ScreenNudge {
  packageName: string;
  /** 匹配到的兴趣 */
  topics: InterestMatch[];
  /** 屏幕文字摘要（≤160 字） */
  snippet: string;
}

/** 渲染成给 agent 的内部提示（bootstrap 会包一层"不要复述本提示"） */
export function renderScreenNudge(nudge: ScreenNudge): string {
  const topics = nudge.topics.map((t) => t.topic).join('、');
  return [
    `你刚才瞄了一眼手机屏幕，看到一些你可能感兴趣的东西（${topics}）。`,
    `画面：${nudge.packageName}`,
    `内容：${nudge.snippet}`,
    '这只是给你一个由头。要不要开口、开口说什么，你自己决定；不想说就不说。',
    '绝对不要在回复里提"我看到你的屏幕""我瞄了一眼"之类的话，就当你是自己刷到的。',
  ].join('\n');
}

// ─────────────────────────── 状态与定时器 ───────────────────────────

/** deliver 三态（与 own-life 同语义） */
export type ScreenDeliverResult = boolean | void | { ok?: boolean; reason?: string };

export interface ScreenWatchState {
  /** 上次真正跑完一轮探测的时间（重启后间隔延续，不补跑） */
  lastProbeAt: number;
  /** 上次成功搭话的时间 */
  lastNudgeAt: number;
  /** 上次搭话的内容指纹（同内容不重复搭话） */
  lastSignature: string;
  lastDay: string;
  nudgedToday: number;
}

export interface ScreenWatchOptions {
  probe: ScreenProbe;
  /** 决定搭话后的投递（bootstrap 注入：向存活会话静默 followup） */
  deliver: (nudge: ScreenNudge) => Promise<ScreenDeliverResult>;
  /** 她的兴趣（来自 SelfProfileService，只读） */
  interests: () => ReadonlyArray<{ topic: string; weight: number }>;
  /** 话痨度（0.1~1.0） */
  chattiness: () => number;
  /** 主动消息预算闸 */
  allowProactive: () => { ok: boolean; reason?: string };
  /** 记一次主动推送 */
  markProactive: () => void;
  /** App 白名单（空 = 不限制，黑名单始终生效） */
  allowedApps?: readonly string[];
  /** 观察间隔(ms)，默认 30 分钟 */
  intervalMs?: number;
  /** 观察时段 [from,to)，默认 [9,23) */
  activeHours?: readonly [number, number];
  /** 搭话所需最低话痨度，默认 0.5 */
  minChattiness?: number;
  /** 搭话要求的最低兴趣权重，默认 0.3 */
  minInterestWeight?: number;
  /** 每天最多搭话几次，默认 3（另有 ProactiveBudget 兜底） */
  maxNudgesPerDay?: number;
  statePath?: string;
  log?: (msg: string) => void;
  now?: () => number;
  enabled?: boolean;
}

export type ScreenSkipReason = PrivacyVerdict['reason'] | 'disabled' | 'quiet-hours' | 'not-yet' | 'probe-failed' | 'no-interest' | 'low-chattiness' | 'daily-cap' | 'same-content' | 'deliver-skip';

export interface ScreenTickResult {
  ok: boolean;
  skipped?: ScreenSkipReason | string;
  /** 探测到的前台包名（诊断用） */
  packageName?: string;
  /** 本轮匹配到的兴趣 */
  topics?: string[];
  at?: number;
  error?: string;
}

export interface ScreenWatchHandle {
  start(): void;
  stop(): void;
  tick(nowTs?: number): Promise<ScreenTickResult>;
  snapshot(): ScreenWatchState & { enabled: boolean; intervalMs: number };
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_ACTIVE_HOURS: readonly [number, number] = [9, 23];
const TICK_MS = 60 * 1000;
/** 同内容去重窗口：10 分钟内同样的画面不重复搭话 */
const SAME_CONTENT_WINDOW_MS = 10 * 60 * 1000;

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 屏幕观察定时器。
 * 只读设备，不点不截图；每一轮都可能因为隐私规则整轮跳过。
 */
export function createScreenWatch(opts: ScreenWatchOptions): ScreenWatchHandle {
  const {
    probe,
    deliver,
    interests,
    chattiness,
    allowProactive,
    markProactive,
    allowedApps = [],
    intervalMs = DEFAULT_INTERVAL_MS,
    activeHours = DEFAULT_ACTIVE_HOURS,
    minChattiness = 0.5,
    minInterestWeight = 0.3,
    maxNudgesPerDay = 3,
    statePath,
    log = (m: string) => console.log('[screen-watch]', m),
    now = () => Date.now(),
    enabled = true,
  } = opts;

  const state: ScreenWatchState = { lastProbeAt: 0, lastNudgeAt: 0, lastSignature: '', lastDay: '', nudgedToday: 0 };
  if (statePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '')) as Partial<ScreenWatchState>;
      if (raw && typeof raw === 'object') Object.assign(state, raw);
    } catch {
      /* 首次运行没有 state 文件是正常的 */
    }
  }

  function save(): void {
    if (!statePath) return;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      log(`state 写不进去（忽略）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let busy = false;

  async function tick(nowTs = now()): Promise<ScreenTickResult> {
    if (!enabled) return { ok: false, skipped: 'disabled' };
    if (busy) return { ok: false, skipped: 'busy' };
    if (!inActiveHours(new Date(nowTs), activeHours)) return { ok: false, skipped: 'quiet-hours' };
    if (nowTs - state.lastProbeAt < intervalMs) return { ok: false, skipped: 'not-yet' };

    busy = true;
    // 一进来就推进 lastProbeAt：探测失败（桥不通/无障碍被关）也按整轮计，
    // 下轮间隔后再试。这样既不会每分钟锤一次失效接口刷日志，也符合"不补跑"。
    state.lastProbeAt = nowTs;
    const today = dayKey(nowTs);
    if (state.lastDay !== today) {
      state.lastDay = today;
      state.nudgedToday = 0;
    }
    try {
      // ── ① 3ms 概览：息屏 / 不在前台直接跳过（硬门禁，绝不跳到截图）──
      const device = await probe.deviceOverview();
      if (!device) return { ok: false, skipped: 'probe-failed' };
      if (device.screen === 'off') return { ok: false, skipped: 'screen-off' };
      if (!device.appForeground) return { ok: false, skipped: 'app-not-foreground' };

      // ── ② 0.25s 前台窗口 ──
      const focus = await probe.windowFocus();
      if (!focus) return { ok: false, skipped: 'probe-failed' };
      if (focus.keyguardShowing) return { ok: false, skipped: 'keyguard' };
      // 通知栏 / 状态栏遮挡：**在读取任何内容之前**就掐掉
      if (isNotificationShade(focus)) return { ok: false, skipped: 'notification-shade' };
      if (focusDiverged(focus)) return { ok: false, skipped: 'focus-diverged' };
      const pkg = focus.focusedAppPackage ?? '';
      const verdict = checkForegroundApp(pkg, focus.focusedAppClass, allowedApps);
      if (!verdict.ok) return { ok: false, skipped: verdict.reason ?? 'unknown-focus', packageName: pkg };

      // ── 无障碍服务可能被 dsha 重启关掉 ──
      const a11y = await probe.accessibilityEnabled();
      if (a11y === false) return { ok: false, skipped: 'probe-failed', packageName: pkg, error: 'accessibility-off' };
      if (a11y === null) return { ok: false, skipped: 'probe-failed', packageName: pkg, error: 'accessibility-unknown' };

      // ── ③ 30–99ms 控件树文字 ──
      const dump = await probe.screenText();
      if (!dump) return { ok: false, skipped: 'probe-failed', packageName: pkg };
      // dump 报告的窗口必须还是前台那个 App（换了窗口/systemui = 遮挡，内容不可信）
      if (dump.packageName && dump.packageName !== pkg) {
        const reason: PrivacyVerdict['reason'] =
          dump.packageName === 'com.android.systemui' ? 'notification-shade' : 'target-mismatch';
        return { ok: false, skipped: reason, packageName: pkg };
      }
      if (containsSensitiveText(dump.text)) {
        // 命中了就整轮丢弃：内容不进上下文，也不进日志
        return { ok: false, skipped: 'sensitive-text', packageName: pkg };
      }

      // ── ④ 兴趣 + 话痨度 + 预算 ──
      const text = `${pkg}\n${dump.text}`;
      const hits = matchInterests(text, interests()).filter((h) => h.weight >= minInterestWeight);
      if (hits.length === 0) return { ok: false, skipped: 'no-interest', packageName: pkg };
      if (chattiness() <= minChattiness) return { ok: false, skipped: 'low-chattiness', packageName: pkg };
      if (state.nudgedToday >= maxNudgesPerDay) return { ok: false, skipped: 'daily-cap', packageName: pkg };
      const gate = allowProactive();
      if (!gate.ok) return { ok: false, skipped: `budget:${gate.reason ?? 'denied'}`, packageName: pkg };

      const signature = `${pkg}|${dump.text.slice(0, 120)}`;
      if (signature === state.lastSignature && nowTs - state.lastNudgeAt < SAME_CONTENT_WINDOW_MS) {
        return { ok: false, skipped: 'same-content', packageName: pkg };
      }

      const nudge: ScreenNudge = { packageName: pkg, topics: hits, snippet: dump.text.slice(0, 160) };
      const res = await deliver(nudge);
      const skip = res === false || (res !== null && typeof res === 'object' && res.ok === false);
      if (skip) {
        const reason = res && typeof res === 'object' ? res.reason ?? '' : '';
        log(`跳过搭话（${pkg}）${reason ? ` ${reason}` : ''}`);
        return { ok: false, skipped: 'deliver-skip', packageName: pkg, topics: hits.map((h) => h.topic), at: nowTs, error: reason };
      }
      // 只有真投递成功了才记账：投递方跳过（没有存活会话）不该吃掉主动额度
      markProactive();
      state.lastNudgeAt = nowTs;
      state.lastSignature = signature;
      state.nudgedToday += 1;
      save();
      log(`搭话（${pkg}）兴趣=${hits.map((h) => h.topic).join('、')} · 今天第 ${state.nudgedToday} 次`);
      return { ok: true, packageName: pkg, topics: hits.map((h) => h.topic), at: nowTs };
    } catch (e) {
      return { ok: false, skipped: 'probe-failed', error: e instanceof Error ? e.message : String(e) };
    } finally {
      save();
      busy = false;
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void tick().catch(() => {});
    }, TICK_MS);
    timer.unref?.();
    log(
      `已武装 · 每 ${(intervalMs / 60000).toFixed(0)} 分钟 · 时段 ${activeHours[0]}:00–${activeHours[1]}:00 · `
      + `白名单 ${allowedApps.length || '无（只走黑名单）'} · 只读不截图`,
    );
    // 启动先自检无障碍（dsha 每次重启都会把服务关掉）
    void probe.accessibilityEnabled().then((on) => {
      if (on === false) log('无障碍服务没开：到「设置 → 无障碍 → 已安装服务」重新打开 DSHA，否则读不到屏幕文字');
    }).catch(() => {});
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
    log('已停止');
  }

  return {
    start,
    stop,
    tick,
    snapshot: () => ({ ...state, enabled, intervalMs }),
  };
}

// ─────────────────────────── 默认探针（真机） ───────────────────────────

export interface ScreenBridgeOptions {
  /** 3090 桥地址 */
  base?: string;
  /** 桥凭据头文件（`X-Token: ...`） */
  headersFile?: string;
  /** 设备 shell 包装命令 */
  adbShell?: string;
  /** 单次 dumpsys 超时 */
  dumpsysTimeoutMs?: number;
  /** 单次 HTTP 超时 */
  httpTimeoutMs?: number;
}

/** 读桥凭据头；读不到返回空对象（loopback 也可能直接放行） */
function loadBridgeHeaders(file: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** 极简 GET（不引 fetch，避免宿主 Node 版本差异；桥只回文本） */
function httpGet(url: string, headers: Record<string, string>, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/** 跑一条设备 shell 命令（adb-shell 会自动选 root / Shizuku / ADB） */
function runAdbShell(bin: string, command: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, [command], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });
}

/**
 * 真机探针：① /app/device · ② adb-shell dumpsys window · ③ /app/ui/dump。
 * 没有任何写操作，也不存在截图路径。
 */
export function createBridgeProbe(opts: ScreenBridgeOptions = {}): ScreenProbe {
  const base = opts.base ?? 'http://127.0.0.1:3090';
  const headersFile = opts.headersFile ?? '/root/.dsh/.bridge_headers';
  const adbShell = opts.adbShell ?? '/root/dsh-bin/adb-shell';
  const dumpsysTimeoutMs = opts.dumpsysTimeoutMs ?? 15 * 1000;
  const httpTimeoutMs = opts.httpTimeoutMs ?? 8 * 1000;

  return {
    async deviceOverview(): Promise<DeviceOverview | null> {
      const body = await httpGet(`${base}/app/device`, loadBridgeHeaders(headersFile), httpTimeoutMs);
      if (!body) return null;
      return parseDeviceOverview(unwrapBridgeResult(body));
    },
    async windowFocus(): Promise<WindowFocus | null> {
      const out = await runAdbShell(adbShell, 'dumpsys window', dumpsysTimeoutMs);
      if (!out) return null;
      return parseWindowFocus(out);
    },
    async accessibilityEnabled(): Promise<boolean | null> {
      const out = await runAdbShell(adbShell, 'settings get secure accessibility_enabled', dumpsysTimeoutMs);
      if (out === null) return null;
      const v = out.trim();
      if (v === '1') return true;
      if (v === '0') return false;
      return null;
    },
    async screenText(): Promise<DumpContent | null> {
      const body = await httpGet(`${base}/app/ui/dump`, loadBridgeHeaders(headersFile), httpTimeoutMs);
      if (!body) return null;
      return parseDumpContent(unwrapBridgeResult(body));
    },
  };
}
