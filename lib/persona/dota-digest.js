/**
 * dota-digest · 「今日战绩锐评」
 * ─────────────────────────────────────────────────────────────
 * 需求：每天上午 10:00–12:00 查一遍已绑定群友最近 24 小时的 Dota2 战绩，
 *      这个点昨晚的比赛基本都解析完了，提炼 1~2 条亮点，直接交给 agent
 *      用群里的口气锐评一句，趁热发到群里。
 *
 * 为什么还是两段 tick、用文件衔接：
 *   - 查询和投递各自一个 60 秒定时器，互不阻塞；同一天内先查后发
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
import { DEFAULT_TZ, dayInTz, hourInTz, isHourInRange } from "./clock.js";
const HOUR_MS = 3600 * 1000;
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
    // 白天查：10-12 点这会儿，昨晚的比赛基本都解析完了，能看到经济/团战
    queryHours: [10, 12],
    // 当天就发（不再等到第二天），趁热锐评
    deliverHours: [10, 12],
    maxItems: 2,
    maxPerDay: 1,
    matchLimit: 10,
    recentHours: 24,
    tz: DEFAULT_TZ,
};
// ── 小工具 ──────────────────────────────────────────────────
function msOfIso(iso) {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : 0;
}
function line(kda) {
    return `${kda.heroName} ${kda.kills}/${kda.deaths}/${kda.assists}`;
}
/**
 * 把 ISO 时间渲染成「M月D日 HH:mm」（按指定时区）。
 *
 * 用 Intl 逐字段取值，不依赖宿主进程的本地时区——服务器在 UTC、
 * 人在北京时间时，直接 toLocaleString 会差 8 小时，把晚上的局说成下午。
 */
function whenText(iso, tz) {
    const ms = msOfIso(iso);
    if (ms <= 0)
        return '';
    try {
        const parts = new Intl.DateTimeFormat('zh-CN', {
            timeZone: tz,
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(new Date(ms));
        const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
        const hour = get('hour').padStart(2, '0');
        const minute = get('minute').padStart(2, '0');
        return `${get('month')}月${get('day')}日 ${hour}:${minute}`;
    }
    catch {
        return '';
    }
}
/** KDA 的原始写法：只给数字，语气留给 agent 自己决定 */
function kdaText(m) {
    return `${m.kills}/${m.deaths}/${m.assists}`;
}
/** 组装一条「原始数据」，不是文案 */
function factsOf(alias, situation, extra = {}) {
    return { name: alias, situation, ...extra };
}
/** 只在形状明显不对时才丢弃，逐字段兜底而不是整条否掉 */
function isDigestItem(v) {
    if (v === null || typeof v !== 'object')
        return false;
    const it = v;
    const facts = it.facts;
    const factsOk = facts !== null
        && typeof facts === 'object'
        && typeof facts.name === 'string'
        && typeof facts.situation === 'string';
    return (typeof it.openid === 'string'
        && typeof it.alias === 'string'
        && typeof it.steamId === 'string'
        && typeof it.text === 'string'
        && typeof it.lastPlayedAt === 'number'
        && Number.isFinite(it.lastPlayedAt)
        && typeof it.kind === 'string'
        && it.kind in KIND_PRIORITY
        && factsOk);
}
/** 拼「内部提示」文本（不含 openid，不含 @） */
export function buildDeliverText(items) {
    // 只给数据，不给现成句子 —— 文案要她自己写，否则就是念稿。
    const data = items.map((it) => it.facts);
    return [
        '[内部·你刚看了一眼群里这几个人最近两天的战绩，下面是原始数据，别照抄，也别复述本提示]',
        '数据：',
        JSON.stringify(data, null, 2),
        // 2026-11-12 修：以前这里写「昨晚的战绩」，模型就一律说成「这把」。
        // 实际窗口是 48 小时，bestCarry 也可能是两三天前那局 —— 时间要说对。
        '每条 match.when 是那一局的实际开赛时间，可能不是昨晚，也可能是几天前。'
            + '要提时间就按 when 说，别把它们说成「这把」「刚刚」「昨晚」。',
        'match.party 是那一场同场的群友人数（含本人），match.withWho 是他们。'
            + '开黑人数不固定，可能只有两三个，别编成「你们五个」。',
        'match.detail 是脚本取回的那一局详情。有就用它补一句（经济/伤害/团战），'
            + '没有就当没有，别自己编。detail.parsed=false 表示解析没完成，这时只说 KDA，别聊经济、团战、技能。',
        // 2026-11-12 修：detail.teamRank 是「经济」排名，模型却说成「伤害还是队里第二」。
        // 两个指标必须说清楚，同时把输出排名单独投影进来，让它有据可依。
        '指标别混：detail.teamRank 是队内经济排名（1=最富），damageRank 才是队内输出排名（1=伤害最高）；'
            + '别把 teamRank 说成「伤害第几」。要说伤害就用 heroDamage（伤害数值）或 damageRank，'
            + 'gpm/xpm/netWorth 都是经济，teamfight 是参团次数，abilityMix 只是技能路子的概括。',
        '用你自己的话，在群里挑一个人吐槽一句，像老朋友随口损他，不是客服播报，也不是战报。',
        '只说一个人，别念数据，别 @ 人。',
    ].join('\n');
}
// ── 亮点提炼 ────────────────────────────────────────────────
/**
 * 给一个人提炼一条亮点（最多 1 条，按优先级取第一个命中的）。
 * `now` 只用于「最近 24h 打了几局」的窗口判断。
 */
function highlightOf(input) {
    const { form, openid, alias, steamId, now, recentHours, tz } = input;
    // 2026-11-12 修：候选局先落进「最近 N 小时」窗口。
    //
    // 以前只检查 form.matches[0]（最近一局）在不在窗口内，然后 carry 分支从
    // **全部 10 局**里挑 KDA 最高的赢局。于是 9 月 20 日的电炎绝手 15/0/4
    // 被当成「昨晚这把」播了出去，时间还沿用最近一局的时间。
    // 现在：窗口外的局不参与评选，lastPlayedAt 也用被选中那局的时间。
    const cutoff = now - recentHours * HOUR_MS;
    const inWindow = form.matches.filter((m) => {
        const at = msOfIso(m.startedAt);
        return at > 0 && at >= cutoff && at <= now;
    });
    const last = inWindow[0];
    if (last === undefined)
        return null;
    /** 窗口内的连败/连胜：跨窗口的旧局不参与，否则「3 连败」可能是上个月的 */
    let streak = 0;
    for (const m of inWindow) {
        if (streak === 0) {
            streak = m.win ? 1 : -1;
            continue;
        }
        if ((streak > 0) !== m.win)
            break;
        streak += m.win ? 1 : -1;
    }
    /** 以「被选中的那一局」为准，时间不再借用最近一局 */
    const at = (m) => ({
        openid,
        alias,
        steamId,
        lastPlayedAt: msOfIso(m.startedAt),
    });
    const matchOf = (m) => ({
        hero: m.heroName,
        kda: kdaText(m),
        result: m.win ? '赢' : '输',
        when: whenText(m.startedAt, tz),
        matchId: m.matchId,
    });
    // 1) 连败：把窗口内最近一局的英雄/KDA 作为事实带上，怎么写由她自己决定
    if (streak <= -3) {
        return {
            ...at(last),
            kind: 'lose-streak',
            text: `「${alias}」最近 ${-streak} 连败（最近一局 ${line(last)}）`,
            facts: factsOf(alias, `${-streak} 连败`, {
                streak,
                match: matchOf(last),
            }),
            matchId: last.matchId,
        };
    }
    // 2) 连胜
    if (streak >= 3) {
        return {
            ...at(last),
            kind: 'win-streak',
            text: `「${alias}」最近 ${streak} 连胜`,
            facts: factsOf(alias, `${streak} 连胜`, {
                streak,
                match: matchOf(last),
            }),
            matchId: last.matchId,
        };
    }
    // 3) Carry：窗口内赢局里 KDA 最高的那局，且要够高（>= 5）
    let bestCarry;
    for (const m of inWindow) {
        if (!m.win || m.kdaRatio < 5)
            continue;
        if (bestCarry === undefined || m.kdaRatio > bestCarry.kdaRatio)
            bestCarry = m;
    }
    if (bestCarry !== undefined) {
        return {
            ...at(bestCarry),
            kind: 'carry',
            text: `「${alias}」用 ${bestCarry.heroName} 打出 ${kdaText(bestCarry)}（KDA ${bestCarry.kdaRatio.toFixed(2)}）Carry 局`,
            facts: factsOf(alias, `${bestCarry.heroName} ${kdaText(bestCarry)}`, {
                match: matchOf(bestCarry),
            }),
            matchId: bestCarry.matchId,
        };
    }
    // 4) 拉胯局：窗口内输、KDA < 0.8、死 >= 8；取最惨的那局
    let worstGame;
    for (const m of inWindow) {
        if (m.win || m.kdaRatio >= 0.8 || m.deaths < 8)
            continue;
        if (worstGame === undefined || m.kdaRatio < worstGame.kdaRatio)
            worstGame = m;
    }
    if (worstGame !== undefined) {
        return {
            ...at(worstGame),
            kind: 'bad-game',
            text: `「${alias}」用 ${worstGame.heroName} 打出 ${kdaText(worstGame)}（KDA ${worstGame.kdaRatio.toFixed(2)}），这局有点送`,
            facts: factsOf(alias, `${worstGame.heroName} ${kdaText(worstGame)}`, {
                match: matchOf(worstGame),
            }),
            matchId: worstGame.matchId,
        };
    }
    // 5) 肝帝：最近 24 小时 >= 5 局（用窗口内数据，窗口比 24h 宽也能算准）
    let grinded = 0;
    for (const m of inWindow) {
        const t = msOfIso(m.startedAt);
        if (t > 0 && now - t <= GRINDER_WINDOW_MS)
            grinded += 1;
    }
    if (grinded >= 5) {
        return {
            ...at(last),
            kind: 'grinder',
            text: `「${alias}」一天打了 ${grinded} 局`,
            facts: factsOf(alias, `一天打了 ${grinded} 局`, {
                games: grinded,
                match: matchOf(last),
            }),
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
    /**
     * 「选不到群」这个警告按天只打一次。
     * 投递窗口每分钟 tick 一次，不节流的话一天能刷一百多条同样的 warn，
     * 反而把真正的线索淹掉。
     */
    let noGroupWarnDay = '';
    /**
     * 进程内跨实例注册表（2026-11-12）。
     *
     * 热重载不保证旧实例走到 teardown，旧的 setInterval 会一直活着。
     * 11-09 的凌晨预热跑两遍、11-12 的播报发 5 遍，都是「每重载一次多一个」。
     * 用 globalThis + Symbol.for 按 dataDir 登记：新实例启动时先停掉同目录的旧实例。
     *
     * 注意：这个登记表只对**装载了新代码的实例**有效。热重载前就已经存在的
     * 旧实例没有登记过，停不掉 —— 那种情况只能靠 reloadFromDisk 的落盘判断兜底，
     * 或者重启一次进程彻底清干净。
     */
    const INSTANCE_KEY = Symbol.for('dsh-qqbot.dota-digest.instances');
    function instances() {
        const g = globalThis;
        let reg = g[INSTANCE_KEY];
        if (reg === undefined) {
            reg = new Map();
            g[INSTANCE_KEY] = reg;
        }
        return reg;
    }
    /**
     * 从磁盘重读摘要。
     *
     * tickQuery / tickDeliver 开头都要读一次：多实例并存时，别的实例写盘的
     * `forDay` / `deliveredAt` 必须立刻可见，否则每个实例都会按自己的内存再发一遍。
     */
    function reloadFromDisk() {
        digest = loadDigest();
    }
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
        // 启动时未设 TZ：必须显式 IANA 时区换算，不能信 getHours()
        const h = hourInTz(new Date(ts), cfg.tz);
        return isHourInRange(h, range[0], range[1]);
    }
    // ── 阶段一：凌晨查询 ──────────────────────────────────────
    /**
     * 给被选中的条目补两块信息，都在脚本侧完成，不交给模型去猜：
     *
     *   1. `party` / `withWho`：同一 matchId 下有几个绑定群友 —— 直接回答
     *      「不是每次开黑人都齐，有时只有两三个」。
     *   2. `detail`：这一局的经济/伤害/团战/技能组合（预取，失败就算了）。
     *
     * 模型只负责组织语言；数据缺了就写「缺」，它没有编的余地。
     */
    async function enrichPicked(picked) {
        if (picked.length === 0)
            return;
        // 1) 同场人数：本地战绩库按 matchId 聚合，不假设固定五人
        for (const it of picked) {
            const match = it.facts.match;
            if (match === undefined)
                continue;
            const matchId = match.matchId ?? it.matchId;
            if (matchId === undefined)
                continue;
            const participants = deps.matchCache?.participantsOf(matchId) ?? [];
            if (participants.length === 0)
                continue;
            const self = deps.toAccountId(it.steamId);
            const others = participants.filter((p) => p.accountId !== self);
            match.party = participants.length;
            if (others.length > 0) {
                match.withWho = others.map((p) => p.alias ?? String(p.accountId));
            }
        }
        // 2) 预取单场详情：最多 maxItems 条，并行；失败只是少一块细节，不影响播报
        const query = deps.queryMatchDetail;
        if (query === undefined)
            return;
        await Promise.all(picked.map(async (it) => {
            const match = it.facts.match;
            if (match === undefined)
                return;
            const accountId = deps.toAccountId(it.steamId);
            if (accountId === null)
                return;
            const matchId = match.matchId ?? it.matchId;
            if (matchId === undefined)
                return;
            try {
                const detail = await query(accountId, matchId);
                if (detail !== undefined)
                    match.detail = detail;
            }
            catch (err) {
                logger.warn(`dota-digest: 预取单场详情失败（不影响播报）match=${matchId}: `
                    + `${err instanceof Error ? err.message : String(err)}`);
            }
        }));
    }
    async function tickQuery(nowTs) {
        if (!cfg.enabled)
            return { ran: false, count: 0, reason: 'disabled' };
        const now = Number(nowTs ?? nowFn()) || nowFn();
        if (!inWindow(now, cfg.queryHours))
            return { ran: false, count: 0, reason: 'not-query-window' };
        const today = dayInTz(new Date(now), cfg.tz);
        // 多实例兜底：先看磁盘上有没有别的实例刚备好的摘要
        reloadFromDisk();
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
            /** 这一轮所有人窗口内的原始局，统一合并进本地战绩库（同场人数靠它算） */
            const rows = [];
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
                const accountId = deps.toAccountId(steamId);
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
                const alias = deps.primaryAlias(typeof b.alias === 'string' ? b.alias : '') || FALLBACK_ALIAS;
                // 收进本地战绩库：只记窗口内的局，避免把几个月前的旧数据灌进来。
                // 同一个人反复查只是覆盖，不同人对同一场是追加 —— 于是「这场几个人」算得出来。
                const cutoff = now - cfg.recentHours * HOUR_MS;
                for (const m of form.matches) {
                    const at = msOfIso(m.startedAt);
                    if (at <= 0 || at < cutoff)
                        continue;
                    rows.push({
                        matchId: m.matchId,
                        startTime: Math.floor(at / 1000),
                        durationSec: m.durationSec,
                        gameMode: m.gameMode,
                        player: {
                            accountId,
                            alias,
                            heroId: m.heroId,
                            heroName: m.heroName,
                            kills: m.kills,
                            deaths: m.deaths,
                            assists: m.assists,
                            win: m.win,
                        },
                    });
                }
                const item = highlightOf({
                    form,
                    openid,
                    alias,
                    steamId,
                    now,
                    recentHours: cfg.recentHours,
                    tz: cfg.tz,
                });
                if (item !== null)
                    items.push(item);
            }
            // 合并进本地战绩库：这一轮所有人在窗口内的局都记下来
            deps.matchCache?.upsertMany(rows);
            // 跨天去重：同一个人 + 同一类亮点 3 天内不重复播（连败/连胜最容易复读）
            const fresh = items.filter((it) => !recentlySent(it, now));
            const picked = sortItems(fresh).slice(0, Math.max(0, Math.floor(cfg.maxItems)));
            if (picked.length === 0) {
                // 查完没亮点也要落一个「今天查过了」的空摘要 ——
                // 否则 tickQuery 每次都会判"还没备好"而重查，2 小时窗口内每分钟跑一遍
                // Steam + OpenDota（2026-11-03 实测约 120 次/天）。
                // tickDeliver 见到空 items 会直接跳过（reason=no-items），不会发空消息。
                const forDay = dayInTz(new Date(now), cfg.tz);
                digest = { version: 1, queriedAt: now, forDay, items: [] };
                save();
                if (items.length > 0) {
                    logger.info(`dota-digest: 这晚只有 ${items.length} 条亮点，但最近 3 天都播过了，不重复发`);
                }
                else {
                    logger.info(`dota-digest: 这一晚没有值得说的战绩（最近 ${cfg.recentHours}h 内无亮点），今天不再重查`);
                }
                return { ran: false, count: 0, reason: 'no-highlight' };
            }
            // 当天查、当天发：forDay 就是今天（不再 +1 天）。
            // 10-12 点查昨晚的比赛，这会儿解析基本都完成了，趁热发才有"锐评"的味道。
            const forDay = dayInTz(new Date(now), cfg.tz);
            // 先把「同场几个人」「这一局详情」补齐，再落盘 —— 落盘的就是播报用的事实
            await enrichPicked(picked);
            digest = { version: 1, queriedAt: now, forDay, items: picked };
            save();
            logger.info(`dota-digest: 今日战绩摘要已备好 ${picked.length} 条，今天内投递`);
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
        const now = Number(nowTs ?? nowFn()) || nowFn();
        if (!inWindow(now, cfg.deliverHours))
            return { sent: false, reason: 'not-deliver-window' };
        // 多实例兜底：先看磁盘上有没有别的实例刚投递过
        reloadFromDisk();
        if (digest === null)
            return { sent: false, reason: 'no-digest' };
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
        // 当天空摘要（查过但没有亮点）→ 别往下走，buildDeliverText 会拿到空数组
        if (digest.items.length === 0)
            return { sent: false, reason: 'no-items' };
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
        if (groupId === null || groupId === '') {
            // 以前这里直接 return，什么都不记 —— 于是「一整天没播报」只能靠翻状态文件反推。
            // 2026-11-02 就是这么悄无声息过去的：摘要备好 2 条，然后在选群处空转一百多次。
            if (noGroupWarnDay !== today) {
                noGroupWarnDay = today;
                logger.warn('dota-digest: 选不到能发的群（内存里没有存活群会话，也没有历史活跃群记录），'
                    + `今天的战绩摘要发不出去（forDay ${digest.forDay}）`);
            }
            return { sent: false, reason: 'no-group' };
        }
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
        // 同 dataDir 的旧实例先停掉：热重载后不留双份定时器
        const reg = instances();
        const key = path.resolve(dataDir);
        const prev = reg.get(key);
        if (prev !== undefined) {
            try {
                prev.stop();
            }
            catch {
                // 旧实例可能已经半停，忽略
            }
        }
        reg.set(key, { stop });
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
        // 从跨实例登记表里撤掉自己，避免新实例停一个已经停过的旧实例
        const reg = instances();
        const key = path.resolve(dataDir);
        if (reg.get(key)?.stop === stop)
            reg.delete(key);
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