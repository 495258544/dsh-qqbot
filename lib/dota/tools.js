import { steamIdToAccountId } from "./opendota.js";
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
            const { account_id, steam_id, limit } = args;
            const accountId = resolveAccountId(account_id, steam_id);
            const form = await service.recentForm(accountId, limit);
            logger.info(`dota: 工具查询 ${accountId} → ${form.matches.length} 局（${form.wins}W/${form.losses}L）`);
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
    logger.info(`im-qqbot: Dota2 工具已注册（${TOOL_NAME}）`);
}
/**
 * account_id 优先于 steam_id。
 * 注意：account_id 给了但非法时**不**回落到 steam_id —— 静默换一个账号查，
 * 比直接报错更危险（群里会把 A 的战绩当 B 的说出来）。
 */
function resolveAccountId(accountId, steamId) {
    if (accountId !== undefined && accountId !== null) {
        const n = Number(accountId);
        if (!Number.isSafeInteger(n) || n <= 0) {
            throw new Error(`qq_dota_recent: account_id 必须是正整数，收到 ${String(accountId)}`);
        }
        return n;
    }
    if (typeof steamId === 'string' && steamId.trim() !== '') {
        const converted = steamIdToAccountId(steamId);
        if (converted === null) {
            throw new Error(`qq_dota_recent: ${steamId.trim()} 不是合法的 SteamID64（需要 17 位数字，且属于个人账号）`);
        }
        return converted;
    }
    throw new Error('qq_dota_recent: 需要 account_id 或 steam_id 其中一个（account_id 优先）');
}
//# sourceMappingURL=tools.js.map