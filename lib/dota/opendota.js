/**
 * OpenDota 客户端（零依赖，只用 fetch）
 * ─────────────────────────────────────────────────────────────
 * 为什么是 OpenDota 而不是 Valve 官方：
 *   IDOTA2Match_570 用普通 Web API Key 调会返回 403（需要特殊的比赛数据权限），
 *   群里问一句战绩没必要为它单独申请权限。OpenDota 反而是免 key 的。
 *
 * 限流（实测响应头）：
 *   X-Rate-Limit-Remaining-Minute / X-Rate-Limit-Remaining-Day
 *   匿名额度 60 次/分钟、3000 次/天。这里把剩余额度记到 lastQuota 供上层降级，
 *   但**不做**主动节流 —— 本地闸门在 service 层，客户端只管单次请求的可靠性。
 *
 * 一个账号一次请求：OpenDota 没有批量端点。多人查询的串行与延迟也归 service 层。
 */
const API_BASE = 'https://api.opendota.com/api';
/** 429 时最多等这么久（Retry-After 更大就直接放弃，别把群消息挂在那儿） */
const MAX_RETRY_WAIT_MS = 3000;
/** 429 最多重试 1 次：重试是给「瞬时抖动」留的余地，不是用来对抗真限流的 */
const MAX_RETRY_ON_429 = 1;
export class OpenDotaError extends Error {
    kind;
    status;
    constructor(kind, message, status) {
        super(message);
        this.name = 'OpenDotaError';
        this.kind = kind;
        this.status = status;
    }
}
/** 天梯奖章编号 → 中文。51 = 传奇 1 星（十位是等级，个位是星级） */
export function rankTierText(rankTier) {
    if (typeof rankTier !== 'number' || !Number.isFinite(rankTier) || rankTier <= 0)
        return null;
    const tier = Math.floor(rankTier / 10);
    const star = rankTier % 10;
    const tiers = ['', '先驱', '卫士', '十字军', '执政官', '传奇', '神话', '超凡', '不朽'];
    const label = tiers[tier];
    if (label === undefined || label === '')
        return null;
    // 不朽段位不显示星级（顶段没有星）
    if (tier >= 8)
        return star > 0 ? `不朽 ${star}` : '不朽';
    return star > 0 ? `${label} ${star} 星` : label;
}
/** 胜负判定：天辉玩家（slot 0-4）赢 = radiant_win；夜魇玩家（slot >= 128）赢 = !radiant_win。
 *  recentMatches **没有** win 字段，这是唯一可靠的算法（已逐条对账验证）。
 */
export function isWin(match) {
    return match.radiant_win === (match.player_slot < 128);
}
// ── SteamID64 ⇄ account_id ─────────────────────────────────
// 公式：account_id = SteamID64 - 76561197960265728
// SteamID64 远超 Number 安全整数（2^53），必须用 BigInt 中转；
// 但 account_id 本身是 32 位无符号，对外给 number 是安全的。
// 放在这个文件里是因为它们描述的是 "OpenDota 的 account_id" 这个语义，
// 也顺便避免 tools.ts ↔ index.ts 的循环依赖。
const STEAM_ID64_BASE = 76561197960265728n;
/**
 * SteamID64 → account_id。
 * 非法（不是 17 位、低于账号基址、超出安全整数）返回 null，不抛错 —— 这是用户输入。
 */
export function steamIdToAccountId(steamId) {
    const text = String(steamId ?? '').trim();
    if (!/^\d{17}$/.test(text))
        return null;
    const accountId = BigInt(text) - STEAM_ID64_BASE;
    if (accountId <= 0n || accountId > BigInt(Number.MAX_SAFE_INTEGER))
        return null;
    return Number(accountId);
}
/** account_id → SteamID64（排查"这是谁"时用） */
export function accountIdToSteamId(accountId) {
    if (!Number.isSafeInteger(accountId) || accountId <= 0)
        return null;
    return (STEAM_ID64_BASE + BigInt(accountId)).toString();
}
export class OpenDotaApi {
    timeoutMs;
    userAgent;
    /** 最近一次响应的剩余额度（含 4xx/5xx 响应，Header 在错误响应上也有） */
    lastQuota;
    constructor({ timeoutMs = 8000, userAgent = 'dsh-qqbot/dota' } = {}) {
        this.timeoutMs = timeoutMs;
        this.userAgent = userAgent;
    }
    // ── 底层 ──────────────────────────────────────────────────
    assertAccountId(accountId) {
        if (!Number.isSafeInteger(accountId) || accountId <= 0) {
            throw new OpenDotaError('bad-request', `account_id 必须是正整数，收到 ${String(accountId)}`);
        }
    }
    recordQuota(res) {
        const pick = (name) => {
            const raw = res.headers.get(name);
            if (raw === null)
                return null;
            const n = Number(raw);
            return Number.isFinite(n) ? n : null;
        };
        this.lastQuota = {
            minute: pick('x-rate-limit-remaining-minute'),
            day: pick('x-rate-limit-remaining-day'),
            at: Date.now(),
        };
    }
    /** 单次 HTTP 往返，不重试；只负责把传输层错误翻译成 timeout / network */
    async send(path) {
        const url = `${API_BASE}${path}`;
        let res;
        try {
            res = await globalThis.fetch(url, {
                signal: AbortSignal.timeout(this.timeoutMs),
                headers: {
                    accept: 'application/json',
                    'user-agent': this.userAgent,
                },
            });
        }
        catch (err) {
            const name = err instanceof Error ? err.name : '';
            const reason = err instanceof Error ? err.message : String(err);
            // AbortSignal.timeout 抛的是 TimeoutError；外部取消是 AbortError。对上层都是"没拿到"
            if (name === 'TimeoutError' || name === 'AbortError') {
                throw new OpenDotaError('timeout', `请求 OpenDota 超时（${this.timeoutMs}ms）: ${path}`);
            }
            throw new OpenDotaError('network', `请求 OpenDota 失败: ${reason}`);
        }
        this.recordQuota(res);
        return res;
    }
    /** 解析 Retry-After：秒数或 HTTP 日期。解析不出来返回 null（→ 不重试） */
    static parseRetryAfter(raw) {
        if (raw === null || raw.trim() === '')
            return null;
        const text = raw.trim();
        if (/^\d+(\.\d+)?$/.test(text)) {
            const sec = Number(text);
            return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : null;
        }
        const at = Date.parse(text);
        if (Number.isNaN(at))
            return null;
        return Math.max(0, at - Date.now());
    }
    /**
     * GET + 错误分类。
     * 429 只在 Retry-After 明确给出且 ≤3 秒时重试 1 次；否则立刻抛 rate-limit。
     * 理由：群聊场景下让一条消息等十几秒比直接说"太频繁了"更糟。
     */
    async get(path) {
        let res = await this.send(path);
        let retried = 0;
        if (res.status === 429) {
            const waitMs = OpenDotaApi.parseRetryAfter(res.headers.get('retry-after'));
            if (waitMs !== null && waitMs <= MAX_RETRY_WAIT_MS && retried < MAX_RETRY_ON_429) {
                retried += 1;
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                res = await this.send(path);
            }
        }
        if (res.status === 429) {
            // 不读 body：OpenDota 的 429 文案没有额外信息，读完只是多消耗一个 socket
            void res.body?.cancel().catch(() => { });
            throw new OpenDotaError('rate-limit', 'OpenDota 限流（HTTP 429），稍后再查', 429);
        }
        if (res.status === 404) {
            void res.body?.cancel().catch(() => { });
            throw new OpenDotaError('not-found', 'OpenDota 找不到这个 account_id（HTTP 404）', 404);
        }
        if (res.status >= 500) {
            void res.body?.cancel().catch(() => { });
            throw new OpenDotaError('server', `OpenDota 服务端错误（HTTP ${res.status}），通常是它自己在抽风`, res.status);
        }
        if (!res.ok) {
            void res.body?.cancel().catch(() => { });
            throw new OpenDotaError('bad-response', `OpenDota 返回 HTTP ${res.status}`, res.status);
        }
        try {
            return (await res.json());
        }
        catch {
            throw new OpenDotaError('bad-response', 'OpenDota 返回的不是合法 JSON');
        }
    }
    // ── 端点 ──────────────────────────────────────────────────
    /**
     * 最近比赛（默认 OpenDota 给 20 条，可用 limit 收窄）。
     * 空数据账号返回 `200 []`，不是 404 —— 这点很重要：调用方不能把它当错误。
     */
    async recentMatches(accountId, limit) {
        this.assertAccountId(accountId);
        const params = new URLSearchParams();
        if (typeof limit === 'number' && Number.isFinite(limit)) {
            params.set('limit', String(Math.max(1, Math.min(100, Math.floor(limit)))));
        }
        const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
        const data = await this.get(`/players/${accountId}/recentMatches${suffix}`);
        if (!Array.isArray(data)) {
            throw new OpenDotaError('bad-response', 'recentMatches 返回的不是数组');
        }
        // 逐条过滤：宁可少一条，也不要让 undefined 字段一路传到文案里
        return data.filter(isRawMatch).map(normalizeMatch);
    }
    /**
     * 玩家资料。查不到（404 或 profile 为 null）返回 null，不抛错 ——
     * 空数据账号就是 `profile: {personaname: null, ...}`，这是正常状态。
     */
    async playerProfile(accountId) {
        this.assertAccountId(accountId);
        let data;
        try {
            data = await this.get(`/players/${accountId}`);
        }
        catch (err) {
            if (err instanceof OpenDotaError && err.kind === 'not-found')
                return null;
            throw err;
        }
        if (data === null || typeof data !== 'object')
            return null;
        const body = data;
        const profile = body.profile;
        const rankTier = typeof body.rank_tier === 'number' && body.rank_tier > 0 ? body.rank_tier : null;
        if (profile === null || profile === undefined) {
            // 没有 profile 也可能有 rank_tier，别把整条丢掉
            return {
                accountId,
                steamId: null,
                personaName: null,
                avatar: null,
                rankTier,
                rankText: rankTierText(rankTier),
            };
        }
        const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
        return {
            accountId,
            steamId: str(profile.steamid),
            personaName: str(profile.personaname),
            avatar: str(profile.avatarfull) ?? str(profile.avatar),
            rankTier,
            rankText: rankTierText(rankTier),
        };
    }
    /** 总胜负。拿不到（404/形状不对）返回 null，让上层省略这项而不是整条失败 */
    async winLoss(accountId) {
        this.assertAccountId(accountId);
        let data;
        try {
            data = await this.get(`/players/${accountId}/wl`);
        }
        catch (err) {
            if (err instanceof OpenDotaError && err.kind === 'not-found')
                return null;
            throw err;
        }
        if (data === null || typeof data !== 'object')
            return null;
        const { win, lose } = data;
        if (typeof win !== 'number' || typeof lose !== 'number') {
            // 空数据账号会给 {"win":0,"lose":0}，所以数字 0 是合法的；非数字才算形状异常
            return null;
        }
        return { win, lose };
    }
    /** 当前剩余额度（给日志/降级用） */
    get quota() {
        return this.lastQuota;
    }
}
// ── 原始数据校验 ────────────────────────────────────────────
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function isRawMatch(v) {
    if (v === null || typeof v !== 'object')
        return false;
    const m = v;
    // 最低要求：没有这三个字段就没法算胜负/展示，别的都可以兜底
    return typeof m.match_id === 'number' && typeof m.player_slot === 'number' && typeof m.radiant_win === 'boolean';
}
function normalizeMatch(v) {
    return {
        match_id: num(v.match_id),
        player_slot: num(v.player_slot),
        radiant_win: v.radiant_win === true,
        hero_id: num(v.hero_id),
        start_time: num(v.start_time),
        duration: num(v.duration),
        game_mode: num(v.game_mode),
        lobby_type: num(v.lobby_type),
        version: numOrNull(v.version),
        kills: num(v.kills),
        deaths: num(v.deaths),
        assists: num(v.assists),
        average_rank: numOrNull(v.average_rank),
        xp_per_min: num(v.xp_per_min),
        gold_per_min: num(v.gold_per_min),
        hero_damage: num(v.hero_damage),
        tower_damage: num(v.tower_damage),
        hero_healing: num(v.hero_healing),
        last_hits: num(v.last_hits),
        lane: numOrNull(v.lane),
        lane_role: numOrNull(v.lane_role),
        is_roaming: typeof v.is_roaming === 'boolean' ? v.is_roaming : null,
        cluster: numOrNull(v.cluster),
        leaver_status: num(v.leaver_status),
        party_size: numOrNull(v.party_size),
        hero_variant: numOrNull(v.hero_variant),
    };
}
//# sourceMappingURL=opendota.js.map