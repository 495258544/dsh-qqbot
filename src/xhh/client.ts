/**
 * 小黑盒只读 API 客户端
 * ─────────────────────────────────────────────────────────────
 * 只用**不需要登录**就能用的接口。这是本模块的核心约束：
 *
 *   小羽有自己的账号，但这个模块**不碰任何账号**——
 *   不发帖、不评论、不点赞、不读私信、不读需要登录态的接口。
 *   所以不需要 Cookie、不需要扫码、不需要凭据落盘，也就不存在
 *   「插件把账号密码存哪儿了」这类问题。
 *
 * 三个实测可用的只读接口（无 Cookie，仅靠签名）：
 *   - `/bbs/app/api/general/search/v1`  搜索帖子（含标题/赞数/评论数/分享哈希）
 *   - `/bbs/app/feeds`                  首页推荐流
 *   - `/bbs/app/api/search/welcome_page/v2`  热搜榜（游戏/热议/小程序）
 *   - `/bbs/app/link/tree`              读正文 + 评论 + 楼中楼
 *
 * ⚠️ 两个必须记住的坑（都实测过）：
 *
 * 1. **`link_id` 要传分享哈希，不能传数字 ID。**
 *       link_id=194674321      → `{"status":"show_captcha"}`（被弹验证码）
 *       link_id=ba9b72b0316e   → ok，正文正常返回
 *    哈希就在搜索/流里每条记录的 `share_url` 末尾（`?link_id=<hash>`）。
 *    数字 ID 只在搜索结果的 `info.linkid` 里，是给别的用途的。
 *
 * 2. **搜索接口有频率限制，约十几次后开始弹 `show_captcha`，冷却约 20 分钟。**
 *    `feeds` 与热搜榜全程不受影响。所以本模块默认给搜索加本地冷却，
 *    并在冷却窗口内直接返回"太频繁了，等会儿",而不是硬打过去换一个验证码。
 *
 * 图片：CDN（`imgheybox*.max-c.com`）不带 Cookie 也能下，实测 200。详见 images.ts。
 */
import type { Logger } from '../types.ts';
import { signatureOf } from './sign.ts';

/** 接口路径 */
const PATHS = {
  search: '/bbs/app/api/general/search/v1',
  feeds: '/bbs/app/feeds',
  hot: '/bbs/app/api/search/welcome_page/v2',
  tree: '/bbs/app/link/tree',
} as const;

/**
 * Web 端公共参数。顺序无关（会按 keys 重新拼），但值必须和浏览器一致：
 * 少了 `x_app`/`x_client_type` 这类字段服务端会当非 Web 客户端处理，
 * 多给字段则会被指纹识别成脚本。
 */
const COMMON_PARAMS: Record<string, string> = {
  os_type: 'web',
  app: 'heybox',
  client_type: 'web',
  version: '999.0.4',
  web_version: '2.5',
  x_client_type: 'web',
  x_app: 'heybox_website',
  x_os_type: 'Windows',
  device_info: 'Chrome',
};

const API_BASE = 'https://api.xiaoheihe.cn';
const REFERER = 'https://www.xiaoheihe.cn/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 全局节流（搜索 + 读正文共用同一个池）。
 *
 * 标定过程（实测，不是估算）：
 *   第一轮连跑 3 次 search + 3 次 tree 全部成功；
 *   继续连跑后，**search 与 tree 同时开始返回 `show_captcha`**。
 *   等约 20 分钟自动恢复。
 *
 * 所以这不是"搜索接口单独限流"，而是 **同一身份(签名)在短时间内的请求总量**被拦。
 * 结论：search 与 readPost 必须共享一个滑动窗口，否则各自守限额、合并起来照样打爆。
 *
 * 配额标定：实测**约 10 次**连续请求后就进验证码状态，且这次实测被拦了
 * 40 分钟以上仍未解除（比最初估的 20 分钟更久）—— 说明这个惩罚比预想重。
 * 所以配额必须比"撞上之前最后一次"更保守：
 *   10 分钟窗口 5 次（≈ 每 2 分钟一次），把 10 次摊到 20 分钟以上。
 * 宁可少用，也不要撞上那个一半小时的黑箱。
 */
const THROTTLE_WINDOW_MS = 10 * 60_000;
const THROTTLE_MAX_CALLS = 5;

/**
 * 搜索结果里 link 只占一部分（其余是 filter_tag / space / game 等噪声）。
 * 实测：limit=10 → 3 条 link；limit=30 → 10 条 link。约 1/3。
 * 所以服务端的 `limit` 是"条目总数"而不是"帖子数"，
 * 想要 N 条帖子就按 3N 去要，再在本地切。
 */
const SEARCH_RAW_LIMIT = 30;
/** 触发验证码后整体静默多久 */
const CAPTCHA_COOLDOWN_MS = 20 * 60_000;

/** 搜索命中一条 */
export interface XhhPost {
  /** 分享哈希（读正文时用这个） */
  hash: string;
  /** 数字 ID（仅用于展示/去重） */
  linkId: number;
  title: string;
  /** 帖子摘要（平台自带，可能为空） */
  summary: string;
  /** 精华数（点赞的等价物） */
  award: number;
  comments: number;
  /** 所属话题名（如「影之刃零」） */
  topic: string;
  createdAt: number;
  author: string;
  coverUrl?: string;
}

/** 正文里的一段 */
export interface XhhParagraph {
  type: 'text' | 'img';
  text?: string;
  url?: string;
}

/** 一条评论 */
export interface XhhComment {
  text: string;
  author: string;
  award: number;
  images: string[];
}

/** 读正文结果 */
export interface XhhPostDetail {
  hash: string;
  title: string;
  author: string;
  paragraphs: XhhParagraph[];
  comments: XhhComment[];
  /** 正文里的图片直链（已按需去重） */
  images: string[];
}

/** 热搜分组 */
export interface XhhHotGroup {
  title: string;
  items: { text: string; tag?: string }[];
}

/** 统一错误类型：把平台语义（验证码/限流/结构变化）和网络错误分开 */
export type XhhErrorKind = 'captcha' | 'rate-limited' | 'network' | 'shape' | 'http';

export class XhhError extends Error {
  constructor(
    readonly kind: XhhErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'XhhError';
  }
}

export interface XhhClientOptions {
  logger: Logger;
  /** 单次请求超时(ms) */
  timeoutMs?: number;
  /** 滑动窗口长度(ms)，默认 10 分钟 */
  throttleWindowMs?: number;
  /** 窗口内最多几次 api 调用，默认 6 */
  throttleMaxCalls?: number;
  /** 触发验证码后静默时长(ms) */
  captchaCooldownMs?: number;
  /** 注入用（测试替身） */
  now?: () => number;
  /** 注入用（测试替身） */
  fetchImpl?: typeof fetch;
}

/** 拆 share_url 里的哈希：`...?link_id=ba9b72b0316e` → `ba9b72b0316e` */
export function hashFromShareUrl(shareUrl: string | undefined): string | undefined {
  if (!shareUrl) return undefined;
  const m = /[?&]link_id=([0-9a-fA-F]+)/.exec(shareUrl);
  return m?.[1];
}

/** 帖子 ID 归一：接受哈希、数字、或整条 share_url */
export function normalizePostRef(input: string): string {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new XhhError('shape', '给的是一个空的帖子标识');
  // 整条链接 → 先取哈希
  if (trimmed.startsWith('http')) {
    const h = hashFromShareUrl(trimmed);
    if (h) return h;
    // 网页版帖子链接里带的是数字 ID，读不了正文，明确说出来
    const num = /\/(?:link|bbs\/link)\/(\d{6,})/.exec(trimmed);
    if (num) {
      throw new XhhError(
        'shape',
        `这是帖子的数字 ID（${num[1]}），读正文要用分享哈希（share_url 里的 link_id）。`
          + '先用 qq_xhh_search 搜到这条帖，它会给出可读的 ref。',
      );
    }
    throw new XhhError('shape', `认不出这个链接里的帖子标识：${trimmed.slice(0, 60)}`);
  }
  return trimmed;
}

/** 正文 JSON 里的富文本段落 → 纯段落（剥掉样式字段，只留文本/图片） */
export function parseRichText(raw: string | undefined): XhhParagraph[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 老帖可能是纯字符串正文
    return [{ type: 'text', text: String(raw) }];
  }
  if (!Array.isArray(parsed)) {
    if (typeof parsed === 'string') return [{ type: 'text', text: parsed }];
    return [];
  }
  const out: XhhParagraph[] = [];
  for (const block of parsed) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      out.push({ type: 'text', text: b.text.trim() });
    } else if (b.type === 'img' && typeof b.url === 'string') {
      // 实测有的帖子 url 是**发帖人手机本地路径**
      // （`/storage/emulated/0/DCIM/Camera/IMG_xxx.jpg`），不是可下载的地址。
      // 这种图我们拿不到，直接丢掉，不要当成图片交给上层去下载。
      if (/^https?:\/\//i.test(b.url)) out.push({ type: 'img', url: b.url });
    }
  }
  return out;
}

/**
 * 只读客户端。
 *
 * 单一职责：把小黑盒的 HTTP 细节关在这里，上层工具层只管"要什么"。
 */
export class XhhClient {
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly throttleWindowMs: number;
  private readonly throttleMaxCalls: number;
  private readonly captchaCooldownMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  /** 最近 api 调用时间戳（滑动窗口，search 与 tree 共用） */
  private callLog: number[] = [];
  /** 触发验证码后的静默截止时间 */
  private mutedUntil = 0;

  constructor(opts: XhhClientOptions) {
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.throttleWindowMs = opts.throttleWindowMs ?? THROTTLE_WINDOW_MS;
    this.throttleMaxCalls = Math.max(1, opts.throttleMaxCalls ?? THROTTLE_MAX_CALLS);
    this.captchaCooldownMs = opts.captchaCooldownMs ?? CAPTCHA_COOLDOWN_MS;
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** 节流还要等多少毫秒（0 = 现在可以发请求） */
  throttleRemainingMs(): number {
    const t = this.now();
    this.callLog = this.callLog.filter((at) => t - at < this.throttleWindowMs);
    if (this.callLog.length < this.throttleMaxCalls) return 0;
    // 最早那次滑出窗口时才能再发
    const oldest = this.callLog[0]!;
    return Math.max(0, oldest + this.throttleWindowMs - t);
  }

  /** 记一次调用 */
  private noteCall(): void {
    const t = this.now();
    this.callLog = this.callLog.filter((at) => t - at < this.throttleWindowMs);
    this.callLog.push(t);
  }

  /** 验证码静默还剩多少毫秒（0 = 没被静默） */
  mutedRemainingMs(): number {
    return Math.max(0, this.mutedUntil - this.now());
  }

  /** 底层：签名 + 发请求 + 解信封。节流与静默统一在这里守，所有入口自动受约束。 */
  private async call(path: string, extra: Record<string, string>): Promise<Record<string, unknown>> {
    const muted = this.mutedRemainingMs();
    if (muted > 0) {
      throw new XhhError('captcha', `刚被人机验证拦过，还要等约 ${Math.ceil(muted / 60_000)} 分钟。`);
    }
    const wait = this.throttleRemainingMs();
    if (wait > 0) {
      throw new XhhError('rate-limited', `请求太密了，还有 ${Math.ceil(wait / 1000)} 秒。小黑盒按总量限流，别连着打。`);
    }
    this.noteCall();

    const sig = signatureOf(path, this.now());
    const params: Record<string, string> = {
      ...COMMON_PARAMS,
      hkey: sig.hkey,
      _time: String(sig._time),
      nonce: sig.nonce,
      ...extra,
    };
    const url = `${API_BASE}${path}?${new URLSearchParams(params).toString()}`;

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        headers: { Referer: REFERER, 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new XhhError('network', `小黑盒请求失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!resp.ok) {
      throw new XhhError('http', `小黑盒返回 HTTP ${resp.status}`);
    }

    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      throw new XhhError('shape', '小黑盒返回的不是 JSON（接口可能改了）');
    }
    const envelope = body as Record<string, unknown>;

    // 平台把业务状态放进 status 字段，HTTP 永远是 200 —— 必须显式检查
    if (envelope.status === 'show_captcha') {
      this.mutedUntil = this.now() + this.captchaCooldownMs;
      this.logger.warn(`im-qqbot: 小黑盒要求人机验证，静默 ${Math.round(this.captchaCooldownMs / 60_000)} 分钟`);
      throw new XhhError(
        'captcha',
        '小黑盒这次要求人机验证（请求太频繁）。要等一会儿再试，现在硬打只会继续被拦。',
      );
    }
    if (envelope.status !== 'ok') {
      const msg = typeof envelope.msg === 'string' ? envelope.msg : '';
      throw new XhhError('shape', `小黑盒拒绝了请求：${msg || String(envelope.status)}`);
    }
    const result = envelope.result;
    return (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  }

  /**
   * 搜索帖子。
   * @param keyword 搜索词
   * @param limit 1~30（服务端单页上限）
   */
  async search(keyword: string, limit = 10): Promise<XhhPost[]> {
    const q = String(keyword ?? '').trim();
    if (!q) throw new XhhError('shape', '搜索词是空的');
    const cap = Math.max(1, Math.min(Math.floor(limit), 30));
    const result = await this.call(PATHS.search, {
      q,
      search_type: 'general',
      is_pull_down: '0',
      offset: '0',
      // 按 3 倍要（link≈1/3），服务端单页封顶 30
      limit: String(Math.min(SEARCH_RAW_LIMIT, cap * 3)),
      dw: '744',
    });
    const items = Array.isArray(result.items) ? result.items : [];
    const posts: XhhPost[] = [];
    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      if (item.type !== 'link') continue;
      const info = item.info as Record<string, unknown> | undefined;
      if (!info) continue;
      const hash = hashFromShareUrl(info.share_url as string | undefined);
      if (!hash) continue;
      posts.push(toPost(info, hash));
    }
    return posts.slice(0, cap);
  }

  /** 首页推荐流（不受搜索冷却影响） */
  async feeds(limit = 10): Promise<XhhPost[]> {
    const cap = Math.max(1, Math.min(Math.floor(limit), 30));
    const result = await this.call(PATHS.feeds, {
      pull: '1',
      offset: '0',
      limit: String(cap),
    });
    const links = Array.isArray(result.links) ? result.links : [];
    const posts: XhhPost[] = [];
    for (const raw of links) {
      const info = raw as Record<string, unknown>;
      const hash = hashFromShareUrl(info.share_url as string | undefined);
      if (!hash) continue;
      posts.push(toPost(info, hash));
    }
    return posts.slice(0, cap);
  }

  /** 热搜榜（游戏榜 / 黑盒热议 / 小程序） */
  async hot(): Promise<XhhHotGroup[]> {
    const result = await this.call(PATHS.hot, {});
    const lists = Array.isArray(result.Lists) ? result.Lists : [];
    const groups: XhhHotGroup[] = [];
    for (const raw of lists) {
      const g = raw as Record<string, unknown>;
      const items = Array.isArray(g.items) ? g.items : [];
      const title = typeof g.head_text === 'string' && g.head_text ? g.head_text : '热搜';
      groups.push({
        title,
        items: items
          .map((it) => {
            const o = it as Record<string, unknown>;
            const text = typeof o.text === 'string' ? o.text : '';
            const tag = (o.right_tag as Record<string, unknown> | undefined)?.text;
            return { text, tag: typeof tag === 'string' ? tag : undefined };
          })
          .filter((x) => x.text),
      });
    }
    return groups;
  }

  /**
   * 读一篇帖子的正文与评论。
   * @param ref 分享哈希 / 数字 ID / 整条链接（内部会归一）
   */
  async readPost(ref: string, commentLimit = 20): Promise<XhhPostDetail> {
    const hash = normalizePostRef(ref);
    const result = await this.call(PATHS.tree, {
      link_id: hash,
      page: '1',
      is_first: '1',
      index: '1',
      owner_only: '0',
      offset: '0',
      limit: '20',
      sort_filter: 'hot',
    });

    const link = (result.link ?? {}) as Record<string, unknown>;
    const paragraphs = parseRichText(link.text as string | undefined);
    const images = paragraphs.filter((p) => p.type === 'img' && p.url).map((p) => p.url!);

    const comments: XhhComment[] = [];
    const floors = Array.isArray(result.comments) ? result.comments : [];
    for (const raw of floors.slice(0, Math.max(0, commentLimit))) {
      const floor = raw as Record<string, unknown>;
      const nodes = Array.isArray(floor.comment) ? floor.comment : [];
      for (const node of nodes) {
        const c = node as Record<string, unknown>;
        const text = typeof c.text === 'string' ? c.text.trim() : '';
        const imgs = Array.isArray(c.imgs) ? c.imgs : [];
        const cImages: string[] = [];
        for (const im of imgs) {
          const o = im as Record<string, unknown>;
          const url = typeof o.url === 'string' ? o.url : (typeof o.thumb === 'string' ? o.thumb : '');
          if (url) cImages.push(url);
        }
        // 纯图无字的评论也算（表情包场景正是这类）
        if (!text && cImages.length === 0) continue;
        comments.push({
          text,
          author: String((c.user as Record<string, unknown> | undefined)?.username ?? ''),
          award: Number(c.link_award_num ?? 0) || 0,
          images: cImages,
        });
      }
    }

    return {
      hash,
      title: String(link.title ?? ''),
      author: String((link.user as Record<string, unknown> | undefined)?.username ?? ''),
      paragraphs,
      comments,
      images,
    };
  }
}

/** 搜索结果里的一条 info → 统一帖子形状 */
function toPost(info: Record<string, unknown>, hash: string): XhhPost {
  const topics = Array.isArray(info.topics) ? info.topics : [];
  const topic = topics
    .map((t) => String((t as Record<string, unknown>).name ?? ''))
    .filter(Boolean)
    .join('/');
  // 搜索结果的标题带 `<em>` 高亮标签，要剥掉
  const title = String(info.title ?? '').replace(/<[^>]+>/g, '');
  const imgs = Array.isArray(info.imgs) ? info.imgs : [];
  const cover = typeof imgs[0] === 'string' ? imgs[0] : undefined;
  return {
    hash,
    linkId: Number(info.linkid ?? 0) || 0,
    title,
    summary: String(info.description ?? ''),
    award: Number(info.link_award_num ?? 0) || 0,
    comments: Number(info.comment_num ?? 0) || 0,
    topic,
    createdAt: Number(info.create_at ?? 0) || 0,
    author: String((info.user as Record<string, unknown> | undefined)?.username ?? ''),
    ...(cover ? { coverUrl: cover } : {}),
  };
}
