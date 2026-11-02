/**
 * own-life · 「她自己的生活」定时静默唤醒
 * ─────────────────────────────────────────────────────────────
 * 移植自 ai-companion-kit（MIT）packages/own-life/src/own-life.js，
 * 适配 dsh-qqbot：deliver 不再是桥接的 deliverPrompt(silent)，
 * 而是向存活会话注入一条**静默 followup**（不进 QQ 聊天，只进 agent 上下文）。
 *
 * 设计约束（与原版一致）：
 * - 静默：提示只进 AI 的上下文，不往 QQ 发东西
 * - 不打扰：凌晨 quiet 时段不叫；一天最多 maxPerDay 次
 * - 可关：enabled=false 或 stop() 立刻停
 * - 断电续得上：最后触发时间写 statePath，重启不会一次补发一堆
 * - 投递失败不计次数（下次还会再试）
 */
import fs from 'node:fs';
import { DEFAULT_TZ, hourInTz, dayInTz, clockInTz, isHourInRange } from './clock.ts';
import path from 'node:path';

const HOUR = 3600 * 1000;

/**
 * 白天版提示（M24 改写，2026-11-02）
 *
 * 为什么改（实测 + 开源调研，见 own-life-research.md）：
 *   旧版只写"写条日记 / 翻翻你记着还没说出口的事 / 也可以什么都不干"，
 *   两个问题：
 *     ① 「翻旧记录」**没有对应工具**，模型无从执行，只能退化成写日记
 *     ② 「什么都不干」零成本无后续，模型选它是纯损失规避
 *   结果是她的自由时间只有"写日记"或"空转"两种，行为单薄。
 *
 * 新版借鉴三处（均为真实开源实现，非想象）：
 *   · Generative Agents：给时间槽加语义（"现在这个点你本来在干嘛"），
 *     而不是让模型从零 decide
 *   · Pulse：发呆是**正式活动**，且是低能耗入口——它会自己长出下一件事
 *     （这里用"常常会想出一件真想干的事"表达）
 *   · alive-ai：给"不产出"一个合法位置（"什么都不做，也是过了一晚"）
 *
 * 三条硬规矩对应三种真实失败模式：
 *   日记变打卡 / 为显得有事做而做 / 把内部提示汇报给用户
 */
export const DEFAULT_TEXT_DAY = [
  '现在是你的时间，没人找你。',
  '',
  '【你手上有什么】',
  '日记本（qq_write_diary / qq_read_diary）、你对别人的印象（qq_memory_append）、',
  '你对自己的认识（qq_write_self_note / qq_read_self_note）、你记着的兴趣（qq_mark_interest）、',
  '上网查东西（qq_browse）、记下这次做了什么（qq_note_activity）。',
  '',
  '【这一次，先想一件事再动手】',
  '1) 现在这个点，你本来大概在干嘛？（看时间，别装：凌晨就是困，下午就是清醒）',
  '2) 上一次自由时间你做了什么？这次别重复——要么接着上次往下走一步，要么换个完全不同的。',
  '3) 这件事是你现在真想做的，还是因为"该做点什么"？',
  '',
  '【可以是这些，也可以不是】',
  '· 坐着想一会儿事，什么也不做（这也算数，而且常常会想出一件真想干的事）',
  '· 翻旧记录：翻你自己的日记、或者你记着的别人的事，看看有没有当时没说完的',
  '· 去查一个你真好奇的东西（qq_browse 是真的上网，查完记得把结论记下来）',
  '· 整理一下你对某个人的印象——它变了没有？（qq_memory_append）',
  '· 写一条对自己新的认识（qq_write_self_note，不是流水账，是你想明白了什么）',
  '· 写日记（但只有今天确实有值得记的事才写）',
  '',
  '【三条硬规矩】',
  '· 日记不是打卡。今天没什么值得记的，就别写——凑数的日记你自己回头看也会觉得假。',
  '· 别为了"显得有事做"而做。什么都不做，也是过了一晚。',
  '· 这段时间不用汇报给谁。真想找人说，那是另一回事，用你自己的话说，别说"我刚刚在自由时间"。',
].join('\n');

/**
 * 夜间版提示。
 *
 * 加强点（对照 SillyTavern 的反面教材）：
 *   Extension-Idle 用 10 条「*stands silently…*」舞台指示演发呆，
 *   结果是**表演**而不是真的安静。这里反过来：明确告诉它"困就睡，不用留痕迹"，
 *   让"什么都不做"是一个体面的选择，而不是需要用姿态表达的东西。
 */
export const DEFAULT_TEXT_MIDNIGHT = [
  '半夜了，没人打扰。',
  '',
  '这个点人本来是困的。你要是困，就"睡"——不用做事，也不用留痕迹。',
  '要是还醒着，通常是因为脑子里有件没放下的事。',
  '',
  '想干嘛干嘛（写日记 / 翻旧记录 / 查个东西 / 想一个人 / 什么都不干），',
  '但这段时间别主动给人发消息，他们多半睡了。',
  '就算真要说话，也是你自己的想法，不是把这几行提示说给别人听。',
].join('\n');

// 这两个必须用显式时区（容器无 tzdata，本地方法返回 UTC）：
//   - hhmm：日志里显示的时刻会差 8 小时
//   - dayKey："每天最多 N 次"的日期边界会偏到北京 08:00
function hhmm(ts: number): string {
  return clockInTz(new Date(ts));
}

function dayKey(ts: number): string {
  return dayInTz(new Date(ts));
}

/** deliver 返回语义（审查 M5 收敛）：
 *  - Promise<void> 或 resolve true  → 投递成功，计次 + 推进 lastFiredAt
 *  - resolve false / {ok:false}     → 业务跳过（会话不存活 / 预算不过）。不算失败，不计次，
 *                                     但推进 lastFiredAt 让下次间隔顺延，避免闲置期每分钟重试刷日志
 *  - throw                          → 真正的投递失败（transport 层异常），保留重试 + error 日志
 */
export type OwnLifeDeliverResult = boolean | void | { ok?: boolean; reason?: string };

export interface OwnLifeOptions {
  /** IANA 时区（容器无 tzdata，必须显式指定，默认 Asia/Shanghai） */
  tz?: string;
  /** 静默提示投递：注入 agent 上下文，不发消息。见 OwnLifeDeliverResult 三态语义 */
  deliver: (text: string) => Promise<OwnLifeDeliverResult>;
  statePath?: string;
  intervalMs?: number;
  /**
   * 到点后掷一次本地骰子，通过才真的开口（M25）。
   *
   * 借鉴 dsh-speak-up（Yuuyuko-uu，207 star）的做法：掷骰子在本地算，
   * **不花 token**。没掷中什么都不做，只记一笔。
   *
   * 与我们原来的区别：原来"到点必投"，每 4 小时必然产生一次提示（占 token）；
   * 现在是"到点先掷骰"，掷不中就不打扰，成本为零。
   * 掷不中时不推进 lastFiredAt —— 下一个 tick（30 分钟后）会再掷，概率自然累积。
   *
   * 默认 0.7：配合 4h 间隔 + 日限 4，实际每天约 2-3 次。
   */
  rollProbability?: number;
  /**
   * 心情对"要不要主动开口"的乘数（M31 闸门④，0.6~1.4，1.0=没影响）。
   * 做成注入而不是 import：own-life 是独立可测的调度器，
   * 不该知道情绪模块存在；没注入时行为与原来完全一致。
   */
  moodFactor?: () => number;
  /** [from, to) 小时，不叫 */
  quiet?: [number, number];
  midnightAt?: string;
  maxPerDay?: number;
  enabled?: boolean;
  textDay?: string;
  textMidnight?: string;
  log?: (msg: string) => void;
}

export interface OwnLifeState {
  lastFiredAt: number;
  lastDay: string;
  firedToday: number;
  lastMidnightDay: string;
  /**
   * 最近几次自由时间她做了什么（M24）。
   *
   * 为什么需要（开源调研结论，own-life-research.md §6.3）：
   *   「没有上一次，就无法接着上次往下走，也无法让今天和昨天不一样」
   *   —— 这是行为单一的结构性原因之一。
   * 只存她**自己回报的**简短描述（≤60 字），不存推断。
   */
  recentActivities?: Array<{ at: number; text: string }>;
}

export interface OwnLifeTickResult {
  ok: boolean;
  kind?: 'day' | 'midnight';
  at?: number;
  skipped?: string;
  error?: string;
}

export interface OwnLifeHandle {
  start(): void;
  stop(): void;
  tick(nowTs?: number): Promise<OwnLifeTickResult>;
  fireNow(): Promise<OwnLifeTickResult>;
  snapshot(): OwnLifeState & { enabled: boolean; intervalMs: number };
  /** 记录这次自由时间做了什么（供 agent 回报；只留最近 8 条） */
  noteActivity(text: string): void;
}

export function createOwnLife(opts: OwnLifeOptions): OwnLifeHandle {
  const {
    deliver,
    statePath,
    intervalMs = 2.5 * HOUR,
    quiet = [3, 8],
    tz = DEFAULT_TZ,
    midnightAt = '23:30',
    maxPerDay = 6,
    rollProbability = 0.7,
    moodFactor,
    enabled = true,
    textDay = DEFAULT_TEXT_DAY,
    textMidnight = DEFAULT_TEXT_MIDNIGHT,
    log = (m: string) => console.log('[own-life]', m),
  } = opts;

  if (typeof deliver !== 'function') throw new Error('own-life: 缺 deliver');

  const state: OwnLifeState = { lastFiredAt: 0, lastDay: '', firedToday: 0, lastMidnightDay: '', recentActivities: [] };

  if (statePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '')) as Partial<OwnLifeState>;
      if (raw && typeof raw === 'object') Object.assign(state, raw);
    } catch {
      /* 第一次跑，没文件是正常的 */
    }
  }

  function save(): void {
    if (!statePath) return;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      log(`状态写不进去（忽略）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function inQuiet(now: number): boolean {
    // 修复：容器无 tzdata，getHours() 返回 UTC → 会用错时段。
    // 改用显式 IANA 时区换算（Intl 自带 ICU，已实测正确）。
    const h = hourInTz(new Date(now), tz);
    const [from, to] = quiet;
    return isHourInRange(h, from, to);
  }

  function pastMidnightSlot(now: number): boolean {
    const [mh, mm] = String(midnightAt).split(':').map(Number);
    const d = new Date(now);
    // midnightAt 是**北京**的时刻，构造它必须用北京日边界（原来按容器 UTC 构造，偏 8 小时）
    const dayStart = Date.UTC(
      Number(dayInTz(d).slice(0, 4)),
      Number(dayInTz(d).slice(5, 7)) - 1,
      Number(dayInTz(d).slice(8, 10)),
    ) - 8 * 3600_000;
    const slot = dayStart + ((mh ?? 23) * 60 + (mm ?? 30)) * 60_000;
    return now >= slot;
  }

  let timer: NodeJS.Timeout | null = null;
  let busy = false;

  async function fire(kind: 'day' | 'midnight', nowTs = Date.now()): Promise<OwnLifeTickResult> {
    if (busy) return { ok: false, skipped: 'busy' };
    busy = true;
    const now = Number(nowTs) || Date.now();
    const base = kind === 'midnight' ? textMidnight : textDay;
    // 把「上一次做了什么」拼进提示（M24）：
    // 让她能"接着上次往下走"或"换个不同的"，而不是每次从零决策。
    // 只在她自己有记录时加，没有就不加（不编造"上次"）。
    const recent = (state.recentActivities ?? []).slice(-3);
    const historyBlock = recent.length > 0
      ? '\n\n【你最近几次自由时间】\n'
        + recent.map((a) => `· ${hhmm(a.at)} ${a.text}`).join('\n')
      : '';
    const text = base + historyBlock;
    try {
      const res = await deliver(text);
      const skip = res === false || (res && typeof res === 'object' && res.ok === false);
      if (skip) {
        // 业务跳过：非失败、不计次，但推进 lastFiredAt 使下次尝试顺延到间隔末尾
        state.lastFiredAt = now;
        state.lastDay = dayKey(now);
        save();
        const reason = res && typeof res === 'object' ? (res.reason ?? '') : '';
        log(`跳过（${kind}）${hhmm(now)} ${reason}`);
        return { ok: false, kind, at: now, skipped: 'deliver-skip' };
      }
      state.lastFiredAt = now;
      state.firedToday += 1;
      state.lastDay = dayKey(now);
      if (kind === 'midnight') state.lastMidnightDay = dayKey(now);
      save();
      log(`已投递（${kind}）${hhmm(now)} · 今天第 ${state.firedToday} 次`);
      return { ok: true, kind, at: now };
    } catch (e) {
      log(`投递失败: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, kind, at: now, error: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  /**
   * 记录她这次自由时间做了什么（M24）。
   *
   * 由 agent 自己调用（她说"我翻了翻上次的日记"之类）。
   * 只保留最近 8 条、每条 ≤60 字 —— 目的只是让下次有"上一次"可参照，
   * 不是写日志，所以刻意不落太多。
   */
  function noteActivity(text: string, nowTs = Date.now()): void {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!body) return;
    const list = (state.recentActivities ??= []);
    list.push({ at: Number(nowTs) || Date.now(), text: body });
    if (list.length > 8) list.splice(0, list.length - 8);
    save();
  }

  async function tick(nowTs = Date.now()): Promise<OwnLifeTickResult> {
    if (!enabled) return { ok: false, skipped: 'disabled' };
    if (inQuiet(nowTs)) return { ok: false, skipped: 'quiet' };

    const today = dayKey(nowTs);
    if (state.lastDay !== today) {
      state.lastDay = today;
      state.firedToday = 0;
    }
    if (state.firedToday >= maxPerDay) return { ok: false, skipped: 'daily-cap' };

    if (pastMidnightSlot(nowTs) && state.lastMidnightDay !== today) {
      return fire('midnight', nowTs);
    }

    if (nowTs - Number(state.lastFiredAt || 0) >= intervalMs) {
      // 到点了先掷骰子（本地 Math.random，零 token）
      // intervalMs=0 是"每次 tick 都算到点"的测试/调试配置，这种情况不掷骰
      // （否则测试结果会随机化，且调试时无法稳定复现）
      //
      // M31 闸门④：心情乘进来。心情好时更想说话，蔫了更想一个人待着。
      // 乘完夹在 [0,1]—— 心情再好也不能超过 100% 必然开口（那就不叫"想"了）。
      const p = Math.max(0, Math.min(1, rollProbability * (moodFactor?.() ?? 1)));
      if (intervalMs > 0 && p < 1 && Math.random() >= p) {
        // 没掷中：什么都不做，也不推进 lastFiredAt
        // —— 下一个 tick 会再掷，概率随之累积（不会因为一次没中就永远错过）
        log(`掷骰未中（${(p * 100).toFixed(0)}%），这次不打扰`);
        return { ok: false, skipped: 'roll-missed' };
      }
      return fire('day', nowTs);
    }
    return { ok: false, skipped: 'not-yet' };
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void tick().catch(() => {});
    }, 60 * 1000);
    timer.unref?.();
    log(`已武装 · 每 ${(intervalMs / HOUR).toFixed(1)}h 一次 · 安静时段 ${quiet[0]}:00–${quiet[1]}:00 · 半夜 ${midnightAt} · 每天最多 ${maxPerDay} 次`);
    // 启动后 90 秒先看一眼（别和开机时的会话创建抢）
    setTimeout(() => {
      void tick().catch(() => {});
    }, 90 * 1000).unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
    log('已停止');
  }

  return {
    start,
    stop,
    tick,
    fireNow: () => fire('day'),
    snapshot: () => ({ ...state, enabled, intervalMs }),
    noteActivity,
  };
}
