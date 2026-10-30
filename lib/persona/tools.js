export function registerPersonaTools(ctx, persona, findByAgent, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，persona 工具未注册');
        return;
    }
    tools.register({
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
    tools.register({
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
    tools.register({
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
    tools.register({
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
    tools.register({
        name: 'qq_mark_interest',
        description: '记下你自己最近关注/感兴趣的话题。记过的话题以后更容易让你主动接话；不记就慢慢淡忘。',
        parameters: {
            type: 'object',
            properties: {
                topic: { type: 'string', description: '话题，如"游戏 新作"' },
                note: { type: 'string', description: '可选：为什么感兴趣' },
            },
            required: ['topic'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
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
            persona.self.touchInterest(a.topic);
            if (a.note)
                persona.self.addFinding(a.topic, a.note);
            return { ok: true, topics: persona.self.topInterests(6).map((i) => ({ topic: i.topic, weight: i.weight })) };
        },
    });
    // ── 提需求：她想要个新功能，可以提给用户 ──
    tools.register({
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
    tools.register({
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
    tools.register({
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
    tools.register({
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
    tools.register({
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
    tools.register({
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
    tools.register({
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
    logger.info('im-qqbot: persona 工具已注册（日记/记忆/称呼/兴趣/需求/口癖/自我，共 12 个）');
}
//# sourceMappingURL=tools.js.map