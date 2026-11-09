import { describeEmotion } from "./emotion.js";
import { NgaClient, NgaError, formatNgaTime, loadCredentials, defaultNgaDir, KNOWN_FORUMS } from "./nga.js";
import { genQrSession, pollQrSession, renderQrBuffer, saveCredentials, } from "./nga-capture.js";
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
/**
 * 进程内的扫码会话表 —— 工具与面板**共用这一张**。
 *
 * 共用是刻意的：她在聊天里生成的那张二维码，主人扫完之后，
 * 面板那边轮询也能同一个 key 拿到结果；反之亦然。
 * 分成两张表会导致"面板说没生成过、但其实她发过"。
 */
const qrSessions = new Map();
/** NGA 的 qrkey 约 2-3 分钟失效；取 120 秒并在本地也判一次，别让人对着死码干等 */
const QR_TTL_SEC = 120;
/** 记一次会话（键固定为 owner：目前只有主人在扫码） */
export function rememberQrSession(session, key = 'owner') {
    qrSessions.set(key, session);
}
/** 取会话（面板/工具轮询用） */
export function currentQrSession(key = 'owner') {
    return qrSessions.get(key);
}
/** 清会话（成功或过期后调） */
export function forgetQrSession(key = 'owner') {
    qrSessions.delete(key);
}
export { pollQrSession, saveCredentials, QR_TTL_SEC };
/**
 * NGA 现在是不是登录态。
 *
 * 单独抽出来是因为它要在两处用（搜索分支 + 工具描述），而且**判据必须是磁盘**
 * 而不是内存快照：用户刚扫完码落盘，这个 client 实例的 credentials 还是旧的。
 */
function ngaAuthenticated() {
    return loadCredentials() !== undefined;
}
/** 把可选数字参数夹到 [min, max]，undefined/NaN 走默认值 */
function clampInt(v, dflt, min, max) {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n))
        return dflt;
    return Math.min(max, Math.max(min, n));
}
export function registerPersonaTools(ctx, persona, findByAgent, logger, 
/** 可选：注入 NGA 客户端（测试用；生产留空即按配置自建） */
ngaClient) {
    const tools = ctx.get('tools');
    // 自动统计注册数量，避免日志里的数字靠手写（写死过一次 15，加到 17 就过期了）
    const registered = new Set();
    const reg = (def) => {
        if (typeof def?.name === 'string')
            registered.add(def.name);
        tools?.register(def);
    };
    // NGA：懒建一次，凭证从磁盘读（没有就是游客态，功能照样可用）
    const nga = ngaClient ?? new NgaClient({ credentials: loadCredentials() });
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，persona 工具未注册');
        return;
    }
    reg({
        name: 'qq_write_diary',
        description: '写一条你自己的日记（关于你这一天，不是关于对方的事——那用 qq_memory_append）。'
            + '第一人称、口语、短句，1~4 句。不要总结升华，不要"今天真是充实的一天"。',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '日记正文' },
                mood: { type: 'string', description: '心情（一两个词，如"踏实"/"有点闷"）' },
                title: { type: 'string', description: '可选：一句话标题' },
                tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
            },
            required: ['text'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: { day: { type: 'string' }, time: { type: 'string' } },
                required: ['day', 'time'],
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: `已写日记 ${v.day} ${v.time}` }];
            },
        },
        async execute(args) {
            const { text, mood, title, tags } = args;
            const row = persona.diary.add({ text, mood, title, tags });
            logger.info(`persona: 日记一条 ${row.day} ${row.time}`);
            return { day: row.day, time: row.time };
        },
    });
    reg({
        name: 'qq_read_diary',
        description: '翻你自己的日记。不传参数返回最近 5 条；传 day（YYYY-MM-DD）返回那天全部。',
        parameters: {
            type: 'object',
            properties: {
                n: { type: 'number', description: '最近几条（默认 5，上限 20）' },
                day: { type: 'string', description: '某天 YYYY-MM-DD' },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    count: { type: 'number' },
                    entries: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                day: { type: 'string' },
                                time: { type: 'string' },
                                mood: { type: 'string' },
                                title: { type: 'string' },
                                text: { type: 'string' },
                            },
                            additionalProperties: false,
                        },
                    },
                    stats: {
                        type: 'object',
                        additionalProperties: true,
                    },
                },
                required: ['count', 'entries'],
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                const head = `共 ${v.count} 条日记`;
                const lines = v.entries.slice(0, 5).map((e) => `${e.day} ${e.time} ${e.text.slice(0, 40)}`);
                return [{ type: 'text', text: [head, ...lines].join('\n') }];
            },
        },
        async execute(args) {
            const { n, day } = args;
            // 审查加固：n 夹到 [1,20]，避免负数/异常值
            const count = Math.max(1, Math.min(Math.floor(Number(n) || 5), 20));
            const rows = day ? persona.diary.day(day) : persona.diary.recent(count);
            return {
                count: rows.length,
                entries: rows.map((r) => ({
                    day: r.day, time: r.time, mood: r.mood, title: r.title, text: r.text,
                })),
                stats: persona.diary.stats(),
            };
        },
    });
    reg({
        name: 'qq_memory_append',
        description: '往某个人的账上记一笔。trait=他的习惯性格，fact=他告诉过你的事实，'
            + 'topic=聊过的话题，pending=你想说但还没说的话（会过期，别攒太多）。'
            + '想起来什么就顺手记，别在聊天里宣布"我记下了"。',
        parameters: {
            type: 'object',
            properties: {
                kind: { type: 'string', enum: ['trait', 'fact', 'topic', 'pending'], description: '记哪一栏' },
                content: { type: 'string', description: '内容（一句话，≤160字）' },
                person: {
                    type: 'string',
                    description: '对象 openid；省略 = 当前说话的人。群聊里想记某个群友就传他的 openid。',
                },
                name: { type: 'string', description: '顺手更新对方昵称（可选）' },
            },
            required: ['kind', 'content'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok'],
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: v.ok ? '已记下。' : '未记录' }];
            },
        },
        async execute(args, exec) {
            const { kind, content, person, name } = args;
            let key = person;
            if (!key) {
                const record = exec.agent !== undefined ? findByAgent(exec.agent) : undefined;
                if (!record)
                    throw new Error('qq_memory_append: 无法确定当前对话对象，请显式传 person');
                key = record.senderId;
            }
            persona.memory.remember(key, { [kind]: content, name });
            return { ok: true };
        },
    });
    // ── 称呼表态：她可以接受或拒绝一个称呼（"喜欢了才接受"）──
    reg({
        name: 'qq_decide_name',
        description: '决定接不接受别人对你的某个叫法。用户用新称呼叫过你几次之后，你来表态：'
            + '喜欢就接受（以后被这么叫就会应），不喜欢就拒绝（以后不当成在叫你）。按你自己的喜好来。',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: '要表态的称呼' },
                accept: { type: 'boolean', description: 'true=接受，false=拒绝' },
                reason: { type: 'string', description: '可选：你的理由' },
            },
            required: ['name', 'accept'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    activeNames: { type: 'array', items: { type: 'string' } },
                    // M33：把"还在等她表态的候选"一并回给模型 ——
                    // 否则她拒绝/接受完这个名字之后，依然不知道还有哪些在等
                    pendingNames: { type: 'array', items: { type: 'string' } },
                },
                required: ['ok', 'activeNames', 'pendingNames'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                if (!r.ok)
                    return [{ type: 'text', text: '表态失败' }];
                const pend = (r.pendingNames ?? []).filter(Boolean);
                const tail = pend.length ? `\n还在等你表态：${pend.join('、')}` : '';
                return [{ type: 'text', text: `能叫醒你的称呼：${r.activeNames.join('、') || '（无）'}${tail}` }];
            },
        },
        async execute(args) {
            const a = args;
            const ok = a.accept ? persona.self.acceptName(a.name, 0.6) : persona.self.rejectName(a.name);
            if (ok)
                logger.info(`persona: 称呼「${a.name}」→ ${a.accept ? '接受' : '拒绝'}`);
            return {
                ok,
                activeNames: persona.self.activeNames(),
                pendingNames: persona.self.pendingNames().map((p) => p.name),
            };
        },
    });
    // ── 兴趣记录：她可以主动记下自己关注的话题 ──
    reg({
        name: 'qq_mark_interest',
        description: '记下你自己最近关注/感兴趣的话题，或者你**讨厌/不想聊**的话题（polarity=dislike）。'
            + '感兴趣的记过以后更容易让你主动接话；讨厌的会让这类话更难让你开口；不记就慢慢淡忘。',
        parameters: {
            type: 'object',
            properties: {
                topic: { type: 'string', description: '话题，如"游戏 新作"' },
                note: { type: 'string', description: '可选：为什么感兴趣' },
                polarity: {
                    type: 'string',
                    enum: ['like', 'dislike'],
                    description: '可选：like=感兴趣（默认），dislike=讨厌/不想聊',
                },
            },
            required: ['topic'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    polarity: { type: 'string', enum: ['like', 'dislike'] },
                    topics: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { topic: { type: 'string' }, weight: { type: 'number' } },
                            required: ['topic', 'weight'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['ok', 'topics'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                return [{ type: 'text', text: r.ok ? `现在的兴趣：${r.topics.map((t) => t.topic).join('、') || '（无）'}` : '记录失败' }];
            },
        },
        async execute(args) {
            const a = args;
            if (a.polarity === 'dislike') {
                // M30：讨厌走另一列（dislikes），因为在 interests 里加负权重会被饱和强化公式吃掉
                persona.self.recordDislike(a.topic);
                logger.info(`persona: 记下厌恶「${a.topic}」`);
                return {
                    ok: true,
                    polarity: 'dislike',
                    topics: persona.self.topDislikes(6).map((i) => ({ topic: i.topic, weight: i.strength ?? i.weight })),
                };
            }
            persona.self.touchInterest(a.topic);
            if (a.note)
                persona.self.addFinding(a.topic, a.note);
            return {
                ok: true,
                polarity: 'like',
                topics: persona.self.topInterests(6).map((i) => ({ topic: i.topic, weight: i.weight })),
            };
        },
    });
    // ── 提需求：她想要个新功能，可以提给用户 ──
    reg({
        name: 'qq_raise_wish',
        description: '你想到一个自己想要、但需要用户帮忙实现的功能时用它提出来。每周最多 2 条，别滥用。'
            + '被拒绝的需求，一个月后可以再提一次。',
        parameters: {
            type: 'object',
            properties: {
                wish: { type: 'string', description: '你想要什么（一句话）' },
                why: { type: 'string', description: '为什么想要（一句话）' },
            },
            required: ['wish', 'why'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    id: { type: 'string' },
                    reason: { type: 'string' },
                    raisedThisWeek: { type: 'integer' },
                },
                required: ['ok', 'id', 'raisedThisWeek'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                return [{ type: 'text', text: r.ok ? '需求已提交。' : `没提成：${r.reason ?? '未知'}` }];
            },
        },
        async execute(args) {
            const a = args;
            const weekAgo = Date.now() - 7 * 24 * 3600_000;
            const raisedThisWeek = persona.self.wishesRaisedSince(weekAgo);
            if (raisedThisWeek >= 2) {
                return { ok: false, id: '', reason: '本周已经提过 2 条了，下周再说', raisedThisWeek };
            }
            const req = persona.self.raiseWish(a.wish, a.why);
            logger.info(`persona: 提出需求「${a.wish}」`);
            return { ok: true, id: req.id, raisedThisWeek: raisedThisWeek + 1 };
        },
    });
    // ── 回应需求：用户接受/拒绝时记录 ──
    reg({
        name: 'qq_answer_wish',
        description: '用户对你的需求表态后，用它记录：接受（会做）还是拒绝（不做）。被拒的一个月后可再提。',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '需求 id' },
                accept: { type: 'boolean', description: 'true=接受，false=拒绝' },
            },
            required: ['id', 'accept'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, status: { type: 'string' } },
                required: ['ok', 'status'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                return [{ type: 'text', text: r.ok ? `已记录：${r.status}` : '记录失败（找不到该需求）' }];
            },
        },
        async execute(args) {
            const a = args;
            const ok = a.accept ? persona.self.acceptWish(a.id) : persona.self.rejectWish(a.id);
            return { ok, status: a.accept ? 'accepted' : 'rejected' };
        },
    });
    // ── 查需求 ──
    reg({
        name: 'qq_list_wishes',
        description: '查看你提过的需求及其状态。',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        output: {
            schema: {
                type: 'object',
                properties: {
                    wishes: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                wish: { type: 'string' },
                                status: { type: 'string' },
                                raisable: { type: 'boolean' },
                            },
                            required: ['id', 'wish', 'status', 'raisable'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['wishes'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                if (r.wishes.length === 0)
                    return [{ type: 'text', text: '还没提过需求。' }];
                return [{ type: 'text', text: r.wishes.map((w) => `· ${w.wish}（${w.status}）${w.raisable ? '可提' : ''}`).join('\n') }];
            },
        },
        async execute() {
            const raisable = new Set(persona.self.raisableWishes(Date.now()).map((w) => w.id));
            return {
                wishes: persona.self.allWishes().map((w) => ({
                    id: w.id,
                    wish: w.wish,
                    status: w.status,
                    raisable: raisable.has(w.id),
                })),
            };
        },
    });
    // ── 口癖表态：她可以接受或拒绝学到的新口头禅 ──
    reg({
        name: 'qq_decide_voice',
        description: '系统从你被接住的话里提炼出一些说话习惯，你来表态接不接受。'
            + '喜欢的就接受（以后聊天会自然带上），不像你的就拒绝。',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '口癖 id（从 qq_list_voice 查）' },
                accept: { type: 'boolean', description: 'true=接受，false=拒绝' },
            },
            required: ['id', 'accept'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, activeCount: { type: 'integer' } },
                required: ['ok', 'activeCount'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                return [{ type: 'text', text: r.ok ? `已记录，现有 ${r.activeCount} 条口癖` : '记录失败' }];
            },
        },
        async execute(args) {
            const a = args;
            const ok = persona.voice.decideHabit(a.id, a.accept);
            return { ok, activeCount: persona.voice.activeHabits().length };
        },
    });
    // ── 查看口癖 ──
    reg({
        name: 'qq_list_voice',
        description: '查看你当前的说话习惯（候选/生效中）。',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        output: {
            schema: {
                type: 'object',
                properties: {
                    habits: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                situation: { type: 'string' },
                                style: { type: 'string' },
                                state: { type: 'string' },
                                count: { type: 'integer' },
                            },
                            required: ['id', 'situation', 'style', 'state', 'count'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['habits'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                if (r.habits.length === 0)
                    return [{ type: 'text', text: '还没有形成说话习惯。' }];
                return [{ type: 'text', text: r.habits.map((h) => `· [${h.state}] 当"${h.situation}"时用"${h.style}"（${h.count}次）`).join('\n') }];
            },
        },
        async execute() {
            return {
                habits: persona.voice.snapshot().habits.map((h) => ({
                    id: h.id,
                    situation: h.situation,
                    style: h.style,
                    state: h.state,
                    count: h.count,
                })),
            };
        },
    });
    // ── 自我叙述（L4 selfNote）：她写对自己的认识 ──
    reg({
        name: 'qq_write_self_note',
        description: '写一条"对自己的认识"——不是记别人，是记你自己是个什么样的人、最近变了什么。'
            + '只在真的想清楚时写，别凑数。有字数上限（约240字），旧的自然会归档。'
            + '和 qq_write_diary 的区别：日记记"我今天经历了什么"，这个记"我是谁"。',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '一条自我叙述（8~240 字，第一人称，具体不空泛）' },
                trigger: { type: 'string', description: '可选：什么触发了这条（自由时间/聊天/日记）' },
            },
            required: ['text'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    count: { type: 'integer', description: '当前保留几条' },
                    chars: { type: 'integer', description: '当前总字数' },
                },
                required: ['ok', 'count', 'chars'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                return [{ type: 'text', text: r.ok ? `已写下（现在 ${r.count} 条 / ${r.chars} 字）` : '没写成（太长或与已有的重复）' }];
            },
        },
        async execute(args) {
            const a = args;
            const ok = persona.selfNote.write(a.text, a.trigger ?? 'chat');
            const st = persona.selfNote.stats();
            if (ok)
                logger.info('persona: 写了一条自我叙述');
            return { ok, count: st.count, chars: st.chars };
        },
    });
    // ── 读自我叙述 ──
    reg({
        name: 'qq_read_self_note',
        description: '看看你对自己现在的认识（有归档的旧版）。',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        output: {
            schema: {
                type: 'object',
                properties: {
                    current: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { text: { type: 'string' }, at: { type: 'integer' } },
                            required: ['text', 'at'],
                            additionalProperties: false,
                        },
                    },
                    archivedCount: { type: 'integer' },
                },
                required: ['current', 'archivedCount'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                if (r.current.length === 0)
                    return [{ type: 'text', text: '还没写过对自己的认识。' }];
                return [{ type: 'text', text: r.current.map((n) => `· ${n.text}`).join('\n') + `\n（另有 ${r.archivedCount} 条旧版已归档）` }];
            },
        },
        async execute() {
            const snap = persona.selfNote.snapshot();
            return {
                current: snap.current.map((n) => ({ text: n.text, at: n.at })),
                archivedCount: snap.archived.length,
            };
        },
    });
    /**
     * qq_browse —— 让她**真的**去网上看看。
     *
     * 为什么必须做成工具（真实事故 2026-11-01）：
     *   用户说「你可以开浏览器再去逛逛」，她答「让人去贴吧微博转了」，
     *   随后**编出了具体内容**（"散文吧有篇《修鞋摊子收起来了》…"）。
     *   根因：surf.ts 只在凌晨 3-7 点定时跑，**没有"我现在去看看"的工具**，
     *   于是她只能凭想象描述"网上有什么"。编造具体文章比不答更糟。
     */
    reg({
        name: 'qq_browse',
        description: '真的去网上看看（用 Bing 搜索 + 抓正文）。'
            + '想聊"最近网上在说什么""贴吧/微博有人讨论什么"时先用它，别凭印象编。'
            + '返回标题/链接/摘要；查不到就说查不到。',
        parameters: {
            type: 'object',
            properties: {
                topic: { type: 'string', description: '想了解的话题或关键词' },
                deep: { type: 'boolean', description: '是否抓正文（更准但更慢，默认 false）' },
            },
            required: ['topic'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    topic: { type: 'string' },
                    findings: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string' },
                                url: { type: 'string' },
                                summary: { type: 'string' },
                            },
                            required: ['title', 'url', 'summary'],
                            additionalProperties: false,
                        },
                    },
                    ok: { type: 'boolean' },
                },
                required: ['topic', 'findings', 'ok'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                if (!r.ok || r.findings.length === 0) {
                    return [{ type: 'text', text: `「${r.topic}」没查到东西（网络或引擎问题）。` }];
                }
                const lines = r.findings.map((f, i) => `${i + 1}. ${f.title}\n   ${f.url}\n   ${f.summary}`);
                return [{ type: 'text', text: `「${r.topic}」查到 ${r.findings.length} 条：\n${lines.join('\n')}` }];
            },
        },
        async execute(args) {
            const { topic, deep } = args;
            try {
                // surf 现在是 async（内部优先走宿主 web 搜索，见 surf.ts 的断词坑说明）
                const r = await persona.surf?.(topic, { deep: deep === true });
                if (!r || r.findings.length === 0)
                    return { topic, findings: [], ok: false };
                return {
                    topic,
                    ok: true,
                    // 只回摘要，不把原始 HTML 塞进上下文
                    findings: r.findings.slice(0, 5),
                };
            }
            catch (err) {
                logger.warn(`persona: qq_browse 失败 ${err instanceof Error ? err.message : String(err)}`);
                return { topic, findings: [], ok: false };
            }
        },
    });
    /**
     * qq_note_watched —— 记下"我看了什么、当时怎么想"(M37)。
     *
     * ## 为什么要单独一个工具，而不是让她调 MCP 记
     *
     * MCP 的 `watch_video` 只返回内容，不写她的记忆。
     * 而"我看过并觉得xxx"是**她自己的经历**，得落在 self.json 里，
     * 下次才能在提示里出现。
     *
     * ## 为什么一条只写一句 note
     *
     * 写得长就变成观后感作业。人回忆"那个视频怎么样"时是一句话，
     * 不是三段分析。所以 note 限 120 字，可以完全不填。
     */
    reg({
        name: 'qq_note_watched',
        description: '记下你刚看过的东西：标题 + 一句自己的话（讲了什么、什么感觉，都可以）。'
            + '不用写观后感，一句话就行；也可以只记标题不写感受。'
            + '下次你会记得自己看过它 —— 而不是每次被问到都现编。',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '看的什么，如《华为配置专题03 DHCP VLAN配置》' },
                ref: { type: 'string', description: '可选：BV 号之类的标识，用来去重' },
                note: { type: 'string', description: '可选：一句你自己的话（≤120 字）' },
                done: { type: 'boolean', description: '可选：看完了吗（从中间跳进去的可以填 false）' },
            },
            required: ['title'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    total: { type: 'number' },
                    error: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                return [{
                        type: 'text',
                        text: r.ok ? `记下了（你最近看过 ${r.total ?? '?'} 个）` : `没记成（${r.error ?? '未知'}）`,
                    }];
            },
        },
        async execute(args) {
            const a = args;
            const title = String(a.title ?? '').trim();
            if (!title)
                return { ok: false, error: '标题不能空' };
            try {
                persona.self.addWatching({
                    title,
                    ...(a.ref ? { ref: String(a.ref) } : {}),
                    ...(a.note ? { note: String(a.note) } : {}),
                    ...(a.done === true ? { done: true } : {}),
                });
                return { ok: true, total: persona.self.recentWatching(99).length };
            }
            catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
    });
    /**
     * qq_nga —— 去 NGA（艾泽拉斯国家地理 / bbs.nga.cn）看看。
     *
     * ## 为什么做成工具，而不是再挂一个 NGA MCP
     *
     * 2026-11-08 实测调研：GitHub 上只有两个沾边的，
     *   - `yixiaowang2001/nga-mcp-server`（8★）走 playwright + chromium，
     *     容器里没装，还会另起一个浏览器进程；
     *   - `beckyeeky/nga-hub-skill`（0★）要登录后的 ngaPassportCid 才能用。
     * 而 NGA 的 JSON 接口裸 fetch 就能打（见 `nga.ts` 的三条实测）。
     * 她本来就有 ego 浏览器与 bash，再塞一份 Playwright 是纯负担。
     *
     * ## 为什么只有「列版面 / 读帖子」两个动作
     *
     * 游客态能做的只有这两个（`app_api.php` 的 `post/list` 与 `subject/list`）。
     * 搜索接口 `__lib=search` 在游客态返回 `ACTION NOT FOUND`——**不是权限不够，是动作不存在**。
     * 与其给她一个"看起来能用、永远返回空"的 search，不如不给：
     * 她要是因此编出"NGA 上有人说……"，比老实说"搜不了"糟得多。
     * 发帖/回帖同理：那属于动用户账号，得走明确的同意，不能藏在一个工具里。
     */
    reg({
        name: 'qq_nga',
        description: '去 NGA（艾泽拉斯国家地理，bbs.nga.cn）看看。三种用法（**都要传对应的 id，别空着调**）：'
            + '① action=list **必须带 fid** 列某个版面的最新主题（"这版今天在聊什么"）；'
            + '② action=read **必须带 tid** 读帖子的正文和回复（要看完整内容时）；'
            + '③ action=search **必须带 keyword** 站内搜帖子（"有没有人聊过 X"）。'
            + '\n'
            + '**【重要】list 不带 fid 会直接报错，不会"列出所有版面"。**'
            + '这个工具没有"版面目录"功能 —— 想认识 NGA 有哪些版，就用 qq_browse 搜'
            + '"NGA 版面 fid 列表"，或者直接问主人某类话题在哪个版。'
            + '\n'
            + '搜索：传 fid 就在那个版面里搜（又快又准），不传 fid 才是全站（覆盖广但噪音大）。'
            + '搜索**需要登录**；游客态只能 list/read，搜不了，会明确告诉你没登录 ——'
            + '那时候你可以用 qq_nga_login 请主人扫一次码。'
            + '\n'
            + '常用 fid：魔兽世界艾泽拉斯议事厅=7、消费电子IT新闻=436、炉石狂野模式=621、'
            + '团队管理=255。不确定 fid 对不对，先 list 试一次看是不是想看的那个版面。'
            + '\n'
            + '**只能读**：不能发帖、不能回帖、不能点赞。'
            + '查不到就如实说查不到，不要凭印象编"论坛上有人说"。',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'read', 'search'], description: 'list=列版面主题（需 fid）；read=读一个帖子（需 tid）；search=站内搜帖子（需 keyword）' },
                keyword: { type: 'string', description: 'search 用：搜什么词' },
                withContent: { type: 'boolean', description: 'search 用：是否搜正文（默认 true；false 只搜标题更快但会漏）' },
                searchPost: { type: 'boolean', description: 'search 用：搜回复而不是主题（想找"评论区里提到过的"时用）' },
                fid: { type: 'number', description: 'list 必填 / search 选填：版面 id（艾泽拉斯议事厅=7、消费电子IT新闻=436）' },
                tid: { type: 'number', description: 'read 用：帖子 id（tid，从链接 read.php?tid=xxx 里拿）' },
                page: { type: 'number', description: '可选：第几页，默认 1' },
                limit: { type: 'number', description: '可选：list 最多返回几条主题（默认 10）；read 最多返回几层楼（默认 8）' },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    action: { type: 'string' },
                    error: { type: 'string' },
                    // ── list 的实际结果 ──
                    forumName: { type: 'string' },
                    totalPage: { type: 'number' },
                    topics: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                tid: { type: 'number' },
                                subject: { type: 'string' },
                                author: { type: 'string' },
                                replies: { type: 'number' },
                                lastAt: { type: 'string' },
                            },
                            required: ['tid', 'subject', 'author', 'replies', 'lastAt'],
                            additionalProperties: false,
                        },
                    },
                    // ── search 的实际结果 ──
                    keyword: { type: 'string' },
                    scope: {
                        type: 'object',
                        properties: { kind: { type: 'string' }, fid: { type: 'number' }, fidGroup: { type: 'string' }, author: { type: 'string' } },
                        required: ['kind'],
                        additionalProperties: false,
                    },
                    needLogin: { type: 'boolean' },
                    // ── "list 没给 fid" 时返回的内置版面表 ──
                    forums: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { fid: { type: 'number' }, name: { type: 'string' }, about: { type: 'string' } },
                            required: ['fid', 'name', 'about'],
                            additionalProperties: false,
                        },
                    },
                    note: { type: 'string' },
                    // ── read 的实际结果 ──
                    subject: { type: 'string' },
                    totalFloors: { type: 'number' },
                    floors: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                author: { type: 'string' },
                                at: { type: 'string' },
                                content: { type: 'string' },
                                comments: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            author: { type: 'string' },
                                            content: { type: 'string' },
                                        },
                                        required: ['author', 'content'],
                                        additionalProperties: false,
                                    },
                                },
                            },
                            required: ['author', 'at', 'content', 'comments'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['ok', 'action'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                if (!r.ok) {
                    const hint = r.needLogin === true
                        ? '\n（你可以用 qq_nga_login 请主人扫码登录）'
                        : '';
                    return [{ type: 'text', text: `NGA 没看成：${r.error ?? '未知原因'}${hint}` }];
                }
                if (r.forums !== undefined) {
                    const fr = r;
                    const lines = fr.forums.map((f, i) => `${i + 1}. ${f.name}（fid=${f.fid}）—— ${f.about}`);
                    return [{ type: 'text', text: `常用版面：\n${lines.join('\n')}\n\n${fr.note ?? ''}` }];
                }
                if (r.action === 'search') {
                    const sr = r;
                    const where = sr.scope.kind === 'forum' ? `版 ${sr.scope.fid}`
                        : sr.scope.kind === 'author' ? `作者 ${sr.scope.author}`
                            : sr.scope.kind === 'fidGroup' ? `版面组 ${sr.scope.fidGroup}`
                                : '全站';
                    const lines = (sr.topics ?? []).map((t, i) => `${i + 1}. [tid=${t.tid}] ${t.subject} —— ${t.author}（${t.replies} 回，${t.lastAt}）`);
                    const head = `「${sr.keyword}」在${where}搜到 ${lines.length} 条（共约 ${sr.totalPage} 页）`;
                    return [{ type: 'text', text: lines.length > 0 ? `${head}\n${lines.join('\n')}` : `${head}：没搜到` }];
                }
                if (r.action === 'list') {
                    const lines = (r.topics ?? []).map((t, i) => `${i + 1}. [tid=${t.tid}] ${t.subject} —— ${t.author}（${t.replies} 回，${t.lastAt}）`);
                    const head = `${r.forumName ?? '版'}（共 ${r.totalPage ?? '?'} 页）`;
                    return [{ type: 'text', text: `${head}\n${lines.join('\n')}` }];
                }
                const floors = (r.floors ?? []).map((f) => {
                    const c = f.comments.length > 0
                        ? `\n  楼中楼：${f.comments.map((x) => `${x.author}：${x.content}`).join(' / ')}`
                        : '';
                    return `【${f.author} · ${f.at}】${f.content}${c}`;
                });
                const tf = r.totalFloors;
                const head = `《${r.subject ?? '?'}》`
                    + (tf !== undefined ? `（共 ${tf} 楼，第 ${r.totalPage ?? '?'} 页）` : '');
                return [{ type: 'text', text: `${head}\n\n${floors.join('\n\n')}` }];
            },
        },
        async execute(args) {
            const a = args;
            const action = String(a.action ?? '').toLowerCase();
            if (action !== 'list' && action !== 'read' && action !== 'search') {
                return { ok: false, action, error: 'action 只能是 list / read / search' };
            }
            const page = clampInt(a.page, 1, 1, 200);
            try {
                if (action === 'list') {
                    const fid = Math.trunc(Number(a.fid ?? 0));
                    // 注意：**不能用 fid <= 0 判断**。NGA 有大量版面 fid 是负数
                    // （厨艺 -608808、小窗视界 -8725919、程序员版 -202020…），
                    // 用 <=0 会把它们全当成"没给 fid"，然后返回版面表 —— 她会以为版打不开。
                    // 0 才是"没指定"的哨兵值。
                    if (!Number.isInteger(fid) || fid === 0) {
                        // 她第一次调 {"action":"list"} 想让工具"列出所有版面"，实测拿到一句
                        // "需要 fid" 就卡住了 —— NGA 根本没有版面目录接口，她没地方找 fid。
                        // 所以这里**不报错**，直接把内置的已验证版面表给她当起点。
                        return {
                            ok: true,
                            action,
                            forums: KNOWN_FORUMS.map((f) => ({ fid: f.fid, name: f.name, about: f.about })),
                            note: '这是内置的常用版面表（都验证过能用），不是 NGA 的全部版面。'
                                + '挑一个 fid 再调 list；想找表里没有的版，可以直接问主人。',
                        };
                    }
                    const limit = clampInt(a.limit, 10, 1, 40);
                    const list = await nga.listTopics(fid, page);
                    return {
                        ok: true,
                        action,
                        forumName: list.forumName,
                        totalPage: list.totalPage,
                        topics: list.topics.slice(0, limit).map((t) => ({
                            tid: t.tid,
                            subject: t.subject,
                            author: t.author,
                            replies: t.replies,
                            lastAt: formatNgaTime(t.lastPostAt),
                        })),
                    };
                }
                if (action === 'search') {
                    const keyword = String(a.keyword ?? '').trim();
                    if (!keyword)
                        return { ok: false, action, error: 'search 需要 keyword' };
                    // 游客态能读帖、能列版面，但**搜不了** —— 直接说清楚，别让她以为"NGA 上没有"
                    if (!ngaAuthenticated()) {
                        return {
                            ok: false,
                            action,
                            error: 'NGA 搜索需要登录，现在是游客态。你可以用 qq_nga_login 请主人扫一次码。',
                            needLogin: true,
                        };
                    }
                    const limit = clampInt(a.limit, 10, 1, 30);
                    const fidNum = Math.trunc(Number(a.fid ?? 0));
                    const result = await nga.searchTopics(keyword, {
                        // 同上：负数 fid 是合法版面，只有 0 表示"没指定、搜全站"
                        ...(Number.isInteger(fidNum) && fidNum !== 0 ? { fid: fidNum } : {}),
                        page,
                        ...(a.withContent === false ? { withContent: false } : {}),
                        ...(a.searchPost === true ? { searchPost: true } : {}),
                    });
                    return {
                        ok: true,
                        action,
                        keyword: result.keyword,
                        scope: result.scope,
                        totalPage: result.totalPage,
                        topics: result.topics.slice(0, limit).map((t) => ({
                            tid: t.tid,
                            subject: t.subject,
                            author: t.author,
                            replies: t.replies,
                            lastAt: formatNgaTime(t.lastPostAt),
                        })),
                    };
                }
                const tid = Math.trunc(Number(a.tid ?? 0));
                if (!Number.isInteger(tid) || tid <= 0) {
                    return { ok: false, action, error: 'read 需要 tid（帖子 id，从 read.php?tid=xxx 里拿）' };
                }
                const limit = clampInt(a.limit, 8, 1, 30);
                const thread = await nga.readThread(tid, page, limit);
                return {
                    ok: true,
                    action,
                    subject: thread.subject || `tid=${tid}`,
                    totalPage: thread.totalPage,
                    // 坑 4.2：楼层总数和页数是两个数，她问"一共多少楼"要用前者
                    ...(thread.totalFloors !== undefined ? { totalFloors: thread.totalFloors } : {}),
                    floors: thread.floors.map((f) => ({
                        author: f.author,
                        at: f.postDate,
                        content: f.content,
                        comments: f.comments,
                    })),
                };
            }
            catch (err) {
                if (err instanceof NgaError) {
                    // 把 kind 翻成人话 —— 她不该看到 'guest-denied' 这种内部词
                    const why = err.kind === 'timeout' ? 'NGA 响应超时'
                        : err.kind === 'network' ? '连不上 NGA'
                            : err.kind === 'guest-denied' ? 'NGA 把这次请求挡了（游客限制或 IP 限流），过一会儿再试'
                                : err.kind === 'not-found' ? '这个版面/帖子不存在，或你的账号看不到它'
                                    : err.kind === 'bad-request' ? '参数不对'
                                        : 'NGA 回了个看不懂的东西';
                    return { ok: false, action, error: `${why}（${err.message}）` };
                }
                return { ok: false, action, error: err instanceof Error ? err.message : String(err) };
            }
        },
    });
    /**
     * qq_nga_login —— 她可以**主动**请主人扫码登录 NGA。
     *
     * ## 为什么给她这个权力（而不是做成面板上的按钮）
     *
     * 用户的原话是"由小羽决定，聊天或者其他时候发现，可以主动发消息给 owner 请求登录"。
     * 也就是说：**发现需要登录的时机归她判断**，不是归代码判断。
     * 所以这里只提供能力，不设触发条件 —— 她在聊天里发现"要搜 NGA 但没登录"、
     * 或者自由时间想上山看看却上不去，都可以自己决定要不要打扰主人。
     *
     * ## 为什么走 qqbot_send_file 而不是普通回复
     *
     * 二维码是**图片**，普通文字回复传不了。而 `qqbot_send_file` 支持显式
     * `target=c2c:<openid>`，正好是"指定发给某个人"的通道。
     * 但这里不由工具自己发 —— 工具只负责生成并把路径交回去，
     * 让她在回复里自然地说一句"你扫一下这个"，比机器弹一条通知更像她。
     *
     * ## 边界
     *
     * 只发私聊（`c2c`），绝不发群 —— 扫码是主人本人的事，不该在群里打扰别人。
     */
    reg({
        name: 'qq_nga_login',
        description: '生成一张 NGA 登录二维码，让主人用手机扫一下，你就能搜 NGA 了。'
            + '什么时候用由你自己判断：比如你想搜 NGA 却发现没登录，'
            + '或者自由时间想上山看看却进不去。'
            + '**别为了登录而登录** —— 只有你真要用 NGA 搜索时才值得打扰他。'
            + '调用后会返回图片路径，你用 qqbot_send_file（target=c2c:<主人的openid>）发给主人，'
            + '再简短说一句请他扫；二维码约 2 分钟有效，过期了再调一次就行。',
        parameters: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    filePath: { type: 'string' },
                    expiresInSec: { type: 'number' },
                    alreadyLoggedIn: { type: 'boolean' },
                    error: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                if (r.alreadyLoggedIn === true) {
                    return [{ type: 'text', text: 'NGA 已经是登录状态了，不用再扫。' }];
                }
                if (!r.ok)
                    return [{ type: 'text', text: `二维码没生成出来：${r.error ?? '未知原因'}` }];
                return [{
                        type: 'text',
                        text: `二维码已生成：${r.filePath}\n约 ${r.expiresInSec ?? 120} 秒内有效。`
                            + '用 qqbot_send_file 发给主人（target=c2c:<主人的openid>），再请他扫一下。',
                    }];
            },
        },
        async execute() {
            try {
                if (loadCredentials() !== undefined)
                    return { ok: true, alreadyLoggedIn: true };
                const session = await genQrSession();
                const png = await renderQrBuffer(session.content, 480);
                // 落盘到一个可发送的位置（send_file 的白名单里有 media 目录）
                const dir = join(defaultNgaDir(), 'qr');
                mkdirSync(dir, { recursive: true });
                const filePath = join(dir, `login-${session.qrkey.slice(0, 8)}.png`);
                writeFileSync(filePath, png);
                // 记住这次会话，供轮询用（面板和工具共用同一张表）
                rememberQrSession(session);
                return { ok: true, filePath, expiresInSec: QR_TTL_SEC };
            }
            catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
    });
    /**
     * qq_surf_preference —— 她自己的冲浪姿态（M-surf-pref）。
     *
     * ## 边界设计
     *
     * 冲浪的机制（时段/频率/引擎/质量闸/提示骨架）她改不了 —— 那是"程序改程序"。
     * 她能调的是**姿态**：此刻想留意什么方向、结果希望怎么被自己记住。
     * 这与 qq_mark_interest 同一性质：自主性长在内容上，不长在机制上。
     *
     * 两个都可空：清空 = 回到默认姿态（提示里就不出现偏好段）。
     * 偏好写进 self.json，冲浪投递时插进提示开头（骨架不变）。
     */
    reg({
        name: 'qq_surf_preference',
        description: '设置你自己上网冲浪时的姿态：这次想留意什么方向、结果希望怎么被自己记住。'
            + '两个都可以不填（不填 = 回到默认姿态）。'
            + '冲浪的时段/频率/引擎这些机制不归你管，这个工具只调"姿态"。',
        parameters: {
            type: 'object',
            properties: {
                focus: {
                    type: 'string',
                    description: '可选：一句话，此刻想在网上留意什么方向（如"最近 C40 相关的实战帖"）。≤200 字。传空串 = 清除',
                },
                digestAs: {
                    type: 'string',
                    description: '可选：一句话，希望结果怎么被自己记住（默认姿态是一句反应 + 出处）。≤200 字。传空串 = 清除',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    preference: {
                        type: 'object',
                        properties: {
                            focus: { type: 'string' },
                            digestAs: { type: 'string' },
                        },
                    },
                    error: { type: 'string' },
                },
            },
            render: (_a, v) => {
                const r = v;
                if (!r.ok)
                    return [{ type: 'text', text: `没存上：${r.error ?? '未知原因'}` }];
                if (r.preference === undefined)
                    return [{ type: 'text', text: '冲浪姿态已清除，回到默认。' }];
                const parts = [];
                if (r.preference.focus)
                    parts.push(`留意：${r.preference.focus}`);
                if (r.preference.digestAs)
                    parts.push(`记住方式：${r.preference.digestAs}`);
                return [{ type: 'text', text: `冲浪姿态已更新 —— ${parts.join('；')}。下次冲浪生效。` }];
            },
        },
        async execute(args) {
            const a = args;
            const normFocus = typeof a.focus === 'string' ? a.focus.trim() : undefined;
            // 空串 = 显式清除该项；其余交给 service
            const result = persona.self.setSurfPreference({
                focus: normFocus === '' ? undefined : normFocus,
                digestAs: typeof a.digestAs === 'string' ? (a.digestAs.trim() === '' ? null : a.digestAs.trim()) : undefined,
            });
            return {
                ok: true,
                preference: result === undefined ? undefined : {
                    ...(result.focus ? { focus: result.focus } : {}),
                    ...(result.digestAs ? { digestAs: result.digestAs } : {}),
                },
            };
        },
    });
    /**
     * qq_note_activity —— 让她记下"这次自由时间做了什么"。
     *
     * 为什么需要（M24，开源调研结论）：
     *   没有"上一次"的记忆，每次自由时间都是从零决策 →
     *   结果每天的可能性完全相同，行为必然单一。
     *   这个工具只写一行（≤60 字），下次提示里会带上，让她能"接着上次"或"换个别的"。
     *
     * 刻意做得**很轻**：一句话就行，不是日志，不是汇报。
     */
    reg({
        name: 'qq_note_activity',
        description: '记一句"这次自由时间做了什么"（一句话，不超过 60 字）。'
            + '下次自由时间会把最近几条带给你，好让你接着上次、或者换个不一样的。'
            + '什么都不做也可以记"坐着没动"。别写汇报口吻。',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '一句话，如"翻了上个月的日记"、"去查了下那家咖啡店"' },
            },
            required: ['text'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
                required: ['ok', 'text'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                return [{ type: 'text', text: r.ok ? `记下了：${r.text}` : '没记成（自由时间还没启动）' }];
            },
        },
        async execute(args) {
            const { text } = args;
            const handle = persona.ownLife;
            if (!handle?.noteActivity)
                return { ok: false, text: '' };
            handle.noteActivity(text);
            return { ok: true, text: String(text ?? '').slice(0, 60) };
        },
    });
    /**
     * qq_check_mood —— 让她能感知自己现在的情绪（M31）。
     *
     * 为什么必须给她看：
     * 情绪已经在四个闸门上真的改变行为了（开口意愿 / 打字快慢 / 分几条 / 主动概率）。
     * 如果她自己不知道，那些行为变化在她那儿就是**无理由的**——
     * 心情差时她只是"莫名懒得说话"，而不是"我今天有点蔫"。
     * 有理由的行为才像人，没理由的行为像故障。
     *
     * 只读：情绪由事件驱动，不让她自己调（否则会变成"想开心就开心"的自欺）。
     */
    reg({
        name: 'qq_check_mood',
        description: '看看你现在的心情和精力怎么样。就是你此刻的状态，没有对错，不用分析原因。'
            + '心情会自然回落，睡一觉、过几个小时就淡了，不用刻意维持。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    valence: { type: 'number', description: '-1 到 1，正=心情好' },
                    arousal: { type: 'number', description: '0 到 1，高=心里有起伏' },
                    energy: { type: 'number', description: '0 到 1，高=有精神' },
                    text: { type: 'string', description: '一句话概括' },
                },
                required: ['ok', 'valence', 'arousal', 'energy', 'text'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                return [{ type: 'text', text: r.text }];
            },
        },
        async execute() {
            const st = persona.emotion.current();
            return {
                ok: true,
                valence: Number(st.valence.toFixed(2)),
                arousal: Number(st.arousal.toFixed(2)),
                energy: Number(st.energy.toFixed(2)),
                text: describeEmotion(st),
            };
        },
    });
    // 数量写死过一次 15，后来加到 17 也忘了改 —— 改成动态。（这种"文档和代码脱节"
    // 是本仓库反复踩的坑：写死在注释里的数字总会过期。）
    logger.info(`im-qqbot: persona 工具已注册（日记/记忆/称呼/兴趣/需求/口癖/自我/浏览/活动/B站/心情，共 ${registered.size} 个）`);
}
//# sourceMappingURL=tools.js.map