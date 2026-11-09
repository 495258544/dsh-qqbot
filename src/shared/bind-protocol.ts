/**
 * 端内绑定协议 —— 宿主路由与客户端面板的共享契约
 *
 * 类型与路径常量的唯一事实源：宿主（setup/bind-routes.ts）与浏览器
 * （client/bind-page.ts）各自 import，杜绝两端协议漂移。
 * 本模块必须保持纯类型 + 纯常量（零 node 依赖、零副作用）：
 * 客户端 tsdown 构建会将其内联进 bundle。
 */

/** 状态查询（绑定页轮询） */
export const BIND_STATE_PATH = '/qqbot/im-qqbot/bind';

/** 刷新二维码（绑定页按钮） */
export const BIND_REFRESH_PATH = '/qqbot/im-qqbot/bind/refresh';

/** 手动填写/编辑凭据（绑定页表单） */
export const BIND_MANUAL_PATH = '/qqbot/im-qqbot/bind/manual';

/** 解绑：移除已保存凭据，回到绑定流程 */
export const BIND_UNBIND_PATH = '/qqbot/im-qqbot/bind/unbind';

/** 配置读写（设置面板表单） */
export const BIND_CONFIG_PATH = '/qqbot/im-qqbot/config';

/** 模型列表（设置面板下拉菜单数据源；只读，动态发现） */
export const BIND_MODELS_PATH = '/qqbot/im-qqbot/models';

/** Agent preset 列表（设置面板 Preset 下拉数据源；只读） */
export const BIND_PRESETS_PATH = '/qqbot/im-qqbot/presets';

/** 运行时状态（设置面板状态总览区；只读快照） */
export const BIND_STATUS_PATH = '/qqbot/im-qqbot/status';

/** 人格热区读写（runtime.json 四件套：names/keywords/otherNames/selfIds） */
export const BIND_PERSONA_PATH = '/qqbot/im-qqbot/persona-runtime';

/**
 * NGA 登录 —— 纯 HTTP 扫码
 * ─────────────────────────────────────────────────────────────
 * 一整套四步：生成二维码 → 面板显示 → 用户用手机 NGA App 扫 → 轮询拿凭证。
 *
 * **完全不依赖浏览器**。初版走的是"在 ego 浏览器里开登录页让用户点"，
 * 但 ego 是 headless 的，手机端客户端不显示它的窗口，用户根本没有可操作的界面
 * （详见 persona/nga-capture.ts 的说明）。
 */
export const NGA_QR_PATH = '/qqbot/im-qqbot/nga/qr';

/** 轮询扫码结果（前端每 2 秒打一次） */
export const NGA_QR_POLL_PATH = '/qqbot/im-qqbot/nga/qr/poll';

/** 当前登录状态（面板显示用；只读） */
export const NGA_STATUS_PATH = '/qqbot/im-qqbot/nga/status';

/** 退出登录（清凭证） */
export const NGA_CLEAR_PATH = '/qqbot/im-qqbot/nga/clear';

/** NGA 登录状态线上形态 */
export interface NgaStatusWire {
  authenticated: boolean;
  /** 已保存的 uid */
  uid?: string;
  /** 凭证文件路径（面板展示，方便用户自己核） */
  path: string;
}

/** 生成二维码的响应 */
export interface NgaQrWire {
  ok: boolean;
  /** data URL，直接塞 <img src> */
  qrDataUrl?: string;
  /** 二维码过期倒计时（秒）；前端据此提示"重新生成" */
  expiresInSec?: number;
  message?: string;
}

/** 轮询响应 */
export interface NgaPollWire {
  status: 'pending' | 'success' | 'expired';
  uid?: string;
  username?: string;
  message: string;
}

/** 一个可选模型条目（下拉菜单的一项） */
export interface ModelOptionWire {
  provider: string;
  id: string;
  name?: string;
}

/** 线上协议（HTTP 路由序列化形态） */
export type BindStateWire =
  | { phase: 'starting' }
  | { phase: 'waiting'; url: string; qrSvg?: string; issuedAt: number }
  | { phase: 'saving' }
  | { phase: 'failed'; reason: string }
  | { phase: 'bound'; appId: string };

/** manual / unbind 操作的统一响应 */
export interface BindActionResponse {
  ok: boolean;
  message?: string;
  error?: string;
}
