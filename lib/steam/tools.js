/** 取当前会话的发送者 openid（工具身份的唯一来源） */
function senderOf(exec, manager) {
    if (exec.agent === undefined)
        return undefined;
    return manager.findByAgent(exec.agent)?.senderId;
}
export function registerSteamTools(ctx, steam, manager, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，Steam 工具未注册');
        return;
    }
    // ── qq_steam_bind ─────────────────────────────────────────
    tools.register({
        name: 'qq_steam_bind',
        description: '把**当前发言人**的 Steam 账号存进群友绑定表。只有在对方明确说出自己的 Steam 账号时才调用。'
            + 'account 接受 17 位 SteamID64、STEAM_0:1:xxx、[U:1:xxx]、个人主页链接、或自定义 ID（vanity）。'
            + '不能替别人绑定——身份永远取当前发言人。',
        parameters: {
            type: 'object',
            properties: {
                account: {
                    type: 'string',
                    description: '对方的 Steam 账号：SteamID64 / STEAM_0:1:xxx / [U:1:xxx] / 主页链接 / 自定义 ID',
                },
                alias: {
                    type: 'string',
                    description: '可选：群里平时怎么叫他（用于以后按名字查）。留空则用 Steam 昵称',
                },
            },
            required: ['account'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    steamId: { type: 'string' },
                    personaName: { type: 'string' },
                    note: { type: 'string' },
                },
                required: ['steamId'],
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: `已绑定 Steam 账号 ${v.personaName ?? v.steamId}` }];
            },
        },
        async execute(args, exec) {
            const { account, alias } = args;
            if (typeof account !== 'string' || account.trim() === '') {
                throw new Error('qq_steam_bind: `account` 不能为空');
            }
            const openid = senderOf(exec, manager);
            if (openid === undefined || openid === '') {
                throw new Error('qq_steam_bind: 取不到当前发言人身份，无法绑定');
            }
            const result = await steam.bind(openid, account, alias);
            // 回查昵称确认"绑对人"了 —— 绑错 SteamID 是这里最常见的错
            let personaName = '';
            if (steam.hasKey) {
                try {
                    const check = await steam.lookup({ who: openid });
                    personaName = check.people[0]?.personaName ?? '';
                }
                catch {
                    // 查询失败不影响绑定结果，静默
                }
            }
            const notes = [];
            if (result.vanityResolved)
                notes.push('自定义 ID 已解析成 SteamID64');
            if (result.previous !== undefined && result.previous !== result.steamId) {
                notes.push(`已覆盖之前的绑定 ${result.previous}`);
            }
            if (personaName !== '')
                notes.push(`账号昵称是「${personaName}」，可让对方确认是不是本人`);
            else if (!steam.hasKey)
                notes.push('未配置 API Key，暂时无法回查昵称确认');
            return {
                steamId: result.steamId,
                ...(personaName !== '' ? { personaName } : {}),
                ...(notes.length > 0 ? { note: notes.join('；') } : {}),
            };
        },
    });
    // ── qq_steam_forget ───────────────────────────────────────
    tools.register({
        name: 'qq_steam_forget',
        description: '解除**当前发言人**自己的 Steam 绑定。对方说"别记我的 Steam 了"之类的话时调用。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
            schema: {
                type: 'object',
                properties: { removed: { type: 'boolean' } },
                required: ['removed'],
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: v.removed ? '已解除 Steam 绑定' : '本来就没有绑定' }];
            },
        },
        async execute(_args, exec) {
            const openid = senderOf(exec, manager);
            if (openid === undefined || openid === '') {
                throw new Error('qq_steam_forget: 取不到当前发言人身份');
            }
            return { removed: steam.unbind(openid) };
        },
    });
    // ── qq_steam_lookup ───────────────────────────────────────
    tools.register({
        name: 'qq_steam_lookup',
        description: '查群友的 Steam 状态：谁在线、正在玩什么游戏、最近在玩什么。'
            + '适合在群里聊到游戏、有人问"最近玩什么"、或你想顺着游戏话题接一句话时用。'
            + 'who 留空 = 查所有已绑定的人，适合回答"群友最近都在玩啥"。'
            + '只看当前状态时不要传 include_recent（更快）；要聊"最近在玩什么"才传 true。',
        parameters: {
            type: 'object',
            properties: {
                who: {
                    type: 'string',
                    description: '要查的人：群里对他的称呼 / openid / SteamID64。留空或填 all 表示所有已绑定的人',
                },
                include_recent: {
                    type: 'boolean',
                    description: '是否附带最近两周玩过的游戏（每个账号一次 API 调用，较慢，按需使用）',
                },
                count: {
                    type: 'integer',
                    description: '每人返回几条最近游戏，默认 5，上限 10',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    summary: { type: 'string' },
                    people: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                alias: { type: 'string' },
                                state: { type: 'string' },
                                inGame: { type: 'string' },
                                recent: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            name: { type: 'string' },
                                            hours2Weeks: { type: 'number' },
                                            hoursForever: { type: 'number' },
                                            lastPlayed: { type: 'string' },
                                        },
                                        additionalProperties: false,
                                    },
                                },
                                note: { type: 'string' },
                            },
                            required: ['name', 'state'],
                            additionalProperties: false,
                        },
                    },
                    hint: { type: 'string' },
                },
                required: ['ok', 'summary'],
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: v.summary }];
            },
        },
        async execute(args) {
            const { who, include_recent, count } = args;
            const result = await steam.lookup({
                ...(who !== undefined ? { who } : {}),
                includeRecent: include_recent === true,
                ...(count !== undefined ? { count } : {}),
            });
            // 致命问题要明确抛给模型，让它如实告诉群友。
            // 例外：限流但已经查到一部分人时，宁可把半截结果给出去，也不要整条丢弃。
            const partialOnRateLimit = result.error?.kind === 'rate-limit' && result.people.length > 0;
            if (!result.ok && result.error !== undefined && !partialOnRateLimit) {
                const { kind, message } = result.error;
                if (kind === 'no-key' || kind === 'unauthorized' || kind === 'rate-limit' || kind === 'disabled') {
                    throw new Error(`${message}${result.hint !== undefined ? `。${result.hint}` : ''}`);
                }
            }
            const people = result.people.map((p) => ({
                name: p.personaName !== '' ? p.personaName : (p.alias ?? p.steamId),
                ...(p.alias !== undefined ? { alias: p.alias } : {}),
                state: p.state,
                ...(p.inGame !== undefined ? { inGame: p.inGame } : {}),
                ...(p.recent !== undefined ? { recent: p.recent } : {}),
                ...(p.note !== undefined ? { note: p.note } : {}),
            }));
            const summary = buildSummary(people, result.ok, result.error?.message);
            logger.info(`steam: 查询 ${who ?? 'all'} → ${people.length} 人${include_recent === true ? '（含最近游戏）' : ''}`);
            return {
                ok: result.ok,
                summary,
                people,
                ...(result.hint !== undefined ? { hint: result.hint } : {}),
            };
        },
    });
    logger.info('im-qqbot: Steam 工具已注册（qq_steam_bind / qq_steam_forget / qq_steam_lookup）');
}
/** 拼一句人话摘要（工具结果同时给模型看，summary 是它最可能直接复述的部分） */
function buildSummary(people, ok, warning) {
    if (people.length === 0)
        return ok ? '没有可查的人' : '查询失败';
    const parts = people.map((p) => {
        const head = p.alias !== undefined && p.alias !== p.name ? `${p.alias}（${p.name}）` : p.name;
        const playing = p.inGame !== undefined ? `正在玩 ${p.inGame}` : p.state;
        const recent = p.recent !== undefined && p.recent.length > 0
            ? `；最近玩过 ${p.recent.slice(0, 3).map((g) => g.name).join('、')}`
            : '';
        const note = p.note !== undefined ? `（${p.note}）` : '';
        return `${head}：${playing}${recent}${note}`;
    });
    // 只在"有不完整结果"时补一句，避免模型把半截数据当成全部
    const tail = !ok && warning !== undefined ? `\n（注意：${warning}，以上结果可能不完整）` : '';
    return parts.join('\n') + tail;
}
//# sourceMappingURL=tools.js.map