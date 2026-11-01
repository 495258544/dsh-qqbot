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
import path from 'node:path';
import { Memory } from "./memory.js";
import { Diary } from "./diary.js";
import { Role } from "./role.js";
import { Waker } from "./wake.js";
import { SelfProfileService } from "./self.js";
import { VoiceService } from "./voice.js";
import { SelfNoteService } from "./self-note.js";
import { runSurfRound, inSurfWindow, surfTopic } from "./surf.js";
import { clockInTz, weekdayInTz, DEFAULT_TZ } from "./clock.js";
import { Humanizer } from "./humanize.js";
import { extractFact, extractTrait } from "./fact-extract.js";
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
        const d = new Date();
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
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
    pruneTimer;
    constructor(deps) {
        this.deps = deps;
        const { config, dataDir, logger } = deps;
        this.memory = new Memory({ dir: path.join(dataDir, 'memory') });
        this.diary = new Diary(path.join(dataDir, 'diary'));
        this.self = new SelfProfileService(dataDir, (m) => logger.info(m));
        this.voice = new VoiceService(dataDir, (m) => logger.info(m));
        this.selfNote = new SelfNoteService(dataDir, (m) => logger.info(m));
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
            waker.setInterestProvider(() => ({
                interests: this.self.snapshot().interests.map((i) => ({ topic: i.topic, weight: i.weight })),
                chattiness: this.self.chattiness(),
                baseProbability: config.interestBaseProbability,
            }));
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
    }
    /** inbound：判定她之前的发言是否被接住（M11） */
    judgeVoice(sessionId, humanText) {
        if (!humanText)
            return;
        this.voice.judgeIncoming(sessionId, humanText);
    }
    /** outbound turn/end：配对写入跨场合流水并清暂存。
     *  who 优先取本轮实际发言人（群会话 record.senderId 是会话创建者，会记错人） */
    flushTurn(sessionId, where, fallbackWho) {
        const entry = this.turnLedger.get(sessionId);
        this.turnLedger.delete(sessionId);
        if (!entry)
            return;
        const user = (entry.user ?? '').trim();
        const reply = entry.reply.trim();
        if (user || reply)
            this.memory.logTurn({ where, who: entry.who ?? fallbackWho, text: user, reply });
        // ── M23：事实硬触发 ──
        // 实测失效：3 个人 89 次交互，实质记忆 0 条。
        // 根因是"指望模型自觉调 qq_memory_append"≈不写（群聊里 0 次）。
        // 改成每轮由代码抽一次，不依赖她想起用工具。
        this.autoRemember(entry.who ?? fallbackWho, user);
        this.autoDiary();
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
            const today = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const day = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
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