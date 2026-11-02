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
import { dayInTz } from './clock.ts';
import path from 'node:path';

/** 情绪的持久化状态 */
export interface EmotionState {
  /** 心情好坏 -1..1，0 = 平静 */
  valence: number;
  /** 激动程度 0..1，0 = 没精神起波澜 */
  arousal: number;
  /** 精力 0..1，1 = 满血 */
  energy: number;
  /** 上次衰减基准 */
  at: number;
  /**
   * 当日各类事件计数（M34）。
   *
   * 为什么需要：实测 130 轮真实语料，正负比 **45.4 : 1**，
   * valence 中位数 1.000、>0.85 占 95.4% —— 也就是"永远开心"。
   *
   * 根因不是负向太少，而是**正向事件的每轮净贡献 +0.159，
   * 远超过 24h 半衰期的回落速度**，必然贴顶。
   * 所以给正向事件加日上限 + 边际递减（见 onAddressed/onReplied）。
   */
  daily?: { day: string; addressed: number; replied: number };
}

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
const DAILY_SOFT_CAP = { addressed: 8, replied: 5 } as const;
// 溢流后降到 1/10 而不是 1/3 —— 因为稳态分析显示：
//   每 30 分钟 +0.06、24h 半衰期 → 稳态 = 0.06/(1-0.9857) = 4.19，
//   远超上限 1.0，光靠"日上限"压不住（130 轮跨 2.7 天，每天都会重置）。
//   改成 1/10 后稳态 ≈ 0.06·(1/10)/(1-0.9857) = 0.42，落在合理区间。
const OVERFLOW_DAMP = { addressed: 1 / 10, replied: 1 / 10 } as const;

/** 基线：久不变化就回到这里 */
const BASELINE: Omit<EmotionState, 'at'> = { valence: 0, arousal: 0.3, energy: 0.7 };

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
const HALF_LIFE_H: Record<'valence' | 'arousal' | 'energy', number> = {
  valence: 24,
  arousal: 4,
  energy: 12,
};

/** 单次事件的调整幅度上限（防一次事件把情绪打到底） */
const MAX_STEP = 0.25;

export interface EmotionDeltas {
  valence?: number;
  arousal?: number;
  energy?: number;
}

/** 把值夹到区间 */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 按经过时间把情绪往基线拉（指数回归）。
 *
 * 注意这里**按真实经过时间算**，不是"每次调用乘一次"——
 * 后者会让衰减速度取决于调用频率，是个经典 bug
 * （同一个类里 `decayInterests` 早期就踩过类似的坑）。
 */
export function regress(state: EmotionState, now = Date.now()): EmotionState {
  const dtH = Math.max(0, (now - state.at) / 3600_000);
  if (dtH <= 0) return { ...state };
  const pull = (cur: number, base: number, halfLife: number): number => {
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
export function applyDeltas(state: EmotionState, d: EmotionDeltas, now = Date.now()): EmotionState {
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
export function speakWillingness(state: EmotionState): number {
  return clamp(1 + 0.4 * state.valence, 0.6, 1.4);
}

/**
 * 闸门 ②：打字快慢。
 * energy 高打字快，低打字慢（困了）。
 * 系数直接乘在 ms 上，所以 <1 = 更快。
 */
export function typingSpeedFactor(state: EmotionState): number {
  // energy 0.7（基线）→ 1.0；energy 0 → 1.35（慢三成半）；energy 1 → 0.85
  const factor = 1.35 - 0.5 * state.energy;
  return clamp(factor, 0.8, 1.4);
}

/**
 * 闸门 ③：分几条发。
 * arousal 高（激动）→ 更容易连发两条；低 → 合成一条。
 * 返回 1 或 2（官方 API 同一 msgId 被动回复限 4 次，留额度）。
 */
export function burstLimit(state: EmotionState, cap = 2): number {
  // arousal 0.3（基线）→ 阈值 0.3，即基线附近约一半概率发两条
  return state.arousal >= 0.3 ? Math.min(2, cap) : 1;
}

/** 调试/日志用：一句话概括当前情绪 */
export function describeEmotion(state: EmotionState): string {
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
  private state: EmotionState;
  private readonly file: string;
  private lastSaveAt = 0;

  constructor(dataDir: string, private readonly log?: (m: string) => void) {
    this.file = path.join(dataDir, 'state', 'emotion.json');
    this.state = this.load();
  }

  private load(): EmotionState {
    const fresh: EmotionState = { ...BASELINE, at: Date.now() };
    try {
      if (!fs.existsSync(this.file)) return fresh;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<EmotionState>;
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
      const num = (v: unknown, base: number, lo: number, hi: number): number =>
        typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : base;
      const st: EmotionState = {
        valence: num(raw.valence, fresh.valence, -1, 1),
        arousal: num(raw.arousal, fresh.arousal, 0, 1),
        energy: num(raw.energy, fresh.energy, 0, 1),
        at: Number.isFinite(Number(raw.at)) && Number(raw.at) > 0 ? Number(raw.at) : Date.now(),
      };
      // 每次加载先回归 —— 进程停了多久，心情就自己平了多少
      return regress(st);
    } catch {
      return fresh;
    }
  }

  private save(): void {
    // 防抖：同一分钟内不重复写盘（情绪变化很频繁，但没必要次次落盘）
    const now = Date.now();
    if (now - this.lastSaveAt < 60_000) return;
    this.lastSaveAt = now;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log?.(`emotion: 写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 当前情绪（已按真实经过时间回归） */
  current(now = Date.now()): EmotionState {
    this.state = regress(this.state, now);
    return this.state;
  }

  /** 施加一次事件 */
  bump(d: EmotionDeltas, now = Date.now()): EmotionState {
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
   * 用**北京时区**——容器无 tzdata，`new Date().getDate()` 是 UTC。
   */
  private tickDaily(kind: 'addressed' | 'replied'): { used: number; damp: number } {
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
  onAddressed(): void {
    const { damp } = this.tickDaily('addressed');
    this.bump({ valence: 0.06 * damp, arousal: 0.12 * (damp === 1 ? 1 : 0.5), energy: -0.01 });
  }

  /** 说出去的话有人接 → 被回应，心情明显好。M34：同样加日上限与递减 */
  onReplied(): void {
    const { damp } = this.tickDaily('replied');
    this.bump({ valence: 0.14 * damp, arousal: 0.08 * (damp === 1 ? 1 : 0.5) });
  }

  /**
   * 主动说了话但没人接 → 失落。
   * 这个是最重要的负向写入点：没有它，情绪只涨不跌，
   * 就退化成 feiyu-mood 那种"永远开心 = 没有心情"。
   */
  onIgnored(): void {
    this.bump({ valence: -0.12, arousal: -0.05, energy: -0.03 });
  }

  /** 被嫌吵 → 心情差 + 蔫下来 */
  onComplained(): void {
    this.bump({ valence: -0.2, arousal: -0.15, energy: -0.05 });
  }

  /**
   * 深夜还在聊 → 精力下降。
   * hour 用**北京时间**（容器无 tzdata，调用方负责传对）。
   */
  onNightChat(hour: number): void {
    if (hour >= 23 || hour < 6) this.bump({ energy: -0.08, arousal: -0.03 });
  }

  /**
   * 把当前心情渲染成可注入的提示段（M33）。
   *
   * 为什么必须注入 —— 这是同一类错误第三次出现了：
   *   `dislikes` 接在闸门上会让她变沉默，但不告诉她为什么 → 行为漂移；
   *   情绪接在四个闸门上会改变她的话多话少、打字快慢，
   *   **但她不知道自己是什么心情** → 在她那儿就是"莫名其妙不想说话"。
   *
   * 外面看是"她在闹脾气"，里面是"她不知道为什么"。
   * 数据和感受必须同时在场。
   *
   * 只在**明显偏离基线**时才注入（|v|>0.2 或 energy<0.45），
   * 平静时不占 token —— 天天说"我心情还行"本身就是 AI 味。
   */
  renderSection(): string {
    const st = this.current();
    const notable = Math.abs(st.valence) > 0.2 || st.energy < 0.45 || st.arousal > 0.65;
    if (!notable) return '';
    const bits: string[] = [];
    if (st.valence > 0.35) bits.push('心情挺好的');
    else if (st.valence > 0.2) bits.push('心情不错');
    else if (st.valence < -0.35) bits.push('有点低落');
    else if (st.valence < -0.2) bits.push('有点闷');
    if (st.energy < 0.3) bits.push('很累');
    else if (st.energy < 0.45) bits.push('有点疲惫');
    if (st.arousal > 0.65) bits.push('心里有点激动');
    if (bits.length === 0) return '';
    return `【你现在的心情：${bits.join('，')}】
这不是要你说出来的话，是你此刻的状态。不用解释原因，也不用刻意表现——
话少一点、句子短一点、懒得展开，都是正常的。对方问起可以承认，但别主动汇报。`;
  }

  /** 睡够了（长时间没消息后第一次说话）→ 精力回升 */
  onRest(): void {
    this.bump({ energy: 0.1, arousal: -0.05 });
  }
}
