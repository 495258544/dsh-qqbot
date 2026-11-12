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
  daily?: { day: string; addressed: number; replied: number; mood: number };
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
const DAILY_SOFT_CAP = { addressed: 8, replied: 5, mood: 6 } as const;
// 溢流后降到 1/10 而不是 1/3 —— 因为稳态分析显示：
//   每 30 分钟 +0.06、24h 半衰期 → 稳态 = 0.06/(1-0.9857) = 4.19，
//   远超上限 1.0，光靠"日上限"压不住（130 轮跨 2.7 天，每天都会重置）。
//   改成 1/10 后稳态 ≈ 0.06·(1/10)/(1-0.9857) = 0.42，落在合理区间。
const OVERFLOW_DAMP = { addressed: 1 / 10, replied: 1 / 10, mood: 1 / 10 } as const;

/**
 * 内容驱动的四种自我报告（qq_note_mood 的数值部分）。
 *
 * ## 为什么幅度是社交的一半左右
 *
 * 用户 2026-11-12 定的原则：**内容驱动弱于社交驱动**。
 * 看书感动 ≠ 被在意的人回了一句。所以 up 是 +0.06，
 * 与 `onAddressed`（被叫到）的 0.06 同级，只有 `onReplied`（0.14）的不到一半。
 * 这不是猜的：`onAddressed` 是"注意力被拉过来"这种很轻的社交事件，
 * 而"读到一段戳中自己的东西"在她的体验里量级相当。
 *
 * ## 为什么不让她自己填数字
 *
 * 感受是方向，数字是表演。让她选 0.8 还是 0.3，
 * 等于把 feiyu-mood 那个"给自己打分系统性偏高"的坑原地重挖一遍
 * （见文件头注释：872 条样本里 577 正 / 86 负）。
 * 所以这里只收四个方向词，幅度由代码定死。
 *
 * ## mixed 的 valence 为什么几乎是 0（+0.01 而不是抵消后为负）
 *
 * "又感动又难受"在人身上不会净变差 —— 复杂情绪的重心在 arousal
 * （说不上来反而更翻腾，+0.06），valence 上略微偏正即可。
 * 若给负值，等于替她判定"复杂情绪是坏事"。
 *
 * ## still 为什么只降 arousal 不动 valence
 *
 * "平了"是**激动程度**下来，不是"心情变好/变坏"。
 * 把 still 当成 +valence 会变成"只要她说自己平静就能刷心情"。
 */
const CONTENT_MOOD_DELTA: Record<MoodSense, EmotionDeltas> = {
  up: { valence: 0.06, arousal: 0.05 },
  // 心里堵着不会平静 —— 负向同时抬 arousal，这是和"冷漠"的区别
  down: { valence: -0.08, arousal: 0.04 },
  mixed: { valence: 0.01, arousal: 0.06 },
  still: { arousal: -0.1 },
};

/** 四种方向（她只给方向，不给程度） */
export type MoodSense = 'up' | 'down' | 'mixed' | 'still';

/** mood-log 里的一条自述 */
export interface MoodEntry {
  /** 稳定 id，撤销时用它定位 */
  id: string;
  /** 什么时候记的（ms） */
  at: number;
  /** 北京时区日期 YYYY-MM-DD，便于按天回看 */
  day: string;
  /** 方向 */
  sense: MoodSense;
  /** 为什么（≤60 字） */
  because: string;
  /**
   * 那一下**像什么**（≤40 字，可选，她自己起的名字）。
   *
   * 为什么不解析、不分类、不打分：`sense` 只有四档是刻意的（数值层必须简单），
   * 但四档的副作用是 `mixed` 变成垃圾桶 —— "又感动又难受""想通了但有点涩"
   * "不知道该怎么形容"全塞进一个筐，以后回看什么都看不出来。
   *
   * 解法是让"细"落在她自己身上，不落在我们的枚举里：
   * Plutchik 的 24 档是心理学家定的坐标系，她只能往里填；
   * feel 是她自己起的名字，能长出她自己的坐标系。
   * 所以它原样存进日志、**不参与任何数值计算**。
   */
  feel?: string;
  /** 撤销标记（不物理删除，保留痕迹） */
  revoked?: boolean;
  /** 撤销时间 */
  revokedAt?: number;
  /** 撤销的理由（必填 —— 不许静默删） */
  revokedWhy?: string;
}

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

/**
 * mood-log 保留多少条。
 *
 * 不设上限的话这个文件会无界增长（每读一段书记一条，一年就上千条）；
 * 但也不能太少 —— 少了就看不到"这两个月在为什么事情动心"。
 * 200 条大约是她几个月的量，够回看，又不至于每次加载都拖。
 */
const MAX_MOOD_ENTRIES = 200;

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
 * 返回 1 或 2（官方：单聊每条消息可被动回复 4 次、群聊 5 次，留额度）。
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
  /** mood-log.json：她自己记的心情自述（可回看、可撤销） */
  private readonly moodFile: string;
  private moodLog: MoodEntry[];
  private lastSaveAt = 0;

  constructor(dataDir: string, private readonly log?: (m: string) => void) {
    this.file = path.join(dataDir, 'state', 'emotion.json');
    // 单独一个文件，不塞进 emotion.json：情绪是每轮都可能变的短期状态，
    // mood-log 是**她自己的记录**（要长期留着回看），生命周期不同。
    // 和 memory / self 分开存是同一个理由（见类注释）。
    this.moodFile = path.join(dataDir, 'state', 'mood-log.json');
    this.state = this.load();
    this.moodLog = this.loadMoodLog();
  }

  /** 读 mood-log（坏档 → 空数组，绝不因为一条记录坏了就起不来） */
  private loadMoodLog(): MoodEntry[] {
    try {
      if (!fs.existsSync(this.moodFile)) return [];
      const raw = JSON.parse(fs.readFileSync(this.moodFile, 'utf8')) as unknown;
      const rows = Array.isArray(raw) ? raw : (raw as { entries?: unknown })?.entries;
      if (!Array.isArray(rows)) return [];
      // 逐条清洗：缺 sense/because 的丢弃，其余字段保守兜底
      return rows
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => ({
          id: typeof r.id === 'string' && r.id ? r.id : this.newMoodId(),
          at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : Date.now(),
          day: typeof r.day === 'string' ? r.day : dayInTz(new Date(Number(r.at) || Date.now())),
          sense: (['up', 'down', 'mixed', 'still'] as const).includes(r.sense as MoodSense)
            ? (r.sense as MoodSense)
            : 'mixed',
          because: typeof r.because === 'string' ? r.because : '',
          ...(typeof r.feel === 'string' && r.feel ? { feel: r.feel } : {}),
          ...(r.revoked === true ? { revoked: true } : {}),
          ...(typeof r.revokedAt === 'number' ? { revokedAt: r.revokedAt } : {}),
          ...(typeof r.revokedWhy === 'string' ? { revokedWhy: r.revokedWhy } : {}),
        }))
        .filter((r) => r.because.length > 0);
    } catch {
      return [];
    }
  }

  private newMoodId(): string {
    // 短 id：她要引用它来撤销，太长没法抄。时间戳 36 进制 + 一点随机防同毫秒撞
    const t = Date.now().toString(36);
    const r = Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0');
    return `m${t}${r}`;
  }

  private saveMoodLog(): void {
    try {
      fs.mkdirSync(path.dirname(this.moodFile), { recursive: true });
      const tmp = `${this.moodFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.moodLog, null, 1), 'utf8');
      fs.renameSync(tmp, this.moodFile);
    } catch (err) {
      this.log?.(`emotion: mood-log 写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
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
   * 用**北京时区**——启动时未设 TZ，`new Date().getDate()` 是 UTC。
   *
   * M-mood：从 'addressed' | 'replied' 扩到三值，加了 'mood'（内容自述）。
   * 扩签名时**必须**同时确认 regress() / applyDeltas() 里 daily 的透传 ——
   * 这里踩过坑：那两个函数构建新对象时丢过 daily，导致计数器恒 undefined、
   * 日上限形同虚设（130 轮后 valence 仍贴顶 1.000）。
   * 现在 tickDaily 本身也做字段兜底（旧档没有 mood 字段时补 0），
   * 免得老 emotion.json 升级上来第一次就 NaN。
   */
  private tickDaily(kind: 'addressed' | 'replied' | 'mood'): { used: number; damp: number } {
    const day = dayInTz(new Date());
    if (!this.state.daily || this.state.daily.day !== day) {
      this.state.daily = { day, addressed: 0, replied: 0, mood: 0 };
    }
    const d = this.state.daily;
    // 旧档（M34 时期没有 mood 字段）读上来是 undefined，`undefined + 1 = NaN`
    // 会一路渗进 damp → delta 全是 NaN。这里显式兜底。
    d[kind] = (typeof d[kind] === 'number' && Number.isFinite(d[kind]) ? d[kind] : 0) + 1;
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
   * hour 用**北京时间**（启动时未设 TZ，调用方负责传对）。
   */
  onNightChat(hour: number): void {
    if (hour >= 23 || hour < 6) this.bump({ energy: -0.08, arousal: -0.03 });
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
  renderSection(facts: { silentDays?: number; unanswered?: number; askedBefore?: boolean } = {}): string {
    const st = this.current();
    const lines: string[] = [];

    // ① 事实：对方多久没怎么理她（这条最像人）
    const d = facts.silentDays ?? 0;
    if (d >= 7) lines.push(`他已经 ${Math.floor(d)} 天没怎么跟你说话了`);
    else if (d >= 3) lines.push(`他最近很少回你，大概 ${Math.floor(d)} 天了`);

    // ② 事实：她主动说了话，连续没人接
    const un = facts.unanswered ?? 0;
    if (un >= 2) lines.push(`你有 ${un} 次主动开口没人接`);

    // ②.5 事实：已经问过"你在忙吗"了，还没回。
    // 「只问一次，不追问」—— 追问是讨人厌最快的路径。
    // 来源：dsh-bili-whale 的 quota ask。
    if (facts.askedBefore && un >= 2) lines.push('你已经问过一次「是不是在忙」了，还没回');

    // ③ 事实：精力状态（用身体感受描述，不用形容词结论）
    if (st.energy < 0.3) lines.push('你现在很困，脑子里转不动');
    else if (st.energy < 0.45) lines.push('你有点累');

    // ④ 事实：心里有起伏（不说是好是坏）
    if (st.arousal > 0.7) lines.push('你心里有点静不下来');

    // ⑤ 事实：她自己记过的心情（qq_note_mood）。没有记录时这一行不出现。
    //
    // 为什么要给她看：设计的一部分 —— 下次她能看到"往上 4 次、往下 1 次"，
    // 据此**重新理解自己**，而不是我们写死"你最近状态如何"的规则。
    // 仍然是只给事实：数字和原话都是她自己留下的，结论让她自己下。
    const moodLog = this.moodLogLine();
    if (moodLog) lines.push(moodLog);

    if (lines.length === 0) return '';
    return `【此刻的状态·只是事实，怎么想随你】
${lines.map((x) => '- ' + x).join('\n')}
这些不用说出来，也不用解释。它会自然影响你话多话少——懒得展开就短一点。`;
  }

  /** 睡够了（长时间没消息后第一次说话）→ 精力回升 */
  onRest(): void {
    this.bump({ energy: 0.1, arousal: -0.05 });
  }

  // ── 内容驱动的写入点：qq_note_mood ──
  //
  // 前面六个写入点**全是社交事件**（被叫到/被回应/没人理/被嫌吵/深夜/睡够）。
  // 没有任何一个接收"她看到了什么"。后果实测过：她读《赛博英雄传》第十一章
  // （向山敲自己胸口那章）、写了一条"我和向山的处境有镜像"的自我认识 ——
  // 这在人身上是明确的情绪事件，但对 valence 的贡献是 **0**。
  // 她的心情只反映"今天用户跟她说了几句话"。

  /**
   * 她自己说"刚才心里动了一下"。
   *
   * ## 为什么要她主动叫
   *
   * 没有"读完书自动打标签"。她在自由时间/聊天中觉得有必要时才叫，
   * 跟 qq_mark_interest / qq_write_self_note 同一性质：
   * **自主性长在内容上，不长在机制上**。
   * 机制自动打标签的结果是情绪系统被塞满她并不认同的"情绪"。
   *
   * ## 为什么只有四个方向
   *
   * 见 CONTENT_MOOD_DELTA 的注释：感受是方向，数字是表演。
   *
   * @param sense   up / down / mixed / still
   * @param because 为什么（≤60 字，人话）
   * @param feel    那一下像什么（≤40 字，可选，她自己起的名字，**不参与计算**）
   */
  onContentMood(sense: MoodSense, because: string, feel?: string, now = Date.now()): MoodEntry {
    // 只有 mood 这一 kind 走日软上限，和社交事件共用同一个 daily 计数器容器
    // （但各自独立计数：看书多了不该削弱"被叫到"的权重，反之亦然）。
    const { damp } = this.tickDaily('mood');
    const d = CONTENT_MOOD_DELTA[sense] ?? CONTENT_MOOD_DELTA.mixed;
    const scaled: EmotionDeltas = {
      ...(d.valence !== undefined ? { valence: d.valence * damp } : {}),
      ...(d.arousal !== undefined ? { arousal: d.arousal * damp } : {}),
    };
    this.bump(scaled, now);

    const text = String(because ?? '').trim().slice(0, 60);
    // feel 只存不算：slice 而不是报错 —— 写长了一句不该让整条记录丢失
    const feelText = typeof feel === 'string' ? feel.trim().slice(0, 40) : '';
    const entry: MoodEntry = {
      id: this.newMoodId(),
      at: now,
      day: dayInTz(new Date(now)),
      sense,
      because: text,
      ...(feelText ? { feel: feelText } : {}),
    };
    this.moodLog.push(entry);
    // 日志无限增长没有意义（也没人回看 500 条），保最近 200 条
    if (this.moodLog.length > MAX_MOOD_ENTRIES) this.moodLog.splice(0, this.moodLog.length - MAX_MOOD_ENTRIES);
    this.saveMoodLog();
    this.log?.(`emotion: 记了一条心情 ${sense}${feelText ? ` 「${feelText}」` : ''}`);
    return entry;
  }

  /**
   * 撤销一条自己记过的心情。
   *
   * ## 为什么不物理删除
   *
   * 用户 2026-11-12：她可以删自己的记录，但**不给静默删除** ——
   * 删的时候必须写一句为什么，留下痕迹。所以是标 `revoked`，
   * 原记录、原理由、撤销理由都留着。
   *
   * ## 为什么撤销**不回滚** valence
   *
   * 情绪已经发生了。事后重新评估"这条其实不该算"是**认知**上的修正，
   * 不等于那段时间没发生过 —— 人的心情不会因为你后来觉得"那天没什么"
   * 就回到没被影响过的样子。
   * 更要紧的是：一旦允许回滚，"撤销"就变成了"改写自己的历史"，
   * 那她就不需要面对自己记过什么了 —— 而这正是留痕的意义所在。
   *
   * ## 为什么参数里没有"谁"
   *
   * 只能撤自己的。参数里不提供任何指定他人的可能（用户明确要求）。
   */
  undoMood(id: string, why: string, now = Date.now()): { ok: boolean; error?: string; entry?: MoodEntry } {
    const reason = String(why ?? '').trim().slice(0, 120);
    if (!reason) return { ok: false, error: '撤销必须写理由，不许静默删' };
    const entry = this.moodLog.find((e) => e.id === id);
    if (!entry) return { ok: false, error: `没有 id 为 ${id} 的记录` };
    if (entry.revoked) return { ok: false, error: '这条已经撤过了' };
    entry.revoked = true;
    entry.revokedAt = now;
    entry.revokedWhy = reason;
    this.saveMoodLog();
    this.log?.(`emotion: 撤销心情记录 ${id}，理由：${reason}`);
    return { ok: true, entry };
  }

  /** 读自己的心情记录（默认不含已撤销的；新的在前） */
  moodEntries(opts: { includeRevoked?: boolean; limit?: number } = {}): MoodEntry[] {
    const rows = opts.includeRevoked ? this.moodLog : this.moodLog.filter((e) => !e.revoked);
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 200));
    return rows.slice(-limit).reverse();
  }

  /** 最近 N 天按方向计数（已撤销的不算） */
  moodStats(days = 7, now = Date.now()): { total: number; bySense: Record<MoodSense, number> } {
    const since = now - days * 86_400_000;
    const bySense: Record<MoodSense, number> = { up: 0, down: 0, mixed: 0, still: 0 };
    let total = 0;
    for (const e of this.moodLog) {
      if (e.revoked || e.at < since) continue;
      bySense[e.sense] += 1;
      total += 1;
    }
    return { total, bySense };
  }

  /**
   * 把最近的心情自述渲染成一行**事实**（给 renderSection 用）。
   *
   * 语气沿用「陈述事实，不给结论」：只说她自己记了几笔、方向分布如何，
   * 不写"所以你最近状态不错"。方向用「往上/往下/说不清/平了」而不是
   * up/down/mixed/still —— 后者是代码里的枚举名，不是她会说的话。
   */
  private moodLogLine(now = Date.now()): string | undefined {
    const { total, bySense } = this.moodStats(7, now);
    if (total === 0) return undefined;
    const label: Record<MoodSense, string> = { up: '往上', down: '往下', mixed: '说不清', still: '平了' };
    const parts = (['up', 'down', 'mixed', 'still'] as const)
      .filter((k) => bySense[k] > 0)
      .map((k) => `${label[k]} ${bySense[k]}`);
    const head = `最近七天你自己记下的：${parts.join('、')}`;
    // 最近一条如果写了 feel，就原样带一句 —— 那是她自己起的名字，比任何统计都准
    const latest = [...this.moodLog].reverse().find((e) => !e.revoked && e.feel);
    if (!latest) return head;
    return `${head}；最近一条你想说的是「${latest.feel}」`;
  }
}
