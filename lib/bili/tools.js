import { runBili, biliFailure } from "./cli.js";
import { mmss, condenseSubtitlesByMinute } from "./subtitles.js";
export function registerBiliTools(ctx, logger) {
    const tools = ctx.get('tools');
    const registered = new Set();
    const reg = (def) => {
        if (typeof def?.name === 'string')
            registered.add(def.name);
        tools?.register(def);
    };
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，B 站工具未注册');
        return;
    }
    /**
     * qq_bili_check —— 让她真的能查 B 站视频。
     *
     * 背景（2026-11-02 实测事故）：
     *   用户说「我给你装了插件，你可以去 b 站逛逛了」、
     *   「qq_bili_check 我给了你这个工具」——**但那时工具根本不存在**，
     *   她翻遍工具清单没找到，只好如实报告"我这儿没有"，然后开始汇报
     *   "python 部分留在 ~/.dsh/bili-duty…node 那个包没进 node_modules…"
     *   一大串内部排查过程泄露给用户。
     *
     * 现在真的给它接上：复用本机已装好的 `bili` CLI（bili-agent 1.2.1，已登录）。
     * 只暴露**只读**能力（info / summary / subtitle / search），不做写操作。
     */
    reg({
        name: 'qq_bili_check',
        description: '查一个 B 站视频：标题、AI 总结、分章提纲、字幕（带时间轴）、弹幕、画面帧。'
            + '想聊某个视频的内容时用它，别凭印象编。没给 BV 号也可以按关键词搜。'
            + '**如果是长视频或合集，先看返回的 pages（分 P 目录），再指定 page 看具体某一集。**',
        parameters: {
            type: 'object',
            properties: {
                bvid: { type: 'string', description: 'BV 号，如 BV1ednc6jE3j' },
                query: { type: 'string', description: '想搜的关键词（没有 BV 号时用）' },
                page: { type: 'number', description: '合集看到第几 P（默认 1）' },
                want: {
                    type: 'string',
                    enum: ['summary', 'subtitle', 'danmaku', 'frames', 'all', 'inbox', 'trending', 'recommend', 'comments'],
                    description: '要什么：summary=AI总结+分章提纲（默认）、subtitle=字幕（按分钟压缩、带时间戳）、'
                        + 'danmaku=观众弹幕、frames=抽画面帧、all=全都拿；'
                        + 'inbox=我的消息中心、trending=B站热门、recommend=首页推荐（这三个不用 bvid）、'
                        + 'comments=某视频的评论（要 bvid）',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    // 具体失败原因（没字幕 / 没登录 / bili 没装）——
                    // 比笼统的"视频信息拿不到"有用得多，模型不会当成"视频不存在"
                    biliError: { type: 'string' },
                    // 消息中心的文字摘要（它是计数型结构，不是列表）
                    note: { type: 'string' },
                    comments: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                user: { type: 'string' },
                                text: { type: 'string' },
                                likes: { type: 'number' },
                            },
                            required: ['user', 'text', 'likes'],
                            additionalProperties: false,
                        },
                    },
                    title: { type: 'string' },
                    // 简介（watch 带的，比只给标题有用）
                    desc: { type: 'string' },
                    // 进度条上的分章（UP 主设置的），不给就是没有
                    chapters: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { title: { type: 'string' }, start: { type: 'string' } },
                            required: ['title', 'start'],
                            additionalProperties: false,
                        },
                    },
                    // watch 抽帧后拼成的**一张**总览图（不是多张单帧）
                    framesSheet: { type: 'string' },
                    page: { type: 'number' },
                    // 合集目录：四十集看不过来时的第一层答案
                    pages: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                page: { type: 'number' },
                                title: { type: 'string' },
                                length: { type: 'string' },
                            },
                            required: ['page', 'title', 'length'],
                            additionalProperties: false,
                        },
                    },
                    summary: { type: 'string' },
                    outline: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string' },
                                start: { type: 'string' },
                                points: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: { t: { type: 'string' }, text: { type: 'string' } },
                                        required: ['t', 'text'],
                                        additionalProperties: false,
                                    },
                                },
                            },
                            required: ['title', 'start', 'points'],
                            additionalProperties: false,
                        },
                    },
                    subtitleOutline: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { t: { type: 'string' }, text: { type: 'string' } },
                            required: ['t', 'text'],
                            additionalProperties: false,
                        },
                    },
                    danmakuPeaks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                t: { type: 'string' },
                                count: { type: 'number' },
                                top: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['t', 'count', 'top'],
                            additionalProperties: false,
                        },
                    },
                    danmaku: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { t: { type: 'string' }, text: { type: 'string' } },
                            required: ['t', 'text'],
                            additionalProperties: false,
                        },
                    },
                    frames: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { t: { type: 'string' }, path: { type: 'string' } },
                            required: ['t', 'path'],
                            additionalProperties: false,
                        },
                    },
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { bvid: { type: 'string' }, title: { type: 'string' } },
                            required: ['bvid', 'title'],
                            additionalProperties: false,
                        },
                    },
                    error: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: false,
            },
            render: (a, v) => {
                const inp = (a ?? {});
                const r = v;
                if (!r.ok) {
                    // biliError 比 error 具体（"没字幕" vs "拿不到"），优先显示
                    return [{ type: 'text', text: `没查到（${r.biliError ?? r.error ?? '未知原因'}）` }];
                }
                const parts = [];
                if (r.title)
                    parts.push(`《${r.title}》${r.page && r.page > 1 ? ` 第 ${r.page} P` : ''}`);
                if (r.desc)
                    parts.push(`简介：${r.desc}`);
                if (r.chapters?.length) {
                    parts.push('分章（UP 主标的进度条节点）：\n'
                        + r.chapters.map((c) => `  [${c.start}] ${c.title}`).join('\n'));
                }
                // 合集先给目录 —— 用户要挑着看，先得知道有哪些集
                if (r.pages?.length) {
                    // 目录同样要"先筛再说"。
                    // 16 行全念一遍等于让他读目录，而他要的是"哪几集值得看"。
                    parts.push(`这是个合集（共 ${r.pages.length} P）：\n`
                        + r.pages.map((p) => `  P${p.page}（${p.length}）${p.title}`).join('\n')
                        + '\n\n↑ 别把 16 行全念给他。按他问的东西**挑相关的 2–3 集**说，'
                        + '或者问他想要哪个方向。\n'
                        + '（要看某一 P 的具体内容，带 page 参数再查一次）');
                }
                if (r.summary)
                    parts.push(`AI 总结：${r.summary}`);
                if (r.outline?.length) {
                    parts.push('分段提纲（可直接按时间跳）：\n' + r.outline.map((sec) => `  [${sec.start}] ${sec.title}\n`
                        + sec.points.map((pt) => `      ${pt.t} ${pt.text}`).join('\n')).join('\n'));
                }
                if (r.subtitleOutline?.length) {
                    // 这不是"给你看的资料"，是"给你挑的原料"。
                    //
                    // 原来的措辞是「字幕·按分钟（这一分钟主要在讲）」——
                    // 那是在暗示"这就是结论"，她很可能直接整段转给用户。
                    // 结果就是从"四十集看不过来"变成"32 分钟看不完"，问题只是换了个尺度。
                    //
                    // 用户要的是**你先筛过**。所以这里明确要求她挑，并给出挑的标准。
                    parts.push('字幕·按分钟（**这是原料，不是结论**）：\n'
                        + r.subtitleOutline.map((x) => `  [${x.t}] ${x.text}`).join('\n')
                        + '\n\n↑ 别整段转给他。你要做的是**从中挑出真正讲到东西的 3–5 段**，'
                        + '每段用一句话说清"这讲了什么"，带上时间点。\n'
                        + '挑的标准：有具体命令/参数/结论/易错点的才算"讲到东西"；'
                        + '铺垫、寒暄、"我们后面再讲"这类跳过。');
                }
                if (r.danmakuPeaks?.length) {
                    parts.push('观众反应最强的时刻：\n'
                        + r.danmakuPeaks.map((x) => `  ${x.t}（${x.count} 条）${x.top.join(' / ')}`).join('\n'));
                }
                if (r.danmaku?.length) {
                    parts.push('弹幕：\n' + r.danmaku.slice(0, 15).map((x) => `  ${x.t} ${x.text}`).join('\n'));
                }
                if (r.frames?.length) {
                    parts.push('画面帧（图片路径）：\n' + r.frames.map((x) => `  ${x.t} ${x.path}`).join('\n'));
                }
                if (r.framesSheet) {
                    parts.push(`画面总览图（抽帧拼成一张）：\n  ${r.framesSheet}\n`
                        + '（这是图片路径。想知道画面内容就交给能看图的工具读，别凭标题猜。）');
                }
                if (r.comments?.length) {
                    parts.push('评论（按热度）：\n' + r.comments.slice(0, 12).map((c, i) => `  ${i + 1}. ${c.likes > 0 ? `[${c.likes}赞] ` : ''}${c.user}：${c.text}`).join('\n')
                        + '\n\n↑ 挑有信息量的说，别整段复述。');
                }
                if (r.note)
                    parts.push(`消息中心：${r.note}`);
                if (r.items?.length) {
                    // 措辞跟着 want 走：对着消息中心说"搜到这些"很怪
                    const label = inp.want === 'inbox' ? '消息中心：'
                        : inp.want === 'trending' ? '现在 B 站热门：'
                            : inp.want === 'recommend' ? '首页推荐：'
                                : '搜到这些：';
                    parts.push(label + '\n' + r.items.map((x, i) => `${i + 1}. ${x.title}${x.bvid ? `（${x.bvid}）` : ''}`).join('\n'));
                }
                // 成功但有一部分没拿到（比如没字幕）：说清楚，别让她以为全拿到了
                if (r.biliError)
                    parts.push(`注意：${r.biliError}`);
                return [{ type: 'text', text: parts.join('\n\n') || '（空）' }];
            },
        },
        async execute(args) {
            const a = args;
            const run = (argv, timeoutMs) => runBili(argv, timeoutMs);
            const want = String(a.want ?? 'summary');
            // ── 消息中心：结构跟列表类不同，是 {unread:{...}, total, note} ──
            if (want === 'inbox') {
                const r = run(['feed', 'inbox']);
                if (r.ok === false)
                    return { ok: false, error: biliFailure(r, '看消息中心') };
                const d = (r.data ?? {});
                const note = String(d.note ?? '').trim();
                const unread = (d.unread ?? {});
                const LABEL = {
                    replies: '回复', mentions: '@我', likes: '赞',
                    private_messages: '私信', system: '系统', up_assistant: 'UP主助手',
                };
                const counts = Object.entries(unread)
                    .filter(([, v]) => Number(v) > 0)
                    .map(([k, v]) => `${LABEL[k] ?? k} ${Number(v)}`);
                const text = counts.length > 0
                    ? `未读：${counts.join(' / ')}${note ? `　${note}` : ''}`
                    : (note || '没有新消息');
                return { ok: true, note: text };
            }
            // ── 列表类：热门 / 首页推荐 ──
            // 返回结构随 bili 版本变化，所以解析做得宽容，解析不出来就如实说，
            // 不要假装"没有内容"。
            const browse = want === 'trending' ? ['hot', 'popular']
                : want === 'recommend' ? ['feed', 'recommend']
                    : null;
            if (browse !== null) {
                const r = run(browse);
                if (r.ok === false)
                    return { ok: false, error: biliFailure(r, '看 B 站首页') };
                const d = (r.data ?? {});
                const candidate = d.items ?? d.list ?? d.videos ?? d.data ?? d.feed;
                const arr = Array.isArray(candidate) ? candidate : [];
                const items = arr.slice(0, 10).map((x) => {
                    const o = (x ?? {});
                    return {
                        bvid: String(o.bvid ?? o.bv ?? ''),
                        title: String(o.title ?? o.name ?? ''),
                    };
                }).filter((x) => x.title !== '');
                if (!items.length) {
                    return { ok: false, error: '拿到数据了但解析不出标题（bili 版本可能变了，用搜索代替）' };
                }
                return { ok: true, items };
            }
            // ── 评论：要 BV 号 ──
            if (want === 'comments') {
                const bv = String(a.bvid ?? '').trim();
                if (!bv)
                    return { ok: false, error: '看评论需要 bvid' };
                const r = run(['comment', 'list', bv]);
                if (r.ok === false)
                    return { ok: false, error: biliFailure(r, '拉评论') };
                const d = (r.data ?? {});
                const src = d.items ?? d.comments ?? d.list ?? d.data;
                const arr = Array.isArray(src) ? src : [];
                const comments = arr.slice(0, 20).map((x) => {
                    const o = (x ?? {});
                    // 实测 bili 1.2.1 的字段是 user:{name}，不是 uname
                    const u = o.user;
                    const author = o.author;
                    return {
                        user: String(u?.name ?? author?.name ?? o.uname ?? ''),
                        text: String(o.content ?? o.message ?? o.text ?? ''),
                        likes: Number(o.like ?? o.likes ?? 0) || 0,
                    };
                }).filter((x) => x.text !== '');
                if (!comments.length)
                    return { ok: false, error: '没拿到评论（可能没有评论，或者没登录 B 站）' };
                return { ok: true, comments };
            }
            // 没给 BV → 搜索
            if (!a.bvid) {
                const q = String(a.query ?? '').trim();
                if (!q)
                    return { ok: false, error: '需要 bvid 或 query' };
                const r = run(['search', 'video', q]);
                // 关键：工具坏了和搜不到是两回事。
                // 原来一律返回 undefined → "没查到" → 模型自己编内容。
                if (r.ok === false)
                    return { ok: false, error: biliFailure(r, '搜索') };
                const d = (r.data ?? {});
                const items = (d.items ?? []).slice(0, 5)
                    .filter((x) => x.bvid && x.title)
                    .map((x) => ({ bvid: x.bvid, title: x.title }));
                if (!items.length)
                    return { ok: false, error: '没搜到相关内容（换个关键词试试，别硬编）' };
                return { ok: true, items };
            }
            const bvid = String(a.bvid).trim();
            const page = Math.max(1, Number(a.page) || 1);
            const mode = (['subtitle', 'danmaku', 'frames', 'all'].includes(String(a.want))
                ? String(a.want) : 'summary');
            const info = run(['video', 'info', bvid]);
            // info 是最基础的一步，它失败说明视频不存在 / 需要登录 / bili 没装 ——
            // 继续查字幕弹幕都是白费，而且最后只会得到"视频信息拿不到"这种含糊答案。
            if (info.ok === false) {
                return { ok: false, error: biliFailure(info, '查视频') };
            }
            const idata = (info?.data ?? {});
            const title = idata.title ?? '';
            const pages = (idata.pages ?? [])
                .filter((p) => (p.page ?? 0) > 0)
                .map((p) => ({
                page: Number(p.page) || 0,
                title: String(p.title ?? '').trim() || `P${p.page}`,
                length: mmss(Number(p.duration) || 0),
            }));
            const isCollection = pages.length > 1;
            const out = { ok: true };
            if (title)
                out.title = title;
            if (isCollection) {
                out.pages = pages;
                out.page = page;
            }
            // ── all：优先走 `bili video watch`（一次拿全）──
            //
            // 实测同一视频：watch 6.4s，原来逐项（summary+subtitle+danmaku+frames）25.7s。
            // 但它的 transcript 是**纯文本、没有时间轴**（官方路径的老问题），
            // 所以拿完 watch 还要单独补一次 subtitle —— 总计仍快得多，
            // 而且白拿章节、热评和画面总览图（这三项本地原来没有）。
            if (mode === 'all') {
                const w = run(['video', 'watch', bvid, '-p', String(page), '--frames', '6', '--comments', '5'], 120_000);
                if (w.ok !== false) {
                    const d = (w.data ?? {});
                    const desc = String(d.desc ?? '').trim();
                    if (desc)
                        out.desc = desc.slice(0, 400);
                    // ai_summary 是字符串被逐字符拆成 {0:'华',1:'为',…} —— 拼回来
                    const rawSum = d.ai_summary;
                    let sumText = '';
                    if (typeof rawSum === 'string')
                        sumText = rawSum;
                    else if (rawSum !== null && typeof rawSum === 'object') {
                        sumText = Object.values(rawSum).map(String).join('');
                    }
                    if (sumText.trim() !== '')
                        out.summary = sumText.trim();
                    const chs = Array.isArray(d.chapters) ? d.chapters : [];
                    const chapters = chs.slice(0, 20).map((c) => ({
                        title: String(c.title ?? c.name ?? ''),
                        start: mmss(Number(c.start ?? c.time ?? 0) || 0),
                    })).filter((c) => c.title !== '');
                    if (chapters.length)
                        out.chapters = chapters;
                    const hc = Array.isArray(d.hot_comments) ? d.hot_comments : [];
                    const hot = hc.slice(0, 8).map((c) => ({
                        user: String(c.user ?? c.uname ?? ''),
                        text: String(c.content ?? c.message ?? ''),
                        likes: Number(c.like ?? c.likes ?? 0) || 0,
                    })).filter((c) => c.text !== '');
                    if (hot.length)
                        out.comments = hot;
                    const dmp = (d.danmaku ?? {}).peaks ?? [];
                    const peaks = dmp.slice(0, 5).map((p) => ({
                        t: mmss(Number(p.time ?? 0) || 0),
                        count: Number(p.count ?? 0) || 0,
                        top: Array.isArray(p.top) ? p.top.slice(0, 3).map(String) : [],
                    })).filter((p) => p.count > 0);
                    if (peaks.length)
                        out.danmakuPeaks = peaks;
                    const sheet = String(d.frames_sheet ?? '');
                    if (sheet)
                        out.framesSheet = sheet;
                    // 字幕时间轴：watch 有文本但没时间轴，单独补一次（只为这个才多跑一条命令）
                    const trText = String(d.transcript?.text ?? '');
                    if (trText.trim() !== '') {
                        const sr = run(['video', 'subtitle', bvid, '-p', String(page)]);
                        const sitems = (sr.data ?? {}).items ?? [];
                        const packed = condenseSubtitlesByMinute(sitems);
                        if (packed.length)
                            out.subtitleOutline = packed;
                    }
                    const got = out.summary || out.subtitleOutline || out.comments || out.danmakuPeaks
                        || out.framesSheet || out.chapters;
                    if (got || isCollection)
                        return out;
                }
                // watch 失败或没拿到内容 → 落到下面逐项取，宁可慢也别没有
            }
            // AI 总结 + 分段提纲
            let summary = '';
            let outline = [];
            if (mode === 'summary' || mode === 'all') {
                const r = run(['video', 'summary', bvid, '--page', String(page)]);
                const data = (r?.data ?? {});
                summary = data.summary ?? '';
                outline = (data.outline ?? [])
                    .filter((sec) => (sec.points?.length ?? 0) > 0)
                    .map((sec) => ({
                    title: String(sec.title ?? ''),
                    start: mmss(Number(sec.start) || 0),
                    points: (sec.points ?? []).map((pt) => ({
                        t: mmss(Number(pt.time) || 0),
                        text: String(pt.content ?? ''),
                    })),
                }));
                if (summary)
                    out.summary = summary;
                if (outline.length)
                    out.outline = outline;
            }
            // 字幕：**必须用 subtitle 而不是 watch**
            // watch 的 transcript 是 {source, text} —— 时间轴被压平了，
            // 正是用户抱怨的"整段倒出来"。带时间轴的只有 subtitle（不带 --text）。
            if (mode === 'subtitle' || mode === 'all') {
                const r = run(['video', 'subtitle', bvid, '-p', String(page)]);
                const items = (r.data ?? {}).items ?? [];
                const packed = condenseSubtitlesByMinute(items);
                if (packed.length)
                    out.subtitleOutline = packed;
                else if (r.ok === false) {
                    // 分清楚三种情况 —— 一刀切"拿不到"会让模型以为要换关键词重搜，
                    // 实际可能是"这视频本来就没字幕"或"没登录"。
                    const code = String(r.error?.code ?? '');
                    const msg = String(r.error?.message ?? '');
                    // 注意 bili 的措辞是「没有可用字幕」/「该视频没有 AI 总结」，
                    // 中间会插字，所以正则要允许间隔，不能写死「没有字幕」
                    if (/没有.{0,4}字幕|无字幕|字幕不存在/i.test(code + msg)) {
                        out.biliError = '这个视频没有字幕（不是查询失败，换个信息源或直接看简介）';
                    }
                    else if (/auth|login|credential|未登录|登录/i.test(code + msg)) {
                        out.biliError = '没登录 B 站，字幕拿不到（其他信息还能用）';
                    }
                    else {
                        out.biliError = `字幕拿不到：${code || '未知'}${msg ? ` - ${msg}` : ''}`;
                    }
                }
            }
            if (mode === 'danmaku' || mode === 'all') {
                try {
                    const pk = run(['video', 'danmaku', bvid, '--peaks', '5', '-p', String(page)]);
                    const pdata = (pk?.data ?? {});
                    const peaks = (pdata.peaks ?? [])
                        .filter((x) => (x.count ?? 0) > 0)
                        .slice(0, 5)
                        .map((x) => ({
                        t: mmss(Number(x.time) || 0),
                        count: Number(x.count) || 0,
                        top: (x.top ?? []).slice(0, 3).map(String),
                    }));
                    if (peaks.length)
                        out.danmakuPeaks = peaks;
                }
                catch { /* peaks 拿不到不影响主流程 */ }
                const r = run(['video', 'danmaku', bvid, '-p', String(page)]);
                const items = (r?.data ?? {}).items ?? [];
                const dm = items.filter((x) => x.text).slice(0, 30)
                    .map((x) => ({ t: mmss(Number(x.time) || 0), text: String(x.text) }));
                if (dm.length)
                    out.danmaku = dm;
            }
            if (mode === 'frames' || mode === 'all') {
                const r = run(['video', 'frames', bvid, '-n', '6', '-p', String(page)]);
                const items = (r?.data ?? {}).frames ?? [];
                const fr = items.filter((x) => x.path)
                    .map((x) => ({ t: mmss(Number(x.time) || 0), path: String(x.path) }));
                if (fr.length)
                    out.frames = fr;
            }
            const hasContent = out.summary || out.subtitleOutline || out.danmaku || out.danmakuPeaks || out.frames
                || out.comments || out.items || out.chapters || out.framesSheet;
            if (!hasContent) {
                // 合集只给目录也算成功（用户接下来要挑 P）
                if (isCollection)
                    return out;
                // 有具体原因就带上（没字幕 / 没登录），别让模型自己猜
                if (out.biliError)
                    return { ...out, ok: false };
                return { ok: false, error: '视频信息拿不到' };
            }
            return out;
        },
    });
    logger.info(`im-qqbot: B 站工具已注册（qq_bili_check，共 ${registered.size} 个）`);
}
//# sourceMappingURL=tools.js.map