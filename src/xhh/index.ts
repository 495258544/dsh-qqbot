/**
 * 小黑盒只读模块（`src/xhh/`）的统一入口
 * ─────────────────────────────────────────────────────────────
 * 只做两件事：让小羽**搜到/刷到**小黑盒的帖子、**读到**正文和评论里的图。
 *
 * 三条硬边界（贯穿整个模块）：
 *   1. **不碰账号**：不需要 Cookie / 扫码 / 任何凭据。所有接口都是匿名只读的。
 *      所以这里不可能发帖、评论、点赞、读私信——不是"关了开关"，是根本没有那套代码。
 *   2. **只收图，不发图**：图片走 images.ts 下载 + 复用现有表情库索引，
 *      发图仍然只走 `qqbot_send_file` 那一条实现。
 *   3. **平台限流是硬约束**：search 与 readPost 共用一个滑动窗口
 *      （实测同一签名短时间内请求总量超标就统一弹 `show_captcha`）。
 *
 * 署名：签名算法与接口知识来自 `fbbDirge/dsh-xiaoheihe`（MIT）。
 * 这个仓库只被借用了 64 行签名代码与接口路径，没有引入它的插件形态。
 */
import type { Logger } from '../types.ts';
import { XhhClient, XhhError, hashFromShareUrl, normalizePostRef, parseRichText } from './client.ts';
import type { XhhComment, XhhErrorKind, XhhHotGroup, XhhParagraph, XhhPost, XhhPostDetail } from './client.ts';

/** 配置默认值（上层 Schema 直接复用，避免两处写死不同数字） */
export const DEFAULT_XHH_CONFIG: XhhConfig = {
  enabled: true,
  timeoutMs: 10_000,
  throttleWindowMs: 10 * 60_000,
  throttleMaxCalls: 5,
  defaultLimit: 8,
  maxLimit: 20,
  commentLimit: 12,
};

export interface XhhConfig {
  /** 总开关（关 = 不注册任何 qq_xhh_* 工具） */
  enabled: boolean;
  /** 单次请求超时(ms) */
  timeoutMs: number;
  /** 节流窗口长度(ms) */
  throttleWindowMs: number;
  /** 窗口内最多几次请求 */
  throttleMaxCalls: number;
  /** search 默认返回几条 */
  defaultLimit: number;
  /** search 单次上限 */
  maxLimit: number;
  /** 读帖时最多带几条评论 */
  commentLimit: number;
}

/** 补齐缺省字段（逐字段兜底，显式 undefined 也回落默认） */
export function resolveXhhConfig(partial: Partial<XhhConfig> | undefined): XhhConfig {
  const src = partial ?? {};
  const pick = <K extends keyof XhhConfig>(key: K): XhhConfig[K] => {
    const value = src[key];
    return value === undefined ? DEFAULT_XHH_CONFIG[key] : value;
  };
  return {
    enabled: pick('enabled'),
    timeoutMs: pick('timeoutMs'),
    throttleWindowMs: pick('throttleWindowMs'),
    throttleMaxCalls: pick('throttleMaxCalls'),
    defaultLimit: pick('defaultLimit'),
    maxLimit: pick('maxLimit'),
    commentLimit: pick('commentLimit'),
  };
}

/** 工厂 */
export function createXhhClient(config: Partial<XhhConfig> | undefined, logger: Logger): XhhClient {
  const c = resolveXhhConfig(config);
  return new XhhClient({
    logger,
    timeoutMs: c.timeoutMs,
    throttleWindowMs: c.throttleWindowMs,
    throttleMaxCalls: c.throttleMaxCalls,
  });
}

export { registerXhhTools } from './tools.ts';

export {
  XhhClient,
  XhhError,
  hashFromShareUrl,
  normalizePostRef,
  parseRichText,
};

export type {
  XhhComment,
  XhhErrorKind,
  XhhHotGroup,
  XhhParagraph,
  XhhPost,
  XhhPostDetail,
};
