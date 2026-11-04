/**
 * 小黑盒工具注册（`src/xhh/`）
 * ─────────────────────────────────────────────────────────────
 * 三个工具，对应她逛小黑盒时会做的三件事：
 *
 *   qq_xhh_search  搜索帖子（给分享哈希，可直接喂给 qq_xhh_read）
 *   qq_xhh_read    读一篇帖子的正文 + 评论（正文和评论里的图会给可下载地址）
 *   qq_xhh_save_sticker  把某张图收进表情库（复用 qq_archive_sticker 的库与索引）
 *
 * 为什么是三个而不是一个：
 *   搜索和读帖是不同成本（搜索吃限流、读帖也吃），混在一起她没法只做想要的那一步；
 *   收图是独立判断（"这图我想要"），而且收完不会自动发出去，跟她发消息是两件事。
 *
 * 全只读、全无账号：这里没有任何写平台的路径。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Logger } from '../types.ts';
import type { ImQQBotConfig } from '../config.ts';
import { resolveLibraryRoot } from '../media/sticker-tool.ts';
import { XhhError, type XhhClient, type XhhPost } from './client.ts';
import { fetchIntoStickerLibrary, isAllowedImageUrl } from './images.ts';
import { resolveXhhConfig, type XhhConfig } from './index.ts';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

export const XHH_TOOL_NAMES = {
  search: 'qq_xhh_search',
  read: 'qq_xhh_read',
  feeds: 'qq_xhh_feed',
  saveSticker: 'qq_xhh_save_sticker',
} as const;

/** 错误 → 给模型看的一句话（不泄内部细节，但要能据此决定下一步） */
function explain(err: unknown): string {
  if (err instanceof XhhError) {
    switch (err.kind) {
      case 'captcha':
        return `小黑盒要求人机验证了（请求太频繁），不是你的问题。等二三十分钟再试，或者先用别的办法。`;
      case 'rate-limited':
        return `${err.message}（小黑盒按请求总量限流，别连着打。）`;
      case 'network':
        return `连不上小黑盒：${err.message}。稍后再试，别反复重试。`;
      case 'http':
        return `小黑盒接口异常：${err.message}。这多半是平台侧问题，不是查询内容的问题。`;
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** 帖子列表 → 给模型看的文本 */
function renderPostList(keyword: string, posts: XhhPost[]): string {
  if (posts.length === 0) {
    return `「${keyword}」在小黑盒没搜到帖子。换个说法试试，或者本来就没有。`;
  }
  const lines = posts.map((p, i) => {
    const meta: string[] = [];
    if (p.topic) meta.push(p.topic);
    if (p.award) meta.push(`赞${p.award}`);
    if (p.comments) meta.push(`评论${p.comments}`);
    if (p.author) meta.push(p.author);
    const head = `${i + 1}. ${p.title}`;
    const tail = [meta.join(' · '), p.summary ? `「${p.summary}」` : ''].filter(Boolean).join(' ');
    return `${head}\n   ${tail}\n   ref: ${p.hash}`;
  });
  return `「${keyword}」搜到 ${posts.length} 条：\n${lines.join('\n')}`;
}

export function registerXhhTools(
  ctx: Context,
  client: XhhClient,
  config: ImQQBotConfig,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，小黑盒工具未注册');
    return;
  }

  const cfg: XhhConfig = resolveXhhConfig(
    (config as { xhh?: Partial<XhhConfig> }).xhh as Partial<XhhConfig> | undefined,
  );
  const registered = new Set<string>();
  const reg = (def: { name?: unknown } & Record<string, unknown>): void => {
    if (typeof def?.name === 'string') registered.add(def.name);
    tools.register(def);
  };

  // ── qq_xhh_search ────────────────────────────────────────────
  reg({
    name: XHH_TOOL_NAMES.search,
    description:
      '在小黑盒（heybox，中国玩家社区）搜帖子，看大家在聊什么、某个游戏有什么讨论。'
      + '只读，不需要登录你的小黑盒账号。'
      + '返回标题/话题/赞数/评论数，以及每条的 ref（读正文时把这个 ref 传给 qq_xhh_read）。'
      + '注意：小黑盒按请求总量限流，短时间内搜太多次会被要求人机验证（静默约 20 分钟），'
      + '所以要一次搜够、别一条一条反复搜。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索词，如「影之刃零」「丝之歌」「独立游戏推荐」' },
        limit: { type: 'integer', description: `返回几条（默认 ${cfg.defaultLimit}，最多 ${cfg.maxLimit}）` },
      },
      required: ['keyword'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          keyword: { type: 'string' },
          posts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: '读正文用的分享哈希' },
                title: { type: 'string' },
                topic: { type: 'string' },
                award: { type: 'integer' },
                comments: { type: 'integer' },
                author: { type: 'string' },
                summary: { type: 'string' },
              },
              required: ['ref', 'title', 'topic', 'award', 'comments', 'author', 'summary'],
              additionalProperties: false,
            },
          },
          error: { type: 'string' },
        },
        required: ['ok', 'keyword', 'posts', 'error'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { ok: boolean; keyword: string; posts: XhhPost[]; error: string };
        if (!r.ok) return [{ type: 'text', text: r.error }];
        return [{ type: 'text', text: renderPostList(r.keyword, r.posts) }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as { keyword: string; limit?: number };
      const keyword = String(a.keyword ?? '').trim();
      try {
        const limit = Math.max(1, Math.min(Number(a.limit) || cfg.defaultLimit, cfg.maxLimit));
        const posts = await client.search(keyword, limit);
        return {
          ok: true,
          keyword,
          error: '',
          posts: posts.map((p) => ({
            ref: p.hash,
            title: p.title,
            topic: p.topic,
            award: p.award,
            comments: p.comments,
            author: p.author,
            summary: p.summary,
          })),
        };
      } catch (err) {
        logger.warn(`im-qqbot: qq_xhh_search 失败 ${keyword}: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, keyword, posts: [], error: explain(err) };
      }
    },
  });

  // ── qq_xhh_feed ──────────────────────────────────────────────
  /**
   * 为什么单独拎出 feeds：
   * 实测 search 与 link/tree 头顶同一个总量限流（被拦时共同返回 show_captcha），
   * 但 **`/bbs/app/feeds` 全程不受影响**（限流期间实测仍能拿到 11 条）。
   * 也就是说被限流的那 20 分钟里，她仍然可以"刷首页"。
   * 这是她逛社区最常用、也最便宜的一项，不该跟搜索绑在一起。
   */
  reg({
    name: XHH_TOOL_NAMES.feeds,
    description:
      '看小黑盒首页推荐流（现在社区在推什么）。只读，不需要登录。'
      + '和搜索不同：这个接口**不吃小黑盒的搜索限流**，被要求人机验证时通常还能用。'
      + '想找特定主题还是用 qq_xhh_search。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: `返回几条（默认 ${cfg.defaultLimit}，最多 ${cfg.maxLimit}）` },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          posts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string' },
                title: { type: 'string' },
                topic: { type: 'string' },
                award: { type: 'integer' },
                comments: { type: 'integer' },
                author: { type: 'string' },
              },
              required: ['ref', 'title', 'topic', 'award', 'comments', 'author'],
              additionalProperties: false,
            },
          },
          error: { type: 'string' },
        },
        required: ['ok', 'posts', 'error'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { ok: boolean; posts: XhhPost[]; error: string };
        if (!r.ok) return [{ type: 'text', text: r.error }];
        if (r.posts.length === 0) return [{ type: 'text', text: '首页现在没内容（不太正常，可能接口变了）。' }];
        const lines = r.posts.map((p, i) => {
          const meta = [p.topic, p.award ? `赞${p.award}` : '', p.comments ? `评论${p.comments}` : '']
            .filter(Boolean)
            .join(' · ');
          return `${i + 1}. ${p.title}\n   ${meta}\n   ref: ${p.hash}`;
        });
        return [{ type: 'text', text: `首页推荐 ${r.posts.length} 条：\n${lines.join('\n')}` }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = (args ?? {}) as { limit?: number };
      try {
        const limit = Math.max(1, Math.min(Number(a.limit) || cfg.defaultLimit, cfg.maxLimit));
        const posts = await client.feeds(limit);
        return {
          ok: true,
          error: '',
          posts: posts.map((p) => ({
            ref: p.hash,
            title: p.title,
            topic: p.topic,
            award: p.award,
            comments: p.comments,
            author: p.author,
          })),
        };
      } catch (err) {
        logger.warn(`im-qqbot: qq_xhh_feed 失败: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, posts: [], error: explain(err) };
      }
    },
  });

  // ── qq_xhh_read ──────────────────────────────────────────────
  reg({
    name: XHH_TOOL_NAMES.read,
    description:
      '读一篇小黑盒帖子的正文和评论（含楼中楼）。只读，不需要登录。'
      + '正文里的图片和评论里的图片会给 https 地址；觉得哪张适合当表情包，'
      + '把地址传给 qq_xhh_save_sticker。'
      + 'ref 要传 qq_xhh_search 给出的那个（分享哈希），传帖子链接里的数字 ID 读不了正文。'
      + '同样吃小黑盒的总量限流。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'qq_xhh_search 返回的 ref（或整条 share_url）' },
        comment_limit: { type: 'integer', description: `最多带几条评论（默认 ${cfg.commentLimit}）` },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          title: { type: 'string' },
          author: { type: 'string' },
          text: { type: 'string', description: '正文纯文本（图片位置用 [图] 标记）' },
          images: { type: 'array', items: { type: 'string' }, description: '可下载的图片地址' },
          comments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                author: { type: 'string' },
                text: { type: 'string' },
                award: { type: 'integer' },
                images: { type: 'array', items: { type: 'string' } },
              },
              required: ['author', 'text', 'award', 'images'],
              additionalProperties: false,
            },
          },
          error: { type: 'string' },
        },
        required: ['ok', 'title', 'author', 'text', 'images', 'comments', 'error'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as {
          ok: boolean;
          title: string;
          author: string;
          text: string;
          images: string[];
          comments: { author: string; text: string; award: number; images: string[] }[];
          error: string;
        };
        if (!r.ok) return [{ type: 'text', text: r.error }];
        const parts: string[] = [`${r.title}${r.author ? `（${r.author}）` : ''}`, '', r.text];
        if (r.images.length > 0) {
          parts.push('', `正文图 ${r.images.length} 张：`, ...r.images.map((u, i) => `  [正文图${i + 1}] ${u}`));
        }
        if (r.comments.length > 0) {
          parts.push('', `评论 ${r.comments.length} 条：`);
          for (const c of r.comments) {
            const tag = c.images.length > 0 ? `（含${c.images.length}图）` : '';
            parts.push(`  ${c.author || '某人'}：${c.text}${tag}`);
            for (const u of c.images) parts.push(`    ${u}`);
          }
        }
        return [{ type: 'text', text: parts.filter((x) => x !== undefined).join('\n') }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as { ref: string; comment_limit?: number };
      const empty = {
        ok: false,
        title: '',
        author: '',
        text: '',
        images: [] as string[],
        comments: [] as unknown[],
        error: '',
      };
      try {
        const limit = Math.max(0, Math.min(Number(a.comment_limit) || cfg.commentLimit, 50));
        const d = await client.readPost(String(a.ref ?? ''), limit);
        const body = d.paragraphs
          .map((p) => (p.type === 'text' ? p.text ?? '' : '[图]'))
          .filter(Boolean)
          .join('\n');
        return {
          ok: true,
          title: d.title,
          author: d.author,
          text: body,
          images: d.images,
          comments: d.comments.map((c) => ({
            author: c.author,
            text: c.text,
            award: c.award,
            images: c.images,
          })),
          error: '',
        };
      } catch (err) {
        logger.warn(`im-qqbot: qq_xhh_read 失败: ${err instanceof Error ? err.message : String(err)}`);
        return { ...empty, error: explain(err) };
      }
    },
  });

  // ── qq_xhh_save_sticker ──────────────────────────────────────
  reg({
    name: XHH_TOOL_NAMES.saveSticker,
    description:
      '把小黑盒帖子里的某张图收进你自己的表情库（收完能被 qq_pick_sticker 检索到，'
      + '也可以之后用 qqbot_send_file 发给别人）。'
      + '这是你的判断，不是任务：觉得有意思、以后用得上才收。'
      + '不适合的别收——截图、证件、二维码、纯风景照、别人自拍。'
      + '收了不会自动发出去，发不发是另一回事。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片的 https 地址（来自 qq_xhh_read 的 images）' },
        timing: {
          type: 'array',
          items: { type: 'string' },
          description: '使用时机，如 ["A1"]（开心）["B2"]（吐槽）["C1"]（搞笑）。可多个。',
        },
        desc: { type: 'string', description: '一句话描述画面内容' },
        text: { type: 'string', description: '图上的字（没有可省略）' },
        emotion: {
          type: 'array',
          items: { type: 'string' },
          description: '具体情绪词，如 ["开心","喜悦"]',
        },
      },
      required: ['url', 'timing', 'desc'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string', description: '落库后的本地路径' },
          bytes: { type: 'integer' },
          reason: { type: 'string', description: '失败原因（ok=false 时）' },
          detail: { type: 'string' },
        },
        required: ['ok', 'path', 'bytes', 'reason', 'detail'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { ok: boolean; path: string; bytes: number; reason: string; detail: string };
        if (!r.ok) return [{ type: 'text', text: `没收进库：${r.detail}` }];
        return [{ type: 'text', text: `收进表情库了：${r.path}（${Math.round((r.bytes ?? 0) / 1024)}KB）` }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as {
        url: string;
        timing: string[];
        desc: string;
        text?: string;
        emotion?: string[];
      };
      const url = String(a.url ?? '').trim();
      if (!isAllowedImageUrl(url)) {
        return {
          ok: false,
          path: '',
          bytes: 0,
          reason: 'host-not-allowed',
          detail: '这个地址不是小黑盒图床的 https 图片，收不了。',
        };
      }
      const root = resolveLibraryRoot(config);
      const res = await fetchIntoStickerLibrary(
        url,
        root,
        {
          timing: Array.isArray(a.timing) ? a.timing : [],
          desc: String(a.desc ?? '小黑盒图片'),
          ...(a.text ? { text: a.text } : {}),
          ...(Array.isArray(a.emotion) ? { emotion: a.emotion } : {}),
        },
        logger,
      );
      return {
        ok: res.ok,
        path: res.path ?? '',
        bytes: res.bytes ?? 0,
        reason: res.reason ?? '',
        detail: res.detail ?? '',
      };
    },
  });

  logger.info(`im-qqbot: 小黑盒工具已注册（搜索/读帖/收图，共 ${registered.size} 个；只读、不需要账号）`);
}
