import { describeEmotion } from "./emotion.js";
import { clockInTz } from "./clock.js";
export function registerPersonaTools(ctx, persona, findByAgent, logger) {
    const tools = ctx.get('tools');
    // 自动统计注册数量，避免日志里的数字靠手写（写死过一次 15，加到 17 就过期了）
    const registered = new Set();
    const reg = (def) => {
        if (typeof def?.name === 'string')
            registered.add(def.name);
        tools?.register(def);
    };
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
    /**
     * qq_note_mood —— 心情自述入口（M-mood，2026-11-12）。
     *
     * ## 为什么需要
     *
     * `onAddressed` / `onReplied` / `onIgnored` / `onComplained` / `onNightChat` /
     * `onRest` —— 六个写入点**全是社交事件**，没有任何一个接收"她看到了什么"。
     * 结果：她读《赛博英雄传》第十一章（向山敲自己胸口那章）、写了一条
     * "我和向山的处境有镜像"的自我认识 —— 这在人身上是明确的情绪事件，
     * 但对 valence 的贡献是 **0**。日记里的 mood 词是真实心绪，
     * 但只是文本，一行都进不了 emotion.json。**心情被记下来了，但没有被用上。**
     *
     * ## 三条不动的设计（用户已明确）
     *
     * 1. **她只给方向，不给程度**。感受是方向，数字是表演 ——
     *    不让她选 0.8 还是 0.3（feiyu-mood 的统计偏差就是这么来的）。
     * 2. **不自动触发**。没有"读完书自动打标签"。她在自由时间/聊天中
     *    觉得有必要时才叫，跟 qq_mark_interest / qq_write_self_note 同一性质：
     *    自主性长在内容上，不长在机制上。
     * 3. **内容驱动弱于社交驱动**。看书感动 ≠ 被在意的人回了一句，
     *    delta 约为社交的一半（见 emotion.ts 的 CONTENT_MOOD_DELTA）。
     *
     * ## feel 为什么和 sense 分开
     *
     * sense 只有四档，粗是刻意的（数值层必须简单）。副作用是 mixed 变成垃圾桶：
     * "又感动又难受""想通了但有点涩""不知道该怎么形容"全塞进一个筐，
     * 以后回看什么都看不出来。
     * feel 是**她自己起的名字**，原样存进日志、不解析不分类不打分 ——
     * 让"细"落在她自己身上，不落在我们的枚举里。
     * 一年后她翻回 mood-log，看见的是具体那句「像被人从背后拍了一下」，
     * 而不是一个心理学家定的坐标。
     */
    reg({
        name: 'qq_note_mood',
        description: '心里动了一下的时候记一句。不是每天打卡，是那种你觉得"刚才这一下有点东西"的时候——'
            + '看完一段书、翻到个帖子、想起件事。不用分析，说个方向就行。'
            + 'because 是说为什么，feel 是说那一下像什么——后者可省，写不出来就不写，别硬凑。',
        parameters: {
            type: 'object',
            properties: {
                sense: {
                    type: 'string',
                    enum: ['up', 'down', 'mixed', 'still'],
                    description: '方向：up=往上、down=往下、mixed=说不清、still=平了',
                },
                because: { type: 'string', description: '为什么（≤60 字，人话，如"读到向山敲胸口那章"）' },
                feel: {
                    type: 'string',
                    description: '可选：那一下像什么（≤40 字，你自己起的名字，如"像被人从背后拍了一下"）',
                },
            },
            required: ['sense', 'because'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    id: { type: 'string', description: '这条记录的 id（想撤回时用它）' },
                    sense: { type: 'string', enum: ['up', 'down', 'mixed', 'still'] },
                    because: { type: 'string' },
                    feel: { type: 'string' },
                    countToday: { type: 'integer', description: '今天已经记了几条' },
                    damped: { type: 'boolean', description: '今天记够 6 条了，这条数值上算得轻' },
                    error: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                if (!r.ok)
                    return [{ type: 'text', text: `没记成（${r.error ?? '未知'}）` }];
                const tail = r.feel ? ` —— 「${r.feel}」` : '';
                const damp = r.damped ? '（今天记得有点多了，这条算得轻）' : '';
                // mixed 收口 A（用户 2026-11-12 从决策页确认）：mixed 是四档里唯一
                // "说了等于没说"的方向，没留 feel 时软引导一句。只改展示层（render
                // 不触发宿主 INVALID_TOOL_OUTPUT 校验），execute 与 output schema 一律不动；
                // 语气是"可跳过"的 —— 不命令不评判，写不出来就不写。
                const guide = r.ok && r.sense === 'mixed' && !r.feel
                    ? '——说不清的话，试着留一句「那一下像什么」（feel），哪怕半句。'
                    : '';
                return [{ type: 'text', text: `记下了（${r.sense}）${tail}${damp}${guide}` }];
            },
        },
        async execute(args) {
            const a = args;
            const sense = a.sense;
            if (sense !== 'up' && sense !== 'down' && sense !== 'mixed' && sense !== 'still') {
                return { ok: false, error: 'sense 只能是 up/down/mixed/still' };
            }
            const because = String(a.because ?? '').trim();
            if (!because)
                return { ok: false, error: 'because 不能空 —— 至少说一句为什么' };
            const feel = typeof a.feel === 'string' && a.feel.trim() ? a.feel.trim().slice(0, 40) : undefined;
            const entry = persona.emotion.onContentMood(sense, because.slice(0, 60), feel);
            const today = persona.emotion.moodEntries({ limit: 50 })
                .filter((e) => e.day === entry.day).length;
            return {
                ok: true,
                id: entry.id,
                sense: entry.sense,
                because: entry.because,
                // feel 只在真的写了时才出现在返回里 —— 没写就不带这个字段，
                // 免得模型看到 `feel: ""` 以为"必须填点什么"。
                ...(entry.feel ? { feel: entry.feel } : {}),
                countToday: today,
                damped: today > 6,
            };
        },
    });
    /**
     * qq_read_mood —— 让她读回自己记过的心情。
     *
     * ## 为什么必须有这个工具（不是"顺便加个查询"）
     *
     * 任务原话要求 mood-log「**要能被她自己读到**」，这是设计的一部分：
     * 下次她能看到「读书 4 次往上、翻帖子 1 次往下」，据此**重新理解自己**，
     * 而不是我们写死"你最近状态如何"的规则。
     *
     * 而且没有它 `qq_undo_mood` 根本用不起来 —— 那个工具要传 `id`，
     * 而 id 只在 `qq_note_mood` 的返回值里出现过一次。隔了一场对话，
     * 她手上就没有 id 了，等于撤销功能永远调不到。
     * （同类问题在 `qq_decide_name` 上出现过：写端接了、读端没接，
     *   候选名进了 self.json 却没有任何消费者，工具永远收不到调用。）
     *
     * 返回里**带 id**，就是为了让她能接着撤。
     */
    reg({
        name: 'qq_read_mood',
        description: '翻一下你自己记过的心情（qq_note_mood 记的那些）。'
            + '能看到当时写的方向和理由，还有那条的 id —— 想撤回某条时用它。'
            + '不是给你复盘用的报告，就是看看自己这几天为什么事情动过心。',
        parameters: {
            type: 'object',
            properties: {
                n: { type: 'number', description: '最近几条（默认 10，上限 50）' },
                includeRevoked: { type: 'boolean', description: '可选：连已撤销的一起看（默认不看）' },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    count: { type: 'integer', description: '这次返回几条' },
                    entries: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                day: { type: 'string' },
                                time: { type: 'string' },
                                sense: { type: 'string', enum: ['up', 'down', 'mixed', 'still'] },
                                because: { type: 'string' },
                                feel: { type: 'string' },
                                revoked: { type: 'boolean' },
                            },
                            required: ['id', 'day', 'time', 'sense', 'because'],
                            additionalProperties: false,
                        },
                    },
                    // 四个方向分开给，不做嵌套 stats 对象 —— 嵌套对象的 additionalProperties
                    // 最容易出校验事故（qq_nga 就是这么挂的），平坦字段没有歧义。
                    up: { type: 'integer', description: '最近七天往上几次' },
                    down: { type: 'integer' },
                    mixed: { type: 'integer' },
                    still: { type: 'integer' },
                    error: { type: 'string' },
                },
                required: ['ok', 'count', 'entries', 'up', 'down', 'mixed', 'still'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                if (!r.ok)
                    return [{ type: 'text', text: `没读成（${r.error ?? '未知'}）` }];
                if (r.count === 0)
                    return [{ type: 'text', text: '还没记过心情。' }];
                const senseLabel = { up: '往上', down: '往下', mixed: '说不清', still: '平了' };
                const lines = r.entries.map((e) => {
                    // mixed 收口 B2（用户 2026-11-12 从决策页确认）：mixed 且没留话时点一句，
                    // 让"筐"在回看时也看得见；mixed 有 feel / 非 mixed 条目不受影响。
                    const feel = e.feel ? `「${e.feel}」` : e.sense === 'mixed' ? '（没留话）' : '';
                    const rev = e.revoked ? '（已撤销）' : '';
                    return `· ${e.day} ${e.time} ${senseLabel[e.sense] ?? e.sense} ${e.because}${feel}${rev}　id=${e.id}`;
                });
                const head = `这几天：往上 ${r.up}、往下 ${r.down}、说不清 ${r.mixed}、平了 ${r.still}`;
                return [{ type: 'text', text: [head, ...lines].join('\n') }];
            },
        },
        async execute(args) {
            const a = args;
            // 夹到 [1,50]：负数/异常值不该让工具崩
            const n = Math.max(1, Math.min(Math.floor(Number(a.n) || 10), 50));
            const rows = persona.emotion.moodEntries({ includeRevoked: a.includeRevoked === true, limit: n });
            const st = persona.emotion.moodStats(7);
            return {
                ok: true,
                count: rows.length,
                entries: rows.map((e) => ({
                    id: e.id,
                    day: e.day,
                    time: clockInTz(new Date(e.at)),
                    sense: e.sense,
                    because: e.because,
                    ...(e.feel ? { feel: e.feel } : {}),
                    ...(e.revoked ? { revoked: true } : {}),
                })),
                up: st.bySense.up,
                down: st.bySense.down,
                mixed: st.bySense.mixed,
                still: st.bySense.still,
            };
        },
    });
    /**
     * qq_undo_mood —— 她可以撤回自己记过的心情，但**必须写理由**。
     *
     * ## 为什么允许撤
     *
     * 用户 2026-11-12 明确同意：她能删自己的记录。
     * 记错了方向、当时随手记的、后来觉得那不算 —— 这些是合理的。
     * 不给她这个口子，等于要求她对自己的每一次随手记录负责，那她会不敢记。
     *
     * ## 为什么必须写 why
     *
     * **不给静默删除。** 删的时候写一句为什么，留下痕迹。
     * 静默删除的好处是干净，代价是"她可以随时改写自己的历史" ——
     * 而留痕恰恰是这个功能的意义。所以 why 是 required。
     *
     * ## 为什么撤销不回滚 valence
     *
     * 情绪已经发生了。事后重新评估"这条其实不该算"是**认知**上的修正，
     * 不等于那段时间没发生过 —— 人的心情不会因为你后来觉得"那天没什么"
     * 就回到没被影响过的样子。
     * 更要紧的是：一旦允许回滚，"撤销"就变成了数值层的后门
     * （记错了 → 撤掉 → 数字回到从前），日上限和边际递减全部失效。
     *
     * ## 只能撤自己的
     *
     * 参数里不提供任何指定他人的可能（用户明确要求）。
     * 记录 id 只在本机 mood-log 里找，不存在"别人的记录"这个概念。
     */
    reg({
        name: 'qq_undo_mood',
        description: '撤回一条你自己记过的心情（用 qq_note_mood 返回的 id）。'
            + '记错了、当时随手记的、后来觉得那不算——都可以撤。'
            + '但要说一句为什么撤，不许闷声删掉。撤掉之后之前的心情数值不会退回去，'
            + '情绪发生过就是发生过，改了说法不等于没发生。',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '要撤销的那条记录 id（qq_note_mood 返回的）' },
                why: { type: 'string', description: '为什么撤（必填 —— 不许静默删）' },
            },
            required: ['id', 'why'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    id: { type: 'string' },
                    because: { type: 'string', description: '原记录写的理由' },
                    why: { type: 'string', description: '这次撤销的理由' },
                    error: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                if (!r.ok)
                    return [{ type: 'text', text: `没撤成（${r.error ?? '未知'}）` }];
                return [{ type: 'text', text: `撤了「${r.because ?? ''}」—— 理由是：${r.why ?? ''}（记录还在，标了撤销）` }];
            },
        },
        async execute(args) {
            const a = args;
            const id = String(a.id ?? '').trim();
            const why = String(a.why ?? '').trim();
            // 缺 why 直接拒绝 —— 不靠 schema 的 required 兜底：
            // 有些宿主会在模型漏填时塞空串，那样就到了这层，必须自己拦。
            if (!why)
                return { ok: false, id, error: '撤销必须写理由（一句为什么），不许静默删' };
            if (!id)
                return { ok: false, id: '', error: '要给记录 id' };
            const r = persona.emotion.undoMood(id, why);
            if (!r.ok)
                return { ok: false, id, error: r.error ?? '撤销失败' };
            return {
                ok: true,
                id,
                because: r.entry?.because ?? '',
                why,
            };
        },
    });
    logger.info(`im-qqbot: persona 工具已注册（日记/记忆/称呼/兴趣/需求/口癖/自我/浏览/活动/B站/心情，共 ${registered.size} 个）`);
}
//# sourceMappingURL=tools.js.map