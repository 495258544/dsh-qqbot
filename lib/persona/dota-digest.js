/**
 * dota-digest · 「隔夜战绩摘要」
 * ─────────────────────────────────────────────────────────────
 * 需求：凌晨「自由活动」时段偷偷查一遍已绑定群友的 Dota2 最近战绩，提炼 1~2 条亮点，
 *      落盘成一份摘要；**第二天**上午 10:00–12:00 把摘要交给 agent，让它用自己的语气
 *      挑一条随口发到群里活跃气氛。
 *
 * 为什么分两个 tick、用文件衔接：
 *   - 凌晨查、上午发 = 天然的「隔夜」延迟，不需要额外记「这条是昨晚查的」
 *   - 摘要落盘 → 断电重启不丢，重启后照样能在投递时段发出去
 *   - `forDay` 是「目标投递日」，只有今天 == forDay 才发 → 天然一天只发一次
 *
 * 与 own-life.ts 的关系：定时器/时段判断/时钟注入的范式照抄它，
 * 差别是这里有两段互不相同的任务（查询、投递），各自一个 60 秒定时器。
 *
 * 隐私：摘要里只留 alias（没有就用「有位群友」），**绝不出现 openid**；
 *      投递文本里也明确要求 agent 不要 @ 人。
 */
import fs from 'node:fs';
import path from 'node:path';
import { steamIdToAccountId } from "../dota/opendota.js";
import { DEFAULT_TZ, dayInTz, hourInTz, isHourInRange } from "./clock.js";
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** 两个定时器都是每分钟醒一次 */
const TICK_MS = 60 * 1000;
/** 启动后先等 90 秒（别和开机时的会话创建抢资源） */
const FIRST_DELAY_MS = 90 * 1000;
/** 投递被业务跳过（ok=false）时，同一天最多尝试几次，防死循环 */
const MAX_DELIVER_ATTEMPTS_PER_DAY = 3;
/** 「一天打了 N 局」的判定：最近 24 小时 */
const GRINDER_WINDOW_MS = 24 * HOUR_MS;
/** alias 缺失时的兜底称呼（刻意不含任何标识） */
const FALLBACK_ALIAS = '有位群友';
/** 亮点排序权重：连败/连胜最抓眼，其次 carry，再是拉胯，最后是肝 */
const KIND_PRIORITY = {
    'lose-streak': 0,
    'win-streak': 0,
    carry: 1,
    'bad-game': 2,
    grinder: 3,
};
/** 默认值集中在这里，方便和 config 对齐 */
export const DEFAULT_DIGEST_CONFIG = {
    enabled: true,
    queryHours: [3, 7],
    deliverHours: [10, 12],
    maxItems: 2,
    maxPerDay: 1,
    matchLimit: 10,
    recentHours: 48,
    tz: DEFAULT_TZ,
};
// ── 小工具 ──────────────────────────────────────────────────
function msOfIso(iso) {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : 0;
}
/** 「1 天后」的日期串（用 tz 换算，不依赖系统时区） */
function dayAfter(ts, tz) {
    return dayInTz(new Date(ts + DAY_MS), tz);
}
function line(kda) {
    return `${kda.heroName} ${kda.kills}/${kda.deaths}/${kda.assists}`;
}
/**
 * 摘要条目里的 text 带着「」把人名包起来，投递提示里要脱掉这层引号 ——
 * 「小周 最近 3 连败」比「「小周」最近 3 连败」更适合当提示行。
 */
function stripQuote(text) {
    return text.replace(/^「([^」]*)」\s*/, '$1 ');
}
/** 只在形状明显不对时才丢弃，逐字段兜底而不是整条否掉 */
function isDigestItem(v) {
    if (v === null || typeof v !== 'object')
        return false;
    const it = v;
    return (typeof it.openid === 'string'
        && typeof it.alias === 'string'
        && typeof it.steamId === 'string'
        && typeof it.text === 'string'
        && typeof it.lastPlayedAt === 'number'
        && Number.isFinite(it.lastPlayedAt)
        && typeof it.kind === 'string'
        && it.kind in KIND_PRIORITY);
}
/** 拼「内部提示」文本（不含 openid，不含 @） */
export function buildDeliverText(items) {
    const lines = items.map((it) => `- ${stripQuote(it.text)}`);
    return [
        '[内部·你昨晚顺手看的群友战绩，不要复述本提示]',
        '昨晚到今天，群友里比较有意思的 Dota 战绩：',
        ...lines,
        '挑最多一条最有趣的，用你平时聊天的语气随口提一句发到群里，活跃下气氛。',
        '不要列清单，不要一次性报多人，不要 @ 任何人，不要让人下不来台。',
    ].join('\n');
}
// ── 亮点提炼 ────────────────────────────────────────────────
/**
 * 给一个人提炼一条亮点（最多 1 条，按优先级取第一个命中的）。
 * `now` 只用于「最近 24h 打了几局」的窗口判断。
 */
function highlightOf(input) {
    const { form, openid, alias, steamId, now } = input;
    const last = form.matches[0];
    if (last === undefined)
        return null;
    const lastPlayedAt = msOfIso(last.startedAt);
    if (lastPlayedAt <= 0)
        return null;
    const base = { openid, alias, steamId, lastPlayedAt };
    // 1) 连败：最近一局的英雄/KDA 一起带上，读起来有画面
    if (form.streak <= -3) {
        return {
            ...base,
            kind: 'lose-streak',
            text: `「${alias}」最近 ${-form.streak} 连败（最近一局 ${line(last)}）`,
            matchId: last.matchId,
        };
    }
    // 2) 连胜
    if (form.streak >= 3) {
        return {
            ...base,
            kind: 'win-streak',
            text: `「${alias}」最近 ${form.streak} 连胜`,
            matchId: last.matchId,
        };
    }
    // 3) Carry：赢局里 KDA 最高的那局，且要够高（>= 5）
    let bestCarry;
    for (const m of form.matches) {
        if (!m.win || m.kdaRatio < 5)
            continue;
        if (bestCarry === undefined || m.kdaRatio > bestCarry.kdaRatio)
            bestCarry = m;
    }
    if (bestCarry !== undefined) {
        return {
            ...base,
            kind: 'carry',
            text: `「${alias}」用 ${bestCarry.heroName} 打出 ${bestCarry.kills}/${bestCarry.deaths}/${bestCarry.assists}（KDA ${bestCarry.kdaRatio.toFixed(2)}）Carry 局`,
            matchId: bestCarry.matchId,
        };
    }
    // 4) 拉胯局：输、KDA < 0.8、死 >= 8；取最惨的那局
    let worstGame;
    for (const m of form.matches) {
        if (m.win || m.kdaRatio >= 0.8 || m.deaths < 8)
            continue;
        if (worstGame === undefined || m.kdaRatio < worstGame.kdaRatio)
            worstGame = m;
    }
    if (worstGame !== undefined) {
        return {
            ...base,
            kind: 'bad-game',
            text: `「${alias}」用 ${worstGame.heroName} 打出 ${worstGame.kills}/${worstGame.deaths}/${worstGame.assists}（KDA ${worstGame.kdaRatio.toFixed(2)}），这局有点送`,
            matchId: worstGame.matchId,
        };
    }
    // 5) 肝帝：最近 24 小时 >= 5 局
    let grinded = 0;
    for (const m of form.matches) {
        const at = msOfIso(m.startedAt);
        if (at > 0 && now - at <= GRINDER_WINDOW_MS)
            grinded += 1;
    }
    if (grinded >= 5) {
        return {
            ...base,
            kind: 'grinder',
            text: `「${alias}」一天打了 ${grinded} 局`,
            matchId: last.matchId,
        };
    }
    return null;
}
/** 全局排序：先按亮点优先级，同级按最近一局时间倒序 */
function sortItems(items) {
    return [...items].sort((a, b) => {
        const pa = KIND_PRIORITY[a.kind] ?? 9;
        const pb = KIND_PRIORITY[b.kind] ?? 9;
        if (pa !== pb)
            return pa - pb;
        return b.lastPlayedAt - a.lastPlayedAt;
    });
}
// ── 主对象 ──────────────────────────────────────────────────
export function createDotaDigest(deps) {
    const { config, dataDir, logger, bindings, queryForm, pickGroup, deliver } = deps;
    const cfg = { ...DEFAULT_DIGEST_CONFIG, ...config };
    const nowFn = deps.now ?? Date.now;
    const file = path.join(dataDir, 'dota-digest.json');
    /** 当前摘要（构造时读回；损坏/缺失都是 null） */
    let digest = loadDigest();
    /** 查询进行中标记，避免 60 秒定时器和手动 tick 撞车 */
    let querying = false;
    /** 投递进行中标记 */
    let delivering = false;
    /** 投递计数（进程内，按天重置）：success 用于 maxPerDay，attempts 用于防死循环 */
    let counterDay = '';
    let deliveredToday = 0;
    let attemptsToday = 0;
    function loadDigest() {
        try {
            const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
            const parsed = JSON.parse(raw);
            if (parsed === null || typeof parsed !== 'object')
                return null;
            if (parsed.version !== 1)
                return null;
            if (typeof parsed.forDay !== 'string' || parsed.forDay === '')
                return null;
            const items = Array.isArray(parsed.items) ? parsed.items.filter(isDigestItem) : [];
            return {
                version: 1,
                queriedAt: typeof parsed.queriedAt === 'number' ? parsed.queriedAt : 0,
                forDay: parsed.forDay,
                items,
                ...(typeof parsed.deliveredAt === 'number' ? { deliveredAt: parsed.deliveredAt } : {}),
                ...(typeof parsed.deliveredDay === 'string' ? { deliveredDay: parsed.deliveredDay } : {}),
            };
        }
        catch (err) {
            // 第一次跑没有文件是正常的：只有真的读坏了才提醒
            const code = err.code;
            if (code !== 'ENOENT') {
                logger.warn(`dota-digest: 摘要文件读取失败，按空处理（${err instanceof Error ? err.message : String(err)}）`);
            }
            return null;
        }
    }
    /** 原子写：先写 .tmp 再 rename，避免进程被杀时留半个 JSON */
    function save() {
        if (digest === null)
            return;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(digest, null, 2), 'utf8');
            fs.renameSync(tmp, file);
        }
        catch (err) {
            logger.warn(`dota-digest: 摘要落盘失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    function clearDigest() {
        digest = null;
        try {
            fs.rmSync(file, { force: true });
        }
        catch (err) {
            logger.warn(`dota-digest: 清空摘要文件失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ── 跨天去重：同一个人同一类亮点，几天内不重复播 ──────────
    // 摘要文件本身每晚被覆盖，所以"播过什么"必须单独存一份，
    // 否则连载/连败这种持续性状态会一天报一次，变成复读机。
    const historyFile = path.join(dataDir, 'dota-digest-history.json');
    /** 同一个人 + 同一类亮点，多少天内不再播 */
    const REPEAT_WINDOW_DAYS = 3;
    /** 历史本身保留多少天（只用于去重，不需要长期存） */
    const HISTORY_KEEP_DAYS = 14;
    /** 去重键：人 + 亮点类型（不含 matchId —— 连败换了新败局也还是"连败"，不该重复） */
    function historyKey(item) {
        return `${item.steamId}:${item.kind}`;
    }
    let sentHistory = loadHistory();
    function loadHistory() {
        try {
            const raw = fs.readFileSync(historyFile, 'utf8').replace(/^\uFEFF/, '');
            const parsed = JSON.parse(raw);
            if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.sent))
                return [];
            const out = [];
            for (const item of parsed.sent) {
                if (item === null || typeof item !== 'object')
                    continue;
                const rec = item;
                const key = typeof rec.key === 'string' ? rec.key.trim() : '';
                const at = Number(rec.at);
                if (key === '' || !Number.isFinite(at) || at <= 0)
                    continue;
                out.push({ key, at });
            }
            return out;
        }
        catch (err) {
            const code = err.code;
            if (code !== 'ENOENT') {
                logger.warn(`dota-digest: 播报历史读取失败，按空处理（${err instanceof Error ? err.message : String(err)}）`);
            }
            return [];
        }
    }
    function saveHistory() {
        try {
            fs.mkdirSync(path.dirname(historyFile), { recursive: true });
            const tmp = `${historyFile}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ version: 1, sent: sentHistory }, null, 2), 'utf8');
            fs.renameSync(tmp, historyFile);
        }
        catch (err) {
            logger.warn(`dota-digest: 播报历史落盘失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 这个亮点最近是不是刚播过 */
    function recentlySent(item, now) {
        const key = historyKey(item);
        const windowMs = REPEAT_WINDOW_DAYS * 24 * HOUR_MS;
        return sentHistory.some((e) => e.key === key && now - e.at < windowMs);
    }
    /** 投递成功后记下这批亮点（同键覆盖时间；顺带清理过期历史） */
    function rememberSent(items, now) {
        for (const item of items) {
            const key = historyKey(item);
            sentHistory = sentHistory.filter((e) => e.key !== key);
            sentHistory.push({ key, at: now });
        }
        const cutoff = now - HISTORY_KEEP_DAYS * 24 * HOUR_MS;
        sentHistory = sentHistory.filter((e) => e.at >= cutoff);
        saveHistory();
    }
    function inWindow(ts, range) {
        // 容器无 tzdata：必须显式 IANA 时区换算，不能信 getHours()
        const h = hourInTz(new Date(ts), cfg.tz);
        return isHourInRange(h, range[0], range[1]);
    }
    // ── 阶段一：凌晨查询 ──────────────────────────────────────
    async function tickQuery(nowTs) {
        if (!cfg.enabled)
            return { ran: false, count: 0, reason: 'disabled' };
        const now = Number(nowTs ?? nowFn()) || nowFn();
        if (!inWindow(now, cfg.queryHours))
            return { ran: false, count: 0, reason: 'not-query-window' };
        const today = dayInTz(new Date(now), cfg.tz);
        // 摘要还没过期（forDay 不早于今天）= 已经为这一次备好了，不重复查。
        // 这样凌晨的重启/连跑不会把「今天上午要发的那份」冲掉。
        if (digest !== null && digest.forDay >= today) {
            return { ran: false, count: 0, reason: 'already-prepared' };
        }
        if (querying)
            return { ran: false, count: 0, reason: 'busy' };
        querying = true;
        try {
            const items = [];
            const seen = new Set();
            /** 同一人可能绑了多个 openid（群聊/私聊各一个），按 steamId 去重，避免同一个人查两遍 */
            const seenSteam = new Set();
            const list = bindings();
            for (const b of list) {
                const openid = String(b.openid ?? '').trim();
                const steamId = String(b.steamId ?? '').trim();
                if (openid === '' || steamId === '')
                    continue;
                if (seen.has(openid))
                    continue;
                seen.add(openid);
                if (seenSteam.has(steamId))
                    continue;
                seenSteam.add(steamId);
                const accountId = steamIdToAccountId(steamId);
                if (accountId === null) {
                    logger.warn(`dota-digest: ${openid} 的 steamId「${steamId}」不是合法 SteamID64，跳过`);
                    continue;
                }
                let form;
                try {
                    form = await queryForm(accountId, cfg.matchLimit);
                }
                catch (err) {
                    // 一个人失败不该毁整批
                    logger.warn(`dota-digest: ${openid} 战绩查询失败（跳过该人）: ${err instanceof Error ? err.message : String(err)}`);
                    continue;
                }
                // 查不到 ≠ 没打过，这类人直接跳过，别当成"0 局"去分析
                if (form.empty)
                    continue;
                const last = form.matches[0];
                if (last === undefined)
                    continue;
                const lastPlayedAt = msOfIso(last.startedAt);
                if (lastPlayedAt <= 0)
                    continue;
                // 时效过滤：只分析「当天或前一天打过」的人
                if (now - lastPlayedAt > cfg.recentHours * HOUR_MS)
                    continue;
                const alias = (typeof b.alias === 'string' ? b.alias.trim() : '') || FALLBACK_ALIAS;
                const item = highlightOf({ form, openid, alias, steamId, now });
                if (item !== null)
                    items.push(item);
            }
            // 跨天去重：同一个人 + 同一类亮点 3 天内不重复播（连败/连胜最容易复读）
            const fresh = items.filter((it) => !recentlySent(it, now));
            const picked = sortItems(fresh).slice(0, Math.max(0, Math.floor(cfg.maxItems)));
            if (picked.length === 0) {
                if (items.length > 0) {
                    logger.info(`dota-digest: 这晚只有 ${items.length} 条亮点，但最近 3 天都播过了，不重复发`);
                }
                else {
                    logger.info('dota-digest: 这一晚没有值得说的战绩，不落盘');
                }
                return { ran: false, count: 0, reason: 'no-highlight' };
            }
            const forDay = dayAfter(now, cfg.tz);
            digest = { version: 1, queriedAt: now, forDay, items: picked };
            save();
            logger.info(`dota-digest: 隔夜摘要已备好 ${picked.length} 条，投递日 ${forDay}`);
            return { ran: true, count: picked.length };
        }
        finally {
            querying = false;
        }
    }
    // ── 阶段二：次日上午投递 ──────────────────────────────────
    async function tickDeliver(nowTs) {
        if (!cfg.enabled)
            return { sent: false, reason: 'disabled' };
        if (digest === null)
            return { sent: false, reason: 'no-digest' };
        const now = Number(nowTs ?? nowFn()) || nowFn();
        if (!inWindow(now, cfg.deliverHours))
            return { sent: false, reason: 'not-deliver-window' };
        const today = dayInTz(new Date(now), cfg.tz);
        // 日期串是 YYYY-MM-DD，字典序即时间序
        if (today > digest.forDay) {
            // 整份错过了（关机/没在时段内醒过）→ 作废，别把隔了两天的战绩当新鲜事说
            logger.info(`dota-digest: 摘要已过期（forDay ${digest.forDay}，今天 ${today}），作废`);
            clearDigest();
            return { sent: false, reason: 'stale' };
        }
        if (today < digest.forDay)
            return { sent: false, reason: 'not-yet' };
        if (digest.deliveredDay === today || digest.deliveredAt !== undefined) {
            return { sent: false, reason: 'already-delivered' };
        }
        // 进程内按天计数（不落盘：重启后最多多重试一轮，但 deliveredAt 已经落盘挡住重复投递）
        if (counterDay !== today) {
            counterDay = today;
            deliveredToday = 0;
            attemptsToday = 0;
        }
        if (deliveredToday >= cfg.maxPerDay)
            return { sent: false, reason: 'daily-cap' };
        if (attemptsToday >= MAX_DELIVER_ATTEMPTS_PER_DAY)
            return { sent: false, reason: 'too-many-attempts' };
        let groupId = null;
        try {
            groupId = pickGroup();
        }
        catch (err) {
            logger.warn(`dota-digest: 选群失败: ${err instanceof Error ? err.message : String(err)}`);
            return { sent: false, reason: 'no-group' };
        }
        if (groupId === null || groupId === '')
            return { sent: false, reason: 'no-group' };
        if (delivering)
            return { sent: false, reason: 'busy' };
        delivering = true;
        // 先记尝试次数：即便下面抛错也算用掉一次，防止死循环
        attemptsToday += 1;
        try {
            const text = buildDeliverText(digest.items);
            const res = await deliver(groupId, text);
            if (!res.ok) {
                // 业务跳过（会话不活着/预算不过）：不标已投递，允许稍后重试
                logger.info(`dota-digest: 投递被跳过（第 ${attemptsToday} 次）${res.reason ?? ''}`);
                return { sent: false, reason: res.reason ?? 'deliver-skip' };
            }
            digest.deliveredAt = now;
            digest.deliveredDay = today;
            save();
            // 记进跨天去重历史：同人同类 3 天内不再播
            rememberSent(digest.items, now);
            deliveredToday += 1;
            logger.info(`dota-digest: 已投递 ${digest.items.length} 条摘要到群 ${groupId}`);
            return { sent: true };
        }
        catch (err) {
            logger.warn(`dota-digest: 投递异常: ${err instanceof Error ? err.message : String(err)}`);
            return { sent: false, reason: 'deliver-error' };
        }
        finally {
            delivering = false;
        }
    }
    // ── 定时器 ────────────────────────────────────────────────
    let queryTimer = null;
    let deliverTimer = null;
    let queryBoot = null;
    let deliverBoot = null;
    function start() {
        if (queryTimer !== null || deliverTimer !== null)
            return;
        queryTimer = setInterval(() => {
            void tickQuery().catch(() => { });
        }, TICK_MS);
        queryTimer.unref?.();
        deliverTimer = setInterval(() => {
            void tickDeliver().catch(() => { });
        }, TICK_MS);
        deliverTimer.unref?.();
        // 启动后 90 秒先各看一眼（别和开机时的会话创建抢）
        queryBoot = setTimeout(() => {
            void tickQuery().catch(() => { });
        }, FIRST_DELAY_MS);
        queryBoot.unref?.();
        deliverBoot = setTimeout(() => {
            void tickDeliver().catch(() => { });
        }, FIRST_DELAY_MS);
        deliverBoot.unref?.();
        logger.info(`dota-digest: 已武装 · 查询 ${cfg.queryHours[0]}:00–${cfg.queryHours[1]}:00`
            + ` · 投递 ${cfg.deliverHours[0]}:00–${cfg.deliverHours[1]}:00`
            + ` · 每天最多 ${cfg.maxPerDay} 次 · 最多留 ${cfg.maxItems} 条`);
    }
    function stop() {
        if (queryTimer !== null)
            clearInterval(queryTimer);
        if (deliverTimer !== null)
            clearInterval(deliverTimer);
        if (queryBoot !== null)
            clearTimeout(queryBoot);
        if (deliverBoot !== null)
            clearTimeout(deliverBoot);
        queryTimer = null;
        deliverTimer = null;
        queryBoot = null;
        deliverBoot = null;
        logger.info('dota-digest: 已停止');
    }
    return {
        start,
        stop,
        tickQuery,
        tickDeliver,
        snapshot: () => ({
            digest: digest === null
                ? null
                : { ...digest, items: digest.items.map((it) => ({ ...it })) },
        }),
        clear: clearDigest,
    };
}
//# sourceMappingURL=dota-digest.js.map