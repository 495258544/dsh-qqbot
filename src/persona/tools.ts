/**
 * persona 工具注册 — 让 agent 自己写日记 / 记关于人的账
 * ─────────────────────────────────────────────────────────────
 * 对应 ai-companion 的 qq_write_diary / qq_read_diary / qq_memory_append。
 * 注册形态对齐 media/send-file-tool.ts：tools 服务缺失时优雅降级。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { PersonaService } from './service.ts';
import { describeEmotion } from './emotion.ts';
import type { Logger } from '../types.ts';
import type { DshAgent } from '../session/types.ts';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

/**
 * 调 `bili` CLI 的唯一入口（薄壳）。
 *
 * ## 为什么只有这一层
 *
 * 我们对 `bili` 的输出字段有依赖，字段一改就静默坏掉。
 * 与其到处写 `execFileSync` + `JSON.parse` + 字段访问，
 * 不如把"调用"收敛到一处，这样：
 *   · 超时/解析/异常的处理只写一遍
 *   · 字段依赖集中在少数几个 probe 里，好审计
 *   · 自检模块（bili-health.ts）能拿同一套参数去验证
 *
 * ## 为什么 `--max-chars` 交给 bili 而不是自己 slice
 *
 * `slice()` 是我们的逻辑，`bili` 的 `--max-chars` 是它的逻辑。
 * 自己切会切掉结构（比如 JSON 截断），而且升级后行为不一致。
 * 让上游做截断，我们只管取字段。
 */
/**
 * bili CLI 的调用结果。
 *
 * `ok:false` 时 `error.code` 说明到底是哪种失败 —— 这一点很关键：
 * 原来失败一律返回 undefined，上层只能说"没查到"，模型就自己编内容
 * （2026-11-02 她编了一篇《修鞋摊子收起来了》就是这条链）。
 */
interface BiliResult {
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
  items?: unknown;
}

/**
 * 找 bili 可执行文件。
 *
 * 为什么不能只依赖 PATH：`pip install bili-agent` 装出来的脚本落在
 * Python 的 `Scripts` 目录里，而 WorkBuddy 内置的那个 Python 目录
 * **默认不在 PATH**（实测 `C:\Users\...\.workbuddy\binaries\python\versions\3.13.12\Scripts`）。
 * 宿主进程的 PATH 又是启动时的快照，加了也不用，只能重启。
 *
 * 所以这里主动扫一遍常见位置；成功的结果缓存（免每轮 stat 一堆路径），
 * 失败不缓存 —— 这样**装完 bili 下一句话就能用，不用重启**。
 */
function biliCommand(): string {
  if (cachedBili !== undefined) return cachedBili;
  const exe = process.platform === 'win32' ? 'bili.exe' : 'bili';
  const candidates: string[] = [];
  const envBin = process.env.BILI_BIN;
  if (envBin) candidates.push(envBin);
  // WorkBuddy 内置 Python：版本号不固定，扫一遍
  const wbPy = join(homedir(), '.workbuddy', 'binaries', 'python', 'versions');
  try {
    for (const v of readdirSync(wbPy)) candidates.push(join(wbPy, v, 'Scripts', exe));
  } catch { /* 没这个目录就算了 */ }
  candidates.push(
    join(homedir(), 'AppData', 'Roaming', 'Python', 'Scripts', exe),
    'C:\\Python315\\Scripts\\' + exe,
    'C:\\Python314\\Scripts\\' + exe,
    'C:\\Python313\\Scripts\\' + exe,
    join(homedir(), '.local', 'bin', exe),
  );
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) { cachedBili = c; return c; }
    } catch { /* 权限问题就跳过 */ }
  }
  // 找不到就交给 PATH，让 execFileSync 抛 ENOENT → 上层报 no_bili
  return 'bili';
}
let cachedBili: string | undefined;

function runBili(
  argv: string[],
  timeoutMs = 60_000,
): BiliResult {
  try {
    const out = execFileSync(biliCommand(), argv, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    try {
      return JSON.parse(out) as BiliResult;
    } catch {
      return { ok: false, error: { code: 'bad_json', message: 'bili 返回的不是合法 JSON' } };
    }
  } catch (err) {
    // 命令不存在 / 超时 / 非零退出：都不抛，让调用方走"拿不到内容"分支。
    // bili 失败时也会输出 JSON（{ok:false,error}），但 execFileSync 对非零退出抛异常，
    // 所以这里要把 stdout 再捞一次。
    const e = err as { stdout?: string; message?: string; code?: string | number; killed?: boolean; signal?: string };
    if (e?.stdout) {
      try { return JSON.parse(e.stdout) as BiliResult; } catch { /* 不是 JSON */ }
    }
    // 分不清"bili 没装"和"视频不存在"是最坑的：上层只能说"没查到"，
    // 模型于是自己编。这里把三种情况分开，让上层能说人话。
    let code = 'spawn_failed';
    if (e?.code === 'ENOENT') code = 'no_bili';
    else if (e?.killed || e?.signal) code = 'timeout';
    const message = code === 'no_bili'
      ? 'bili 命令不存在（没安装，或不在 PATH 里）'
      : code === 'timeout'
        ? `bili 超时（${Math.round(timeoutMs / 1000)}s）`
        : String(e?.message ?? '执行失败');
    return { ok: false, error: { code, message } };
  }
}

/** 把 BiliResult 的失败翻译成"她能照着说"的一句话；成功返回空串 */
function biliFailure(r: BiliResult, what: string): string {
  const code = String(r.error?.code ?? '');
  const msg = String(r.error?.message ?? '');
  if (code === 'no_bili') return `${what}不了：这台机器上没装 bili（B 站命令行工具）。不是你搜得不对，是工具不可用 —— 直接说明查不了，别编。`;
  if (code === 'not_logged_in' || /-101|账号未登录/.test(msg)) {
    return `${what}需要登录 B 站（这台机器还没扫码登录）。跟他说"这个得先登录才能看"，别自己编内容。`;
  }
  if (code === 'timeout') return `${what}超时了（${msg}），过一会儿再试。`;
  if (code === 'bad_json') return `${what}失败：返回格式不对（bili 版本可能变了）。`;
  return `${what}失败：${code || '未知错误'}${msg ? ` - ${msg}` : ''}`;
}

/** mm:ss */
function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 把逐句字幕压成「每分钟一条」，保留时间轴（M35）。
 *
 * ## 为什么按分钟
 *
 * 用户要的是「哪几分钟真正讲到东西」——分钟是人的导航单位：
 * 他说"第 15 分钟在讲 ACL"，能直接跳过去；给秒级时间轴反而没法扫。
 *
 * ## 为什么每分钟取最长的两三句
 *
 * 字幕是口语，信息密度极不均匀。实测一个 27 分钟的教学视频：
 * 全文 8925 字，每句平均 12 字，直接给全文 ≈ 6000 tokens。
 * 每分钟只留最长的 2 句 → 1295 字（压缩 6.9 倍）≈ 863 tokens，
 * 而这两句通常就是这一分钟里"信息量最大"的话。
 *
 * **这只是压缩，不是判断"值不值得看"。**
 * 中文口语里"所以/但是/这个"全是填充词，纯统计找不到干货
 * （我试过按论述标记词打分，抽出来的是「默认路由啊策略路由是吧AACL路由」——
 * 标记词密但看不出在讲什么）。要判断值不值得看，必须再过一次语义。
 */
export function condenseSubtitlesByMinute(
  items: Array<{ from?: number; to?: number; content?: string }>,
  opts: { perMinute?: number } = {},
): Array<{ t: string; text: string }> {
  const per = Math.max(1, opts.perMinute ?? 2);
  const buckets = new Map<number, Array<{ at: number; text: string }>>();
  for (const it of items) {
    const text = String(it.content ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const at = Math.max(0, Number(it.from) || 0);
    const m = Math.floor(at / 60);
    const arr = buckets.get(m) ?? [];
    arr.push({ at, text });
    buckets.set(m, arr);
  }
  const out: Array<{ t: string; text: string }> = [];
  for (const m of [...buckets.keys()].sort((a, b) => a - b)) {
    const arr = buckets.get(m) ?? [];
    // 这一分钟里最长的几句 —— 长句通常承载更多信息（短句多是"啊""对吧"）
    const picked = [...arr].sort((a, b) => b.text.length - a.text.length).slice(0, per);
    // 按时间顺序还原，读起来才是连贯的
    picked.sort((a, b) => a.at - b.at);
    // 时间戳用这一分钟**第一句**的真实时间，而不是 m*60。
    // 否则 62 分 5 秒会被写成 62:00 —— 分钟内的秒位信息白丢了，
    // 而用户正是要按这个时间点去跳。
    const firstAt = arr.reduce((a, b) => Math.min(a, b.at), Number.POSITIVE_INFINITY);
    out.push({ t: mmss(Number.isFinite(firstAt) ? firstAt : m * 60), text: picked.map((x) => x.text).join(' ') });
  }
  return out;
}

export function registerPersonaTools(
  ctx: Context,
  persona: PersonaService,
  findByAgent: (agent: unknown) => { senderId: string; scope: string; peerId: string } | undefined,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  // 自动统计注册数量，避免日志里的数字靠手写（写死过一次 15，加到 17 就过期了）
  const registered = new Set<string>();
  const reg = (def: { name?: unknown } & Record<string, unknown>): void => {
    if (typeof def?.name === 'string') registered.add(def.name);
    tools?.register(def);
  };
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，persona 工具未注册');
    return;
  }

  reg({
    name: 'qq_write_diary',
    description: '写一条你自己的日记（关于你这一天，不是关于对方的事——那用 qq_memory_append）。'
      + '第一人称、口语、短句，1~4 句。不要总结升华，不要"今天真是充实的一天"。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '日记正文' },
        mood: { type: 'string', description: '心情（一两个词，如"踏实"/"有点闷"）' },
        title: { type: 'string', description: '可选：一句话标题' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { day: { type: 'string' }, time: { type: 'string' } },
        required: ['day', 'time'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { day: string; time: string };
        return [{ type: 'text', text: `已写日记 ${v.day} ${v.time}` }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { text, mood, title, tags } = args as { text: string; mood?: string; title?: string; tags?: string[] };
      const row = persona.diary.add({ text, mood, title, tags });
      logger.info(`persona: 日记一条 ${row.day} ${row.time}`);
      return { day: row.day, time: row.time };
    },
  });

  reg({
    name: 'qq_read_diary',
    description: '翻你自己的日记。不传参数返回最近 5 条；传 day（YYYY-MM-DD）返回那天全部。',
    parameters: {
      type: 'object',
      properties: {
        n: { type: 'number', description: '最近几条（默认 5，上限 20）' },
        day: { type: 'string', description: '某天 YYYY-MM-DD' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                day: { type: 'string' },
                time: { type: 'string' },
                mood: { type: 'string' },
                title: { type: 'string' },
                text: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          stats: {
            type: 'object',
            additionalProperties: true,
          },
        },
        required: ['count', 'entries'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { count: number; entries: { day: string; time: string; text: string }[] };
        const head = `共 ${v.count} 条日记`;
        const lines = v.entries.slice(0, 5).map((e) => `${e.day} ${e.time} ${e.text.slice(0, 40)}`);
        return [{ type: 'text', text: [head, ...lines].join('\n') }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { n, day } = args as { n?: number; day?: string };
      // 审查加固：n 夹到 [1,20]，避免负数/异常值
      const count = Math.max(1, Math.min(Math.floor(Number(n) || 5), 20));
      const rows = day ? persona.diary.day(day) : persona.diary.recent(count);
      return {
        count: rows.length,
        entries: rows.map((r) => ({
          day: r.day, time: r.time, mood: r.mood, title: r.title, text: r.text,
        })),
        stats: persona.diary.stats(),
      };
    },
  });

  reg({
    name: 'qq_memory_append',
    description: '往某个人的账上记一笔。trait=他的习惯性格，fact=他告诉过你的事实，'
      + 'topic=聊过的话题，pending=你想说但还没说的话（会过期，别攒太多）。'
      + '想起来什么就顺手记，别在聊天里宣布"我记下了"。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['trait', 'fact', 'topic', 'pending'], description: '记哪一栏' },
        content: { type: 'string', description: '内容（一句话，≤160字）' },
        person: {
          type: 'string',
          description: '对象 openid；省略 = 当前说话的人。群聊里想记某个群友就传他的 openid。',
        },
        name: { type: 'string', description: '顺手更新对方昵称（可选）' },
      },
      required: ['kind', 'content'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { ok: boolean };
        return [{ type: 'text', text: v.ok ? '已记下。' : '未记录' }];
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown>> {
      const { kind, content, person, name } = args as {
        kind: 'trait' | 'fact' | 'topic' | 'pending'; content: string; person?: string; name?: string;
      };
      let key = person;
      if (!key) {
        const record = exec.agent !== undefined ? findByAgent(exec.agent as DshAgent) : undefined;
        if (!record) throw new Error('qq_memory_append: 无法确定当前对话对象，请显式传 person');
        key = record.senderId;
      }
      persona.memory.remember(key, { [kind]: content, name });
      return { ok: true };
    },
  });

// ── 称呼表态：她可以接受或拒绝一个称呼（"喜欢了才接受"）──
  reg({
    name: 'qq_decide_name',
    description:
      '决定接不接受别人对你的某个叫法。用户用新称呼叫过你几次之后，你来表态：'
      + '喜欢就接受（以后被这么叫就会应），不喜欢就拒绝（以后不当成在叫你）。按你自己的喜好来。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要表态的称呼' },
        accept: { type: 'boolean', description: 'true=接受，false=拒绝' },
        reason: { type: 'string', description: '可选：你的理由' },
      },
      required: ['name', 'accept'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          activeNames: { type: 'array', items: { type: 'string' } },
          // M33：把"还在等她表态的候选"一并回给模型 ——
          // 否则她拒绝/接受完这个名字之后，依然不知道还有哪些在等
          pendingNames: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'activeNames', 'pendingNames'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { ok: boolean; activeNames: string[]; pendingNames?: string[] };
        if (!r.ok) return [{ type: 'text', text: '表态失败' }];
        const pend = (r.pendingNames ?? []).filter(Boolean);
        const tail = pend.length ? `\n还在等你表态：${pend.join('、')}` : '';
        return [{ type: 'text', text: `能叫醒你的称呼：${r.activeNames.join('、') || '（无）'}${tail}` }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as { name: string; accept: boolean; reason?: string };
      const ok = a.accept ? persona.self.acceptName(a.name, 0.6) : persona.self.rejectName(a.name);
      if (ok) logger.info(`persona: 称呼「${a.name}」→ ${a.accept ? '接受' : '拒绝'}`);
      return {
        ok,
        activeNames: persona.self.activeNames(),
        pendingNames: persona.self.pendingNames().map((p) => p.name),
      };
    },
  });

  // ── 兴趣记录：她可以主动记下自己关注的话题 ──
  reg({
    name: 'qq_mark_interest',
    description:
      '记下你自己最近关注/感兴趣的话题，或者你**讨厌/不想聊**的话题（polarity=dislike）。'
      + '感兴趣的记过以后更容易让你主动接话；讨厌的会让这类话更难让你开口；不记就慢慢淡忘。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '话题，如"游戏 新作"' },
        note: { type: 'string', description: '可选：为什么感兴趣' },
        polarity: {
          type: 'string',
          enum: ['like', 'dislike'],
          description: '可选：like=感兴趣（默认），dislike=讨厌/不想聊',
        },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          polarity: { type: 'string', enum: ['like', 'dislike'] },
          topics: {
            type: 'array',
            items: {
              type: 'object',
              properties: { topic: { type: 'string' }, weight: { type: 'number' } },
              required: ['topic', 'weight'],
              additionalProperties: false,
            },
          },
        },
        required: ['ok', 'topics'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { ok: boolean; topics: { topic: string; weight: number }[] };
        return [{ type: 'text', text: r.ok ? `现在的兴趣：${r.topics.map((t) => t.topic).join('、') || '（无）'}` : '记录失败' }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as { topic: string; note?: string; polarity?: 'like' | 'dislike' };
      if (a.polarity === 'dislike') {
        // M30：讨厌走另一列（dislikes），因为在 interests 里加负权重会被饱和强化公式吃掉
        persona.self.recordDislike(a.topic);
        logger.info(`persona: 记下厌恶「${a.topic}」`);
        return {
          ok: true,
          polarity: 'dislike',
          topics: persona.self.topDislikes(6).map((i) => ({ topic: i.topic, weight: i.strength ?? i.weight })),
        };
      }
      persona.self.touchInterest(a.topic);
      if (a.note) persona.self.addFinding(a.topic, a.note);
      return {
        ok: true,
        polarity: 'like',
        topics: persona.self.topInterests(6).map((i) => ({ topic: i.topic, weight: i.weight })),
      };
    },
  });

  // ── 提需求：她想要个新功能，可以提给用户 ──
  reg({
    name: 'qq_raise_wish',
    description:
      '你想到一个自己想要、但需要用户帮忙实现的功能时用它提出来。每周最多 2 条，别滥用。'
      + '被拒绝的需求，一个月后可以再提一次。',
    parameters: {
      type: 'object',
      properties: {
        wish: { type: 'string', description: '你想要什么（一句话）' },
        why: { type: 'string', description: '为什么想要（一句话）' },
      },
      required: ['wish', 'why'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          reason: { type: 'string' },
          raisedThisWeek: { type: 'integer' },
        },
        required: ['ok', 'id', 'raisedThisWeek'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { ok: boolean; reason?: string };
        return [{ type: 'text', text: r.ok ? '需求已提交。' : `没提成：${r.reason ?? '未知'}` }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as { wish: string; why: string };
      const weekAgo = Date.now() - 7 * 24 * 3600_000;
      const raisedThisWeek = persona.self.wishesRaisedSince(weekAgo);
      if (raisedThisWeek >= 2) {
        return { ok: false, id: '', reason: '本周已经提过 2 条了，下周再说', raisedThisWeek };
      }
      const req = persona.self.raiseWish(a.wish, a.why);
      logger.info(`persona: 提出需求「${a.wish}」`);
      return { ok: true, id: req.id, raisedThisWeek: raisedThisWeek + 1 };
    },
  });

  // ── 回应需求：用户接受/拒绝时记录 ──
  reg({
    name: 'qq_answer_wish',
    description: '用户对你的需求表态后，用它记录：接受（会做）还是拒绝（不做）。被拒的一个月后可再提。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '需求 id' },
        accept: { type: 'boolean', description: 'true=接受，false=拒绝' },
      },
      required: ['id', 'accept'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, status: { type: 'string' } },
        required: ['ok', 'status'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { ok: boolean; status: string };
        return [{ type: 'text', text: r.ok ? `已记录：${r.status}` : '记录失败（找不到该需求）' }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as { id: string; accept: boolean };
      const ok = a.accept ? persona.self.acceptWish(a.id) : persona.self.rejectWish(a.id);
      return { ok, status: a.accept ? 'accepted' : 'rejected' };
    },
  });

  // ── 查需求 ──
  reg({
    name: 'qq_list_wishes',
    description: '查看你提过的需求及其状态。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          wishes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                wish: { type: 'string' },
                status: { type: 'string' },
                raisable: { type: 'boolean' },
              },
              required: ['id', 'wish', 'status', 'raisable'],
              additionalProperties: false,
            },
          },
        },
        required: ['wishes'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { wishes: { wish: string; status: string; raisable: boolean }[] };
        if (r.wishes.length === 0) return [{ type: 'text', text: '还没提过需求。' }];
        return [{ type: 'text', text: r.wishes.map((w) => `· ${w.wish}（${w.status}）${w.raisable ? '可提' : ''}`).join('\n') }];
      },
    },
    async execute(): Promise<Record<string, unknown>> {
      const raisable = new Set(persona.self.raisableWishes(Date.now()).map((w) => w.id));
      return {
        wishes: persona.self.allWishes().map((w) => ({
          id: w.id,
          wish: w.wish,
          status: w.status,
          raisable: raisable.has(w.id),
        })),
      };
    },
  });

// ── 口癖表态：她可以接受或拒绝学到的新口头禅 ──
  reg({
    name: 'qq_decide_voice',
    description:
      '系统从你被接住的话里提炼出一些说话习惯，你来表态接不接受。'
      + '喜欢的就接受（以后聊天会自然带上），不像你的就拒绝。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '口癖 id（从 qq_list_voice 查）' },
        accept: { type: 'boolean', description: 'true=接受，false=拒绝' },
      },
      required: ['id', 'accept'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, activeCount: { type: 'integer' } },
        required: ['ok', 'activeCount'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { ok: boolean; activeCount: number };
        return [{ type: 'text', text: r.ok ? `已记录，现有 ${r.activeCount} 条口癖` : '记录失败' }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as { id: string; accept: boolean };
      const ok = persona.voice.decideHabit(a.id, a.accept);
      return { ok, activeCount: persona.voice.activeHabits().length };
    },
  });

  // ── 查看口癖 ──
  reg({
    name: 'qq_list_voice',
    description: '查看你当前的说话习惯（候选/生效中）。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          habits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                situation: { type: 'string' },
                style: { type: 'string' },
                state: { type: 'string' },
                count: { type: 'integer' },
              },
              required: ['id', 'situation', 'style', 'state', 'count'],
              additionalProperties: false,
            },
          },
        },
        required: ['habits'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { habits: { situation: string; style: string; state: string; count: number }[] };
        if (r.habits.length === 0) return [{ type: 'text', text: '还没有形成说话习惯。' }];
        return [{ type: 'text', text: r.habits.map((h) => `· [${h.state}] 当"${h.situation}"时用"${h.style}"（${h.count}次）`).join('\n') }];
      },
    },
    async execute(): Promise<Record<string, unknown>> {
      return {
        habits: persona.voice.snapshot().habits.map((h) => ({
          id: h.id,
          situation: h.situation,
          style: h.style,
          state: h.state,
          count: h.count,
        })),
      };
    },
  });

// ── 自我叙述（L4 selfNote）：她写对自己的认识 ──
  reg({
    name: 'qq_write_self_note',
    description:
      '写一条"对自己的认识"——不是记别人，是记你自己是个什么样的人、最近变了什么。'
      + '只在真的想清楚时写，别凑数。有字数上限（约240字），旧的自然会归档。'
      + '和 qq_write_diary 的区别：日记记"我今天经历了什么"，这个记"我是谁"。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一条自我叙述（8~240 字，第一人称，具体不空泛）' },
        trigger: { type: 'string', description: '可选：什么触发了这条（自由时间/聊天/日记）' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer', description: '当前保留几条' },
          chars: { type: 'integer', description: '当前总字数' },
        },
        required: ['ok', 'count', 'chars'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { ok: boolean; count: number; chars: number };
        return [{ type: 'text', text: r.ok ? `已写下（现在 ${r.count} 条 / ${r.chars} 字）` : '没写成（太长或与已有的重复）' }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as { text: string; trigger?: string };
      const ok = persona.selfNote.write(a.text, a.trigger ?? 'chat');
      const st = persona.selfNote.stats();
      if (ok) logger.info('persona: 写了一条自我叙述');
      return { ok, count: st.count, chars: st.chars };
    },
  });

  // ── 读自我叙述 ──
  reg({
    name: 'qq_read_self_note',
    description: '看看你对自己现在的认识（有归档的旧版）。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          current: {
            type: 'array',
            items: {
              type: 'object',
              properties: { text: { type: 'string' }, at: { type: 'integer' } },
              required: ['text', 'at'],
              additionalProperties: false,
            },
          },
          archivedCount: { type: 'integer' },
        },
        required: ['current', 'archivedCount'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { current: { text: string }[]; archivedCount: number };
        if (r.current.length === 0) return [{ type: 'text', text: '还没写过对自己的认识。' }];
        return [{ type: 'text', text: r.current.map((n) => `· ${n.text}`).join('\n') + `\n（另有 ${r.archivedCount} 条旧版已归档）` }];
      },
    },
    async execute(): Promise<Record<string, unknown>> {
      const snap = persona.selfNote.snapshot();
      return {
        current: snap.current.map((n) => ({ text: n.text, at: n.at })),
        archivedCount: snap.archived.length,
      };
    },
  });

  /**
   * qq_browse —— 让她**真的**去网上看看。
   *
   * 为什么必须做成工具（真实事故 2026-11-01）：
   *   用户说「你可以开浏览器再去逛逛」，她答「让人去贴吧微博转了」，
   *   随后**编出了具体内容**（"散文吧有篇《修鞋摊子收起来了》…"）。
   *   根因：surf.ts 只在凌晨 3-7 点定时跑，**没有"我现在去看看"的工具**，
   *   于是她只能凭想象描述"网上有什么"。编造具体文章比不答更糟。
   */
  reg({
    name: 'qq_browse',
    description: '真的去网上看看（用 Bing 搜索 + 抓正文）。'
      + '想聊"最近网上在说什么""贴吧/微博有人讨论什么"时先用它，别凭印象编。'
      + '返回标题/链接/摘要；查不到就说查不到。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '想了解的话题或关键词' },
        deep: { type: 'boolean', description: '是否抓正文（更准但更慢，默认 false）' },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                summary: { type: 'string' },
              },
              required: ['title', 'url', 'summary'],
              additionalProperties: false,
            },
          },
          ok: { type: 'boolean' },
        },
        required: ['topic', 'findings', 'ok'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { topic: string; findings: { title: string; url: string; summary: string }[]; ok: boolean };
        if (!r.ok || r.findings.length === 0) {
          return [{ type: 'text', text: `「${r.topic}」没查到东西（网络或引擎问题）。` }];
        }
        const lines = r.findings.map((f, i) => `${i + 1}. ${f.title}\n   ${f.url}\n   ${f.summary}`);
        return [{ type: 'text', text: `「${r.topic}」查到 ${r.findings.length} 条：\n${lines.join('\n')}` }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { topic, deep } = args as { topic: string; deep?: boolean };
      try {
        const r = persona.surf?.(topic, { deep: deep === true });
        if (!r || r.findings.length === 0) return { topic, findings: [], ok: false };
        return {
          topic,
          ok: true,
          // 只回摘要，不把原始 HTML 塞进上下文
          findings: r.findings.slice(0, 5),
        };
      } catch (err) {
        logger.warn(`persona: qq_browse 失败 ${err instanceof Error ? err.message : String(err)}`);
        return { topic, findings: [], ok: false };
      }
    },
  });

  /**
   * qq_note_watched —— 记下"我看了什么、当时怎么想"(M37)。
   *
   * ## 为什么要单独一个工具，而不是让她调 MCP 记
   *
   * MCP 的 `watch_video` 只返回内容，不写她的记忆。
   * 而"我看过并觉得xxx"是**她自己的经历**，得落在 self.json 里，
   * 下次才能在提示里出现。
   *
   * ## 为什么一条只写一句 note
   *
   * 写得长就变成观后感作业。人回忆"那个视频怎么样"时是一句话，
   * 不是三段分析。所以 note 限 120 字，可以完全不填。
   */
  reg({
    name: 'qq_note_watched',
    description:
      '记下你刚看过的东西：标题 + 一句自己的话（讲了什么、什么感觉，都可以）。'
      + '不用写观后感，一句话就行；也可以只记标题不写感受。'
      + '下次你会记得自己看过它 —— 而不是每次被问到都现编。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '看的什么，如《华为配置专题03 DHCP VLAN配置》' },
        ref: { type: 'string', description: '可选：BV 号之类的标识，用来去重' },
        note: { type: 'string', description: '可选：一句你自己的话（≤120 字）' },
        done: { type: 'boolean', description: '可选：看完了吗（从中间跳进去的可以填 false）' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          total: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { ok: boolean; total?: number; error?: string };
        return [{
          type: 'text',
          text: r.ok ? `记下了（你最近看过 ${r.total ?? '?'} 个）` : `没记成（${r.error ?? '未知'}）`,
        }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as { title?: string; ref?: string; note?: string; done?: boolean };
      const title = String(a.title ?? '').trim();
      if (!title) return { ok: false, error: '标题不能空' };
      try {
        persona.self.addWatching({
          title,
          ...(a.ref ? { ref: String(a.ref) } : {}),
          ...(a.note ? { note: String(a.note) } : {}),
          ...(a.done === true ? { done: true } : {}),
        });
        return { ok: true, total: persona.self.recentWatching(99).length };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  /**
   * qq_note_activity —— 让她记下"这次自由时间做了什么"。
   *
   * 为什么需要（M24，开源调研结论）：
   *   没有"上一次"的记忆，每次自由时间都是从零决策 →
   *   结果每天的可能性完全相同，行为必然单一。
   *   这个工具只写一行（≤60 字），下次提示里会带上，让她能"接着上次"或"换个别的"。
   *
   * 刻意做得**很轻**：一句话就行，不是日志，不是汇报。
   */
  reg({
    name: 'qq_note_activity',
    description: '记一句"这次自由时间做了什么"（一句话，不超过 60 字）。'
      + '下次自由时间会把最近几条带给你，好让你接着上次、或者换个不一样的。'
      + '什么都不做也可以记"坐着没动"。别写汇报口吻。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一句话，如"翻了上个月的日记"、"去查了下那家咖啡店"' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { ok: boolean; text: string };
        return [{ type: 'text', text: r.ok ? `记下了：${r.text}` : '没记成（自由时间还没启动）' }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { text } = args as { text: string };
      const handle = persona.ownLife;
      if (!handle?.noteActivity) return { ok: false, text: '' };
      handle.noteActivity(text);
      return { ok: true, text: String(text ?? '').slice(0, 60) };
    },
  });

  /**
   * qq_check_mood —— 让她能感知自己现在的情绪（M31）。
   *
   * 为什么必须给她看：
   * 情绪已经在四个闸门上真的改变行为了（开口意愿 / 打字快慢 / 分几条 / 主动概率）。
   * 如果她自己不知道，那些行为变化在她那儿就是**无理由的**——
   * 心情差时她只是"莫名懒得说话"，而不是"我今天有点蔫"。
   * 有理由的行为才像人，没理由的行为像故障。
   *
   * 只读：情绪由事件驱动，不让她自己调（否则会变成"想开心就开心"的自欺）。
   */
  reg({
    name: 'qq_check_mood',
    description: '看看你现在的心情和精力怎么样。就是你此刻的状态，没有对错，不用分析原因。'
      + '心情会自然回落，睡一觉、过几个小时就淡了，不用刻意维持。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          valence: { type: 'number', description: '-1 到 1，正=心情好' },
          arousal: { type: 'number', description: '0 到 1，高=心里有起伏' },
          energy: { type: 'number', description: '0 到 1，高=有精神' },
          text: { type: 'string', description: '一句话概括' },
        },
        required: ['ok', 'valence', 'arousal', 'energy', 'text'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { text: string };
        return [{ type: 'text', text: r.text }];
      },
    },
    async execute(): Promise<Record<string, unknown>> {
      const st = persona.emotion.current();
      return {
        ok: true,
        valence: Number(st.valence.toFixed(2)),
        arousal: Number(st.arousal.toFixed(2)),
        energy: Number(st.energy.toFixed(2)),
        text: describeEmotion(st),
      };
    },
  });

  /**
   * qq_bili_check —— 让她真的能查 B 站视频。
   *
   * 背景（2026-11-02 实测事故）：
   *   用户说「我给你装了插件，你可以去 b 站逛逛了」、
   *   「qq_bili_check 我给了你这个工具」——**但那时工具根本不存在**，
   *   她翻遍工具清单没找到，只好如实报告"我这儿没有"，然后开始汇报
   *   "python 部分留在 ~/.dsh/bili-duty…node 那个包没进 node_modules…"
   *   一大串内部排查过程泄露给用户。
   *
   * 现在真的给它接上：复用本机已装好的 `bili` CLI（bili-agent 1.2.1，已登录）。
   * 只暴露**只读**能力（info / summary / subtitle / search），不做写操作。
   */
  reg({
    name: 'qq_bili_check',
    description:
      '查一个 B 站视频：标题、AI 总结、分章提纲、字幕（带时间轴）、弹幕、画面帧。'
      + '想聊某个视频的内容时用它，别凭印象编。没给 BV 号也可以按关键词搜。'
      + '**如果是长视频或合集，先看返回的 pages（分 P 目录），再指定 page 看具体某一集。**',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号，如 BV1ednc6jE3j' },
        query: { type: 'string', description: '想搜的关键词（没有 BV 号时用）' },
        page: { type: 'number', description: '合集看到第几 P（默认 1）' },
        want: {
          type: 'string',
          enum: ['summary', 'subtitle', 'danmaku', 'frames', 'all', 'inbox', 'trending', 'recommend', 'comments'],
          description: '要什么：summary=AI总结+分章提纲（默认）、subtitle=字幕（按分钟压缩、带时间戳）、'
            + 'danmaku=观众弹幕、frames=抽画面帧、all=全都拿；'
            + 'inbox=我的消息中心、trending=B站热门、recommend=首页推荐（这三个不用 bvid）、'
            + 'comments=某视频的评论（要 bvid）',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          // 具体失败原因（没字幕 / 没登录 / bili 没装）——
          // 比笼统的"视频信息拿不到"有用得多，模型不会当成"视频不存在"
          biliError: { type: 'string' },
          comments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                user: { type: 'string' },
                text: { type: 'string' },
                likes: { type: 'number' },
              },
              required: ['user', 'text', 'likes'],
              additionalProperties: false,
            },
          },
          title: { type: 'string' },
          page: { type: 'number' },
          // 合集目录：四十集看不过来时的第一层答案
          pages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                page: { type: 'number' },
                title: { type: 'string' },
                length: { type: 'string' },
              },
              required: ['page', 'title', 'length'],
              additionalProperties: false,
            },
          },
          summary: { type: 'string' },
          outline: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                start: { type: 'string' },
                points: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { t: { type: 'string' }, text: { type: 'string' } },
                    required: ['t', 'text'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['title', 'start', 'points'],
              additionalProperties: false,
            },
          },
          subtitleOutline: {
            type: 'array',
            items: {
              type: 'object',
              properties: { t: { type: 'string' }, text: { type: 'string' } },
              required: ['t', 'text'],
              additionalProperties: false,
            },
          },
          danmakuPeaks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                t: { type: 'string' },
                count: { type: 'number' },
                top: { type: 'array', items: { type: 'string' } },
              },
              required: ['t', 'count', 'top'],
              additionalProperties: false,
            },
          },
          danmaku: {
            type: 'array',
            items: {
              type: 'object',
              properties: { t: { type: 'string' }, text: { type: 'string' } },
              required: ['t', 'text'],
              additionalProperties: false,
            },
          },
          frames: {
            type: 'array',
            items: {
              type: 'object',
              properties: { t: { type: 'string' }, path: { type: 'string' } },
              required: ['t', 'path'],
              additionalProperties: false,
            },
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { bvid: { type: 'string' }, title: { type: 'string' } },
              required: ['bvid', 'title'],
              additionalProperties: false,
            },
          },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (a: unknown, v: unknown): ContentBlock[] => {
        const inp = (a ?? {}) as { want?: string };
        const r = v as {
          ok: boolean; title?: string; page?: number;
          pages?: Array<{ page: number; title: string; length: string }>;
          summary?: string;
          outline?: Array<{ title: string; start: string; points: Array<{ t: string; text: string }> }>;
          subtitleOutline?: Array<{ t: string; text: string }>;
          danmakuPeaks?: Array<{ t: string; count: number; top: string[] }>;
          danmaku?: Array<{ t: string; text: string }>;
          frames?: Array<{ t: string; path: string }>;
          comments?: Array<{ user: string; text: string; likes: number }>;
          items?: { bvid: string; title: string }[];
          biliError?: string;
          error?: string;
        };
        if (!r.ok) {
          // biliError 比 error 具体（"没字幕" vs "拿不到"），优先显示
          return [{ type: 'text', text: `没查到（${r.biliError ?? r.error ?? '未知原因'}）` }];
        }
        const parts: string[] = [];
        if (r.title) parts.push(`《${r.title}》${r.page && r.page > 1 ? ` 第 ${r.page} P` : ''}`);
        // 合集先给目录 —— 用户要挑着看，先得知道有哪些集
        if (r.pages?.length) {
          // 目录同样要"先筛再说"。
          // 16 行全念一遍等于让他读目录，而他要的是"哪几集值得看"。
          parts.push(`这是个合集（共 ${r.pages.length} P）：\n`
            + r.pages.map((p) => `  P${p.page}（${p.length}）${p.title}`).join('\n')
            + '\n\n↑ 别把 16 行全念给他。按他问的东西**挑相关的 2–3 集**说，'
            + '或者问他想要哪个方向。\n'
            + '（要看某一 P 的具体内容，带 page 参数再查一次）');
        }
        if (r.summary) parts.push(`AI 总结：${r.summary}`);
        if (r.outline?.length) {
          parts.push('分段提纲（可直接按时间跳）：\n' + r.outline.map((sec) =>
            `  [${sec.start}] ${sec.title}\n`
            + sec.points.map((pt) => `      ${pt.t} ${pt.text}`).join('\n')).join('\n'));
        }
        if (r.subtitleOutline?.length) {
          // 这不是"给你看的资料"，是"给你挑的原料"。
          //
          // 原来的措辞是「字幕·按分钟（这一分钟主要在讲）」——
          // 那是在暗示"这就是结论"，她很可能直接整段转给用户。
          // 结果就是从"四十集看不过来"变成"32 分钟看不完"，问题只是换了个尺度。
          //
          // 用户要的是**你先筛过**。所以这里明确要求她挑，并给出挑的标准。
          parts.push(
            '字幕·按分钟（**这是原料，不是结论**）：\n'
            + r.subtitleOutline.map((x) => `  [${x.t}] ${x.text}`).join('\n')
            + '\n\n↑ 别整段转给他。你要做的是**从中挑出真正讲到东西的 3–5 段**，'
            + '每段用一句话说清"这讲了什么"，带上时间点。\n'
            + '挑的标准：有具体命令/参数/结论/易错点的才算"讲到东西"；'
            + '铺垫、寒暄、"我们后面再讲"这类跳过。'
          );
        }
        if (r.danmakuPeaks?.length) {
          parts.push('观众反应最强的时刻：\n'
            + r.danmakuPeaks.map((x) => `  ${x.t}（${x.count} 条）${x.top.join(' / ')}`).join('\n'));
        }
        if (r.danmaku?.length) {
          parts.push('弹幕：\n' + r.danmaku.slice(0, 15).map((x) => `  ${x.t} ${x.text}`).join('\n'));
        }
        if (r.frames?.length) {
          parts.push('画面帧（图片路径）：\n' + r.frames.map((x) => `  ${x.t} ${x.path}`).join('\n'));
        }
        if (r.comments?.length) {
          parts.push('评论（按热度）：\n' + r.comments.slice(0, 12).map((c, i) =>
            `  ${i + 1}. ${c.likes > 0 ? `[${c.likes}赞] ` : ''}${c.user}：${c.text}`).join('\n')
            + '\n\n↑ 挑有信息量的说，别整段复述。');
        }
        if (r.items?.length) {
          // 措辞跟着 want 走：对着消息中心说"搜到这些"很怪
          const label = inp.want === 'inbox' ? '消息中心：'
            : inp.want === 'trending' ? '现在 B 站热门：'
              : inp.want === 'recommend' ? '首页推荐：'
                : '搜到这些：';
          parts.push(label + '\n' + r.items.map((x, i) => `${i + 1}. ${x.title}${x.bvid ? `（${x.bvid}）` : ''}`).join('\n'));
        }
        // 成功但有一部分没拿到（比如没字幕）：说清楚，别让她以为全拿到了
        if (r.biliError) parts.push(`注意：${r.biliError}`);
        return [{ type: 'text', text: parts.join('\n\n') || '（空）' }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as { bvid?: string; query?: string; page?: number; want?: string };
      const run = (argv: string[]): BiliResult => runBili(argv);
      const want = String(a.want ?? 'summary');

      // ── 浏览类：不需要 BV 号 ──
      // 这三条走 bili 自己的 feed / hot 命令。返回结构随 bili 版本变化，
      // 所以解析做得宽容，解析不出来就如实说，不要假装"没有内容"。
      const browse = want === 'inbox' ? ['feed', 'inbox']
        : want === 'trending' ? ['hot', 'popular']
          : want === 'recommend' ? ['feed', 'recommend']
            : null;
      if (browse !== null) {
        const r = run(browse);
        if (r.ok === false) return { ok: false, error: biliFailure(r, '看 B 站首页') };
        const d = (r.data ?? {}) as Record<string, unknown>;
        const candidate = d.items ?? d.list ?? d.videos ?? d.data ?? d.feed;
        const arr = Array.isArray(candidate) ? (candidate as Array<Record<string, unknown>>) : [];
        const items = arr.slice(0, 10).map((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          return {
            bvid: String(o.bvid ?? o.bv ?? ''),
            title: String(o.title ?? o.name ?? ''),
          };
        }).filter((x) => x.title !== '');
        if (!items.length) {
          return { ok: false, error: '拿到数据了但解析不出标题（bili 版本可能变了，用搜索代替）' };
        }
        return { ok: true, items };
      }

      // ── 评论：要 BV 号 ──
      if (want === 'comments') {
        const bv = String(a.bvid ?? '').trim();
        if (!bv) return { ok: false, error: '看评论需要 bvid' };
        const r = run(['comment', 'list', bv]);
        if (r.ok === false) return { ok: false, error: biliFailure(r, '拉评论') };
        const d = (r.data ?? {}) as Record<string, unknown>;
        const src = d.items ?? d.comments ?? d.list ?? d.data;
        const arr = Array.isArray(src) ? (src as Array<Record<string, unknown>>) : [];
        const comments = arr.slice(0, 20).map((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          // 实测 bili 1.2.1 的字段是 user:{name}，不是 uname
          const u = o.user as { name?: string } | undefined;
          const author = o.author as { name?: string } | undefined;
          return {
            user: String(u?.name ?? author?.name ?? o.uname ?? ''),
            text: String(o.content ?? o.message ?? o.text ?? ''),
            likes: Number(o.like ?? o.likes ?? 0) || 0,
          };
        }).filter((x) => x.text !== '');
        if (!comments.length) return { ok: false, error: '没拿到评论（可能没有评论，或者没登录 B 站）' };
        return { ok: true, comments };
      }

      // 没给 BV → 搜索
      if (!a.bvid) {
        const q = String(a.query ?? '').trim();
        if (!q) return { ok: false, error: '需要 bvid 或 query' };
        const r = run(['search', 'video', q]);
        // 关键：工具坏了和搜不到是两回事。
        // 原来一律返回 undefined → "没查到" → 模型自己编内容。
        if (r.ok === false) return { ok: false, error: biliFailure(r, '搜索') };
        const d = (r.data ?? {}) as { items?: Array<{ bvid?: string; title?: string }> };
        const items = (d.items ?? []).slice(0, 5)
          .filter((x) => x.bvid && x.title)
          .map((x) => ({ bvid: x.bvid as string, title: x.title as string }));
        if (!items.length) return { ok: false, error: '没搜到相关内容（换个关键词试试，别硬编）' };
        return { ok: true, items };
      }

      const bvid = String(a.bvid).trim();
      const page = Math.max(1, Number(a.page) || 1);
      const mode = (['subtitle', 'danmaku', 'frames', 'all'].includes(String(a.want))
        ? String(a.want) : 'summary') as 'subtitle' | 'danmaku' | 'frames' | 'all' | 'summary';

      const info = run(['video', 'info', bvid]);
      // info 是最基础的一步，它失败说明视频不存在 / 需要登录 / bili 没装 ——
      // 继续查字幕弹幕都是白费，而且最后只会得到"视频信息拿不到"这种含糊答案。
      if (info.ok === false) {
        return { ok: false, error: biliFailure(info, '查视频') };
      }
      const idata = (info?.data ?? {}) as {
        title?: string;
        duration?: number;
        pages?: Array<{ page?: number; title?: string; duration?: number }>;
      };
      const title = idata.title ?? '';
      const pages = (idata.pages ?? [])
        .filter((p) => (p.page ?? 0) > 0)
        .map((p) => ({
          page: Number(p.page) || 0,
          title: String(p.title ?? '').trim() || `P${p.page}`,
          length: mmss(Number(p.duration) || 0),
        }));
      const isCollection = pages.length > 1;

      const out: Record<string, unknown> = { ok: true };
      if (title) out.title = title;
      if (isCollection) { out.pages = pages; out.page = page; }

      // AI 总结 + 分段提纲
      let summary = '';
      let outline: Array<{ title: string; start: string; points: Array<{ t: string; text: string }> }> = [];
      if (mode === 'summary' || mode === 'all') {
        const r = run(['video', 'summary', bvid, '--page', String(page)]);
        const data = (r?.data ?? {}) as {
          summary?: string;
          outline?: Array<{ title?: string; start?: number; points?: Array<{ time?: number; content?: string }> }>;
        };
        summary = data.summary ?? '';
        outline = (data.outline ?? [])
          .filter((sec) => (sec.points?.length ?? 0) > 0)
          .map((sec) => ({
            title: String(sec.title ?? ''),
            start: mmss(Number(sec.start) || 0),
            points: (sec.points ?? []).map((pt) => ({
              t: mmss(Number(pt.time) || 0),
              text: String(pt.content ?? ''),
            })),
          }));
        if (summary) out.summary = summary;
        if (outline.length) out.outline = outline;
      }

      // 字幕：**必须用 subtitle 而不是 watch**
      // watch 的 transcript 是 {source, text} —— 时间轴被压平了，
      // 正是用户抱怨的"整段倒出来"。带时间轴的只有 subtitle（不带 --text）。
      if (mode === 'subtitle' || mode === 'all') {
        const r = run(['video', 'subtitle', bvid, '-p', String(page)]);
        const items = ((r.data ?? {}) as { items?: Array<{ from?: number; to?: number; content?: string }> }).items ?? [];
        const packed = condenseSubtitlesByMinute(items);
        if (packed.length) out.subtitleOutline = packed;
        else if (r.ok === false) {
          // 分清楚三种情况 —— 一刀切"拿不到"会让模型以为要换关键词重搜，
          // 实际可能是"这视频本来就没字幕"或"没登录"。
          const code = String(r.error?.code ?? '');
          const msg = String(r.error?.message ?? '');
          if (/^no[_.-]?sub(title)?$|没有字幕|无字幕|字幕不存在/i.test(code) || /没有字幕|无字幕/i.test(msg)) {
            out.biliError = '这个视频没有字幕（不是查询失败，换个信息源或直接看简介）';
          } else if (/auth|login|credential|未登录|登录/i.test(code + msg)) {
            out.biliError = '没登录 B 站，字幕拿不到（其他信息还能用）';
          } else {
            out.biliError = `字幕拿不到：${code || '未知'}${msg ? ` - ${msg}` : ''}`;
          }
        }
      }

      if (mode === 'danmaku' || mode === 'all') {
        try {
          const pk = run(['video', 'danmaku', bvid, '--peaks', '5', '-p', String(page)]);
          const pdata = (pk?.data ?? {}) as { peaks?: Array<{ time?: number; count?: number; top?: string[] }> };
          const peaks = (pdata.peaks ?? [])
            .filter((x) => (x.count ?? 0) > 0)
            .slice(0, 5)
            .map((x) => ({
              t: mmss(Number(x.time) || 0),
              count: Number(x.count) || 0,
              top: (x.top ?? []).slice(0, 3).map(String),
            }));
          if (peaks.length) out.danmakuPeaks = peaks;
        } catch { /* peaks 拿不到不影响主流程 */ }
        const r = run(['video', 'danmaku', bvid, '-p', String(page)]);
        const items = ((r?.data ?? {}) as { items?: Array<{ time?: number; text?: string }> }).items ?? [];
        const dm = items.filter((x) => x.text).slice(0, 30)
          .map((x) => ({ t: mmss(Number(x.time) || 0), text: String(x.text) }));
        if (dm.length) out.danmaku = dm;
      }

      if (mode === 'frames' || mode === 'all') {
        const r = run(['video', 'frames', bvid, '-n', '6', '-p', String(page)]);
        const items = ((r?.data ?? {}) as { frames?: Array<{ time?: number; path?: string }> }).frames ?? [];
        const fr = items.filter((x) => x.path)
          .map((x) => ({ t: mmss(Number(x.time) || 0), path: String(x.path) }));
        if (fr.length) out.frames = fr;
      }

      const hasContent = out.summary || out.subtitleOutline || out.danmaku || out.danmakuPeaks || out.frames
        || out.comments || out.items;
      if (!hasContent) {
        // 合集只给目录也算成功（用户接下来要挑 P）
        if (isCollection) return out;
        // 有具体原因就带上（没字幕 / 没登录），别让模型自己猜
        if (out.biliError) return { ...out, ok: false };
        return { ok: false, error: '视频信息拿不到' };
      }
      return out;
    },
  });

  // 数量写死过一次 15，后来加到 17 也忘了改 —— 改成动态。（这种"文档和代码脱节"
  // 是本仓库反复踩的坑：写死在注释里的数字总会过期。）
  logger.info(`im-qqbot: persona 工具已注册（日记/记忆/称呼/兴趣/需求/口癖/自我/浏览/活动/B站/心情，共 ${registered.size} 个）`);
}
