/**
 * 情绪 · 三个数字（M31）
 * ─────────────────────────────────────────────────────────────
 * ## 为什么只有三个数
 *
 * 前期调研（emotion-systems-research.md）的结论很硬：
 *   **情绪要"活"，必须接在有返回值的闸门上（概率/延迟/条数/枚举）。
 *     接在提词句上必死。**
 *
 * 对照实验就在隔壁：`dsh-feiyu-mood` 有 7 维打分、双半衰、置信度门槛、
 * 日上限、饱和 —— 设计得比这套复杂得多，但它的 `mood` 只有
 * `moodLine()`（渲染成提词）和 HTTP 面板两个消费者，没有任何行为分支。
 * 结果就是一份"精心设计的死代码"：模型照着描述演，演完什么也不变。
 *
 * 所以这里反过来：**先找到要接的闸门，再决定需要几个数字。**
 * 这个项目里能真正改变行为的闸门只有四个：
 *
 *   闸门                          现在的公式                          接入点
 *   ────────────────────────────────────────────────────────────────────
 *   ① 兴趣唤醒概率   chattiness × Σweight × base     wake.ts matchInterest()
 *   ② 打字延迟       字数 × 110ms × 深夜 1.6        humanize.ts typingMsFor()
 *   ③ 分几条发       burstMax = 2（API 上限）        humanize.ts split()
 *   ④ 主动开口概率   rollProbability = 0.7          own-life.ts tick()
 *
 * 四个闸门需要区分两件事："心情好不好"（→ ①④）和"还有没有力气"
 * （→ ②③）。再加上一个"激动程度"用来在两极都放大反应，就是三个数。
 * 剩下的维度（信任、亲密、疲惫的原因…）**不建**：没有闸门消费它们，
 * 建了就是下一个 feiyu-mood。
 *
 * ## 为什么值是 -1..1 而不是 0..100
 *
 * feiyu-mood 的实测问题：模型给自己打分系统性偏高（872 条样本里
 * 577 正 / 86 负 = 6.7:1），模拟 14 天有 78% 的时间在 95 分以上——
 * "永远开心"等于"没有心情"。用 -1..1 并以 0 为基线，
 * "好"和"不好"都是**偏离**，回到 0 是常态，这才有起伏。
 */
import fs from 'node:fs';
import { dayInTz } from "./clock.js";
import path from 'node:path';
/**
 * 正向事件的日上限与边际递减（M34）。
 *
 * 实测数据：130 轮真实语料里 onAddressed 触发 130 次、onReplied 100 次，
 * 而负向只有 own-life 每天最多 4 次。正负比 45.4:1，valence 中位数 1.000。
 *
 * 解法不是"加大负向"，而是**承认正向事件在一天里会饱和**：
 *   - 被叫到：一天前 8 次全额，之后每多一次只给 1/3
 *   - 被回应：一天前 5 次全额，之后每多一次只给 1/4
 * 这样密集聊天时单次价值衰减，而偶尔聊天时每次仍算数。
 */
const DAILY_SOFT_CAP = { addressed: 8, replied: 5 };
// 溢流后降到 1/10 而不是 1/3 —— 因为稳态分析显示：
//   每 30 分钟 +0.06、24h 半衰期 → 稳态 = 0.06/(1-0.9857) = 4.19，
//   远超上限 1.0，光靠"日上限"压不住（130 轮跨 2.7 天，每天都会重置）。
//   改成 1/10 后稳态 ≈ 0.06·(1/10)/(1-0.9857) = 0.42，落在合理区间。
const OVERFLOW_DAMP = { addressed: 1 / 10, replied: 1 / 10 };
/** 基线：久不变化就回到这里 */
const BASELINE = { valence: 0, arousal: 0.3, energy: 0.7 };
/**
 * 回归半衰期（小时）。
 *
 * 为什么是"回归"而不是"衰减到 0"：
 * 情绪的作用是**短暂改变行为倾向**，不是永久改变人格。
 * 一次开心的事不该让她永远更爱说话，但也不该 10 分钟就忘。
 *
 * 参数是**实测调过的**（第一版定错了）：
 *   初版 valence=6h，模拟 7 天真实节奏发现 —— 睡一觉 8 小时，
 *   心情只剩 40%，第二天永远从 0 开始。D1 还能到 0.79，
 *   D3 就已经是 0.00 了。所谓"情绪"变成了"每场对话内的抖动"。
 *
 * 人的心情是**跨天**的：昨天被夸了，今天起来还是有点轻快。
 * 所以 valence 要能扛过一夜睡眠 → 取 24h（8 小时睡醒还剩 79%）。
 *
 * 三个量的速度不同：
 *   valence 24h —— 心情，扛得过一夜
 *   arousal  4h —— 激动，气头上就那阵子，但也不至于半小时就平
 *   energy  12h —— 精力，累了要睡，睡醒恢复（和 valence 独立）
 */
const HALF_LIFE_H = {
    valence: 24,
    arousal: 4,
    energy: 12,
};
/** 单次事件的调整幅度上限（防一次事件把情绪打到底） */
const MAX_STEP = 0.25;
/** 把值夹到区间 */
function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}
/**
 * 按经过时间把情绪往基线拉（指数回归）。
 *
 * 注意这里**按真实经过时间算**，不是"每次调用乘一次"——
 * 后者会让衰减速度取决于调用频率，是个经典 bug
 * （同一个类里 `decayInterests` 早期就踩过类似的坑）。
 */
export function regress(state, now = Date.now()) {
    const dtH = Math.max(0, (now - state.at) / 3600_000);
    if (dtH <= 0)
        return { ...state };
    const pull = (cur, base, halfLife) => {
        const k = Math.pow(2, -dtH / halfLife);
        return base + (cur - base) * k;
    };
    return {
        valence: clamp(pull(state.valence, BASELINE.valence, HALF_LIFE_H.valence), -1, 1),
        arousal: clamp(pull(state.arousal, BASELINE.arousal, HALF_LIFE_H.arousal), 0, 1),
        energy: clamp(pull(state.energy, BASELINE.energy, HALF_LIFE_H.energy), 0, 1),
        at: now,
        // M34：daily 计数器必须跟着走，否则 regress 一返回就被丢掉，
        // 日上限形同虚设（实测发现：daily 恒 undefined，130 轮后 valence 仍 1.000）
        ...(state.daily ? { daily: state.daily } : {}),
    };
}
/** 施加一次事件（先回归到当前时刻，再加增量） */
export function applyDeltas(state, d, now = Date.now()) {
    const s = regress(state, now);
    return {
        valence: clamp(s.valence + clamp(d.valence ?? 0, -MAX_STEP, MAX_STEP), -1, 1),
        arousal: clamp(s.arousal + clamp(d.arousal ?? 0, -MAX_STEP, MAX_STEP), 0, 1),
        energy: clamp(s.energy + clamp(d.energy ?? 0, -MAX_STEP, MAX_STEP), 0, 1),
        at: now,
        // M34：同样必须带上 daily —— regress 已保留，这里再丢一次就前功尽弃
        ...(s.daily ? { daily: s.daily } : {}),
    };
}
// ───────────── 闸门系数 ─────────────
//
// 每个系数都以 1.0 为"没影响"，这样即使情绪系统整个挂掉、
// 或者所有值都在基线，行为也和接情绪之前**完全一致**。
// 这是刻意的：情绪是调制，不是开关。
/**
 * 闸门 ①④：愿不愿意主动开口。
 * valence 高 → 更愿意；低 → 懒得说话。
 * 范围 0.6~1.4，最多四成偏移 —— 不会因为心情差就变成哑巴
 * （"被嫌吵 ×0.3"再叠"心情差 ×0.4"会到 0.12，人就没了）。
 */
export function speakWillingness(state) {
    return clamp(1 + 0.4 * state.valence, 0.6, 1.4);
}
/**
 * 闸门 ②：打字快慢。
 * energy 高打字快，低打字慢（困了）。
 * 系数直接乘在 ms 上，所以 <1 = 更快。
 */
export function typingSpeedFactor(state) {
    // energy 0.7（基线）→ 1.0；energy 0 → 1.35（慢三成半）；energy 1 → 0.85
    const factor = 1.35 - 0.5 * state.energy;
    return clamp(factor, 0.8, 1.4);
}
/**
 * 闸门 ③：分几条发。
 * arousal 高（激动）→ 更容易连发两条；低 → 合成一条。
 * 返回 1 或 2（官方 API 同一 msgId 被动回复限 4 次，留额度）。
 */
export function burstLimit(state, cap = 2) {
    // arousal 0.3（基线）→ 阈值 0.3，即基线附近约一半概率发两条
    return state.arousal >= 0.3 ? Math.min(2, cap) : 1;
}
/** 调试/日志用：一句话概括当前情绪 */
export function describeEmotion(state) {
    const v = state.valence;
    const mood = v > 0.35 ? '心情不错' : v < -0.35 ? '有点蔫' : '没什么波澜';
    const body = state.energy > 0.75 ? '精神很好' : state.energy < 0.35 ? '有点累' : '精神一般';
    return `${mood} · ${body}（v=${v.toFixed(2)} a=${state.arousal.toFixed(2)} e=${state.energy.toFixed(2)}）`;
}
/**
 * 情绪服务：读写 state/emotion.json。
 *
 * 为什么不塞进 self.json：
 *   self.json 存的是兴趣/称呼（**几天才写一次**），
 *   情绪是**每轮对话都可能变**的。混在一起会让每轮消息都重写
 *   self.json —— 文件更大、写坏的风险更高、而且两个数据集的
 *   生命周期完全不同（兴趣要长期，情绪要短期）。
 */
export class EmotionService {
    log;
    state;
    file;
    lastSaveAt = 0;
    constructor(dataDir, log) {
        this.log = log;
        this.file = path.join(dataDir, 'state', 'emotion.json');
        this.state = this.load();
    }
    load() {
        const fresh = { ...BASELINE, at: Date.now() };
        try {
            if (!fs.existsSync(this.file))
                return fresh;
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            // 坏字段必须**各自回落各自的基线**，不能统一变 0。
            //
            // 原写法 `Number(x ?? base) || 0` 有两个坑：
            //   ① `|| 0` 把 NaN 和 0 混为一谈，坏档会静默变成 0 而不报错；
            //   ② 更糟的是缺省值也被抹掉了 —— arousal/energy 的基线是 0.3/0.7，
            //      掉到 0 意味着 burstLimit 永远返回 1、typingSpeedFactor 永远 1.35，
            //      也就是"永远很累、永远只发一条"，而且没有任何日志能看出来。
            // 只接受**真正的 number**，不走 Number() 强转。
            // 原因是 Number() 的隐式转换全是坑：
            //   Number(null)=0  Number('')=0  Number([])=0  Number(true)=1
            // 这些值都"有限"、都能过 isFinite 检查，于是坏档会被当成
            // 合法的 0 收下 —— 和我上一版想修的 bug 一模一样。
            const num = (v, base, lo, hi) => typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : base;
            const st = {
                valence: num(raw.valence, fresh.valence, -1, 1),
                arousal: num(raw.arousal, fresh.arousal, 0, 1),
                energy: num(raw.energy, fresh.energy, 0, 1),
                at: Number.isFinite(Number(raw.at)) && Number(raw.at) > 0 ? Number(raw.at) : Date.now(),
            };
            // 每次加载先回归 —— 进程停了多久，心情就自己平了多少
            return regress(st);
        }
        catch {
            return fresh;
        }
    }
    save() {
        // 防抖：同一分钟内不重复写盘（情绪变化很频繁，但没必要次次落盘）
        const now = Date.now();
        if (now - this.lastSaveAt < 60_000)
            return;
        this.lastSaveAt = now;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), 'utf8');
            fs.renameSync(tmp, this.file);
        }
        catch (err) {
            this.log?.(`emotion: 写入失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 当前情绪（已按真实经过时间回归） */
    current(now = Date.now()) {
        this.state = regress(this.state, now);
        return this.state;
    }
    /** 施加一次事件 */
    bump(d, now = Date.now()) {
        this.state = applyDeltas(this.state, d, now);
        this.save();
        return this.state;
    }
    // ── 四个零成本写入点（都由代码触发，不依赖她自觉）──
    //
    // 全部是"已经发生的事实"，不需要额外 LLM 调用：
    // 被 @ 了、被回复了、主动说话没人理、聊到深夜。
    /**
     * 取当日计数器并递增（跨日自动归零）。
     * 用**北京时区**——启动时未设 TZ，`new Date().getDate()` 是 UTC。
     */
    tickDaily(kind) {
        const day = dayInTz(new Date());
        if (!this.state.daily || this.state.daily.day !== day) {
            this.state.daily = { day, addressed: 0, replied: 0 };
        }
        const d = this.state.daily;
        d[kind] += 1;
        const used = d[kind];
        const cap = DAILY_SOFT_CAP[kind];
        const damp = used <= cap ? 1 : OVERFLOW_DAMP[kind];
        return { used, damp };
    }
    /**
     * 被人叫到（@ / 点名）→ 注意力被拉过来，心情微升。
     *
     * M34：过了当日软上限后边际递减 —— 见 DAILY_SOFT_CAP 的注释。
     * 不这么做的话，实测每轮净 +0.159 会让 valence 必然贴顶。
     */
    onAddressed() {
        const { damp } = this.tickDaily('addressed');
        this.bump({ valence: 0.06 * damp, arousal: 0.12 * (damp === 1 ? 1 : 0.5), energy: -0.01 });
    }
    /** 说出去的话有人接 → 被回应，心情明显好。M34：同样加日上限与递减 */
    onReplied() {
        const { damp } = this.tickDaily('replied');
        this.bump({ valence: 0.14 * damp, arousal: 0.08 * (damp === 1 ? 1 : 0.5) });
    }
    /**
     * 主动说了话但没人接 → 失落。
     * 这个是最重要的负向写入点：没有它，情绪只涨不跌，
     * 就退化成 feiyu-mood 那种"永远开心 = 没有心情"。
     */
    onIgnored() {
        this.bump({ valence: -0.12, arousal: -0.05, energy: -0.03 });
    }
    /** 被嫌吵 → 心情差 + 蔫下来 */
    onComplained() {
        this.bump({ valence: -0.2, arousal: -0.15, energy: -0.05 });
    }
    /**
     * 深夜还在聊 → 精力下降。
     * hour 用**北京时间**（启动时未设 TZ，调用方负责传对）。
     */
    onNightChat(hour) {
        if (hour >= 23 || hour < 6)
            this.bump({ energy: -0.08, arousal: -0.03 });
    }
    /**
     * 把当前状态渲染成可注入的提示段（M33）。
     *
     * ## 只给事实，不给结论
     *
     * 第一版我写的是「【你现在的心情：心情挺好的】」——**替她下了结论**。
     * 这是错的，错在解释权的归属。
     *
     * 对照 `dsh-bili-whale` 的做法（CHANGELOG 原文）：
     *   「唤醒提示里会告诉她『主人已经 N 天没有回应你了』——**只给事实**，
     *     情绪留给她自己写」
     *
     * 区别在于：
     *   给结论 → 她照着演，而且结论一旦写进提示词就固化了（今天"低落"，
     *            聊得多开心都不好意思转晴）
     *   给事实 → 她自己决定那是什么感觉，同一件事在不同语境下可以有不同的情绪
     *
     * 所以这里输出的是**可观察的状态**（多久没说话、精力低、心里有波动），
     * 不是形容词。
     *
     * 平静时不注入 —— 天天说"我状态还行"本身就是 AI 味。
     */
    renderSection(facts = {}) {
        const st = this.current();
        const lines = [];
        // ① 事实：对方多久没怎么理她（这条最像人）
        const d = facts.silentDays ?? 0;
        if (d >= 7)
            lines.push(`他已经 ${Math.floor(d)} 天没怎么跟你说话了`);
        else if (d >= 3)
            lines.push(`他最近很少回你，大概 ${Math.floor(d)} 天了`);
        // ② 事实：她主动说了话，连续没人接
        const un = facts.unanswered ?? 0;
        if (un >= 2)
            lines.push(`你有 ${un} 次主动开口没人接`);
        // ②.5 事实：已经问过"你在忙吗"了，还没回。
        // 「只问一次，不追问」—— 追问是讨人厌最快的路径。
        // 来源：dsh-bili-whale 的 quota ask。
        if (facts.askedBefore && un >= 2)
            lines.push('你已经问过一次「是不是在忙」了，还没回');
        // ③ 事实：精力状态（用身体感受描述，不用形容词结论）
        if (st.energy < 0.3)
            lines.push('你现在很困，脑子里转不动');
        else if (st.energy < 0.45)
            lines.push('你有点累');
        // ④ 事实：心里有起伏（不说是好是坏）
        if (st.arousal > 0.7)
            lines.push('你心里有点静不下来');
        if (lines.length === 0)
            return '';
        return `【此刻的状态·只是事实，怎么想随你】
${lines.map((x) => '- ' + x).join('\n')}
这些不用说出来，也不用解释。它会自然影响你话多话少——懒得展开就短一点。`;
    }
    /** 睡够了（长时间没消息后第一次说话）→ 精力回升 */
    onRest() {
        this.bump({ energy: 0.1, arousal: -0.05 });
    }
}
//# sourceMappingURL=emotion.js.map