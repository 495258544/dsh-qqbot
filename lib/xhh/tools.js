import { resolveLibraryRoot } from "../media/sticker-tool.js";
import { XhhError, normalizePostRef, webUrlOf } from "./client.js";
import { fetchIntoStickerLibrary, isAllowedImageUrl } from "./images.js";
import { resolveXhhConfig } from "./index.js";
export const XHH_TOOL_NAMES = {
    search: 'qq_xhh_search',
    read: 'qq_xhh_read',
    feeds: 'qq_xhh_feed',
    saveSticker: 'qq_xhh_save_sticker',
};
/** 错误 → 给模型看的一句话（不泄内部细节，但要能据此决定下一步） */
function explain(err, webUrl) {
    if (err instanceof XhhError) {
        switch (err.kind) {
            case 'captcha':
                // 这条不是泛泛的"等一会"。实测：API 被风控时，**真实浏览器打开同一个帖子
                // 完全不受影响**（同一时刻 API 返回 show_captcha、浏览器连读 6 篇 0 次验证，
                // 同一个端点、浏览器也没带登录 Cookie —— 差别只在 HTTP/TLS 指纹）。
                // 所以这里必须直接指路到浏览器，而不是让她在 API 上反复试（重试会延长风控）。
                // 必须给出**这一篇的实际地址**，不能只给占位符：
                // 让她自己去把 ref 拼进模板，多一步就可能拼错或干脆放弃去浏览器。
                return `小黑盒的接口这次被风控拦了（它按请求指纹判定，不是你的问题）。`
                    + `**别在接口上重试**——实测重试会把封禁拉长到一个多小时。`
                    + (webUrl
                        ? `要现在就看这篇，用 ego_navigate 打开 ${webUrl} ，再 ego_js 读 document.body.innerText（正文和评论都在里面，图片在 img 的 src 里）。真实浏览器不受这个风控影响。`
                        : `要现在就看内容，用 ego_navigate 打开 https://www.xiaoheihe.cn/app/bbs/link/<ref> （把 <ref> 换成分享哈希），再 ego_js 读 document.body.innerText。真实浏览器不受这个风控影响。`);
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
function renderPostList(keyword, posts) {
    if (posts.length === 0) {
        return `「${keyword}」在小黑盒没搜到帖子。换个说法试试，或者本来就没有。`;
    }
    const lines = posts.map((p, i) => {
        const meta = [];
        if (p.topic)
            meta.push(p.topic);
        if (p.award)
            meta.push(`赞${p.award}`);
        if (p.comments)
            meta.push(`评论${p.comments}`);
        if (p.author)
            meta.push(p.author);
        const head = `${i + 1}. ${p.title}`;
        const tail = [meta.join(' · '), p.summary ? `「${p.summary}」` : ''].filter(Boolean).join(' ');
        return `${head}\n   ${tail}\n   ref: ${p.hash}`;
    });
    return `「${keyword}」搜到 ${posts.length} 条：\n${lines.join('\n')}`;
}
export function registerXhhTools(ctx, client, config, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，小黑盒工具未注册');
        return;
    }
    const cfg = resolveXhhConfig(config.xhh);
    const registered = new Set();
    const reg = (def) => {
        if (typeof def?.name === 'string')
            registered.add(def.name);
        tools.register(def);
    };
    // ── qq_xhh_search ────────────────────────────────────────────
    reg({
        name: XHH_TOOL_NAMES.search,
        description: '在小黑盒（heybox，中国玩家社区）搜帖子，看大家在聊什么、某个游戏有什么讨论。'
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
            render: (_a, v) => {
                const r = v;
                if (!r.ok)
                    return [{ type: 'text', text: r.error }];
                return [{ type: 'text', text: renderPostList(r.keyword, r.posts) }];
            },
        },
        async execute(args) {
            const a = args;
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
            }
            catch (err) {
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
        description: '看小黑盒首页推荐流（现在社区在推什么）。只读，不需要登录。'
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
            render: (_a, v) => {
                const r = v;
                if (!r.ok)
                    return [{ type: 'text', text: r.error }];
                if (r.posts.length === 0)
                    return [{ type: 'text', text: '首页现在没内容（不太正常，可能接口变了）。' }];
                const lines = r.posts.map((p, i) => {
                    const meta = [p.topic, p.award ? `赞${p.award}` : '', p.comments ? `评论${p.comments}` : '']
                        .filter(Boolean)
                        .join(' · ');
                    return `${i + 1}. ${p.title}\n   ${meta}\n   ref: ${p.hash}`;
                });
                return [{ type: 'text', text: `首页推荐 ${r.posts.length} 条：\n${lines.join('\n')}` }];
            },
        },
        async execute(args) {
            const a = (args ?? {});
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
            }
            catch (err) {
                logger.warn(`im-qqbot: qq_xhh_feed 失败: ${err instanceof Error ? err.message : String(err)}`);
                return { ok: false, posts: [], error: explain(err) };
            }
        },
    });
    // ── qq_xhh_read ──────────────────────────────────────────────
    reg({
        name: XHH_TOOL_NAMES.read,
        description: '读一篇小黑盒帖子的正文和评论（含楼中楼）。只读，不需要登录。'
            + '正文里的图片和评论里的图片会给 https 地址；觉得哪张适合当表情包，'
            + '把地址传给 qq_xhh_save_sticker。'
            + 'ref 要传 qq_xhh_search 给出的那个（分享哈希），传帖子链接里的数字 ID 读不了正文。'
            + '同样吃小黑盒的总量限流。**被风控拦了不要重试**——改用 ego_navigate 打开网页版帖子地址，'
            + '真实浏览器不受影响（这条是实测结论，不是猜测）。',
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
            render: (_a, v) => {
                const r = v;
                if (!r.ok)
                    return [{ type: 'text', text: r.error }];
                const parts = [`${r.title}${r.author ? `（${r.author}）` : ''}`, '', r.text];
                if (r.images.length > 0) {
                    parts.push('', `正文图 ${r.images.length} 张：`, ...r.images.map((u, i) => `  [正文图${i + 1}] ${u}`));
                }
                if (r.comments.length > 0) {
                    parts.push('', `评论 ${r.comments.length} 条：`);
                    for (const c of r.comments) {
                        const tag = c.images.length > 0 ? `（含${c.images.length}图）` : '';
                        parts.push(`  ${c.author || '某人'}：${c.text}${tag}`);
                        for (const u of c.images)
                            parts.push(`    ${u}`);
                    }
                }
                return [{ type: 'text', text: parts.filter((x) => x !== undefined).join('\n') }];
            },
        },
        async execute(args) {
            const a = args;
            const empty = {
                ok: false,
                title: '',
                author: '',
                text: '',
                images: [],
                comments: [],
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
            }
            catch (err) {
                logger.warn(`im-qqbot: qq_xhh_read 失败: ${err instanceof Error ? err.message : String(err)}`);
                // 尽力把这一篇的真实网页地址给她（ref 可能本身就是坏的，那就退回不给）
                let webUrl;
                try {
                    webUrl = webUrlOf(normalizePostRef(String(a.ref ?? '')));
                }
                catch {
                    webUrl = undefined;
                }
                return { ...empty, error: explain(err, webUrl) };
            }
        },
    });
    // ── qq_xhh_save_sticker ──────────────────────────────────────
    reg({
        name: XHH_TOOL_NAMES.saveSticker,
        description: '把小黑盒帖子里的某张图收进你自己的表情库（收完能被 qq_pick_sticker 检索到，'
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
            render: (_a, v) => {
                const r = v;
                if (!r.ok)
                    return [{ type: 'text', text: `没收进库：${r.detail}` }];
                return [{ type: 'text', text: `收进表情库了：${r.path}（${Math.round((r.bytes ?? 0) / 1024)}KB）` }];
            },
        },
        async execute(args) {
            const a = args;
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
            const res = await fetchIntoStickerLibrary(url, root, {
                timing: Array.isArray(a.timing) ? a.timing : [],
                desc: String(a.desc ?? '小黑盒图片'),
                ...(a.text ? { text: a.text } : {}),
                ...(Array.isArray(a.emotion) ? { emotion: a.emotion } : {}),
            }, logger);
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
//# sourceMappingURL=tools.js.map