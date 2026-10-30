/**
 * 自我画像（self.json）— 「她自己的」喜好与兴趣
 * ─────────────────────────────────────────────────────────────
 * 与 memory.ts 的区别：
 *   memory.ts  → 按「人」存，记的是**别人**（用户的 traits/facts/topics）
 *   self.ts    → 只存一份，记的是**她自己**（喜欢什么、对什么有兴趣、被叫几个名字）
 *
 * 文件：~/.dsh-qqbot/persona/app-{appId}/self.json
 *
 * 设计要点：
 * - 称呼要「喜欢才接受」（accepted 标记），不是无脑全学
 * - 兴趣带权重，会随互动涨落、随时间衰减（借鉴 MaiBot 加权 + generative_agents 重要度）
 * - engagement.chattiness 记录「被嫌吵」后的收敛程度
 */
import fs from 'node:fs';
import path from 'node:path';
/** 冻结线：强度低于此值 → 冻结（不删除，保留可追溯） */
const FREEZE_THRESHOLD = 0.1;
/** 复活线：冻结态强度涨过此值 → 解冻（双阈值滞回，防抖） */
const REVIVE_THRESHOLD = 0.15;
/** 衰减半衰期：24 小时（MaiBot A_memorix 默认值） */
const HALF_LIFE_MS = 24 * 3600_000;
/** ACCESS 强化系数（她主动用了一次/被召回） */
const ALPHA_ACCESS = 0.05;
/** ACCESS 冷却期（60 分钟内重复不叠加） */
const ACCESS_COOLDOWN_MS = 60 * 60 * 1000;
/** EVIDENCE 强化直接置为该档（用户明确表态） */
const EVIDENCE_STRENGTH = 1.0;
/** 活跃兴趣上限（Reddit 研究：人的活跃兴趣数量极少） */
const MAX_ACTIVE_INTERESTS = 5;
/** 兴趣上限 */
const MAX_INTEREST_WEIGHT = 1.0;
/** 称呼被叫多少次才进入"候选"（还需她表态接受） */
const NAME_ACCEPT_THRESHOLD = 3;
/** 默认画像 */
function emptyProfile() {
    return {
        names: [],
        interests: [],
        engagement: { chattiness: 1.0, lastComplainedAt: 0, complaints: 0 },
        screenWatch: { enabled: false, allowedApps: [], intervalMs: 30 * 60 * 1000 },
        wishes: [],
    };
}
/**
 * 自我画像服务：读写 self.json，并提供兴趣/称呼/收敛的更新逻辑。
 */
export class SelfProfileService {
    log;
    data;
    file;
    constructor(dataDir, log) {
        this.log = log;
        this.file = path.join(dataDir, 'self.json');
        this.data = this.load();
    }
    load() {
        try {
            if (!fs.existsSync(this.file))
                return emptyProfile();
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const base = emptyProfile();
            return {
                names: Array.isArray(raw.names) ? raw.names : base.names,
                interests: Array.isArray(raw.interests) ? raw.interests : base.interests,
                engagement: { ...base.engagement, ...(raw.engagement ?? {}) },
                screenWatch: { ...base.screenWatch, ...(raw.screenWatch ?? {}) },
                lastSurfAt: raw.lastSurfAt,
                wishes: Array.isArray(raw.wishes) ? raw.wishes : base.wishes,
            };
        }
        catch (err) {
            this.log?.(`self: 读取失败，用空画像: ${err instanceof Error ? err.message : String(err)}`);
            return emptyProfile();
        }
    }
    /** 持久化（原子写，避免半截文件） */
    save() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
            fs.renameSync(tmp, this.file);
        }
        catch (err) {
            this.log?.(`self: 写入失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 只读快照 */
    snapshot() {
        return this.data;
    }
    // ───────────── 称呼 ─────────────
    /** 当前真正能唤醒她的称呼（accepted 且 weight>0） */
    activeNames() {
        return this.data.names.filter((n) => n.accepted && n.weight > 0).map((n) => n.name);
    }
    /**
     * 记录一次"被叫"。新称呼先进候选（accepted=false），
     * 被叫满 NAME_ACCEPT_THRESHOLD 次后标记 pending，等她通过 acceptName 表态。
     * 返回当前状态供调用方决定是否要提示她表态。
     */
    recordNameCall(name) {
        const now = Date.now();
        let entry = this.data.names.find((n) => n.name === name);
        const isNew = !entry;
        if (!entry) {
            entry = { name, weight: 0, accepted: false, calledCount: 0, source: 'learned' };
            this.data.names.push(entry);
        }
        entry.calledCount += 1;
        entry.lastAskedAt = now;
        if (!entry.firstAskedAt)
            entry.firstAskedAt = now;
        const reachedThreshold = !entry.accepted && entry.calledCount >= NAME_ACCEPT_THRESHOLD && entry.weight === 0;
        if (isNew)
            this.log?.(`self: 新称呼「${name}」进入候选`);
        this.save();
        return { isNew, reachedThreshold, accepted: entry.accepted };
    }
    /** 她表态接受某个称呼 */
    acceptName(name, weight = 0.6) {
        const entry = this.data.names.find((n) => n.name === name);
        if (!entry)
            return false;
        entry.accepted = true;
        entry.weight = Math.min(MAX_INTEREST_WEIGHT, weight);
        this.log?.(`self: 接受称呼「${name}」`);
        this.save();
        return true;
    }
    /** 她表态拒绝某个称呼 */
    rejectName(name) {
        const entry = this.data.names.find((n) => n.name === name);
        if (!entry)
            return false;
        entry.accepted = false;
        entry.weight = 0;
        this.log?.(`self: 拒绝称呼「${name}」`);
        this.save();
        return true;
    }
    // ───────────── 兴趣（M12：两库 + 事件分型 + 饱和强化 + 双阈值滞回） ─────────────
    //
    // 设计来源（research-digest.md §二）：
    //   - MaiBot A_memorix：s·2^(-Δt/HL)，s ← s + α(1-s)，freeze 0.1 / revive 0.15
    //   - elizaOS：durable（永不衰减）/ current（会衰减）两层
    //   - MemoryBank（arXiv 2305.10250）：每次召回 S+=1 且 t 重置
    //   - Reddit 710万用户（arXiv 1912.09210）：兴趣是 drift/shift，不是平滑衰减
    /** 取强度（兼容旧 weight 字段） */
    strengthOf(e) {
        return typeof e.strength === 'number' ? e.strength : e.weight;
    }
    /** 写回强度（同时同步 weight 兼容别名） */
    setStrength(e, v) {
        const clamped = Math.max(0, Math.min(1, v));
        e.strength = clamped;
        e.weight = clamped;
    }
    /**
     * 饱和强化：s ← s + α(1-s)
     * 越接近 1 涨得越慢 —— 符合人性（已经很喜欢的不会因为再提一次就更喜欢）。
     */
    saturate(e, alpha) {
        const cur = this.strengthOf(e);
        this.setStrength(e, cur + alpha * (1 - cur));
    }
    /**
     * ACCESS 事件：她主动用了一次 / 被召回（弱事件，带冷却）。
     * 对应 MaiBot 的 α_access=0.05 + 60min 冷却。
     */
    touchInterest(topic) {
        const now = Date.now();
        let e = this.data.interests.find((i) => i.topic === topic);
        if (!e) {
            e = { topic, weight: 0.3, strength: 0.3, kind: 'current', count: 0, lastAt: now };
            this.data.interests.push(e);
        }
        e.count += 1;
        // 冷却：60 分钟内重复提及不叠加（防刷分）
        const cooled = now - (e.lastRecalledAt ?? 0) >= ACCESS_COOLDOWN_MS;
        if (cooled) {
            this.saturate(e, ALPHA_ACCESS);
            e.lastRecalledAt = now;
        }
        // 召回即重置衰减计时（MemoryBank：t 重置）
        e.lastAt = now;
        // 双阈值滞回：越过 revive 线才解冻
        if (e.frozen && this.strengthOf(e) >= REVIVE_THRESHOLD) {
            e.frozen = false;
            this.log?.(`self: 兴趣「${topic}」解冻复活`);
        }
        this.save();
    }
    /**
     * EVIDENCE 事件：用户明确表达喜好（"我超喜欢X"）→ 强度直接置满。
     * 对应 MaiBot 的 α_evidence（直接 1.0）。
     */
    reinforceInterest(topic, explicit = false) {
        const e = this.data.interests.find((i) => i.topic === topic);
        if (!e)
            return;
        if (explicit) {
            this.setStrength(e, EVIDENCE_STRENGTH);
            if (e.frozen)
                e.frozen = false;
        }
        else {
            // 非明确证据：较强但非满值（α=0.5）
            this.saturate(e, 0.5);
            if (e.frozen && this.strengthOf(e) >= REVIVE_THRESHOLD)
                e.frozen = false;
        }
        e.lastAt = Date.now();
        this.save();
    }
    /** 因兴趣接话但没人理 → 兴趣降温（线性小幅下调，不参与衰减曲线） */
    dampenInterest(topic) {
        const e = this.data.interests.find((i) => i.topic === topic);
        if (!e)
            return;
        this.setStrength(e, this.strengthOf(e) - 0.05);
        this.save();
    }
    /**
     * 惰性衰减：durable 永不衰减；current 按 s·2^(-Δt/HL) 衰减。
     * 跌破 FREEZE 线 → 冻结（**不删除**，保留可追溯）；未冻结的不动。
     * 返回新冻结的数量。
     */
    decayInterests(now = Date.now()) {
        let frozen = 0;
        for (const e of this.data.interests) {
            const kind = e.kind ?? 'current';
            if (kind === 'durable')
                continue; // 长期品味不衰减
            if (e.frozen)
                continue; // 已冻结的不再算
            const idle = now - e.lastAt;
            if (idle <= 0)
                continue;
            // s·2^(-Δt/HL)
            const strength = this.strengthOf(e) * Math.pow(2, -idle / HALF_LIFE_MS);
            this.setStrength(e, strength);
            if (strength < FREEZE_THRESHOLD && this.strengthOf(e) < FREEZE_THRESHOLD) {
                e.frozen = true;
                frozen += 1;
            }
        }
        if (frozen > 0)
            this.log?.(`self: 冻结 ${frozen} 个兴趣（保留可追溯，未删除）`);
        this.save();
        return frozen;
    }
    /**
     * 取强度最高的前 n 个兴趣（**只读，不写回** —— 写回由 touchInterest 负责）。
     * 排除已冻结的。
     */
    topInterests(n = 3) {
        return this.data.interests
            .filter((i) => !i.frozen)
            .sort((a, b) => this.strengthOf(b) - this.strengthOf(a))
            .slice(0, Math.min(n, MAX_ACTIVE_INTERESTS));
    }
    /** 全部未冻结兴趣数量（用于"活跃兴趣上限"检查） */
    activeInterestCount() {
        return this.data.interests.filter((i) => !i.frozen).length;
    }
    /** 记录一次冲浪成果 */
    addFinding(topic, summary, source) {
        const e = this.data.interests.find((i) => i.topic === topic);
        if (!e)
            return;
        e.findings = e.findings ?? [];
        e.findings.push({ at: Date.now(), summary, source });
        // 上限 8 条，防膨胀
        while (e.findings.length > 8)
            e.findings.shift();
        this.data.lastSurfAt = Date.now();
        this.save();
    }
    // ───────────── 收敛（被嫌吵） ─────────────
    /** 被嫌吵 → 话痨度按倍率下降 */
    registerComplaint() {
        const g = this.data.engagement;
        g.chattiness = Math.max(0.1, g.chattiness * 0.3);
        g.lastComplainedAt = Date.now();
        g.complaints += 1;
        this.log?.(`self: 被嫌吵，chattiness → ${g.chattiness.toFixed(2)}`);
        this.save();
        return g.chattiness;
    }
    /** 用户主动找她说话 → 恢复一点话痨度 */
    warmUp(amount = 0.2) {
        const g = this.data.engagement;
        g.chattiness = Math.min(1.0, g.chattiness + amount);
        this.save();
    }
    /** 24h 未再被嫌 → 缓慢恢复 */
    recoverIfCalm(now = Date.now()) {
        const g = this.data.engagement;
        if (g.lastComplainedAt === 0 || g.chattiness >= 1.0)
            return;
        if (now - g.lastComplainedAt >= 24 * 3600_000) {
            g.chattiness = Math.min(1.0, g.chattiness + 0.1);
            g.lastComplainedAt = now; // 平滑推进，避免一次跳很多
            this.save();
        }
    }
    /** 当前话痨度 */
    chattiness() {
        return this.data.engagement.chattiness;
    }
    // ───────────── 需求（她想让用户实现的功能） ─────────────
    /** 提出一条需求（每周最多 2 条由调用方限制） */
    raiseWish(wish, why) {
        const now = Date.now();
        const existing = this.data.wishes.find((w) => w.wish === wish);
        if (existing) {
            existing.raisedAt = now;
            existing.status = 'raised';
            this.save();
            return existing;
        }
        const req = {
            id: `w${now}`,
            wish,
            why,
            raisedAt: now,
            rejectedAt: 0,
            retryAfterMs: 30 * 24 * 3600_000, // 用户确认：被拒后 1 个月可再提
            status: 'raised',
        };
        this.data.wishes.push(req);
        this.save();
        return req;
    }
    /** 用户拒绝某需求 → 记录时间，1 个月后可再提 */
    rejectWish(id) {
        const w = this.data.wishes.find((x) => x.id === id);
        if (!w)
            return false;
        w.rejectedAt = Date.now();
        w.status = 'rejected';
        this.log?.(`self: 需求「${w.wish}」被拒，${Math.round(w.retryAfterMs / 86400000)}天后可再提`);
        this.save();
        return true;
    }
    /** 用户接受某需求 */
    acceptWish(id) {
        const w = this.data.wishes.find((x) => x.id === id);
        if (!w)
            return false;
        w.status = 'accepted';
        this.save();
        return true;
    }
    /** 当前可以提的需求（未被拒，或已过 1 个月冷静期） */
    raisableWishes(now = Date.now()) {
        return this.data.wishes.filter((w) => {
            if (w.status === 'accepted')
                return false;
            if (w.status === 'rejected')
                return now - (w.rejectedAt ?? 0) >= w.retryAfterMs;
            return true;
        });
    }
    /** 本周已提过几条（用于限流：每周最多 2 条） */
    wishesRaisedSince(sinceMs) {
        return this.data.wishes.filter((w) => (w.raisedAt ?? 0) >= sinceMs).length;
    }
    /** 全部需求快照 */
    allWishes() {
        return this.data.wishes;
    }
}
//# sourceMappingURL=self.js.map