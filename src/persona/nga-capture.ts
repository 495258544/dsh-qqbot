/**
 * NGA 登录 —— 纯 HTTP 扫码，不依赖任何浏览器
 * ─────────────────────────────────────────────────────────────
 * ## 为什么是扫码，而不是"打开登录页让用户点"
 *
 * 初版走的是「在 ego 浏览器里打开 NGA 登录页 → 用户操作 → 读 cookie」。
 * 那个方案在这台设备上**结构性不可用**（2026-11-09 用户报"只有手机触屏"后查明）：
 *
 *   `dsh-ego-browser` 以 `--headless=new` 运行。手机端 DSH 客户端
 *   **不显示它的窗口** —— 无障碍树里只有对话界面，没有任何浏览器窗口。
 *   我做的"打开页面/点按钮"全发生在服务端那个看不见的页面里，
 *   用户看到的只是我发到聊天里的静态截图。他没法扫、没法点。
 *
 * 改成纯 HTTP：**二维码直接发到聊天/面板里，用户用手机 NGA App 扫一下就行**。
 *
 * ## 实测确认的三步流程（2026-11-09，逐段从 NGA 自己的 JS 读出来后实跑）
 *
 * ```
 * 1. POST nuke.php?__lib=login&__act=qrlogin_gen&__output=1&app_id=5004
 *    → {"data":{"0":"<qrkey>,<hiddenkey>"}}
 *
 * 2. 二维码内容 = https://bbs.nga.cn/nuke.php?__lib=login&__act=qrlogin_ui&qrkey=<qrkey>
 *    （来自 account_copy.html 的 JS：qrcodeGeneratorV1().generatePNG(...)）
 *
 * 3. 轮询 POST nuke.php?__lib=login&__act=login&__output=1
 *          v2=1 & qrkey=<qrkey> & hiddenkey=<hiddenkey>
 *    · 还没扫 → {"error":{"0":"未找到登录许可"}}
 *    · 扫了   → {"data":{"0":"登录成功","1":<uid>,"2":<token>,
 *                       "3":{"uid":..,"username":..,"token":..}}}
 * ```
 *
 * **不需要 ngaPassportCid 的"真 cid"**：服务端认的是 `uid` + `token`，
 * 当成 cookie 用（`ngaPassportUid=<uid>; ngaPassportCid=<token>`）就带登录态。
 * 实测 `nuke.php?__lib=ucp&__act=get` 返回了真实资料（uid/username/group/newpm）。
 *
 * ## 安全边界
 *
 * 只存 `uid` + `token`，不存密码、不存整串 cookie。
 * 密码登录那条路（`_encrypt(_trim(pass))` + `app_id`/`device`/`trackid`/
 * `__ngaClientChecksum`）我们**完全不做** —— 要复刻 NGA 客户端的前端加密，
 * 投入产出比极差，而扫码一次拿到的是一模一样的东西。
 */

import { mkdirSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultNgaDir, decodeByCharset, loadCredentials, type NgaCredentials } from '../persona/nga.ts';

const NGA_BASE = 'https://bbs.nga.cn';

/** NGA 官方 APP 的 UA：不带它会被当可疑游客（与 nga.ts 一致） */
const NGA_X_UA = 'NGA_skull/7.3.1(iPhone17,1;iOS17.0)';

const NGA_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

/** 凭证文件名 */
const CREDENTIALS_FILE = 'credentials.json';

/** 服务端判定"还没扫码"的文案（不同版本写法不同，都认） */
const PENDING_MARKERS = ['未找到登录许可', '未找到登录请求'];

export interface QrSession {
  qrkey: string;
  hiddenkey: string;
  /** 二维码内容（URL），面板/工具渲染成图片用 */
  content: string;
  /** 生成时刻（ms） */
  issuedAt: number;
}

export type QrPollStatus = 'pending' | 'success' | 'expired';

export interface QrPollResult {
  status: QrPollStatus;
  credentials?: NgaCredentials;
  /** 人物名（成功时给面板显示"你登录的是谁"） */
  username?: string;
  /** 人类可读说明 */
  message: string;
}

export interface NgaLoginDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

// ────────────────────────────────────────────────────────────────
// 第一步：申请 qrkey
// ────────────────────────────────────────────────────────────────

/**
 * 申请一对登录用 key。
 *
 * `__output=1` 与 `app_id=5004` 是从网页 JS 里逐字抄下来的：
 * 缺 app_id 时服务端直接不给 data（实测）。
 */
export async function genQrSession(deps: NgaLoginDeps = {}): Promise<QrSession> {
  const now = deps.now ?? (() => Date.now());
  const raw = await ngaFetch(
    `${NGA_BASE}/nuke.php?__lib=login&__act=qrlogin_gen&__output=1&app_id=5004`,
    deps,
  );
  const payload = parseScriptVarStore(raw);
  const data = payload.data as Record<string, unknown> | undefined;
  const first = String(data?.['0'] ?? '');
  if (!first.includes(',')) {
    throw new Error(`NGA 没有返回 qrkey（回包：${raw.slice(0, 120)}）`);
  }
  const [qrkey, hiddenkey] = first.split(',');
  if (!qrkey || !hiddenkey) throw new Error('NGA 返回的 qrkey 不完整');

  return {
    qrkey,
    hiddenkey,
    // 与 NGA 自己的 JS 一字不差
    content: `${NGA_BASE}/nuke.php?__lib=login&__act=qrlogin_ui&qrkey=${qrkey}`,
    issuedAt: now(),
  };
}

// ────────────────────────────────────────────────────────────────
// 第二步：渲染二维码
// ────────────────────────────────────────────────────────────────

/**
 * 渲染二维码 PNG（data URL）。
 *
 * 复用已有的 `qrcode` 依赖（QQ 绑定二维码本来就在用），**零新增依赖**。
 * 返回 data URL：面板直接塞 `<img src>`，也能转成 Buffer 发给 QQ。
 */
export async function renderQrPng(content: string, size = 480): Promise<string> {
  // 动态 import：qrcode 是 CJS，打包后需要 default 兜底
  const mod = await import('qrcode');
  const qr = (mod as unknown as { default?: typeof import('qrcode') }).default
    ?? (mod as unknown as typeof import('qrcode'));
  return qr.toDataURL(content, { width: size, margin: 2, errorCorrectionLevel: 'M' });
}

/** 渲染成 PNG Buffer（落盘或走 QQ 文件通道） */
export async function renderQrBuffer(content: string, size = 480): Promise<Buffer> {
  const dataUrl = await renderQrPng(content, size);
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
}

// ────────────────────────────────────────────────────────────────
// 第三步：轮询扫码结果
// ────────────────────────────────────────────────────────────────

/**
 * 问一次"扫了没"。
 *
 * 刻意用**三态**而不是布尔：调用方要能区分"再等等"和"这个码废了"。
 * 把过期当 pending 一直轮询，用户会对着一个死码干等 —— 比直接报错更糟。
 */
export async function pollQrSession(session: QrSession, deps: NgaLoginDeps = {}): Promise<QrPollResult> {
  const raw = await ngaFetch(
    `${NGA_BASE}/nuke.php?__lib=login&__act=login&__output=1`,
    deps,
    new URLSearchParams({
      v2: '1',
      qrkey: session.qrkey,
      hiddenkey: session.hiddenkey,
      app_id: '5004',
      device: 'web',
    }).toString(),
  );

  let payload: Record<string, unknown>;
  try {
    payload = parseScriptVarStore(raw);
  } catch {
    return { status: 'pending', message: `NGA 回了个看不懂的东西（${raw.slice(0, 80)}）` };
  }

  const err = payload.error as Record<string, unknown> | undefined;
  if (err) {
    const text = String(err['0'] ?? '');
    if (PENDING_MARKERS.some((m) => text.includes(m))) {
      return { status: 'pending', message: '还没扫（或扫了没点确认）' };
    }
    // 其余错误（key 过期/无效）→ 这个码不能再用
    return { status: 'expired', message: text || 'NGA 拒绝了这个二维码，请重新生成' };
  }

  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return { status: 'pending', message: 'NGA 没给结果' };

  // data[3] 是人物信息对象；实测成功时一定有它
  const who = data['3'] as Record<string, unknown> | undefined;
  const uid = String(who?.uid ?? data['1'] ?? '');
  const token = String(who?.token ?? data['2'] ?? '');
  const username = String(who?.username ?? '');

  if (!uid || !token) {
    return { status: 'pending', message: '登录成功但没拿到凭证，再试一次' };
  }
  return {
    status: 'success',
    credentials: { uid, cid: token },
    ...(username ? { username } : {}),
    message: `登录成功${username ? `：${username}` : ''}`,
  };
}

// ────────────────────────────────────────────────────────────────
// 底层
// ────────────────────────────────────────────────────────────────

/**
 * 打一次 NGA 接口，返回 **GBK 解码后的文本**。
 *
 * 不直接 `res.json()`：这些接口回的是
 * `window.script_muti_get_var_store={...}`（赋值给 JS 变量），不是纯 JSON。
 */
async function ngaFetch(url: string, deps: NgaLoginDeps, body?: string): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 15000;
  const headers: Record<string, string> = {
    'User-Agent': NGA_UA,
    'X-User-Agent': NGA_X_UA,
    Referer: `${NGA_BASE}/nuke.php?__lib=login&__act=login_ui`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status >= 500) throw new Error(`NGA 服务端 ${res.status}`);
  // nuke.php 系列是 GBK，但别硬编码 —— 按服务端给的 charset 解
  return decodeByCharset(await res.arrayBuffer(), res.headers.get('content-type'));
}

/** 从 `window.script_muti_get_var_store={...}` 里抠出 JSON 对象 */
export function parseScriptVarStore(raw: string): Record<string, unknown> {
  const marker = 'script_muti_get_var_store=';
  const idx = raw.indexOf(marker);
  let jsonText = idx >= 0 ? raw.slice(idx + marker.length).trim() : raw.trim();
  jsonText = jsonText.replace(/<\/script>\s*$/i, '').replace(/;\s*$/, '').trim();
  try {
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    throw new Error(`NGA 回包解析失败（前 100 字：${jsonText.slice(0, 100)}）`);
  }
}

// ────────────────────────────────────────────────────────────────
// 凭证落盘
// ────────────────────────────────────────────────────────────────

export function credentialsPath(dir = defaultNgaDir()): string {
  return join(dir, CREDENTIALS_FILE);
}

/** 保存凭证（**只写 uid/token**，不写密码、不写整串 cookie） */
export function saveCredentials(creds: NgaCredentials, dir = defaultNgaDir()): string {
  const file = credentialsPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ uid: creds.uid, cid: creds.cid, savedAt: new Date().toISOString() }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return file;
}

/** 删除凭证（回到游客态）；不存在不算错 */
export function clearCredentials(dir = defaultNgaDir()): boolean {
  const file = credentialsPath(dir);
  if (!existsSync(file)) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 当前状态（面板用） */
export function ngaStatus(dir = defaultNgaDir()): {
  authenticated: boolean;
  uid?: string;
  path: string;
} {
  const creds = loadCredentials(dir);
  return {
    authenticated: creds !== undefined,
    ...(creds ? { uid: creds.uid } : {}),
    path: credentialsPath(dir),
  };
}
