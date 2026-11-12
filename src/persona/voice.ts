/**
 * 口癖系统（M11）— 从「她自己被接住的那句话」里长出说话习惯
 * ─────────────────────────────────────────────────────────────
 * 为什么自研（research-digest.md §一1）：
 *   - MaiBot 的过滤第一刀是 `is_bot_self()` —— **明确不学自己说的话**
 *   - Mirrai 的口头禅是从用户上传的记录蒸馏，不是从分身自身生成
 *   - elizaOS / AstrBot / SillyTavern 全是静态角色卡字段
 *   → 全行业没有现成实现。但零件可借：
 *     · MaiBot 的「当 A 时可以用 B」表示法 + 四关护栏
 *     · Mirrai 的 micro-rule 形状（证据 + verified）+ 未确认不注入
 *
 * 核心创新（本模块自己的设计）：
 *   用「她的话被接住」作为正样本奖励信号 —— 等价 D-MEM 的奖励预测门控。
 *   冷场不算负样本（可能是别人没看到）；只有被明确嫌才算负样本。
 *   这天然解决 MaiBot 不敢学自己的顾虑（它怕学到幻觉和客户腔）。
 *
 * 流程：
 *   outbound：记下她说过的短句（带 turnId）
 *   inbound：5 分钟内同一会话的下一条人类消息 = 「接住」（引用/复读/哈哈/确实/问号）
 *   攒够样本 → 抽取候选句式 → 护栏 → state='candidate'
 *   满足确认门槛（count>=2 且至少2条不同证据）→ state='active' → 才注入 prompt
 */
import fs from 'node:fs';
import path from 'node:path';

/** 一条口癖 */
export interface VoiceHabit {
  id: string;
  /** 当"…"时（≤20字，MaiBot 规范） */
  situation: string;
  /** 可以说"…"（≤20字，保留原作句式，不做抽象） */
  style: string;
  /** 被使用次数 */
  count: number;
  /** 开始采用的时间 */
  adoptedAt: number;
  /** 最后说的时问 */
  lastSaidAt?: number;
  /** 状态：候选 / 生效 / 退役 */
  state: 'candidate' | 'active' | 'retired';
  /** 证据（她被接住的具体案例） */
  evidence: Array<{ turnId: string; herLine: string; theirReply: string; at: number }>;
  /** 语气分类 */
  tone?: 'warm' | 'dry' | 'teasing' | 'tired';
  /** 与角色卡硬约束冲突的项 */
  conflictWith?: string[];
}

/** 她说的一句话 */
export interface Utterance {
  turnId: string;
  /** 会话键（scope:peerId） */
  key: string;
  /** 原话 */
  text: string;
  /** 发送时间 */
  at: number;
  /** 是否被接住（后续判定） */
  caught?: boolean;
  /** 接住她的人说了什么 */
  reply?: string;
}

/** 文件结构 */
interface VoiceFile {
  version: number;
  /** 待判定的发言（最近 N 条） */
  pending: Utterance[];
  /** 已确认被接住的正样本 */
  caughtSamples: Array<{ turnId: string; herLine: string; theirReply: string; at: number; key: string }>;
  /** 口癖库 */
  habits: VoiceHabit[];
  updatedAt?: string;
}

/** 「接住」判据：用户回应里出现这些就说明她的话被接住了 */
const CAUGHT_PATTERNS = [
  /哈+|笑死|笑|233/i,
  /确实|是这样|对|真的|可不是/i,
  /照做|学你|复读/i,
  /？/,
  /好家伙|绝了|妙|太对/i,
];

/** 「被嫌」判据（负样本，复用 M5） */
const COMPLAINT_RE = /太吵|别刷屏|刷屏了|安静点|安静些|闭嘴|别发了|少说点|烦死了|别吵|能不能别发|话太多|别这样/i;

/** 太短或太长的话不算口癖素材 */
const MIN_LINE = 4;
const MAX_LINE = 60;

/** 待判定队列上限 */
const MAX_PENDING = 40;
/** 正样本上限 */
const MAX_SAMPLES = 60;
/** 无人回应多久后丢弃待判定项（毫秒） */
/**
 * 待判定说话的有效期。
 *
 * M36 修的 bug：原来只有 5 分钟，实测线上「48 条样本、最新一条停在 11-02 12:07」——
 * 40 小时没有新样本，但**期间有 10 轮对话**。
 * 根因：她说的话写进 pending 后，要等对方**下一条消息**来判定；
 * 而真实对话间隔中位数 1.4 分钟、平均 12.1 分钟，**只有 69% 落在 5 分钟内**。
 * 剩下的全被 TTL 静默丢弃，样本永远攒不够 → 口癖管线等于停摆。
 *
 * 改成 60 分钟：覆盖普通对话轮次间的停顿，又不至于把"隔天再回"也算成接话。
 * 真正的判定依据仍然是对方的回复内容（CAUGHT_PATTERNS），TTL 只是粗筛。
 */
const PENDING_TTL_MS = 60 * 60 * 1000;
/** 口癖 active 后连续多久无增长则退役 */
const RETIRE_IDLE_MS = 90 * 24 * 3600_000;
/**
 * 转正所需的最低出现次数（M33）。
 *
 * 原来是 2，但它和 `consider()` 里写死的 `count: n`（n>=2）配合，
 * 等于"只要抽出来就满足"。现在 `count` 由真含该词的样本数推出，
 * 门槛提到 3：一个词至少在三句不同的话里出现，才算"说话习惯"而不是"凑巧"。
 */
const PROMOTE_MIN_COUNT = 3;

/** 角色卡硬约束的冲突词（学来的口癖如果让她变成这样，就拒绝） */
const CONFLICT_WORDS = ['哇', '太棒了', '哈哈哈哈哈', '亲爱的', '宝贝', '人家', '嘤嘤嘤', '冲鸭'];

/**
 * 判定「同一词组算几次独立出现」时，两次出现之间至少要隔多久才算独立的场合。
 *
 * M40 简介：原来的判据是**会话维度**（≥2 个不同 session key），
 * 实测线上数据把它判死了 —— 60 条样本里 55 条 key 都是
 * `session-b19fc5fb-…`，因为用户跟她基本只有一个长期私聊会话。
 * 于是任何词组的「跨会话数」都恒等于 1，2 个候选（「是我自己」「你这」）
 * 永远转不了正，整条口癖管线在生产环境里实际上停摆。
 *
 * 判据本身要守的意图是对的：「同一场对话里连说两次，不算稳定的说话习惯」。
 * 错的是**用什么维度衡量「不同场合」**：该衡量时间上的独立性，不是会话数量。
 * 所以改成时间桶 —— 同一词组出现在 ≥2 个不同的时间桶里，才算独立证据。
 */
const EVIDENCE_GAP_MS = 4 * 3600_000;

/**
 * 把一串出现时间切成「时间桶」，返回桶的数量。
 *
 * 切法（贪心聚类）：按时间排序后，离**当前桶起点** ≥ 4 小时就另起一桶。
 *
 * 为什么不用「离上一条 ≥4 小时」的写法：那样会形成**链式合并**——
 * 每隔 3.9 小时出现一次，能一路串几十个小时还只算 1 个桶，
 * 明明跨了好几天的独立场合却被判成同一场对话。
 * 锚定桶起点后，任何一段连续场合最多被拉长到 4 小时就断，不会无限累加。
 *
 * 为什么不用「按北京日期分桶」：日期是固定边界，跟对话节奏无关。
 * 实测反例就在线上数据里 ——「是我自己」的两次出现是
 * UTC 10-31 17:02 和 11-01 14:09（北京时间 11-01 01:02 / 22:09），
 * 按北京日期算是**同一天**，但实际隔了 21 小时，
 * 按天分桶会把这份合法证据判成 1 个桶，判据又一次永远不满足。
 * 按间隔切分才真正对应「不同场合」这个语义。
 */
export function independentOccurrenceCount(times: number[]): number {
  if (times.length === 0) return 0;
  const sorted = [...times].sort((a, b) => a - b);
  let buckets = 1;
  let bucketStart = sorted[0]!;
  for (const t of sorted.slice(1)) {
    if (t - bucketStart >= EVIDENCE_GAP_MS) {
      buckets += 1;
      bucketStart = t;
    }
  }
  return buckets;
}

/**
 * M41：句尾切片必须落在「语义边界」上 —— 挡「半个词」。
 *
 * 问题的本质是**中文没有词边界，而字符 n-gram 不知道这件事**：
 *   「我今天读完了」取最后 2 字 = 「完了」（真词）
 *   「今天下午翻了几页书」取最后 2 字 = 「了书」→ 被别的判据挡住
 *   「我今天很累」取最后 2 字 = 「很累」；但「今天」那种才是真漏网的：
 *   「今天看了个讲研磨度的」开头也取 2 字，就得到「今天」——
 *   它是「今天」这个词本身，可它在这里只是**时间状语**，
 *   不是她的说话习惯（换谁说这话都会有「今天」）。
 *
 * 纯字符串规则**无法**根治中文分词（这是已知的、必须接受的局限），
 * 所以这里的策略是「收紧准入 + 允许漏」：宁可少抽，不可乱抽。
 *
 * 判据（按长度分档，长度本身就是特异性的代理）：
 *   - 切片起点在句首（start === 0）→ 天然边界，放行
 *   - 起点前一个字不是汉字（标点/空格/英文/数字）→ 天然边界，放行
 *   - **2 字候选**：要求前一字是结构助词「的/了/着/过/地/得」。
 *     2 字特异性太低，长句里几乎必然是半个词（「…很|累了」「…今|天」）。
 *     只看"是不是任意汉字"根本不构成边界证据。
 *   - **3 字候选**：条件放宽到"前一字是任意汉字即可"。
 *     3 字的特异性明显高于 2 字（"是一样" vs "一样"），
 *     而且真口癖常常是 3 字（说真的/说实话/其实吧）——
 *     对 3 字用 2 字那道严判据会大面积误伤。
 *
 * 反例校验（线上 60 条实跑）：
 *   放过 3 字 → 「读完了」「弄好了」「挺清楚」这类真·完整片段能进；
 *   拒掉 2 字 → 「今天」这种半个词进不来。
 */
const STRUCT_PARTICLE = new Set(['的', '了', '着', '过', '地', '得']);
function tailBoundaryOk(tail: string, start: number, n: number): boolean {
  if (start <= 0) return true;                    // 起点在句首
  const prev = tail[start - 1]!;
  if (!HAN_RE.test(prev)) return true;            // 前面是标点/非汉字 → 天然边界
  if (n >= 3) return true;                        // 3 字特异性足够，汉字前邻即视为边界
  return STRUCT_PARTICLE.has(prev);               // 2 字：只认结构助词边界
}

/**
 * 口癖的最小表达性（M33）。
 *
 * 复核 8a94319 时用线上 voice.json（48 条正样本）实跑，抽出来并 100% 转正的是：
 *
 *     的。 / 多。 / 完了。 / 一样。 / 行,
 *
 * 这五条会原样注入 system prompt（`renderSection` 生成
 * 「当"想收尾时"时，可以用"的。"来表达。」）。根因不是"没接线"，
 * 是**抽取粒度**：字符 n-gram 没有词边界，标点尾巴天然高频。
 *
 * 所以加两道判据：
 *   1. 必须以**汉字**开头 —— 排除 "行," 这种纯标点/半角混入
 *   2. 去掉尾部标点后仍 >= 2 字 —— 排除 "的。" "多。" 这种单字 + 标点
 */
const SENTENCE_TAIL_PUNCT = /[，。！？、,.!?~…：:；;"'）)】\]》」]+$/;
/** 词内部（不只是尾部）出现任何标点/空白 → 一定是跨句切片，不可能是词 */
const PUNCT_ANY_RE = /[，。！？、；：,.!?;:…~"'（）()【】\[\]「」『』《》\s]/;
/** 至少一个汉字 */
const HAN_RE = /[\u4e00-\u9fa5]/;
/** 去掉句尾标点，得到"这句话的正文" */
const stripTailPunct = (s: string): string => s.replace(SENTENCE_TAIL_PUNCT, '');

/**
 * M41：话语标记（discourse markers）白名单。
 *
 * 它们**确实以虚词收尾**（"说真的"以"的"结尾、"其实吧"以"吧"结尾），
 * 下面的「虚词收尾」判据本能地会把它们当碎片拒掉 —— 但它们不是碎片，
 * 是汉语里一个**封闭小类**：整句就是一个完整的话语标记，常年在句首/句中独立使用。
 *
 * 为什么用白名单而不是再加一条通用规则：这个类目本身就是封闭的、可枚举的
 * （不像"连接词""名词短语"那样开放），白名单是这类问题最诚实的工具；
 * 再加启发式规则只会让判据越来越难解释。
 *
 * 背景：M34 注释里点名"说实话""说真的"是真实口癖的正面例子，
 * 但收紧虚词收尾判据时只保住了"说实话"（3字以实词"说"结尾），
 * "说真的""其实吧"被误伤了。M41 修的就是这个误伤。
 */
const DISCOURSE_MARKERS = new Set([
  '说实话', '说真的', '说实在的', '老实说', '讲真', '讲真的',
  '其实吧', '其实呢', '反正吧', '怎么说呢', '这样吧', '好吧',
]);

function isExpressive(word: string): boolean {
  const core = stripTailPunct(word);
  if (core.length < 2) return false;                       // "的。" → "的" → 太短
  if (core.length > 8) return false;                       // M34：超过 8 字不是"口癖"，是半句话
  if (!/^[\u4e00-\u9fa5]/.test(core)) return false;         // 必须以汉字开头
  if (!/[\u4e00-\u9fa5]/.test(core)) return false;          // 至少含一个汉字

  // M41 硬拒 ①：词内部含标点/空白 → 一定是跨句切片。
  //
  // 实测漏网："了。刚才" 是从「…弄好了。刚才随手搜了一下…」切出来的，
  // 它当时被 LEADING_PARTICLE 挡住了 —— 但那是**巧合**（恰好以"了"开头）。
  // 一旦切片起点落在别的字上（比如 "西。今天"），那道判据就完全不起作用。
  // 跨句号/逗号的片段在语义上不可能是"一个词"，这条必须独立成立，
  // 不能依赖"开头恰好是虚词"这种偶然。
  //
  // 注意位置：必须在 `core`（已去掉**尾部**标点）上判，
  // 因为 "不一样。" 的句号在尾部，是允许的；"了。刚才" 的句号在中间，必须拒。
  if (PUNCT_ANY_RE.test(core)) return false;

  // M41 硬拒 ②：话语标记放行（见 DISCOURSE_MARKERS 注释）。
  // 它们合法的以虚词收尾，必须先于下面几条"虚词收尾/开头"判据返回。
  if (DISCOURSE_MARKERS.has(core)) return true;

  // M34：挡住"跨词边界的碎片"。
  //
  // 实测线上 48 条样本，isExpressive 只挡住了标点尾巴（"的。""多。"），
  // 但抽出来的仍是 "叫小羽我" "小羽我就" "别的没" "了会儿" 这类碎片 ——
  // 它们是从句子中间硬切出来的，不是口癖。
  //
  // 三条判据：
  // ① 不能以常见助词/连接词结尾（"我就""别的没""了会儿"都以虚词收尾）
  // ② 不能整体是"代词+动词"结构（"叫小羽我"这种跨从句的）
  // ③ 必须以实词开头（排除"了""的""是""在"这类）
  // 注意：不能把"说实话"这类真实口癖挡掉 —— 它以"说"结尾但整体是完整词。
  // 所以只在**结尾是单个虚词、且整体长度 ≥3** 时才拦（"叫小羽我" 5字以"我"结尾）。
  // 反之 2-3 字以实词收尾的都放过（"说实话" 3字）。
  // 实测补充：2 字的 "完了" "走了" "好了" 也都是碎片（以"了"收尾）。
  // 但 "说实话"（3字，以"说"结尾）是真实口癖。所以：
  //   - 2 字：以任何虚词收尾都拦
  //   - 3 字以上：只拦代词/助词收尾（"叫小羽我"），不拦实词（"说实话"）
  const TRAILING_PARTICLE = /(?:我|你|他|她|它|们|的|了|着|过|吗|呢|吧|啊|就|没|会|能|想|要|和|跟|把|被|让|给|从|向)$/;
  const TRAILING_PARTICLE_SHORT = /(?:了|的|着|过|吗|呢|吧|啊|就|没|和|跟|把|被|让|给|从|向)$/;
  if (core.length === 2 && TRAILING_PARTICLE_SHORT.test(core)) return false;
  if (core.length >= 3 && TRAILING_PARTICLE.test(core)) return false;

  // 开头是虚词/代词 → 多半是半句的开头碎片（"了会儿""这个真"）
  // 但"说实话""说真的"这类是完整词，所以排除"说"。
  const LEADING_PARTICLE = /^(?:了|的|着|过|吗|呢|吧|啊|就|没|会|能|和|跟|把|被|让|给|从|向|这|那)/;
  if (LEADING_PARTICLE.test(core)) return false;

  return true;
}

/**
 * 口癖服务：读写 voice.json。
 */
export class VoiceService {
  private data: VoiceFile;
  private readonly file: string;

  constructor(dataDir: string, private readonly log?: (m: string) => void) {
    this.file = path.join(dataDir, 'voice.json');
    this.data = this.load();
  }

  private load(): VoiceFile {
    try {
      if (!fs.existsSync(this.file)) return { version: 1, pending: [], caughtSamples: [], habits: [] };
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<VoiceFile>;
      return {
        version: 1,
        pending: Array.isArray(raw.pending) ? raw.pending : [],
        caughtSamples: Array.isArray(raw.caughtSamples) ? raw.caughtSamples : [],
        habits: Array.isArray(raw.habits) ? raw.habits : [],
        updatedAt: raw.updatedAt,
      };
    } catch {
      return { version: 1, pending: [], caughtSamples: [], habits: [] };
    }
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      this.data.updatedAt = new Date().toISOString();
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log?.(`voice: 写入失败 ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  snapshot(): VoiceFile {
    return this.data;
  }

  // ───────────── 采集：她说的话 ─────────────

  /**
   * outbound：记录她说的一句话（待后续判定是否被接住）。
   * 只收长度合适、不像图片/表情占位的内容。
   */
  recordUtterance(turnId: string, key: string, text: string): boolean {
    const t = text.trim();
    if (t.length < MIN_LINE || t.length > MAX_LINE) return false;
    if (/^\[图片|^\[表情|^\[语音|^【图/.test(t)) return false;
    // 占位/系统消息不算
    if (/^\[.*\]$/.test(t)) return false;

    this.data.pending.push({ turnId, key, text: t, at: Date.now() });
    // 控制队列长度
    while (this.data.pending.length > MAX_PENDING) this.data.pending.shift();
    this.save();
    return true;
  }

  /**
   * inbound：判定她之前说的话是否被「接住」。
   * 规则：同会话、5 分钟内的下一条人类消息。
   * 返回被判定为「接住」的发言。
   */
  judgeIncoming(key: string, humanText: string): Utterance[] {
    const now = Date.now();
    const caught: Utterance[] = [];
    const remain: Utterance[] = [];

    for (const u of this.data.pending) {
      // 过了 TTL 的丢弃（冷场不算负样本）
      if (now - u.at > PENDING_TTL_MS) continue;
      // 不同会话的保留
      if (u.key !== key) {
        remain.push(u);
        continue;
      }
      // 同会话且 TTL 内 → 判定
      if (COMPLAINT_RE.test(humanText)) {
        // 被嫌 = 负样本，直接丢（不记入正样本，也不学）
        this.log?.(`voice: 她的「${u.text.slice(0, 16)}」被嫌，丢弃`);
        continue;
      }
      const isCaught = CAUGHT_PATTERNS.some((re) => re.test(humanText));
      if (isCaught) {
        caught.push(u);
        this.data.caughtSamples.push({
          turnId: u.turnId,
          herLine: u.text,
          theirReply: humanText.slice(0, 80),
          at: now,
          key,
        });
      } else {
        // 平淡回应：保留（可能下一句才接住）
        remain.push(u);
      }
    }

    while (this.data.caughtSamples.length > MAX_SAMPLES) this.data.caughtSamples.shift();
    this.data.pending = remain;
    if (caught.length > 0 || remain.length !== this.data.pending.length) this.save();
    return caught;
  }

  // ───────────── 抽取与护栏 ─────────────

  /** 正样本数量（够不够触发抽取） */
  caughtSampleCount(): number {
    return this.data.caughtSamples.length;
  }

  /**
   * 从正样本里抽取候选口癖（纯本地启发式，不调 LLM —— 省成本、可控）。
   *
   * 做法：找她多条「被接住」发言里的**重复句式特征**：
   *   - 开头固定词（"说实话"、"其实"）
   *   - 结尾固定词（"…吧"、"…来着"）
   *   - 常用连接（"反正"、"倒是"）
   * 抽出来存为 candidate，等确认。
   */
  extractCandidates(): VoiceHabit[] {
    const samples = this.data.caughtSamples;
    if (samples.length < 4) return [];

    // 统计各种开头/结尾模式的出现频率
    const starts = new Map<string, number>();
    const ends = new Map<string, number>();
    const middles = new Map<string, number>();

    for (const s of samples) {
      const line = s.herLine;
      // 开头 2-3 字
      //
      // 句首本身就是天然边界，不需要额外校验；危险的只有"内容"——
      // 「嗯，」「对，」这类以标点收尾的开头会在 consider() 里被统一拒掉。
      for (const n of [2, 3]) {
        const p = line.slice(0, n);
        if (p.length >= 2) starts.set(p, (starts.get(p) ?? 0) + 1);
      }
      // 结尾 2-3 字
      //
      // M41：这里原来是 `line.slice(-n)` —— 裸切片，不看起点落在哪。
      // 结果是「今天」「一样。」「字典页」这类**半个词**直接进候选。
      // 现在两步修正：
      //  ① 先去掉整句的句尾标点再切 —— 句子的终结标点不属于"词"，
      //     留着它就等于把「字典页。」当成一个词（它会 100% 转正并注入 prompt）。
      //  ② 切出来的起点必须落在**语义边界**上（见 tailBoundaryOk）。
      const tail = stripTailPunct(line);
      for (const n of [2, 3]) {
        const start = tail.length - n;
        if (start < 0) continue;
        const p = tail.slice(start);
        if (p.length < 2) continue;
        if (!tailBoundaryOk(tail, start, n)) continue;
        ends.set(p, (ends.get(p) ?? 0) + 1);
      }
      // 中间常见词（3~4字）
      //
      // M33：原来是 2 字。中文里任何 2 字组合都会高频出现，
      // 线上实跑抽出的 "出来" "自己" "句话" 全是这种碎片 ——
      // 它们不是"口癖"，是中文的公共零件。中间类提到 3 字起，
      // 因为中间词没有位置约束（句首/句尾至少还有个边界），
      // 只能靠长度换特异性。
      // M39：原来从 3 字起。实测 53 条样本（仅 2 个会话）抽出来的
      // '是我自己' '在不在意' '不一样。' '造出来' **全部是普通词组巧合重复**，
      // 语境是"另一行是我自己的话""在不在意的人那儿分量不一样"——
      // 一句话中间的任意片段，不是口癖。
      // 提到 4 字：中间词没有位置约束，只能靠长度换特异性。
      for (const n of [4, 5]) {
        for (let i = 0; i <= line.length - n; i++) {
          const p = line.slice(i, i + n);
          if (p.length === n) middles.set(p, (middles.get(p) ?? 0) + 1);
        }
      }
    }

    // 出现 >=2 次且不是通用词的，作为候选
    //
    // M41：原来的 9 个词远不够。线上实跑漏过的是「今天」（4 次）——
    // 它不是碎片（"今天"确实是完整词），问题在于它是**高频通用词**：
    // 换谁说这句话都会有"今天"，它不构成"她的说话习惯"。
    // 这类词没有位置约束、也不违规，只能靠枚举挡；它们是个封闭小类
    // （时间词/数量词/泛用名词），所以用白名单式集合是合适的工具。
    const COMMON = new Set([
      // ── M33 原有 ──
      '的话', '时候', '什么', '这个', '那个', '可以', '就是', '还是', '不是',
      // ── M41 补：时间/数量词（最容易被当口癖，实际换谁都说） ──
      '今天', '明天', '昨天', '现在', '刚才', '一下', '一样', '一点', '有点',
      '一会', '一直', '然后', '以前', '以后', '最近',
      // ── M41 补：泛用名词/动词（语义空，任何话题都会出现） ──
      '东西', '事情', '问题', '感觉', '觉得', '知道', '看看', '说话',
      '这样', '那样', '真的', '其实', '所以', '但是', '因为',
    ]);
    const picked = new Map<string, VoiceHabit>();
    /**
     * 候选 id → 覆盖了几个**独立时间桶**（M40：原来记的是会话数，见下方判据注释）。
     * 目前只作调试/排查线索保留，不参与任何判定。
     */
    const diversity = new Map<string, number>();

    /** kind → 中文「使用时机」文案。写入和去重必须用同一套映射。 */
    const situationOf = (kind: 'start' | 'end' | 'mid'): string =>
      kind === 'start' ? '想说开场白时' : kind === 'end' ? '想收尾时' : '想加个连接词时';

    const consider = (kind: 'start' | 'end' | 'mid', word: string, n: number): void => {
      if (n < 2) return;
      if (word.length < 2) return;
      if (COMMON.has(word)) return;
      // 护栏 1：冲突词直接丢
      if (CONFLICT_WORDS.some((w) => word.includes(w))) return;
      const id = `${kind}:${word}`;
      if (picked.has(id)) return;
      // M38 修的 bug：这里原来等于 `h.situation === kind`，即拿中文
      // `'想加个连接词时'` 跟英文字符串 `'mid'` 比 —— **永远为 false**，
      // 去重完全失效。后果：同一个词每次抽取都重新插入一条，
      // 实测线上出现 4 个候选 × 3 份重复 = 12 条 habits。
      const situation = situationOf(kind);
      if (this.data.habits.some((h) => h.situation === situation && h.style === word)) return;
      // M33：证据必须来自**真的含有这个词**的样本，不能拿 samples.slice(0,2) 冒充。
      //
      // 原写法 `evidence: samples.slice(0, 2)` 是"前两条样本无论有没有这个词都当证据"，
      // 配上 `count: n`（n 只要 >= 2），转正判据 `count>=2 && distinctEvidence>=2`
      // 就**恒成立** —— 任何候选一产生就立即转正，门槛完全没起作用。
      // 线上实跑证实：5 条候选，5 条全部当场转正。
      const matched = samples.filter((s) => {
        if (kind === 'start') return s.herLine.startsWith(word);
        if (kind === 'end') return s.herLine.endsWith(word);
        return s.herLine.includes(word);
      });
      if (matched.length < 2) return;
      picked.set(id, {
        id,
        situation: situationOf(kind),
        style: word,
        count: matched.length,
        adoptedAt: Date.now(),
        state: 'candidate',
        evidence: matched.slice(0, 3).map((s) => ({
          turnId: s.turnId,
          herLine: s.herLine,
          theirReply: s.theirReply,
          at: s.at,
        })),
        tone: 'dry',
      });
      // M40：另存一份出现场合的独立性指标。
      // 原来存的是 `new Set(matched.map(s => s.key)).size`（会话数），
      // 但会话维度在真实使用里几乎恒为 1，指标本身失真；
      // 改成独立时间桶数，和判据保持同一语义。
      diversity.set(id, independentOccurrenceCount(matched.map((s) => s.at)));
    };

    // 按出现频次优先：先 ends（收尾句式最像口癖），再 starts，最后 middles
    const byFreq = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    // M39 的意图（保留）：口癖必须在**不同场合**都出现，不能是同一场对话里的
    // 重复。实测教训：句尾「一样」抽出 3 次，但语境是"分量不一样"/"不全一样"/
    // "其实不一样"——语义完全不同，不是口癖而是中文常用词的巧合。
    //
    // M40 换维度：M39 用「≥2 个不同 session key」衡量"不同场合"，但真实使用里
    // 用户跟她就一个长期私聊会话（实测 60 条样本 55 条同一个 key），
    // 于是任何词组的跨会话数恒为 1，判据在线上**永远不满足**，
    // 「是我自己」「你这」两个候选 count 卡在 2 再也动不了。
    // 现在改用时间桶（见 EVIDENCE_GAP_MS / independentOccurrenceCount）：
    // 同一词组出现在 ≥2 个相隔 ≥4 小时的时间桶里，才算独立证据。
    //
    // 代价：样本少时会抽不出东西（这是对的，宁缺毋滥）。
    const independentOccurrences = (w: string): boolean =>
      independentOccurrenceCount(
        samples.filter((s) => s.herLine.includes(w)).map((s) => s.at),
      ) >= 2;

    for (const [w, n] of byFreq(ends)) if (independentOccurrences(w)) consider('end', w, n);
    for (const [w, n] of byFreq(starts)) if (independentOccurrences(w)) consider('start', w, n);
    // mid 类同样要求独立出现。
    // 理由：中间词没有位置锚点，同一场对话里连续几条都含某词组很正常
    // （比如同一段话题里反复说"在意"），那不叫说话习惯。
    // 跨场合（时间上分开）才说明是"她这个人"的模式，而不是"这一场对话"的痕迹。
    for (const [w, n] of byFreq(middles)) if (independentOccurrences(w)) consider('mid', w, n);

    /**
     * M41：特异性兜底 —— 复现率过高的词不是口癖，是常用词。
     *
     * 直觉：如果她"被接住"的样本里有超过三成的句子都含某个词组，
     * 那这个词组更可能是**中文的公共零件**（换谁说都会有），
     * 而不是"她这个人的说话习惯"。
     *
     * ⚠️ 但这条判据**不能无条件套用到全部候选种类**，否则会直接
     * 和本任务最重要的一条要求冲突：真口癖可能确实高频。
     * 实测反例就在项目自己的测试里 ——「说实话」在 4 条样本里出现 4 次
     * （密度 1.0），而它是 M34 点名的**正面例子**，必须保住。
     * 全局套用 >0.3 会把「说实话」100% 杀掉。
     *
     * 所以只对 **mid 类**生效，理由是两者有本质差别：
     *   - start/end 有**位置锚点**（"她开头爱说…""她结尾爱说…"），
     *     位置本身已经提供了特异性；高频反而是真口癖的典型特征。
     *   - mid 没有位置约束，一个高频的中间片段几乎必然是常用词 ——
     *     这正是 M39 的教训（"是我自己""在不在意"全是普通词组巧合）。
     *     对它用密度判据最有效，也最不容易误伤。
     *
     * 阈值定在 0.5（比任务建议的 0.3 更保守）：mid 类只拦"一半以上样本都有"的极端情况。
     * 线上 60 条实跑，mid 候选密度最高是「冲浪回来」3/60=0.05，
     * 离阈值很远 —— 这条兜底在当前数据上不误伤任何东西，
     * 它的价值是挡住将来数据里可能出现的、真正泛滥的中间片段。
     */
    const DENSITY_LIMIT = 0.5;
    const sampleCount = samples.length;
    const tooCommon = (h: VoiceHabit): boolean => {
      if (!h.situation.startsWith('想加个连接词')) return false; // 只对 mid 生效
      const hit = samples.filter((s) => s.herLine.includes(h.style)).length;
      return sampleCount > 0 && hit / sampleCount > DENSITY_LIMIT;
    };

    /**
     * M41：候选本身携带标点 → 一定是跨小句切出来的碎片。
     *
     * 只在 `end` 类上，句子的**终结标点**是合法的（她在那里结束了这句话），
     * 所以 `ends` 在生成时（见上方 tail / stripTailPunct）就把尾部标点去掉了，
     * 这里的候选不可能带标点。
     *
     * 而 `start` / `mid` 拿的是**句子中间**的切片：一个"词"中间出现
     * 「，。！？、」意味着切片跨过了小句边界，语义上不可能是词。
     * 线上实例：「不一样。」来自「…分量不一样。 别的没干。…」——
     * 这个句号是**小句**的结束符，不是她这句话的结束符；
     * 它此前能过 `isExpressive`，是因为那里只看**尾部**标点并把它剥掉，
     * 「不一样。」剥成「不一样」就显得无害了。这道判据补上那个缺口。
     */
    const carriesPunct = (style: string): boolean => PUNCT_ANY_RE.test(style);

    // ── 护栏管线：顺序很重要 ──
    //
    // M41 修的 bug：原来 dedup（子串去重）跑在硬性过滤**之前**，
    // 于是「更长的垃圾片段」会先把「合法的短候选」判成子串丢掉，
    // 自己再被表达性/密度判据拒掉 —— 两个一起消失，产出空集。
    // 实测：fixture「说实话这事挺离谱的吧」×4 条，
    //   mid「说实话这事」(5字) 包含 start「说实话」→ 说实话 被子串去重丢弃；
    //   而「说实话这事」随后被 mid 密度判据拒 → 候选归零。
    // 正确顺序是**先剔除垃圾，再在存活者之间做子串去重**。
    const all = [...picked.values()];
    const valid = all.filter((h) => {
      // 含标点的跨小句碎片（"不一样。" "冲浪回来，"）
      if (carriesPunct(h.style)) return false;
      // 复现率过高的中间片段（不是口癖，是常用词）
      if (tooCommon(h)) return false;
      // M33：必须有表达性 —— 线上实跑证明没有这道闸门时
      // 抽出来的是 "的。" "多。" "行," 这类标点尾巴，而且会 100% 转正
      return isExpressive(h.style);
    });

    // 护栏：子串去重 —— "说实" 是 "说实话" 的子串，只保留更长更有意义的那个。
    // 只在**通过全部硬性判据的候选**之间比较，避免上面说的连锁误杀。
    const final = valid.filter((h) => {
      return !valid.some((o) => o !== h && o.style.length > h.style.length && o.style.includes(h.style));
    });
    // 最多新增 5 条候选
    const added = final.slice(0, 5);
    for (const h of added) this.data.habits.push(h);
    if (added.length > 0) {
      this.save();
      this.log?.(`voice: 抽取 ${added.length} 条候选口癖`);
    }
    return added;
  }
  /**
   * 确认门槛：count>=2 且至少 2 条不同证据 → 转 active。
   * 对应 Mirrai 的「未 verified 不注入」。
   *
   * M33：这道门槛原来**等于没设**。`consider()` 写死 `count: n`（入口要求 n>=2）
   * 和 `evidence: samples.slice(0, 2)`（写死 2 条且 turnId 必然不同），
   * 于是 `count>=2 && distinctEvidence>=2` 对任何候选恒成立 —— 抽一条转一条。
   * 现在 `count` 与 `evidence` 改由**真含该词**的样本推出（见 `consider`），
   * 这里的 `distinctEvidence` 用 turnId 去重 = 轮次级独立（同一轮里说了两次不算两条），
   * 方向是对的，M40 不动它。
   *
   * 「不同场合」那道判据不在这里：它在 `extractCandidates` 里决定要不要产出候选
   * （M40 起按时间桶算，见 `EVIDENCE_GAP_MS`）。
   */
  promoteHabits(): number {
    let promoted = 0;
    for (const h of this.data.habits) {
      if (h.state !== 'candidate') continue;
      const distinctEvidence = new Set(h.evidence.map((e) => e.turnId)).size;
      if (h.count >= PROMOTE_MIN_COUNT && distinctEvidence >= 2) {
        h.state = 'active';
        promoted += 1;
        this.log?.(`voice: 口癖「${h.style}」转正`);
      }
    }
    if (promoted > 0) this.save();
    return promoted;
  }

  /** 她表态：接受/拒绝某条候选口癖 */
  decideHabit(id: string, accept: boolean): boolean {
    const h = this.data.habits.find((x) => x.id === id);
    if (!h) return false;
    h.state = accept ? 'active' : 'retired';
    this.save();
    return true;
  }

  /** 退役体检：active 且 90 天无增长 → retired */
  retireStale(now = Date.now()): number {
    let n = 0;
    for (const h of this.data.habits) {
      if (h.state !== 'active') continue;
      const last = h.lastSaidAt ?? h.adoptedAt;
      if (now - last >= RETIRE_IDLE_MS) {
        h.state = 'retired';
        n += 1;
      }
    }
    if (n > 0) {
      this.save();
      this.log?.(`voice: ${n} 条口癖因长期不用退役`);
    }
    return n;
  }

  /** 生效中的口癖（只有这些会被注入 prompt） */
  activeHabits(): VoiceHabit[] {
    return this.data.habits.filter((h) => h.state === 'active');
  }

  /** 生成注入 prompt 的文本（照 MaiBot 句式） */
  renderSection(): string {
    const active = this.activeHabits();
    if (active.length === 0) return '';
    const lines = active.slice(0, 4).map((h) => `- 当"${h.situation}"时，可以用"${h.style}"来表达。`);
    return [
      '【你自己的一些说话习惯（视情况自由用，不强求；一轮最多用一条，连续两轮不要用同一条）】',
      ...lines,
    ].join('\n');
  }

  /** 记录一次实际使用（她说了带该口癖的话） */
  markUsed(id: string): void {
    const h = this.data.habits.find((x) => x.id === id);
    if (!h) return;
    h.count += 1;
    h.lastSaidAt = Date.now();
    this.save();
  }
}
