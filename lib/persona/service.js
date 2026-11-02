/**
 * persona · 装配器
 * ─────────────────────────────────────────────────────────────
 * 把移植自 ai-companion-kit 的五个模块（Role/Memory/Waker/Humanizer/Diary）
 * 与 own-life 静默唤醒装配成一个服务，暴露给：
 *   - session-manager：system-prompt/assemble 注入（人格 + 记忆 + 日记）
 *   - inbound：Waker 判定 + 对话流水记账
 *   - outbound：Humanizer 拟人化发送 + 回复记账
 *   - bootstrap：工具注册（qq_write_diary / qq_read_diary / qq_memory_append）
 *                + own-life 定时静默唤醒 + 主动消息预算/冷退避
 */
import fs from 'node:fs';
import path from 'node:path';
import { Memory } from "./memory.js";
import { Diary } from "./diary.js";
import { Role } from "./role.js";
import { Waker } from "./wake.js";
import { SelfProfileService } from "./self.js";
import { VoiceService } from "./voice.js";
import { SelfNoteService } from "./self-note.js";
import { EmotionService, speakWillingness, typingSpeedFactor, burstLimit, describeEmotion } from "./emotion.js";
import { runSurfRound, inSurfWindow, surfTopic } from "./surf.js";
import { clockInTz, weekdayInTz, dayInTz, hourInTz, DEFAULT_TZ } from "./clock.js";
import { Humanizer } from "./humanize.js";
import { extractFact, extractTrait } from "./fact-extract.js";
import { matchesTopic } from "./word-match.js";
import { pickDiaryMaterial, composeDiaryText, readTurnsOfDay, shouldWriteDiary } from "./diary-auto.js";
import { createOwnLife } from "./own-life.js";
import { createScreenWatch } from "./screen-watch.js";
/**
 * 主动消息预算 + 冷启动退避（DESIGN §4）。
 * streak≥2 冷却 3 天，≥3 冷却 14 天，≥5 永久静默该 peer。
 */
export class ProactiveBudget {
    maxPerPeerPerDay;
    minGapMs;
    logger;
    peers = new Map();
    daily = new Map();
    dayKey = '';
    constructor(maxPerPeerPerDay, minGapMs, logger) {
        this.maxPerPeerPerDay = maxPerPeerPerDay;
        this.minGapMs = minGapMs;
        this.logger = logger;
    }
    day() {
        // 必须用北京时区：「每日上限」的边界应该在北京零点切换，
        // 用容器本地时区（UTC）会让每天从北京 08:00 才开始，早上的主动消息会被算进前一天。
        return dayInTz(new Date(), DEFAULT_TZ);
    }
    /**
     * 只读快照（不创建占位）。给 PersonaService 结算情绪用 ——
     * 它需要在 observe 前后各看一次 unansweredStreak 才知道"这次算不算失落"。
     */
    peerSnapshot(id) {
        return this.peers.get(id);
    }
    peer(id) {
        let p = this.peers.get(id);
        if (!p) {
            p = { lastProactiveAt: 0, unansweredStreak: 0, mutedUntil: 0 };
            this.peers.set(id, p);
        }
        return p;
    }
    /** 是否允许对该 peer 主动推送 */
    allow(peerId) {
        const today = this.day();
        if (today !== this.dayKey) {
            this.daily.clear();
            this.dayKey = today;
        }
        const p = this.peer(peerId);
        const now = Date.now();
        if (p.mutedUntil === -1)
            return { ok: false, reason: 'muted-forever' };
        if (now < p.mutedUntil)
            return { ok: false, reason: 'cooling' };
        if ((this.daily.get(peerId) ?? 0) >= this.maxPerPeerPerDay)
            return { ok: false, reason: 'daily-cap' };
        if (now - p.lastProactiveAt < this.minGapMs)
            return { ok: false, reason: 'too-soon' };
        return { ok: true };
    }
    /** 记一次主动推送 */
    recordProactive(peerId) {
        // 必须和 allow() 一样先过一次日切。
        // 踩过的坑（2026-11-01）：原来这里只写 daily 不动 dayKey，
        // 而 allow() 开头发现 today !== dayKey（初值是 ''）就把 daily 清空，
        // 于是**刚记录的计数立刻被抹掉** → 每日上限永远不生效（真实 bug，非测试问题）。
        const today = this.day();
        if (today !== this.dayKey) {
            this.daily.clear();
            this.dayKey = today;
        }
        const p = this.peer(peerId);
        p.lastProactiveAt = Date.now();
        p.staleCounted = false;
        this.daily.set(peerId, (this.daily.get(peerId) ?? 0) + 1);
    }
    /** 主动推送后对方无响应（own-life 决定发消息但对方没回） */
    markUnanswered(peerId) {
        const p = this.peer(peerId);
        p.unansweredStreak += 1;
        const now = Date.now();
        if (p.unansweredStreak >= 5) {
            p.mutedUntil = -1;
            this.logger.info(`persona: budget peer ${peerId} muted forever (streak=${p.unansweredStreak})`);
        }
        else if (p.unansweredStreak >= 3) {
            p.mutedUntil = now + 14 * 24 * 3600_000;
        }
        else if (p.unansweredStreak >= 2) {
            p.mutedUntil = now + 3 * 24 * 3600_000;
        }
    }
    /** 对方主动说话 → 清零（这是社交意义上"理你了"） */
    markReplied(peerId) {
        const p = this.peer(peerId);
        // 只有"在我方最后一次主动推送之后来的消息"才算理你了（防 observe 交替重计）
        if (p.lastProactiveAt === 0 || Date.now() >= p.lastProactiveAt)
            p.staleCounted = false;
        if (p.unansweredStreak > 0) {
            p.unansweredStreak = 0;
            p.mutedUntil = 0;
        }
    }
    /**
     * 观察 peer 的最近活跃时间：若晚于我方最后一次主动推送，
     * 视为"理你了"清零；否则在下次投递前记一次未响应。
     * （inbound 直接调 markReplied；本方法供 own-life 投递前结算用）
     */
    observe(peerId, lastActivityAt) {
        const p = this.peer(peerId);
        if (p.lastProactiveAt === 0)
            return;
        if (lastActivityAt > p.lastProactiveAt)
            this.markReplied(peerId);
        else if (!p.staleCounted) {
            p.staleCounted = true;
            this.markUnanswered(peerId);
        }
    }
    /** 定期清理（审查 m9）：清掉从未主动推送过的纯占位空壳。
     *  正在冷退避、永久静默、以及近期主动过的 peer 保留（语义不能丢）。 */
    prune(staleMs = 30 * 24 * 3600_000) {
        const now = Date.now();
        let removed = 0;
        for (const [id, p] of this.peers) {
            const active = p.lastProactiveAt > 0 && now - p.lastProactiveAt < staleMs;
            const inCooldown = p.mutedUntil !== 0; // >0 冷却中，-1 永久静默
            if (!active && !inCooldown && p.unansweredStreak === 0) {
                this.peers.delete(id);
                removed += 1;
            }
        }
        return removed;
    }
}
export class PersonaService {
    deps;
    memory;
    diary;
    role;
    waker;
    /** 她自己的画像（称呼偏好 / 兴趣 / 话痨度 / 冲浪见闻） */
    self;
    /** 她的口癖（M11：从"被接住的话"里长出来的说话习惯） */
    voice;
    /** 她对自己的认识（M16：L4 层，她自己写的成长叙述） */
    selfNote;
    /** 情绪（M31：三个数字，接在四个行为闸门上，不进提示词当描述） */
    emotion;
    humanizer;
    budget;
    ownLife;
    /** 冲浪定时器（M6：低峰时段上网搜集她感兴趣的内容） */
    surfTimer;
    /** 看屏幕观察（M7/R7，默认关；只在 screenWatchEnabled 时存在） */
    screenWatch;
    /** 轮内记账暂存（sessionId → 用户/回复文本），turn/end 配对写流水后清除。
     *  刻意不挂 SessionRecord：deliverables 等既有路径对 record 做深比较 */
    turnLedger = new Map();
    /**
     * 上一次对话轮结束的时间（M31：用来判断"中间是不是睡了一觉"）。
     *
     * M33：**必须落盘**。原来它是纯内存字段，进程一重启就归零 →
     * 重启后第一次 flushTurn 被 `last > 0` 挡掉（正确），
     * 但第二次因为 `now - last` 很小，于是"睡了一觉"的时间维度整个丢失。
     * 而 `onRest` 是 energy 的**唯一正向来源**，压在易失字段上等于
     * "重启越频繁，她越累"。改从 `state/last-turn.json` 读，
     * 拿不到再回落到内存值。
     */
    lastTurnAt = 0;
    lastTurnFile;
    pruneTimer;
    /** 读取上次轮末时间（优先落盘值，失败回落内存） */
    loadLastTurnAt() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.lastTurnFile, 'utf8'));
            const n = raw.at;
            if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
                this.lastTurnAt = n;
            }
        }
        catch {
            /* 文件不存在/坏档 → 用内存值（通常是 0，即"不知道上次什么时候") */
        }
        return this.lastTurnAt;
    }
    /** 写回上次轮末时间（失败只记日志，不影响主流程） */
    persistLastTurnAt(at) {
        this.lastTurnAt = at;
        try {
            fs.mkdirSync(path.dirname(this.lastTurnFile), { recursive: true });
            const tmp = `${this.lastTurnFile}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ at }, null, 1), 'utf8');
            fs.renameSync(tmp, this.lastTurnFile);
        }
        catch (err) {
            this.deps.logger.warn(`persona: 写入 last-turn 失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    constructor(deps) {
        this.deps = deps;
        const { config, dataDir, logger } = deps;
        this.lastTurnFile = path.join(dataDir, 'state', 'last-turn.json');
        this.memory = new Memory({ dir: path.join(dataDir, 'memory') });
        this.diary = new Diary(path.join(dataDir, 'diary'));
        this.self = new SelfProfileService(dataDir, (m) => logger.info(m));
        this.voice = new VoiceService(dataDir, (m) => logger.info(m));
        this.selfNote = new SelfNoteService(dataDir, (m) => logger.info(m));
        this.emotion = new EmotionService(dataDir, (m) => logger.info(m));
        this.loadLastTurnAt();
        if (config.roleCardPath) {
            this.role = new Role({ cardPath: config.roleCardPath, maxChars: config.roleMaxChars });
            const l = this.role.lint();
            if (!l.ok)
                logger.warn(`persona: 角色卡体检: ${l.warn.join(' | ')}`);
            else
                logger.info('persona: 角色卡体检通过');
        }
        if (config.wakeEnabled) {
            const baselineNames = [...config.names];
            const waker = new Waker({
                names: baselineNames,
                keywords: config.keywords,
                ownerIds: config.ownerOpenids,
                probability: config.groupProbability,
                idleDiveThreshold: config.idleDiveThreshold,
            });
            // 兴趣驱动唤醒：从 self.json 实时取兴趣与话痨度
            waker.setInterestProvider(() => {
                const snap = this.self.snapshot();
                return {
                    interests: snap.interests.map((i) => ({ topic: i.topic, weight: i.weight })),
                    // M30：讨厌的话题把唤醒概率打下来（在 wake.ts 的公式里做减法）
                    dislikes: (snap.dislikes ?? []).filter((i) => !i.frozen).map((i) => ({ topic: i.topic, weight: i.strength ?? i.weight })),
                    chattiness: this.self.chattiness(),
                    // M31 闸门①：心情好坏影响"愿不愿意主动开口"（0.6~1.4 倍）
                    moodFactor: speakWillingness(this.emotion.current()),
                    baseProbability: config.interestBaseProbability,
                };
            });
            // 动态称呼：配置名 ∪ 她自己接受的称呼
            waker.setNameProvider(() => {
                const extra = this.self.activeNames();
                return extra.length > 0 ? [...new Set([...baselineNames, ...extra])] : baselineNames;
            });
            this.waker = waker;
        }
        this.humanizer = new Humanizer({
            enabled: config.humanizeEnabled,
            msPerChar: config.msPerChar,
            burstMax: config.burstMax,
            gapRange: config.gapMinMs && config.gapMaxMs ? [config.gapMinMs, config.gapMaxMs] : undefined,
            // M31 闸门②③：情绪影响打字快慢（累了会拖）与分几条发（激动时连发）
            mood: () => {
                const st = this.emotion.current();
                return { speed: typingSpeedFactor(st), burst: burstLimit(st, config.burstMax) };
            },
        });
        this.budget = new ProactiveBudget(config.maxProactivePerDay, config.proactiveMinGapMs, logger);
        // 周期清理 Waker/Budget 的过期会话状态（审查 m9）——每 6h 一次
        this.pruneTimer = setInterval(() => this.pruneStale(), 6 * 3600_000);
        if (typeof this.pruneTimer.unref === 'function')
            this.pruneTimer.unref();
    }
    /** 清掉长期无活跃的会话配置/预算占位（waker + budget） */
    pruneStale() {
        const SW = 30 * 24 * 3600_000;
        const a = this.waker?.prune(SW) ?? 0;
        const b = this.budget.prune(SW);
        if (a || b)
            this.deps.logger.info(`persona: prune 清理 waker=${a} budget=${b}`);
        this.decaySelf();
        // M32：口癖退役体检（原来也是零调用 —— 长期不用的口癖永远不会退役）
        try {
            const retired = this.voice.retireStale();
            if (retired)
                this.deps.logger.info(`persona: ${retired} 条口癖因长期不用退役`);
        }
        catch {
            /* 不影响主流程 */
        }
        // M31：心情也在动，但它是**最容易被写成死代码**的那类数据
        // （算出来了没人看）。每 6 小时打一行，让"她的情绪"在日志里可见 ——
        // 出问题时能一眼看出是"真的没波动"还是"根本没在跑"。
        this.deps.logger.info(`persona: 心情 ${describeEmotion(this.emotion.current())}`);
    }
    /**
     * 兴趣/厌恶惰性衰减（M30 修的一处死链）。
     *
     * 实测发现：`decayInterests()` 从写出来那天起**没有任何调用点** ——
     * 也就是说「兴趣会随时间淡掉」这条设计一直是文档里的话，代码里从没跑过。
     * 表现就是 self.json 里的兴趣强度只会涨不会跌，最后全都顶到 1.0。
     *
     * 挂在 pruneStale 里（每 6h 一次）而不是单独起定时器：
     * 衰减本来就是小时级的慢变量，6h 的粒度足够；少一个定时器少一处电量开销。
     */
    decaySelf() {
        try {
            const now = Date.now();
            const fi = this.self.decayInterests(now);
            const fd = this.self.decayDislikes(now);
            if (fi || fd)
                this.deps.logger.info(`persona: 衰减冻结 兴趣=${fi} 厌恶=${fd}`);
            // M32：被嫌吵之后的话痨度恢复（原来也是零调用 —— 一旦被嫌就永远安静下去）
            const before = this.self.chattiness();
            this.self.recoverIfCalm(now);
            const after = this.self.chattiness();
            if (after !== before)
                this.deps.logger.info(`persona: 24h 没再被嫌，话痨度 ${before.toFixed(2)} → ${after.toFixed(2)}`);
        }
        catch (err) {
            this.deps.logger.warn(`persona: 衰减失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /**
     * 投递前结算"上次主动消息有没有被理"，并据此写情绪（M31 写入点③）。
     *
     * 为什么必须在这里而不是在 ProactiveBudget 里：
     * `ProactiveBudget` 是纯计数/退避的状态机，它不该知道"情绪"这种语义。
     * 但我第一版把 onIgnored 写进了 budget 的 markUnanswered —— 编译不过，
     * 于是把它删了，结果**忘了在 service 侧补回来**，
     * 导致"最重要负向写入点"静默消失了（被死代码审计抓到）。
     *
     * 这条链的重要性：情绪只有 onAddressed/onReplied 两个正向源时，
     * valence 会长期贴在上限，speakWillingness 锁在 1.4 ——
     * 正好复现 feiyu-mood 的"永远开心 = 没有心情"。
     */
    observePeer(peerId, lastActivityAt) {
        const p = this.budget.peerSnapshot(peerId);
        const wasProactive = (p?.lastProactiveAt ?? 0) > 0;
        const wasAnswered = wasProactive && lastActivityAt > (p?.lastProactiveAt ?? 0);
        const before = p?.unansweredStreak ?? 0;
        this.budget.observe(peerId, lastActivityAt);
        // 只有"确实主动过、且这次算没被理"才记一次失落（不能重复计）
        if (wasProactive && !wasAnswered) {
            const after = this.budget.peerSnapshot(peerId)?.unansweredStreak ?? 0;
            if (after > before)
                this.emotion.onIgnored();
        }
    }
    /**
     * 记一次"她可能被叫成什么"（M32）。
     *
     * `recordNameCall()` 原来零调用 → names 候选永远是空的 →
     * `qq_decide_name`（"她能拒绝某个称呼"）面对一个永远为空的列表，
     * 等于一个永远点不动的按钮。
     *
     * 已配置的名字、已接受的称呼都不算候选（否则会把自己的名字记成"新称呼"）。
     */
    notePossibleName(name) {
        const known = new Set([...this.deps.config.names, ...this.self.activeNames()]);
        if (!name || known.has(name))
            return { isNew: false, reachedThreshold: false };
        const r = this.self.recordNameCall(name);
        return { isNew: r.isNew, reachedThreshold: r.reachedThreshold };
    }
    /** 该 peer 的注入 section（人格 + 该人的账 + 日记连续性）；空数组 = 不注入 */
    buildSections(personKey) {
        const out = [];
        if (this.role) {
            const text = this.role.renderSection();
            if (text)
                out.push({ name: 'qqbot:persona-role', order: 60, text });
        }
        // M11 口癖（order 61，紧跟角色卡）：只有被确认的口癖才会注入
        const voiceSec = this.voice.renderSection();
        if (voiceSec)
            out.push({ name: 'qqbot:persona-voice', order: 61, text: voiceSec });
        if (personKey) {
            const ledger = this.memory.renderPerson(personKey);
            if (ledger)
                out.push({ name: 'qqbot:persona-memory', order: 62, text: ledger });
        }
        const diaryCtx = this.diary.context(3);
        if (diaryCtx)
            out.push({ name: 'qqbot:persona-diary', order: 64, text: diaryCtx });
        // M16 L4 selfNote：她对自己的认识（只在有内容时注入）
        const selfSec = this.selfNote.renderSection();
        if (selfSec)
            out.push({ name: 'qqbot:persona-selfnote', order: 65, text: selfSec });
        // M30 口味：她喜欢/讨厌什么。
        // 必须注入 —— dislikes 已经在唤醒闸门上让她变沉默了，
        // 如果她自己不知道讨厌什么，那个沉默在她那里就是"莫名其妙不想说话"。
        const tasteSec = this.self.renderSection();
        if (tasteSec)
            out.push({ name: 'qqbot:persona-taste', order: 66, text: tasteSec });
        // M33 称呼候选（order 67，紧跟口味）：**这是 `recordNameCall` 的读端**。
        //
        // 复核 8a94319 时发现：写端接了、读端没接 —— 候选名写进 self.json 之后
        // 没有任何消费者，`qq_decide_name` 要模型自己填名字，而模型根本不知道
        // 有哪些候选。结果"等她表态"只是日志里一句话，工具永远收不到调用。
        //
        // 和口味段同一个道理：数据必须进上下文，否则她无法对自己的状态表态。
        const nameCandSec = this.self.renderNameCandidates();
        if (nameCandSec)
            out.push({ name: 'qqbot:persona-name-candidates', order: 67, text: nameCandSec });
        // M13 抗漂移锚点：硬约束放在**最后一个 order**（尽量贴近生成点）。
        // 之前拼在 user message 里会污染上下文、还有被复述的风险；
        // 放在 system prompt 末尾既保持"靠近生成"的效果，又不进对话内容。
        const anchor = this.role?.renderAnchor();
        if (anchor)
            out.push({ name: 'qqbot:persona-anchor', order: 998, text: anchor });
        return out;
    }
    /** P6：时间感上下文——"几点了 / 周几 / 距上次聊了多久"，给人格现实锚点。
     *  距上次由调用方传入 lastActivityAt（ms）；缺省则不拼该句。 */
    static timeSection(now = new Date(), lastActivityAt) {
        // 修复：容器无 tzdata，getHours() 是 UTC → 时间感会差 8 小时
        const hhmm = clockInTz(now, DEFAULT_TZ);
        const weekdayIdx = weekdayInTz(now, DEFAULT_TZ);
        const week = ['日', '一', '二', '三', '四', '五', '六'][weekdayIdx];
        let mindist = '';
        if (lastActivityAt) {
            const mins = Math.max(0, Math.round((now.getTime() - lastActivityAt) / 60000));
            if (mins >= 1)
                mindist = ` · 距上次聊了约 ${mins >= 60 ? `${Math.floor(mins / 60)}小时${mins % 60 ? `${mins % 60}分` : ''}` : `${mins}分`}`;
        }
        return {
            name: 'qqbot:persona-clock',
            order: 63,
            text: `[当前时间 ${hhmm} · 星期${week}${mindist}]`,
        };
    }
    /** 启动 own-life 静默唤醒（deliver 由 bootstrap 注入：向 owner 存活会话 followup 一条静默消息） */
    startOwnLife(deliver) {
        if (!this.deps.config.ownLifeEnabled)
            return;
        this.ownLife = createOwnLife({
            deliver,
            statePath: path.join(this.deps.dataDir, 'state', 'own-life.json'),
            intervalMs: this.deps.config.ownLifeIntervalMs,
            // M31 闸门④：心情影响"想不想主动说话"
            moodFactor: () => speakWillingness(this.emotion.current()),
            maxPerDay: this.deps.config.ownLifeMaxPerDay,
            // quiet = "这个时段别打扰她"，语义是**禁止**（own-life.ts: inQuiet → skipped:'quiet'）。
            //
            // 踩过的坑（2026-11-01 实测）：之前写成 [surfToHour, surfFromHour] = [7,3]，
            // 而 isHourInRange 对 from>to 的解释是 "hour>=from || hour<to" → 覆盖 7点到次日3点，
            // 也就是说**大半天都被禁掉了**，她唯一能自由活动的时间只剩 3-7 点的冲浪时段。
            // 结果：own-life.json 里 lastFiredAt 有值但 firedToday=0 —— 触发了却被静默跳过。
            //
            // 正确语义应该按"睡觉时段"来：深夜到清晨别叫，白天晚上都算她的时间。
            quiet: [23, 8],
            log: (m) => this.deps.logger.info(`persona: own-life ${m}`),
        });
        this.ownLife.start();
    }
    /**
     * 启动看屏幕定时观察（M7/R7）。
     * deliver 由 bootstrap 注入：只向**存活的** owner 会话静默 followup，
     * 不发 QQ 消息；预算闸与话痨度闸都在 screen-watch 内部过。
     */
    startScreenWatch(probe, deliver) {
        const cfg = this.deps.config;
        if (!cfg.screenWatchEnabled)
            return undefined;
        const ownerId = cfg.ownerOpenids[0] ?? 'owner';
        this.screenWatch = createScreenWatch({
            probe,
            deliver,
            interests: () => this.self.topInterests(8).map((i) => ({ topic: i.topic, weight: i.strength ?? i.weight })),
            chattiness: () => this.self.chattiness(),
            allowProactive: () => this.budget.allow(ownerId),
            markProactive: () => this.budget.recordProactive(ownerId),
            allowedApps: cfg.screenWatchAllowedApps,
            intervalMs: cfg.screenWatchIntervalMs,
            activeHours: cfg.screenWatchActiveHours,
            statePath: path.join(this.deps.dataDir, 'state', 'screen-watch.json'),
            log: (m) => this.deps.logger.info(`persona: screen-watch ${m}`),
        });
        this.screenWatch.start();
        return this.screenWatch;
    }
    /**
     * 按需冲浪（供 qq_browse 工具调用）。
     *
     * 与 startSurf 的区别：这是**她主动想查**的时候用，不受 3-7 点时段限制。
     * 实测事故（2026-11-01）：用户让她"去逛逛"，她没有工具可用，
     * 结果**编造了具体文章**（"散文吧有篇《修鞋摊子收起来了》"）。
     * 有了这个入口，她就能真的查，查不到也如实说查不到。
     */
    surf(topic, opts = {}) {
        const t = String(topic ?? '').trim();
        if (!t)
            return undefined;
        try {
            const r = surfTopic(t, { deep: opts.deep === true, maxFindings: 5 });
            return r;
        }
        catch (err) {
            this.deps.logger.warn(`persona: 按需冲浪失败 ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
    }
    /**
     * 启动自主冲浪（M6）。
     * 只在 surfEnabled 且处于冲浪时段（默认凌晨 3-7 点）时跑；
     * 每 30 分钟检查一次，同一时段内最多跑一轮（用 lastSurfAt 防重复）。
     * 结果写进 self.json 的 findings，**不占主上下文**。
     */
    startSurf() {
        const cfg = this.deps.config;
        if (!cfg.surfEnabled)
            return;
        const log = this.deps.logger;
        const tick = () => {
            if (!inSurfWindow(new Date(), cfg.surfFromHour, cfg.surfToHour))
                return;
            // 同一冲浪时段内只跑一轮（2 小时内已冲过就跳过）
            const last = this.self.snapshot().lastSurfAt ?? 0;
            if (Date.now() - last < 2 * 3600_000)
                return;
            try {
                log.info('persona: 冲浪开始');
                const results = runSurfRound(this.self, {
                    maxTopics: cfg.surfMaxTopics,
                    deep: cfg.surfDeep,
                    log: (m) => log.info(`persona: ${m}`),
                });
                const total = results.reduce((a, r) => a + r.findings.length, 0);
                log.info(`persona: 冲浪完成，${results.length} 个话题 / ${total} 条见闻`);
                // 收集到的内容对下次对话有用 → 静默告知 agent（如果 owner 会话存活）
                if (total > 0)
                    this.notifySurfResults(results);
            }
            catch (err) {
                log.warn(`persona: 冲浪失败 ${err instanceof Error ? err.message : String(err)}`);
            }
        };
        this.surfTimer = setInterval(tick, 30 * 60 * 1000); // 每 30 分钟检查
        if (typeof this.surfTimer.unref === 'function')
            this.surfTimer.unref();
        log.info(`persona: 冲浪已武装 · 时段 ${cfg.surfFromHour}:00-${cfg.surfToHour}:00 · 每轮最多 ${cfg.surfMaxTopics} 话题`);
    }
    /** 把冲浪结果静默投递给存活的 owner 会话（不占主上下文，不主动发消息） */
    surfDeliver;
    /** 由 bootstrap 注入静默投递函数 */
    setSurfDeliver(fn) {
        this.surfDeliver = fn;
    }
    notifySurfResults(results) {
        if (!this.surfDeliver)
            return;
        const lines = ['[内部·你刚自己上网看的东西，不用复述本提示]'];
        for (const r of results) {
            if (r.findings.length === 0)
                continue;
            lines.push(`关于「${r.topic}」：`);
            for (const f of r.findings)
                lines.push(`- ${f.title}：${f.summary}`);
        }
        try {
            this.surfDeliver(lines.join('\n'));
        }
        catch {
            /* 投递失败不影响 */
        }
    }
    stop() {
        this.ownLife?.stop();
        this.screenWatch?.stop();
        if (this.pruneTimer)
            clearInterval(this.pruneTimer);
    }
    /** inbound：本轮用户消息与其发言人（空串也记，覆盖上一轮残留） */
    noteUserTurn(sessionId, text, who) {
        const cur = this.turnLedger.get(sessionId) ?? { reply: '' };
        this.turnLedger.set(sessionId, { ...cur, user: text, who });
    }
    /** outbound：累积本轮已发送回复（截断 300 字，与 memory.logTurn 对齐） */
    noteReplyChunk(sessionId, text) {
        const cur = this.turnLedger.get(sessionId) ?? { reply: '' };
        this.turnLedger.set(sessionId, { user: cur.user, who: cur.who, reply: (cur.reply + ' ' + text).slice(0, 300) });
        // M11：记下她说的话，等后续判定是否被"接住"（key 用 sessionId 即可，只需同会话判定）
        this.voice.recordUtterance(`${sessionId}#${Date.now()}`, sessionId, text);
        // M32：口癖使用计数。
        //
        // `markUsed()` 原来零调用 → `lastSaidAt` 永远是 undefined →
        // `retireStale()` 会按"上次使用时间"判定退役，而那个时间从来没被写过。
        // 更直接的问题是 `h.count` 永远不涨，于是"这条口癖被用过几次"永远是接手时的数字。
        //
        // 判据：她这条回复里真的出现了这条口癖的词面。简单、可解释，
        // 但只认**完整词面出现**，不做模糊匹配（错记会让退役判断失真）。
        if (text) {
            for (const h of this.voice.activeHabits()) {
                if (h.style && text.includes(h.style))
                    this.voice.markUsed(h.id);
            }
        }
    }
    /** inbound：判定她之前的发言是否被接住（M11） */
    /**
     * 她说的话被接住了吗（口癖学习的正样本来源）。
     *
     * M32：这条链原来只做了第一步 —— `judgeIncoming` 攒正样本，
     * 但下游 `extractCandidates`（抽候选）和 `promoteHabits`（转正）
     * **零调用**。结果是：
     *   · 样本攒到 60 条被 shift() 丢掉
     *   · habits 永远是空数组
     *   · 而 persona-health 按"正样本 N 条"报进度，看起来一切正常
     * —— 不只是没功能，是**谎报健康**。
     *
     * 现在：攒够 4 条就抽一次候选；每次抽完尝试转正。
     */
    judgeVoice(sessionId, humanText) {
        if (!humanText)
            return;
        const caught = this.voice.judgeIncoming(sessionId, humanText);
        if (!caught.length)
            return;
        // 攒够就抽（extractCandidates 内部还有 <4 条直接返回的保护）
        if (this.voice.caughtSampleCount() >= 4) {
            const cands = this.voice.extractCandidates();
            if (cands.length)
                this.deps.logger.info(`persona: 口癖候选 +${cands.length}`);
        }
        this.voice.promoteHabits();
    }
    /** outbound turn/end：配对写入跨场合流水并清暂存。
     *  who 优先取本轮实际发言人（群会话 record.senderId 是会话创建者，会记错人） */
    flushTurn(sessionId, where, fallbackWho) {
        const entry = this.turnLedger.get(sessionId);
        this.turnLedger.delete(sessionId);
        if (!entry)
            return;
        // ── M31 写入点：睡够了 → 精力回升 ──
        // onRest 是 energy 的**唯一正向**来源，其余五个写入点里三个是负向、
        // 两个不影响 energy。不接它的话 energy 只降不升，几天后永远"很累"。
        // 判据用"距上次任何消息超过 6 小时"，近似于"中间睡了一觉"。
        {
            const now = Date.now();
            const last = this.lastTurnAt;
            if (last > 0 && now - last >= 6 * 3600_000)
                this.emotion.onRest();
            // M33：落盘，否则重启后这个时间维度就丢了
            this.persistLastTurnAt(now);
        }
        const user = (entry.user ?? '').trim();
        const reply = entry.reply.trim();
        if (user || reply)
            this.memory.logTurn({ where, who: entry.who ?? fallbackWho, text: user, reply });
        // ── M31 情绪写入点②：她说了话、而且对方也说了话 → 这是"聊起来了" ──
        // 判据用"本轮既有她的回复又有对方的话"，而不是"来了条消息"——
        // 后者在她没说话时也会触发，等于白送心情。
        if (reply && user)
            this.emotion.onReplied();
        // ── M31 情绪写入点④：深夜还在聊 → 精力下降 ──
        // 时间必须用北京时间算（容器无 tzdata，getHours() 是 UTC）
        if (user || reply)
            this.emotion.onNightChat(hourInTz(new Date(), DEFAULT_TZ));
        // ── M23：事实硬触发 ──
        // 实测失效：3 个人 89 次交互，实质记忆 0 条。
        // 根因是"指望模型自觉调 qq_memory_append"≈不写（群聊里 0 次）。
        // 改成每轮由代码抽一次，不依赖她想起用工具。
        this.autoRemember(entry.who ?? fallbackWho, user);
        // ── M30：兴趣续命（同样是硬触发）──
        this.touchMentionedInterests(user);
        this.autoDiary();
    }
    /**
     * 聊天里聊到她感兴趣的话题 → 该兴趣续命（刷新 lastAt）。
     *
     * 为什么必须自动做：衰减的计时基准是 `lastAt`，而刷新 `lastAt` 原本只有
     * 两条路 —— 她主动调 qq_mark_interest、或冲浪拿到新东西。两条都依赖
     * "她自觉"，而实测她几乎从不调那个工具。
     *
     * 后果很硬：`current` 类兴趣按 24h 半衰，没有续命就会被
     * "聊得越多反而越接近过期"反噬 —— 实测她 4 条 current 兴趣里
     * 唯一活着的那条已 5.7 天没刷新，接上衰减的那一刻会直接
     * 从 0.335 掉到 0.0064 被冻结。**不接这条，衰减等于一键清空。**
     *
     * 用「对方说的话」判断而不是她的回复：她被勾起来是因为**话题出现了**，
     * 不是因为她自己提了一嘴。
     */
    touchMentionedInterests(userText) {
        if (!userText)
            return;
        try {
            for (const i of this.self.snapshot().interests) {
                if (i.frozen)
                    continue;
                if (matchesTopic(userText, i.topic))
                    this.self.touchInterest(i.topic);
            }
        }
        catch {
            /* 续命失败不影响主流程 */
        }
    }
    /**
     * 从用户原话里抽事实/话题/性格，自动写进人物账本。
     *
     * 原则：宁可少抽，不要错抽 —— 错记比不记更糟（她会把编的东西当真）。
     * 规则见 fact-extract.ts：只抽"对方说的关于他自己的事"，隐私一律不记。
     */
    /**
     * 日记硬触发：当天聊过就在当天写一条，不问她要不要写。
     *
     * 实测：diary/ 曾长期为 0 个文件 —— "指望模型自觉写"就是不写。
     * 只在"当天还没写过"时触发，避免每条消息都写。
     */
    autoDiary() {
        try {
            // 用显式时区算"今天"（容器无 tzdata，getDate() 是 UTC，会差 8 小时）
            const day = dayInTz(new Date(), DEFAULT_TZ);
            // 当天已经写过就不重复
            const already = this.diary.recent(30).some((e) => e.day === day);
            if (already)
                return;
            const turnsFile = path.join(this.deps.dataDir, 'memory', 'turns.jsonl');
            const turns = readTurnsOfDay(turnsFile, day);
            if (!shouldWriteDiary(turns.length, already))
                return;
            const text = composeDiaryText(pickDiaryMaterial(turns));
            if (!text)
                return;
            this.diary.add({ text, mood: turns.length >= 20 ? '说累了' : '平常' });
        }
        catch {
            /* 日记写失败不影响主流程 */
        }
    }
    autoRemember(who, userText) {
        if (!who || !userText)
            return;
        try {
            const f = extractFact(userText);
            const trait = extractTrait(userText);
            if (!f && !trait)
                return;
            this.memory.remember(who, {
                ...(f?.fact ? { fact: f.fact } : {}),
                ...(f?.topic ? { topic: f.topic } : {}),
                ...(trait ? { trait } : {}),
            });
        }
        catch {
            /* 抽取失败不影响主流程 */
        }
    }
}
//# sourceMappingURL=service.js.map