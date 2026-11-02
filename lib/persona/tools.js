/**
 * persona 工具注册 — 让 agent 自己写日记 / 记关于人的账
 * ─────────────────────────────────────────────────────────────
 * 对应 ai-companion 的 qq_write_diary / qq_read_diary / qq_memory_append。
 * 注册形态对齐 media/send-file-tool.ts：tools 服务缺失时优雅降级。
 */
import { execFileSync } from 'node:child_process';
import { describeEmotion } from "./emotion.js";
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
                },
                required: ['ok', 'activeNames'],
                additionalProperties: false,
            },
            render: (_a, v) => {
                const r = v;
                return [{ type: 'text', text: r.ok ? `能叫醒你的称呼：${r.activeNames.join('、') || '（无）'}` : '表态失败' }];
            },
        },
        async execute(args) {
            const a = args;
            const ok = a.accept ? persona.self.acceptName(a.name, 0.6) : persona.self.rejectName(a.name);
            if (ok)
                logger.info(`persona: 称呼「${a.name}」→ ${a.accept ? '接受' : '拒绝'}`);
            return { ok, activeNames: persona.self.activeNames() };
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
                const r = persona.surf?.(topic, { deep: deep === true });
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
        description: '查一个 B 站视频：拿标题、简介、AI 总结、字幕、弹幕、画面帧。'
            + '想聊某个 B 站视频的内容时用它，别凭印象编。没给 BV 号也可以按关键词搜。',
        parameters: {
            type: 'object',
            properties: {
                bvid: { type: 'string', description: 'BV 号，如 BV1ednc6jE3j' },
                query: { type: 'string', description: '想搜的关键词（没有 BV 号时用）' },
                want: {
                    type: 'string',
                    enum: ['summary', 'subtitle', 'danmaku', 'frames', 'all'],
                    description: '要什么：summary=AI总结（默认）、subtitle=字幕、'
                        + 'danmaku=观众弹幕（能反映笑点槽点，比总结有人味）、'
                        + 'frames=抽画面帧（返回图片路径，要能看图的模型才能读懂）、all=全都拿',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    title: { type: 'string' },
                    summary: { type: 'string' },
                    subtitle: { type: 'string' },
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
            render: (_a, v) => {
                const r = v;
                if (!r.ok)
                    return [{ type: 'text', text: `没查到（${r.error ?? '未知原因'}）` }];
                const parts = [];
                if (r.title)
                    parts.push(`《${r.title}》`);
                if (r.summary)
                    parts.push(`AI 总结：${r.summary}`);
                if (r.subtitle)
                    parts.push(`字幕节选：${r.subtitle}`);
                if (r.danmaku?.length) {
                    parts.push('弹幕（观众当时在说什么）：\n'
                        + r.danmaku.slice(0, 15).map((x) => `  ${x.t} ${x.text}`).join('\n'));
                }
                if (r.frames?.length) {
                    parts.push('画面帧（图片路径）：\n' + r.frames.map((x) => `  ${x.t} ${x.path}`).join('\n'));
                }
                if (r.items?.length) {
                    parts.push('搜到这些：\n' + r.items.map((x, i) => `${i + 1}. ${x.title}（${x.bvid}）`).join('\n'));
                }
                return [{ type: 'text', text: parts.join('\n\n') || '（空）' }];
            },
        },
        async execute(args) {
            const { bvid, query, want } = args;
            const run = (a) => {
                try {
                    const out = execFileSync('bili', a, { encoding: 'utf8', timeout: 30_000 });
                    return JSON.parse(out);
                }
                catch {
                    return undefined;
                }
            };
            // 没给 BV → 搜索
            if (!bvid) {
                const q = String(query ?? '').trim();
                if (!q)
                    return { ok: false, error: '需要 bvid 或 query' };
                const r = run(['search', 'video', q]);
                const d = (r?.data ?? {});
                const items = (d.items ?? []).slice(0, 5)
                    .filter((x) => x.bvid && x.title)
                    .map((x) => ({ bvid: x.bvid, title: x.title }));
                if (!items.length)
                    return { ok: false, error: '没搜到' };
                return { ok: true, items };
            }
            const mode = (['subtitle', 'danmaku', 'frames', 'all'].includes(String(want)) ? String(want) : 'summary');
            const info = run(['video', 'info', bvid]);
            const title = (info?.data ?? {}).title ?? '';
            let summary = '';
            if (mode === 'summary' || mode === 'all') {
                const r = run(['video', 'summary', bvid]);
                summary = (r?.data ?? {}).summary ?? '';
            }
            let subtitle = '';
            if (mode === 'subtitle' || mode === 'all') {
                const r = run(['video', 'subtitle', bvid]);
                const items = (r?.data ?? {}).items ?? [];
                // 只取前若干条并压成一段 —— 全文太占上下文
                subtitle = items.slice(0, 40).map((x) => x.content ?? '').filter(Boolean).join(' ').slice(0, 1200);
            }
            // 弹幕（M29）：观众看到画面后的真实反应，比 AI 总结有人味，且纯文本零成本
            let danmaku = [];
            if (mode === 'danmaku' || mode === 'all') {
                const r = run(['video', 'danmaku', bvid]);
                const items = (r?.data ?? {}).items ?? [];
                danmaku = items
                    .filter((x) => x.text)
                    // 弹幕很多，只留前 30 条，时间转成 mm:ss 便于她引用
                    .slice(0, 30)
                    .map((x) => {
                    const sec = Math.max(0, Math.floor(Number(x.time) || 0));
                    return { t: `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`, text: String(x.text) };
                });
            }
            // 画面帧（M29）：抽图返回路径。她如果没有视觉能力，拿到的是路径而非内容；
            // 但配合弹幕能间接理解画面（弹幕是"人看了画面之后的反应"）。
            let frames = [];
            if (mode === 'frames' || mode === 'all') {
                const r = run(['video', 'frames', bvid, '-n', '6']);
                const items = (r?.data ?? {}).frames ?? [];
                frames = items
                    .filter((x) => x.path)
                    .map((x) => {
                    const sec = Math.max(0, Math.floor(Number(x.time) || 0));
                    return { t: `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`, path: String(x.path) };
                });
            }
            if (!title && !summary && !subtitle && !danmaku.length && !frames.length) {
                return { ok: false, error: '视频信息拿不到' };
            }
            return {
                ok: true,
                ...(title ? { title } : {}),
                ...(summary ? { summary } : {}),
                ...(subtitle ? { subtitle } : {}),
                ...(danmaku.length ? { danmaku } : {}),
                ...(frames.length ? { frames } : {}),
            };
        },
    });
    // 数量写死过一次 15，后来加到 17 也忘了改 —— 改成动态。（这种"文档和代码脱节"
    // 是本仓库反复踩的坑：写死在注释里的数字总会过期。）
    logger.info(`im-qqbot: persona 工具已注册（日记/记忆/称呼/兴趣/需求/口癖/自我/浏览/活动/B站/心情，共 ${registered.size} 个）`);
}
//# sourceMappingURL=tools.js.map