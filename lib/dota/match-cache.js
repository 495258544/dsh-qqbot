/**
 * 本地战绩库（按 match_id 存）
 * ─────────────────────────────────────────────────────────────
 * digest 每轮查询都会拿到每个人最近 N 局的原始摘要，但以前**用完就丢**：
 *   - 播报只能靠这轮的返回值，跨天/跨轮次无法复用；
 *   - 两个人是否同一场，要再请求一次 `/matches/{id}` 才知道；
 *   - 时间只能从 `startedAt` 反推，还要防时区错位。
 *
 * 这里按 match_id 落一份精简账本：
 *   - `startTime` 存 OpenDota 的原始 `start_time`（秒），时间是权威值；
 *   - `players` 只记**我们查过的人**（绑定的群友），不是全队十人 —— 不冒充全量；
 *   - 同 match_id 的多次写入按 accountId 合并，于是「这一场有哪几个群友」自然算得出来。
 *
 * 文件位置：`~/.dsh-qqbot/dota/matches.json`（与 ability-records.json 同目录，
 * 整个 dota/ 拷走即可迁移）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/** 最多留多少场（一天十几场，800 场≈两三个月，再老也没人翻） */
const DEFAULT_MAX_MATCHES = 800;
const FILE_VERSION = 1;
/**
 * 简报结构版本：给 CachedBriefSession 加字段时 +1。
 * briefing 构建器只复用 schema 相同的缓存，老简报自动重取一次。
 *
 * 3 → 4（2026-11-16）：点评（notes）的判定口径改了 —— 「划水」这类定性
 * 现在必须有 factSheet 里的 minus 撑腰，满参团+输出不差的局不再被判划水。
 * 老简报里没有 notes 字段本身（notes 只活在摘要里），但模型是靠整份简报
 * 判断「这人这局怎么样」，旧简报会带着旧口径一起被复用，所以必须让老的失效重取。
 * 4 → 5（2026-11-20）：加了 standouts（突出的路人/对手），老简报没有这个字段，
 * 得重取一次才能补上，否则路人锐评永远缺席。
 */
export const BRIEF_SCHEMA = 5;
function isFinitePositive(v) {
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
}
/** 可接受的 verdict 三态；别的值一律当坏数据丢掉 */
function isVerdict(v) {
    return v === 'plus' || v === 'minus' || v === 'flat';
}
/**
 * factSheet 的形状兜底（2026-11-16 加）。
 *
 * 为什么要单独兜一遍而不是直接信 JSON：这份数据在**缓存命中**时会原样喂给模型，
 * 一条形式坏掉的行（verdict 拼错、evidence 指向不存在的下标）就会让模型指错行说错话。
 * 兜底口径跟 role 字段一样：坏一条丢一条，整份不因此作废。
 */
function sanitizeFactSheet(v) {
    if (v === null || typeof v !== 'object')
        return undefined;
    const o = v;
    const lines = [];
    if (Array.isArray(o.lines)) {
        for (const item of o.lines) {
            if (item === null || typeof item !== 'object')
                continue;
            const l = item;
            if (typeof l.dim !== 'string' || l.dim === '')
                continue;
            if (typeof l.fact !== 'string' || l.fact === '')
                continue;
            if (!isVerdict(l.verdict))
                continue;
            lines.push({ dim: l.dim, fact: l.fact, verdict: l.verdict });
        }
    }
    if (lines.length === 0)
        return undefined;
    const findings = [];
    if (Array.isArray(o.findings)) {
        for (const item of o.findings) {
            if (item === null || typeof item !== 'object')
                continue;
            const f = item;
            if (typeof f.text !== 'string' || f.text === '')
                continue;
            const evidence = Array.isArray(f.evidence)
                // 下标必须落在 lines 范围内：越界的 evidence 就是「指回不存在的数据」
                ? f.evidence.filter((e) => (typeof e === 'number' && Number.isInteger(e) && e >= 0 && e < lines.length))
                : [];
            if (evidence.length === 0)
                continue;
            findings.push({ text: f.text, evidence });
        }
    }
    return { lines, findings };
}
/** 简报只做形状兜底：坏字段丢掉，不让整份 matches.json 作废 */
function sanitizeBriefing(v, matchId) {
    if (v === null || typeof v !== 'object')
        return undefined;
    const o = v;
    const s = (obj, key) => (typeof obj[key] === 'string' && obj[key] !== '' ? obj[key] : undefined);
    const n = (obj, key) => (typeof obj[key] === 'number' && Number.isFinite(obj[key]) ? obj[key] : undefined);
    const boundPlayers = [];
    const rawPlayers = Array.isArray(o.boundPlayers) ? o.boundPlayers : [];
    for (const p of rawPlayers) {
        if (p === null || typeof p !== 'object')
            continue;
        const q = p;
        if (s(q, 'name') === undefined)
            continue;
        // factSheet 兜一遍形状：缓存命中时这份数据是直接喂模型的，
        // 一条 verdict 拼错/evidence 越界的行就会让它指错行说错话（2026-11-16）。
        // 只调一次，结果放进局部变量 —— 调两次是白算（而且每次都会新建对象）。
        const factSheet = sanitizeFactSheet(q.factSheet);
        const abilities = [];
        if (Array.isArray(q.abilities)) {
            for (const a of q.abilities) {
                if (a === null || typeof a !== 'object')
                    continue;
                const b = a;
                if (s(b, 'name') === undefined)
                    continue;
                abilities.push({
                    name: b.name,
                    ...(s(b, 'nameZh') !== undefined ? { nameZh: b.nameZh } : {}),
                    uses: n(b, 'uses') ?? 0,
                    ...(s(b, 'behavior') !== undefined ? { behavior: b.behavior } : {}),
                    ...(s(b, 'damageType') !== undefined ? { damageType: b.damageType } : {}),
                });
            }
        }
        boundPlayers.push({
            name: q.name,
            hero: s(q, 'hero') ?? '',
            kda: s(q, 'kda') ?? '',
            win: q.win === true,
            abilities,
            ...(n(q, 'gpm') !== undefined ? { gpm: n(q, 'gpm') } : {}),
            ...(n(q, 'xpm') !== undefined ? { xpm: n(q, 'xpm') } : {}),
            ...(n(q, 'netWorth') !== undefined ? { netWorth: n(q, 'netWorth') } : {}),
            ...(n(q, 'heroDamage') !== undefined ? { heroDamage: n(q, 'heroDamage') } : {}),
            ...(n(q, 'teamRank') !== undefined ? { teamRank: n(q, 'teamRank') } : {}),
            ...(n(q, 'damageRank') !== undefined ? { damageRank: n(q, 'damageRank') } : {}),
            ...(n(q, 'teamSize') !== undefined ? { teamSize: n(q, 'teamSize') } : {}),
            ...(s(q, 'teamfight') !== undefined ? { teamfight: q.teamfight } : {}),
            ...(s(q, 'abilityMix') !== undefined ? { abilityMix: q.abilityMix } : {}),
            ...(q.role === 'core' || q.role === 'support' || q.role === 'unknown'
                ? { role: q.role }
                : {}),
            ...(s(q, 'roleReason') !== undefined ? { roleReason: q.roleReason } : {}),
            ...(q.abilityBasis === 'uses' || q.abilityBasis === 'levels'
                ? { abilityBasis: q.abilityBasis }
                : {}),
            ...(factSheet !== undefined ? { factSheet } : {}),
        });
    }
    // 突出的路人/对手（2026-11-20）：只认客观字段，isBound 不存盘 ——
    // 放在这个数组里的每一个都保证是路人，模型不会看到 alias，也就无从认错人。
    const standouts = [];
    if (Array.isArray(o.standouts)) {
        for (const sp of o.standouts) {
            if (sp === null || typeof sp !== 'object')
                continue;
            const q = sp;
            if (s(q, 'heroName') === undefined)
                continue;
            if (q.relation !== 'teammate' && q.relation !== 'opponent')
                continue;
            standouts.push({
                heroName: q.heroName,
                relation: q.relation,
                kda: s(q, 'kda') ?? '',
                kills: n(q, 'kills') ?? 0,
                deaths: n(q, 'deaths') ?? 0,
                assists: n(q, 'assists') ?? 0,
                gpm: n(q, 'gpm') ?? 0,
                heroDamage: n(q, 'heroDamage') ?? 0,
                reason: s(q, 'reason') ?? '',
            });
        }
    }
    let lineup;
    if (o.lineup !== null && typeof o.lineup === 'object') {
        const l = o.lineup;
        const arr = (key) => (Array.isArray(l[key])
            ? l[key].filter((x) => typeof x === 'string')
            : []);
        lineup = { radiant: arr('radiant'), dire: arr('dire') };
    }
    return {
        matchId,
        when: typeof o.when === 'string' ? o.when : '',
        gameMode: typeof o.gameMode === 'string' ? o.gameMode : '',
        durationMin: n(o, 'durationMin') ?? 0,
        parsed: o.parsed === true,
        ...(n(o, 'schema') !== undefined ? { schema: n(o, 'schema') } : {}),
        boundPlayers,
        ...(standouts.length > 0 ? { standouts } : {}),
        ...(lineup !== undefined ? { lineup } : {}),
        fetchedAt: n(o, 'fetchedAt') ?? 0,
    };
}
/** 只做形状兜底：坏一条丢一条，不让整份文件作废 */
function sanitize(v) {
    if (v === null || typeof v !== 'object')
        return null;
    const o = v;
    if (!isFinitePositive(o.matchId) || !isFinitePositive(o.startTime))
        return null;
    const rawPlayers = Array.isArray(o.players) ? o.players : [];
    const players = [];
    for (const p of rawPlayers) {
        if (p === null || typeof p !== 'object')
            continue;
        const q = p;
        if (!isFinitePositive(q.accountId))
            continue;
        players.push({
            accountId: q.accountId,
            ...(typeof q.alias === 'string' && q.alias !== '' ? { alias: q.alias } : {}),
            heroId: typeof q.heroId === 'number' ? q.heroId : 0,
            heroName: typeof q.heroName === 'string' ? q.heroName : '',
            kills: typeof q.kills === 'number' ? q.kills : 0,
            deaths: typeof q.deaths === 'number' ? q.deaths : 0,
            assists: typeof q.assists === 'number' ? q.assists : 0,
            win: q.win === true,
        });
    }
    const id = Math.floor(o.matchId);
    const briefing = o.briefing === undefined ? undefined : sanitizeBriefing(o.briefing, id);
    return {
        matchId: id,
        startTime: Math.floor(o.startTime),
        ...(typeof o.durationSec === 'number' ? { durationSec: o.durationSec } : {}),
        ...(typeof o.gameMode === 'number' ? { gameMode: o.gameMode } : {}),
        players,
        at: typeof o.at === 'number' ? o.at : 0,
        ...(briefing !== undefined ? { briefing } : {}),
    };
}
export class MatchCacheStore {
    file;
    logger;
    max;
    cache = null;
    constructor(dir, logger, max = DEFAULT_MAX_MATCHES) {
        const root = dir !== undefined && dir !== '' ? dir : path.join(os.homedir(), '.dsh-qqbot', 'dota');
        this.file = path.join(root, 'matches.json');
        this.logger = logger ?? { warn: () => { } };
        this.max = Math.max(50, Math.floor(max));
    }
    load() {
        if (this.cache !== null)
            return this.cache;
        try {
            const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
            const parsed = JSON.parse(raw);
            const out = { version: FILE_VERSION, matches: {} };
            if (parsed !== null && typeof parsed === 'object' && typeof parsed.matches === 'object' && parsed.matches !== null) {
                for (const [k, v] of Object.entries(parsed.matches)) {
                    const m = sanitize(v);
                    if (m !== null)
                        out.matches[k] = m;
                }
            }
            this.cache = out;
            return out;
        }
        catch (err) {
            const code = err.code;
            if (code !== 'ENOENT') {
                this.logger.warn(`dota: 战绩库读取失败（当作空库）: ${err instanceof Error ? err.message : String(err)}`);
            }
            this.cache = { version: FILE_VERSION, matches: {} };
            return this.cache;
        }
    }
    /** 原子写：先写 .tmp 再 rename，避免进程被杀时留下半份 JSON */
    save() {
        const data = this.load();
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tmp, this.file);
        }
        catch (err) {
            this.logger.warn(`dota: 战绩库落盘失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 淘汰最旧的，保持文件不无限长 */
    prune() {
        const data = this.load();
        const keys = Object.keys(data.matches);
        if (keys.length <= this.max)
            return;
        const sorted = keys
            .map((k) => data.matches[k])
            .sort((a, b) => b.startTime - a.startTime)
            .slice(0, this.max);
        data.matches = {};
        for (const m of sorted)
            data.matches[String(m.matchId)] = m;
    }
    /**
     * 合并写入。同一 matchId 的 players 按 accountId 覆盖 —— 后写的更完整，
     * 但 alias 为空时保留旧值（不同入口拿到的名字完整度不一样）。
     */
    upsertMany(items) {
        if (items.length === 0)
            return;
        const data = this.load();
        const now = Date.now();
        let changed = false;
        for (const it of items) {
            if (!isFinitePositive(it.matchId) || !isFinitePositive(it.startTime))
                continue;
            if (!isFinitePositive(it.player.accountId))
                continue;
            const key = String(it.matchId);
            const prev = data.matches[key];
            const player = {
                accountId: it.player.accountId,
                ...(it.player.alias !== undefined && it.player.alias !== ''
                    ? { alias: it.player.alias }
                    : prev?.players.find((p) => p.accountId === it.player.accountId)?.alias !== undefined
                        ? { alias: prev.players.find((p) => p.accountId === it.player.accountId)?.alias }
                        : {}),
                heroId: it.player.heroId,
                heroName: it.player.heroName,
                kills: it.player.kills,
                deaths: it.player.deaths,
                assists: it.player.assists,
                win: it.player.win,
            };
            if (prev === undefined) {
                data.matches[key] = {
                    matchId: Math.floor(it.matchId),
                    startTime: Math.floor(it.startTime),
                    ...(it.durationSec !== undefined ? { durationSec: it.durationSec } : {}),
                    ...(it.gameMode !== undefined ? { gameMode: it.gameMode } : {}),
                    players: [player],
                    at: now,
                };
                changed = true;
                continue;
            }
            const idx = prev.players.findIndex((p) => p.accountId === player.accountId);
            if (idx >= 0)
                prev.players[idx] = player;
            else
                prev.players.push(player);
            // 同一场的时间以先写入的为准：后面那位可能查到了新一轮数据，
            // 但 start_time 是比赛的固有属性，不该被覆盖成别的值。
            prev.at = now;
            changed = true;
        }
        if (changed) {
            this.prune();
            this.save();
        }
    }
    /**
     * 写入该场的完整简报。按 matchId 只存一份：同一场里有 3 个群友也只写一次，
     * 不会把「谁和谁一起打」重复记三遍。
     *
     * 场次必须由 upsertMany 先建好（原始战绩里有 start_time）—— 没有原始记录
     * 就写简报会在重读时被 sanitize 丢掉，所以这里直接拒绝并告警。
     */
    putBriefing(session) {
        if (!isFinitePositive(session.matchId))
            return;
        const data = this.load();
        const key = String(Math.floor(session.matchId));
        const prev = data.matches[key];
        if (prev === undefined) {
            this.logger.warn(`dota: 场次 ${key} 还没有原始战绩记录，跳过简报写入`);
            return;
        }
        prev.briefing = { ...session, matchId: prev.matchId, fetchedAt: Date.now() };
        this.save();
    }
    /** 已落盘的完整简报；parsed=true 的可以直接复用，不必再打 OpenDota */
    getBriefing(matchId) {
        return this.get(matchId)?.briefing;
    }
    get(matchId) {
        return this.load().matches[String(Math.floor(matchId))];
    }
    /** 这一场已知的参与者（只含绑定群友，按 accountId 去重） */
    participantsOf(matchId) {
        return this.get(matchId)?.players ?? [];
    }
    /** 最近 N 秒内的场次（按开赛时间倒序） */
    recent(sinceSec) {
        const all = Object.values(this.load().matches);
        const filtered = sinceSec === undefined ? all : all.filter((m) => m.startTime >= sinceSec);
        return filtered.sort((a, b) => b.startTime - a.startTime);
    }
    /** 测试/维护用：清空内存缓存，强制下次从磁盘读 */
    resetForTest() {
        this.cache = null;
    }
}
//# sourceMappingURL=match-cache.js.map