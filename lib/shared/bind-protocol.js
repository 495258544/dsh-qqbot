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
//# sourceMappingURL=bind-protocol.js.map