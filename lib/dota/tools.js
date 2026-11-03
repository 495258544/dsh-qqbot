import { steamIdToAccountId } from "./opendota.js";
import { heroIdByName } from "./heroes.js";
const TOOL_NAME = 'qq_dota_recent';
export function registerDotaTools(ctx, service, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，Dota2 工具未注册');
        return;
    }
    const { defaultLimit, maxLimit } = service.limits;
    tools.register({
        name: TOOL_NAME,
        description: '查某个人的 Dota2 最近战绩（输赢、KDA、用的英雄、时长），用于群里聊游戏时接话或调侃。'
            + '数据来自 OpenDota 的公开数据：对方在 Dota2 设置里关掉了「公开比赛数据」时会查不到，'
            + '这种情况要如实说"查不到"，不要说成对方没打过。'
            + 'account_id 和 steam_id 至少给一个，都给了以 account_id 为准。',
        parameters: {
            type: 'object',
            properties: {
                account_id: {
                    type: 'integer',
                    description: 'Dota2 的 32 位 account_id（OpenDota 用的那个），如 70388657',
                },
                steam_id: {
                    type: 'string',
                    description: 'SteamID64（17 位数字，如 76561198030654385），工具内部会换算成 account_id',
                },
                limit: {
                    type: 'integer',
                    description: `查最近几局，默认 ${defaultLimit}，最多 ${maxLimit}（OpenDota 一次最多返回 20 条）`,
                },
                hero: {
                    type: 'string',
                    description: '只看某个英雄的局：填英雄名都行 —— 官方名（伐木机）、英文名（Timbersaw）、'
                        + '群里常见的叫法（timber / 锯子 / 剑圣 / 白牛 / AM / SF）。'
                        + '给了这个参数时 limit 默认拉满（20 局），因为只查几局很可能没玩这个英雄。',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    accountId: { type: 'integer' },
                    displayName: { type: 'string' },
                    rankText: { type: 'string' },
                    summary: { type: 'string' },
                    stats: {
                        type: 'object',
                        properties: {
                            wins: { type: 'integer' },
                            losses: { type: 'integer' },
                            winRate: { type: 'integer' },
                            avgKda: { type: 'number' },
                            streak: { type: 'integer' },
                        },
                        additionalProperties: false,
                    },
                    matches: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                matchId: { type: 'integer' },
                                heroId: { type: 'integer' },
                                heroName: { type: 'string' },
                                win: { type: 'boolean' },
                                kills: { type: 'integer' },
                                deaths: { type: 'integer' },
                                assists: { type: 'integer' },
                                kdaRatio: { type: 'number' },
                                durationSec: { type: 'integer' },
                                durationText: { type: 'string' },
                                startedAt: { type: 'string' },
                                startedAtText: { type: 'string' },
                                gameMode: { type: 'integer' },
                                gameModeText: { type: 'string' },
                                lobbyType: { type: 'integer' },
                                lobbyTypeText: { type: 'string' },
                                isRanked: { type: 'boolean' },
                            },
                            required: ['matchId', 'heroName', 'win', 'kills', 'deaths', 'assists', 'kdaRatio'],
                            additionalProperties: false,
                        },
                    },
                    note: { type: 'string' },
                },
                required: ['ok', 'summary', 'matches'],
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: v.summary ?? '没有战绩可展示' }];
            },
        },
        async execute(args) {
            const { account_id, steam_id, limit, hero } = args;
            const accountId = resolveAccountId(account_id, steam_id);
            // 英雄筛选：群友说的往往是黑话（timber / 剑圣 / 白牛 / SF），先翻译成 ID。
            // 认不出来就如实说 —— 猜一个最像的比不认更糟，她会照着错英雄编一整段分析。
            let heroId;
            if (hero !== undefined && String(hero).trim() !== '') {
                const q = String(hero).trim();
                heroId = heroIdByName(q);
                if (heroId === undefined) {
                    return {
                        ok: false,
                        error: `没认出英雄「${q}」。可以用官方名（伐木机）、英文名（Timbersaw）或常见叫法（timber / 锯子 / 白牛）。`,
                    };
                }
            }
            // 按英雄筛时默认拉满（20 局）：只查最近 5 局的话，很可能这几局里根本没玩这个英雄
            const finalLimit = heroId !== undefined && limit === undefined ? maxLimit : limit;
            const form = await service.recentForm(accountId, finalLimit, heroId);
            logger.info(`dota: 工具查询 ${accountId} → ${form.matches.length} 局（${form.wins}W/${form.losses}L）`
                + (hero !== undefined ? ` 筛=${String(hero)}` : ''));
            return {
                ok: true,
                accountId: form.accountId,
                displayName: form.displayName,
                ...(form.rankText !== null ? { rankText: form.rankText } : {}),
                summary: form.summaryText,
                stats: {
                    wins: form.wins,
                    losses: form.losses,
                    winRate: form.winRate,
                    avgKda: form.avgKda,
                    streak: form.streak,
                },
                matches: form.matches.map((m) => ({
                    matchId: m.matchId,
                    heroId: m.heroId,
                    heroName: m.heroName,
                    win: m.win,
                    kills: m.kills,
                    deaths: m.deaths,
                    assists: m.assists,
                    kdaRatio: m.kdaRatio,
                    durationSec: m.durationSec,
                    durationText: m.durationText,
                    startedAt: m.startedAt,
                    startedAtText: m.startedAtText,
                    gameMode: m.gameMode,
                    gameModeText: m.gameModeText,
                    lobbyType: m.lobbyType,
                    lobbyTypeText: m.lobbyTypeText,
                    isRanked: m.isRanked,
                })),
                ...(form.note !== undefined ? { note: form.note } : {}),
            };
        },
    });
    // ── qq_dota_match：单场详细解析 ─────────────────────────────
    tools.register({
        name: 'qq_dota_match',
        description: '解析一场具体的 Dota2 对局（比 qq_dota_recent 细得多）：经济/输出/正反补、队内排名、对位对比、'
            + '首血/肉山/推塔、经济曲线、团战参与、双方阵容、出装。'
            + '给了 match_id 就查那场；只给 account 不给 match_id 时，自动取该账号最近一场。'
            + 'account 仍然是必需的（要定位这局里的哪个人）。数据来自 OpenDota 公开数据；'
            + '对方关掉「公开比赛数据」时查不到，要如实说查不到。',
        parameters: {
            type: 'object',
            properties: {
                match_id: {
                    type: 'integer',
                    description: '对局 ID（qq_dota_recent 返回的 matchId）；省略则取该账号最近一场',
                },
                account_id: {
                    type: 'integer',
                    description: 'Dota2 的 32 位 account_id（OpenDota 用的那个）',
                },
                steam_id: {
                    type: 'string',
                    description: 'SteamID64（17 位数字），工具内部换算成 account_id',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    matchId: { type: 'integer' },
                    summary: { type: 'string' },
                    heroName: { type: 'string' },
                    win: { type: 'boolean' },
                    kills: { type: 'integer' },
                    deaths: { type: 'integer' },
                    assists: { type: 'integer' },
                    kdaRatio: { type: 'number' },
                    gpm: { type: 'integer' },
                    xpm: { type: 'integer' },
                    lastHits: { type: 'integer' },
                    denies: { type: 'integer' },
                    heroDamage: { type: 'integer' },
                    towerDamage: { type: 'integer' },
                    heroHealing: { type: 'integer' },
                    netWorth: { type: 'integer' },
                    level: { type: 'integer' },
                    items: { type: 'array', items: { type: 'string' } },
                    teamRank: {
                        type: 'object',
                        properties: {
                            netWorth: { type: 'integer' },
                            heroDamage: { type: 'integer' },
                            teamSize: { type: 'integer' },
                        },
                        additionalProperties: false,
                    },
                    laneOpponent: {
                        type: 'object',
                        properties: {
                            heroName: { type: 'string' },
                            gpmDiff: { type: 'integer' },
                            damageDiff: { type: 'integer' },
                        },
                        additionalProperties: false,
                    },
                    objectives: {
                        type: 'object',
                        properties: {
                            firstBlood: { type: 'string' },
                            roshanRadiant: { type: 'integer' },
                            roshanDire: { type: 'integer' },
                            towersRadiant: { type: 'integer' },
                            towersDire: { type: 'integer' },
                        },
                        additionalProperties: false,
                    },
                    goldSwing: {
                        type: 'object',
                        properties: {
                            maxLead: { type: 'integer' },
                            maxDeficit: { type: 'integer' },
                            leadMinute: { type: 'integer' },
                            deficitMinute: { type: 'integer' },
                        },
                        additionalProperties: false,
                    },
                    teamfights: {
                        type: 'object',
                        properties: {
                            count: { type: 'integer' },
                            participated: { type: 'integer' },
                        },
                        additionalProperties: false,
                    },
                    lineup: {
                        type: 'object',
                        properties: {
                            radiant: { type: 'array', items: { type: 'string' } },
                            dire: { type: 'array', items: { type: 'string' } },
                        },
                        additionalProperties: false,
                    },
                    notes: { type: 'array', items: { type: 'string' } },
                    // 技能组合：技能征召（OMG）局里这是分析的核心，不是装饰
                    abilities: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                uses: { type: 'integer' },
                                behavior: { type: 'string' },
                                damageType: { type: 'string' },
                            },
                            required: ['name', 'uses'],
                            additionalProperties: false,
                        },
                    },
                    abilityMix: { type: 'string' },
                },
                required: ['ok', 'matchId', 'summary'],
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: v.summary ?? '没有可展示的解析' }];
            },
        },
        async execute(args) {
            const { match_id, account_id, steam_id } = args;
            const accountId = resolveAccountId(account_id, steam_id, 'qq_dota_match');
            // 没给对局 ID 就取该账号最近一场（recentForm 已带缓存，不会多打一次）
            let matchId;
            if (match_id !== undefined && match_id !== null) {
                const n = Number(match_id);
                if (!Number.isSafeInteger(n) || n <= 0) {
                    throw new Error(`qq_dota_match: match_id 必须是正整数，收到 ${String(match_id)}`);
                }
                matchId = n;
            }
            else {
                const recent = await service.recentForm(accountId, 1);
                const first = recent.matches[0];
                if (first === undefined) {
                    throw new Error('qq_dota_match: 这个账号最近没有比赛，取不到「最近一场」');
                }
                matchId = first.matchId;
            }
            const form = await service.matchDetail(matchId, accountId);
            logger.info(`dota: 单场解析 ${matchId} → ${form.player.heroName}`);
            const p = form.player;
            const ob = form.objectives;
            return {
                ok: true,
                matchId: form.matchId,
                summary: form.summaryText,
                heroName: p.heroName,
                win: p.win,
                kills: p.kills,
                deaths: p.deaths,
                assists: p.assists,
                kdaRatio: p.kdaRatio,
                gpm: p.gpm,
                xpm: p.xpm,
                lastHits: p.lastHits,
                denies: p.denies,
                heroDamage: p.heroDamage,
                towerDamage: p.towerDamage,
                heroHealing: p.heroHealing,
                netWorth: p.netWorth,
                level: p.level,
                items: p.items,
                teamRank: form.teamRank,
                ...(form.laneOpponent !== null ? { laneOpponent: form.laneOpponent } : {}),
                objectives: {
                    firstBlood: ob.firstBlood ?? 'unknown',
                    roshanRadiant: ob.roshan.radiant,
                    roshanDire: ob.roshan.dire,
                    towersRadiant: ob.towers.radiant,
                    towersDire: ob.towers.dire,
                },
                ...(form.goldSwing !== null ? { goldSwing: form.goldSwing } : {}),
                ...(form.teamfights !== null ? { teamfights: form.teamfights } : {}),
                lineup: form.lineup,
                notes: form.notes,
                // 技能组合（内部 key 不上报，schema 里也没有它）
                ...(p.abilities !== undefined && p.abilities.length > 0
                    ? {
                        abilities: p.abilities.map((a) => ({
                            name: a.name,
                            uses: a.uses,
                            ...(a.behavior !== undefined ? { behavior: a.behavior } : {}),
                            ...(a.damageType !== undefined ? { damageType: a.damageType } : {}),
                        })),
                    }
                    : {}),
                ...(p.abilityMix !== undefined && p.abilityMix !== '' ? { abilityMix: p.abilityMix } : {}),
            };
        },
    });
    logger.info(`im-qqbot: Dota2 工具已注册（${TOOL_NAME} / qq_dota_match）`);
}
/**
 * account_id 优先于 steam_id。
 * 注意：account_id 给了但非法时**不**回落到 steam_id —— 静默换一个账号查，
 * 比直接报错更危险（群里会把 A 的战绩当 B 的说出来）。
 */
function resolveAccountId(accountId, steamId, toolName = 'qq_dota_recent') {
    if (accountId !== undefined && accountId !== null) {
        const n = Number(accountId);
        if (!Number.isSafeInteger(n) || n <= 0) {
            throw new Error(`${toolName}: account_id 必须是正整数，收到 ${String(accountId)}`);
        }
        return n;
    }
    if (typeof steamId === 'string' && steamId.trim() !== '') {
        const converted = steamIdToAccountId(steamId);
        if (converted === null) {
            throw new Error(`${toolName}: ${steamId.trim()} 不是合法的 SteamID64（需要 17 位数字，且属于个人账号）`);
        }
        return converted;
    }
    throw new Error(`${toolName}: 需要 account_id 或 steam_id 其中一个（account_id 优先）`);
}
//# sourceMappingURL=tools.js.map