/**
 * 唤醒判定 · 什么时候该说话，什么时候该安静
 * ─────────────────────────────────────────────────────────────
 * 移植自 ai-companion-kit（MIT）packages/companion/src/wake.js。
 *
 * 把"要不要醒"拆成独立条件，任一命中才醒：
 *   atMention / nameMention / keywords / question / speakerIds /
 *   probability / anyMessage
 * 注：原版的 poke（拍一拍）在 QQ 官方 Bot API 无对应事件，未移植。
 * 另含「无限期潜水」概念：醒过一次后，一段时间内除非再次命中否则装没看见。
 */

/** 中文里"在问问题"的粗略特征 */
const QUESTION_HINTS = /[?？]|怎么|为什么|为啥|如何|是不是|能不能|可不可以|有没有|谁|哪儿|哪里|何时|多少/;

/**
 * 判断一句话是否"像在问某人 / 指向某人"（中文口语大量省略主语和问号）。
 *
 * 实测基线：只用 `?？|怎么|是不是` 这类正则，以下全部漏判：
 *   吃了吗 / 吃饭没 / 在干嘛 / 睡了吗 / 今天忙不忙 / 明天来不来 / 有空吗
 * 根因：中文口语省略主语和问号。这里用中文特有的句式特征补齐：
 *   ① 句尾语气词（吗/呢/么/没）
 *   ② 正反问（A不A：忙不忙、来不来、好不好）
 *   ③ 省略主语的常见问句（干嘛/在吗/咋样）
 *   ④ 明确的第二人称（你…）
 *   ⑤ 邀请/提议类
 */
function looksAddressedToMe(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  // ④ 明确第二人称：最可靠
  if (/你|您/.test(t)) return true;

  // ② 正反问 A不A（中文特有）：忙不忙、来不来、好不好、行不行
  if (/[\u4e00-\u9fa5]{1,3}不[\u4e00-\u9fa5]{1,3}/.test(t) && t.length <= 14) return true;

  // ① 句尾疑问语气词
  if (/(吗|么|呢)\s*[？?！!。.]?$/.test(t)) return true;

  // ③ 省略主语的常见问句（高频口语）
  if (/^(在吗|在么|在不在|在干嘛|在干啥|干嘛呢|干啥呢|咋样|怎么样|如何|有事吗|吃了吗|吃了没|吃饭没|睡了吗|睡了没|忙吗|忙不忙)$/.test(t)) return true;

  // ⑤ 邀请/提议
  if (/^(要不要|能不能|可不可以|一起|来不来|去不去|行不行|好不好|有空)/.test(t)) return true;

  // ⑥ 极短句 + 句尾"了吗/了没"组合
  if (t.length <= 8 && /(了吗|了没|了么|过没|过吗)$/.test(t)) return true;

  return false;
}

export interface WakeConfig {
  mode: 'diving' | 'active';
  /** 活跃期内连续"与她无关"的消息计数；达到阈值就提前回潜水 */
  idleStreak?: number;
  infinite: boolean;
  until: number;
  atMention: boolean;
  nameMention: boolean;
  keywords: string[];
  question: boolean;
  speakerIds: string[];
  probability: number;
  anyMessage: boolean;
  lastWakeAt?: number;
  wakeCount?: number;
}

export interface WakeMessage {
  /** 会话标识，如 'group:xxx' / 'c2c:xxx' */
  key: string;
  userId: string;
  name?: string;
  text: string;
  isAtMe?: boolean;
  isQuoteMe?: boolean;
  /**
   * 是否处于"刚被叫醒"的活跃对话期（由 gate 传入）。
   * 活跃期内不是每条都要接——否则会变成应答器（"去吧""走吧"刷屏）。
   */
  inActiveWindow?: boolean;
}

/** 外部注入的「她的兴趣与话痨度」，用于兴趣驱动唤醒（由 SelfProfileService 提供） */
export interface InterestContext {
  /** 兴趣词 -> 权重(0~1) */
  interests: Array<{ topic: string; weight: number }>;
  /** 话痨度 0~1，被嫌吵会降低 */
  chattiness: number;
  /** 兴趣命中时的基础唤醒概率（默认 0.5） */
  baseProbability?: number;
}

export interface WakeDecision {
  wake: boolean;
  reason: string;
}

export class Waker {
  private readonly names: string[];
  private readonly keywords: string[];
  private readonly defaultProbability: number;
  private readonly configs = new Map<string, WakeConfig>();
  /** 唤醒后保持"活跃"的时长（毫秒）。活跃期内即使没被 @ 也照常对话。 */
  private readonly activeWindowMs: number;
  /** 活跃期内连续多少条无关消息后提前回潜水（默认 3 条） */
  private readonly idleDiveThreshold: number;

  constructor(opts: {
    names?: string[];
    keywords?: string[];
    ownerIds?: string[];
    probability?: number;
    activeWindowMs?: number;
    /** 活跃期内连续多少条无关消息后回潜水（默认 3） */
    idleDiveThreshold?: number;
  } = {}) {
    this.names = (opts.names ?? []).filter(Boolean);
    this.keywords = (opts.keywords ?? []).filter(Boolean);
    this.defaultProbability = opts.probability ?? 0.05;
    this.activeWindowMs = opts.activeWindowMs ?? 10 * 60 * 1000;
    this.idleDiveThreshold = opts.idleDiveThreshold ?? 3;
  }

  /** 给某个会话设置唤醒配置 */
  setConfig(key: string, cfg: Partial<WakeConfig> = {}): void {
    this.configs.set(key, {
      mode: 'diving',          // 'diving' 潜水 | 'active' 活跃
      infinite: true,          // 无限期，直到再次命中条件
      until: 0,
      atMention: true,
      nameMention: true,
      keywords: [],
      question: true,
      speakerIds: [],
      probability: this.defaultProbability,
      anyMessage: false,
      ...cfg,
    });
  }

  getConfig(key: string): WakeConfig {
    if (!this.configs.has(key)) this.setConfig(key, {});
    return this.configs.get(key) as WakeConfig;
  }

  /** 现在是不是在潜水（潜水中 = 不该主动说话） */
  isDiving(key: string): boolean {
    const c = this.getConfig(key);
    if (c.mode === 'active') return false;
    if (c.infinite) return true;
    return Date.now() < c.until;
  }

  /**
   * 把它从潜水里叫起来，并进入「活跃」状态一段时间。
   * 活跃期内（activeWindowMs）即使没被 @ 也照常对话，超时自动回潜水。
   * （修复：原实现只写 lastWakeAt 不改 mode，导致状态机形同虚设）
   */
  wake(key: string): void {
    const c = this.getConfig(key);
    const now = Date.now();
    c.mode = 'active';
    c.infinite = false;
    c.until = now + this.activeWindowMs;
    c.lastWakeAt = now;
    c.wakeCount = (c.wakeCount ?? 0) + 1;
    c.idleStreak = 0;   // 新一次唤醒，无关计数归零
  }

  /** 现在是否处于活跃对话期（被 @ 过且在窗口内） */
  isActive(key: string): boolean {
    const c = this.getConfig(key);
    if (c.mode !== 'active') return false;
    if (c.infinite) return true;
    return Date.now() < c.until;
  }

  /**
   * 定期清理长期无活跃的会话配置（审查 m9）。
   * staleMs 太长会把活跃潜水误判为过期，太短又删得太勤 → 保守用 30 天。
   * 半衰指标：最后一次唤醒距今。返回清理数。
   */
  prune(staleMs = 30 * 24 * 3600_000): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, c] of this.configs) {
      // 只清"唤醒过一次且很久没再醒"的会话；从未醒过的潜水配置保守保留
      // 否则 getConfig 惰性创建的 key 会在第二次 prune 被误删、丢掉潜水语义
      if (c.lastWakeAt !== undefined && c.lastWakeAt < now - staleMs) {
        this.configs.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** 让它继续潜水（可以指定潜多久）。立即退出活跃态。 */
  dive(key: string, ms = 0): void {
    const c = this.getConfig(key);
    c.mode = 'diving';
    c.infinite = !ms;
    c.until = ms ? Date.now() + ms : 0;
  }

  /** 兴趣上下文提供者（由外部注入，未注入则不做兴趣唤醒） */
  private interestProvider?: () => InterestContext | undefined;
  /** 名字提供者（动态名字：配置名 + 她接受的称呼） */
  private nameProvider?: () => string[];

  /** 注入动态名字来源（SelfProfileService.acceptName 后自动生效） */
  setNameProvider(fn: () => string[]): void {
    this.nameProvider = fn;
  }

  /** 当前生效的称呼列表（配置名 ∪ 动态名） */
  private currentNames(): string[] {
    const dyn = this.nameProvider?.();
    return dyn && dyn.length > 0 ? [...new Set([...this.names, ...dyn])] : this.names;
  }

  /** 注入兴趣上下文来源（SelfProfileService 接入用） */
  setInterestProvider(fn: () => InterestContext | undefined): void {
    this.interestProvider = fn;
  }

  /**
   * 兴趣匹配：返回命中的兴趣及综合权重。
   * 权重 = Σ(命中兴趣的 weight)，再按话痨度折算。
   */
  matchInterest(text: string): { hit: boolean; topics: string[]; probability: number } {
    const ctx = this.interestProvider?.();
    if (!ctx || ctx.interests.length === 0) return { hit: false, topics: [], probability: 0 };
    const hits = ctx.interests.filter((i) => i.weight > 0 && text.includes(i.topic));
    if (hits.length === 0) return { hit: false, topics: [], probability: 0 };
    const sumWeight = Math.min(1, hits.reduce((a, b) => a + b.weight, 0));
    const base = ctx.baseProbability ?? 0.5;
    // 被嫌吵后 chattiness 降低，接话概率同步下降
    const probability = Math.max(0, Math.min(1, ctx.chattiness * sumWeight * base));
    return { hit: true, topics: hits.map((h) => h.topic), probability };
  }

  /** 判定一条消息要不要唤醒 */
  shouldWake(msg: WakeMessage): WakeDecision {
    const c = this.getConfig(msg.key);
    const text = String(msg.text ?? '');
    const uid = String(msg.userId ?? '');

    // 潜水优先：owner 说话同样遵循潜水规则（方案A，不 @ 不醒）。
    // owner 身份不再强制叫醒——否则 owner 在群里发任何消息都会打断潜水，
    // 无法验证"不@→潜水→@→唤醒"的完整链路。
    if (Array.isArray(c.speakerIds) && c.speakerIds.map(String).includes(uid)) {
      return { wake: true, reason: 'speaker' };
    }

    if (c.anyMessage) return { wake: true, reason: 'anyMessage' };
    // 注意：删掉了原来的 `if (c.mode === 'active') return wake:true`。
    // 那条会让活跃期内每条消息都必醒 → 变成应答器（"去吧""走吧"刷屏）。
    // 现在活跃期的接话交给下面的概率判定。

    // @ / 引用：永远必醒（这是在明确叫它）
    if (c.atMention && (msg.isAtMe || msg.isQuoteMe)) return { wake: true, reason: 'atMention' };

    // 活跃对话期内：**只对"值得接的话"放行**，无关闲聊一律潜水。
    //
    // 之前这里写成"纯概率 45%"，导致不分话题内容——有人在群里提了她一句，
    // 之后别人聊"今天好热""你吃了吗"，她照样按 45% 插话，很吵。
    // 正确做法：先判"这条话跟她有关吗"，再决定概率。
    if (msg.inActiveWindow) {
      const ctx = this.interestProvider?.();
      const chat = ctx?.chattiness ?? 1;
      // 命中任何"跟她有关"的信号 → 清零无关计数（对话还在继续）

      // ① 命中她的兴趣 → 有话说，按概率接（概率更高）
      const it = this.matchInterest(text);
      if (it.hit && it.probability > 0 && Math.random() < it.probability) {
        c.idleStreak = 0;
        return { wake: true, reason: 'active-window:interest' };
      }

      // ② 提问（带问号/疑问词）→ 有可能是问她，按较高概率接
      if (QUESTION_HINTS.test(text) && [...text].length >= 4 && Math.random() < chat * 0.5) {
        c.idleStreak = 0;
        return { wake: true, reason: 'active-window:question' };
      }

      // ③ 第二人称指向她（"你吃了吗""你困不困"）→ 很可能是在问她，
      //    尤其是刚被叫到名字之后。这类要接，否则会出现"问了却不回答"。
      //    （用户实测提的场景：群聊里有人提了小羽，紧接着问"你吃了吗"）
      if (looksAddressedToMe(text) && Math.random() < chat * 0.65) {
        c.idleStreak = 0;
        return { wake: true, reason: 'active-window:to-me' };
      }

      // ④ 其余闲聊 → 潜水，并累计"连续无关"计数
      c.idleStreak = (c.idleStreak ?? 0) + 1;
      if (c.idleStreak >= this.idleDiveThreshold) {
        // 连续多条跟她无关 → 说明这轮对话已经飘走了，提前回潜水
        this.dive(msg.key);
        return { wake: false, reason: 'active-window:auto-dive' };
      }
      return { wake: false, reason: 'active-window:irrelevant' };
    }

    if (c.nameMention) {
      const hit = this.currentNames().find((n) => n && text.includes(n));
      if (hit) return { wake: true, reason: 'name:' + hit };
    }

    const kw = [...(c.keywords ?? []), ...this.keywords];
    if (kw.length) {
      const hit = kw.find((k) => k && text.includes(k));
      if (hit) return { wake: true, reason: 'keyword:' + hit };
    }

    // 兴趣驱动唤醒：命中她自己的兴趣 → 按 chattiness × 权重 × 基础概率 决定是否接话
    const it = this.matchInterest(text);
    if (it.hit && it.probability > 0 && Math.random() < it.probability) {
      return { wake: true, reason: 'interest:' + it.topics.join(',') };
    }

    if (c.question && QUESTION_HINTS.test(text) && [...text].length >= 4) {
      return { wake: true, reason: 'question' };
    }

    if (Number(c.probability) > 0 && Math.random() < Number(c.probability)) {
      return { wake: true, reason: 'probability' };
    }

    return { wake: false, reason: '' };
  }
}
