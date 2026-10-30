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
/** 兴趣权重下限，低于则移除 */
const MIN_INTEREST_WEIGHT = 0.1;
/** 兴趣上限 */
const MAX_INTEREST_WEIGHT = 1.0;
/** 无提及多少天后开始衰减 */
const DECAY_AFTER_MS = 7 * 24 * 3600_000;
/** 每天衰减系数 */
const DECAY_FACTOR = 0.95;
/** 称呼被叫多少次才进入"候选"（还需她表态接受） */
const NAME_ACCEPT_THRESHOLD = 3;
/** 默认画像 */
function emptyProfile() {
    return {
        names: [],
        interests: [],
        engagement: { chattiness: 1.0, lastComplainedAt: 0, complaints: 0 },
        screenWatch: { enabled: false, allowedApps: [], intervalMs: 30 * 60 * 1000 },
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
    // ───────────── 兴趣 ─────────────
    /** 提到某兴趣：权重 +0.05，计数 +1 */
    touchInterest(topic) {
        const now = Date.now();
        let e = this.data.interests.find((i) => i.topic === topic);
        if (!e) {
            e = { topic, weight: 0.3, count: 0, lastAt: now };
            this.data.interests.push(e);
        }
        e.count += 1;
        e.weight = Math.min(MAX_INTEREST_WEIGHT, e.weight + 0.05);
        e.lastAt = now;
        this.save();
    }
    /** 因兴趣接话、且被回应 → 更"喜欢" */
    reinforceInterest(topic) {
        const e = this.data.interests.find((i) => i.topic === topic);
        if (!e)
            return;
        e.weight = Math.min(MAX_INTEREST_WEIGHT, e.weight + 0.1);
        this.save();
    }
    /** 因兴趣接话但没人理 → 兴趣降温 */
    dampenInterest(topic) {
        const e = this.data.interests.find((i) => i.topic === topic);
        if (!e)
            return;
        e.weight = Math.max(0, e.weight - 0.05);
        this.save();
    }
    /** 按当前时间做衰减（7 天未提，按天 ×0.95），低于下限则移除 */
    decayInterests(now = Date.now()) {
        let removed = 0;
        for (const e of [...this.data.interests]) {
            const idle = now - e.lastAt;
            if (idle <= DECAY_AFTER_MS)
                continue;
            const days = Math.floor((idle - DECAY_AFTER_MS) / (24 * 3600_000));
            e.weight *= Math.pow(DECAY_FACTOR, days);
            if (e.weight < MIN_INTEREST_WEIGHT) {
                this.data.interests = this.data.interests.filter((x) => x.topic !== e.topic);
                removed += 1;
            }
        }
        if (removed > 0)
            this.log?.(`self: 淡忘 ${removed} 个兴趣`);
        this.save();
        return removed;
    }
    /** 取权重最高的前 n 个兴趣 */
    topInterests(n = 3) {
        return [...this.data.interests].sort((a, b) => b.weight - a.weight).slice(0, n);
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
}
//# sourceMappingURL=self.js.map