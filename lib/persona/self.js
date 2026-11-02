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
// ───────────── 衰减参数（M30 重标定：原参数在数学上不可能存活）─────────────
//
// 原值 HALF_LIFE_MS=24h、ALPHA_ACCESS=0.05，是从 fish-memory 的**记忆**衰减
// 直接搬过来的。搬到**兴趣**上之后尺度就错了，而且错得很彻底：
//
//   稳态公式（每次 touch 后 decay）：
//     s_eq = d·α / (1 - d + d·α)      d = 2^(-Δt/HL)
//
//   代入 Δt=1天、HL=24h → d=0.5：
//     s_eq = 0.5*0.05 / (1 - 0.5 + 0.5*0.05) = 0.048
//
//   而冻结线是 0.1。**每天聊到一次，稳态也只有 0.048** ——
//   也就是说这套参数下，兴趣在数学上不可能存活，必然被冻结。
//   实测吻合：她 6 条兴趣里 2 条已冻结在 0.04375（0.35 走 3 个半衰期）。
//
// 为什么记忆和兴趣不能共用这套参数：
//   记忆条目都是几十上百条，衰减只是个**排序手段**，死掉几条无所谓；
//   兴趣只有 4~6 条，而且是**长期特征**——"我喜欢咖啡"不该因为
//   两周没聊就变成一个陌生人的事。
//
// 重标定（按"多久不理它才该淡掉"反推）：
//   每天聊到   → 稳态 ≈ 0.86（活着，而且热）
//   每周聊到   → 稳态 ≈ 0.46（还喜欢，但不亢奋）
//   两周没聊到 → 掉到 0.24 附近（淡了，还能想起来）
//   一个月+    → 跌破 0.1（冻结，等同于"那阵子喜欢过"）
/** 兴趣衰减半衰期：30 天（原 24 小时，见上面的推导） */
const HALF_LIFE_MS = 30 * 24 * 3600_000;
/** ACCESS 强化系数（她主动用了一次 / 被召回 / 聊天里提到） */
const ALPHA_ACCESS = 0.15;
/** ACCESS 冷却期（60 分钟内重复不叠加） */
const ACCESS_COOLDOWN_MS = 60 * 60 * 1000;
/** EVIDENCE 强化直接置为该档（用户明确表态） */
const EVIDENCE_STRENGTH = 1.0;
/** 活跃兴趣上限（Reddit 研究：人的活跃兴趣数量极少） */
const MAX_ACTIVE_INTERESTS = 5;
/** 活跃厌恶上限（讨厌的东西人记得更牢，但同样不该有几百条） */
const MAX_ACTIVE_DISLIKES = 5;
/** 兴趣上限 */
const MAX_INTEREST_WEIGHT = 1.0;
// ───────────── 厌恶参数（M30）─────────────
//
// 与兴趣的**唯一**差别是半衰期：厌恶比喜好更持久（3 倍）。
// 这个比例不是读来的（MaiBot/fish-memory 都只有一套参数，没有按极性分档的先例），
// 是按「人对负面体验的记忆更久」这条常识定的，属于可调参数。
//
// 注意：比例是相对的，绝对值跟着兴趣一起在 M30 重标定过——
// 兴趣 24h → 30 天，厌恶 72h → 90 天。只改一边会让"讨厌比喜欢持久"
// 这个结论在数值上失效（原来 72h vs 24h 是 3 倍，现在也是 3 倍）。
/** 厌恶衰减半衰期：90 天（兴趣是 30 天） */
const DISLIKE_HALF_LIFE_MS = 90 * 24 * 3600_000;
/** 厌恶饱和强化系数（比 ACCESS 大：一次明确的"我讨厌X"比一次提及分量重） */
const ALPHA_DISLIKE = 0.35;
/** 因讨厌被强提到嗓子眼时的降温速率（乘性，见 dampenInterest 的注释） */
const DAMPEN_RATE = 0.15;
/** 称呼被叫多少次才进入"候选"（还需她表态接受） */
const NAME_ACCEPT_THRESHOLD = 3;
/** 默认画像 */
function emptyProfile() {
    return {
        names: [],
        interests: [],
        dislikes: [],
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
                // M30：老 self.json 没有 dislikes 字段，读成空数组即可（向后兼容）
                dislikes: Array.isArray(raw.dislikes) ? raw.dislikes : base.dislikes,
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
     * 被叫够次数、等她表态的候选称呼（M33）。
     *
     * 这是 `recordNameCall` 的**读端**。复核 8a94319 时发现写端接了、读端没接：
     * 候选名写进 `names` 之后没有任何消费者 ——
     * `activeNames()` 把它们过滤掉，`buildSections()` 不注入，
     * `qq_decide_name` 要模型自己填名字（模型不知道有哪些候选，就永远不填）。
     * 结果是 `recordNameCall` 的日志开始打印"等她表态"，而她永远不知道
     * 该对哪个名字表态 —— 仍然是"点不动的按钮"。
     *
     * 判据与 `recordNameCall` 的 `reachedThreshold` 保持一致，
     * 额外排除已拒绝的（拒绝过的不该反复问她）。
     */
    pendingNames() {
        return this.data.names
            .filter((n) => !n.accepted &&
            (n.weight ?? 0) === 0 &&
            (n.rejectedAt ?? 0) === 0 &&
            n.calledCount >= NAME_ACCEPT_THRESHOLD)
            .map((n) => ({ name: n.name, calledCount: n.calledCount, lastAskedAt: n.lastAskedAt ?? 0 }))
            .sort((a, b) => b.lastAskedAt - a.lastAskedAt);
    }
    /**
     * 把"有人一直这么叫我"渲染成可注入的提示段（M33）。
     *
     * 为什么必须注入：`qq_decide_name` 是"她按自己的喜好表态"的工具，
     * 但模型要凭空想起"有个叫 X 的称呼被喊了 3 次"是不可能的 ——
     * 候选列表必须进上下文，否则这个工具永远收不到调用。
     *
     * 只渲染**过了阈值**的，最多 3 个：把还在攒次数的也列出来，
     * 会让她过早表态（只被喊过一次的名字不构成"叫法"）。
     */
    renderNameCandidates() {
        const pend = this.pendingNames().slice(0, 3);
        if (pend.length === 0)
            return '';
        const lines = pend.map((p) => `- 有人开始用「${p.name}」叫你了（已经 ${p.calledCount} 次）`);
        return [
            '【最近别人对你的新叫法】',
            ...lines,
            '你可以在合适的时候用 qq_decide_name 决定接不接受其中一个（喜欢才接受；不想被这么叫就拒绝，以后就不当成在叫你）。不表态也行，不会有人逼你。',
        ].join('\n') + '\n';
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
        // M33：拒绝过的名字不再进候选（否则每次被叫都重新"等她表态"，
        // 她会反复被问同一个已经表态过的问题）
        if (entry.rejectedAt)
            return { isNew, reachedThreshold: false, accepted: false };
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
        entry.rejectedAt = 0;
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
        // M33：打上拒绝时间，`pendingNames()` 与 `recordNameCall` 都靠它
        // 把"已表态过"和"还没表态"区分开
        entry.rejectedAt = Date.now();
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
    /**
     * 因兴趣接话但没人理 → 兴趣降温（**乘性**小幅下调）。
     *
     * 为什么必须是乘性（M30 修的 bug）：
     *   原实现是 `s - 0.05` 线性减法。在 s=0.06 时减 0.05 只剩 0.01，
     *   直接击穿 FREEZE_THRESHOLD=0.1 被冻结 —— 而这条线本来是给
     *   "很久没碰"留的，结果成了"两次没人理就死了"。
     *   乘性 `s *= 0.85` 永远不会因为一次事件跨过数量级，符合"慢慢淡掉"的直觉。
     */
    dampenInterest(topic) {
        const e = this.data.interests.find((i) => i.topic === topic);
        if (!e)
            return;
        this.setStrength(e, this.strengthOf(e) * (1 - DAMPEN_RATE));
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
    // ───────────── 厌恶（M30：与兴趣结构同构、符号相反） ─────────────
    //
    // 为什么不做成 interests 的负权重：
    //   强化函数 `s ← s + α(1-s)` 是单调递增的，负数喂进去 = 越提越不讨厌，
    //   数学上就是错的。所以这里是**另一列数据**，同样只会往 0~1 涨，
    //   只是在消费端（唤醒概率）做减法。
    /**
     * 她明确讨厌某样东西。
     * 与 touchInterest 的差别：α 更大（0.35 vs 0.05），因为"我讨厌X"比"提到X"信号强得多。
     */
    recordDislike(topic, strength = ALPHA_DISLIKE) {
        const now = Date.now();
        let e = this.data.dislikes.find((i) => i.topic === topic);
        if (!e) {
            e = { topic, weight: 0, strength: 0, kind: 'current', count: 0, lastAt: now };
            this.data.dislikes.push(e);
        }
        e.count += 1;
        this.saturate(e, strength);
        e.lastAt = now;
        if (e.frozen && this.strengthOf(e) >= REVIVE_THRESHOLD)
            e.frozen = false;
        // 上限：讨厌的东西记得牢，但同样不该无限增长（留最强的 MAX_ACTIVE_DISLIKES 条）
        this.trimDislikes();
        this.save();
    }
    /** 修剪厌恶列表到上限（按强度，弱的最先丢） */
    trimDislikes() {
        const live = this.data.dislikes.filter((i) => !i.frozen);
        if (live.length <= MAX_ACTIVE_DISLIKES)
            return;
        const keep = new Set([...live]
            .sort((a, b) => this.strengthOf(b) - this.strengthOf(a))
            .slice(0, MAX_ACTIVE_DISLIKES)
            .map((i) => i.topic));
        this.data.dislikes = this.data.dislikes.filter((i) => i.frozen || keep.has(i.topic));
    }
    /**
     * 厌恶衰减：半衰期 **90 天**（兴趣是 **30 天** —— 人忘掉讨厌比忘掉喜欢慢 3 倍）。
     * 跌破冻结线同样只冻结不删除。
     *
     * 注：这里最初写的是"72h / 24h"，是 M30 重标定参数（24h→30天、72h→90天）
     * 时漏改的。数值差 30 倍，会让读代码的人按错的数量级理解这段逻辑。
     */
    decayDislikes(now = Date.now()) {
        let frozen = 0;
        for (const e of this.data.dislikes) {
            if (e.frozen)
                continue;
            const idle = now - e.lastAt;
            if (idle <= 0)
                continue;
            const strength = this.strengthOf(e) * Math.pow(2, -idle / DISLIKE_HALF_LIFE_MS);
            this.setStrength(e, strength);
            if (strength < FREEZE_THRESHOLD) {
                e.frozen = true;
                frozen += 1;
            }
        }
        if (frozen > 0)
            this.log?.(`self: 冻结 ${frozen} 个厌恶（不那么讨厌了，但还记着）`);
        this.save();
        return frozen;
    }
    /** 当前最讨厌的前 n 样（排除已淡忘的） */
    topDislikes(n = 3) {
        return this.data.dislikes
            .filter((i) => !i.frozen)
            .sort((a, b) => this.strengthOf(b) - this.strengthOf(a))
            .slice(0, Math.min(n, MAX_ACTIVE_DISLIKES));
    }
    /**
     * 记录一次冲浪成果（她在这个话题上主动查到了新东西）。
     *
     * M30 修的 bug：原来只写 findings，**不刷新 lastAt**。
     * 而 lastAt 是衰减的计时基准 —— 结果是"她越研究某个话题，
     * 那个话题在数据上越接近过期"，因为她查得越多、旧时间戳显得越旧。
     * 语义上"主动查资料"本来就是对这个话题最强的投入信号，必须续命。
     */
    addFinding(topic, summary, source) {
        const e = this.data.interests.find((i) => i.topic === topic);
        if (!e)
            return;
        const now = Date.now();
        e.findings = e.findings ?? [];
        e.findings.push({ at: now, summary, source });
        // 上限 8 条，防膨胀
        while (e.findings.length > 8)
            e.findings.shift();
        // 续命：主动查 = 投入，等价于一次 ACCESS 事件
        e.lastAt = now;
        if (e.frozen && this.strengthOf(e) >= REVIVE_THRESHOLD)
            e.frozen = false;
        this.data.lastSurfAt = now;
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
    /**
     * 把「她喜欢什么 / 讨厌什么」渲染成可注入的提示段（M30）。
     *
     * 为什么必须注入，而不是让它只影响概率：
     *   dislikes 接在唤醒概率上之后，她命中讨厌话题时**会明显变沉默**。
     *   但如果她不知道自己讨厌什么，这个沉默在她那里就是"不知道为什么不想说话"——
     *   表现出来就是"莫名其妙不理人"，比不沉默更糟。
     *   数据和感受必须同时在场，否则就是行为漂移。
     *
     * 只渲染到「有感觉」的程度（强度 ≥ 0.35），弱的不提 ——
     * 列一长串"我讨厌XX"会让人格变成一张清单。
     */
    renderSection() {
        const likes = this.topInterests(4).filter((i) => this.strengthOf(i) >= 0.35);
        const hates = this.topDislikes(3).filter((i) => this.strengthOf(i) >= 0.35);
        if (likes.length === 0 && hates.length === 0)
            return '';
        const L = [];
        if (likes.length)
            L.push('你会被这些话题勾起来：' + likes.map((i) => i.topic).join('、'));
        if (hates.length) {
            // 措辞是"聊起来会没什么兴致"，不是"拒绝回答"——
            // 前者是情绪，后者是禁令。禁令会把模型逼成客服话术。
            L.push('这些话题你聊起来会没什么兴致（不是不能聊，是懒得展开）：' + hates.map((i) => i.topic).join('、'));
        }
        return '【你自己的口味】\n' + L.join('\n') + '\n';
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