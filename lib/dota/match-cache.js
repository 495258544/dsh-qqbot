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
function isFinitePositive(v) {
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
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
    return {
        matchId: Math.floor(o.matchId),
        startTime: Math.floor(o.startTime),
        ...(typeof o.durationSec === 'number' ? { durationSec: o.durationSec } : {}),
        ...(typeof o.gameMode === 'number' ? { gameMode: o.gameMode } : {}),
        players,
        at: typeof o.at === 'number' ? o.at : 0,
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