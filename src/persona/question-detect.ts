/**
 * 中文口语疑问句识别 + 说话对象判定
 * ─────────────────────────────────────────────────────────────
 * 背景：QQ 群里大量提问不带问号、省略主语（"吃了吗""在干嘛""忙不忙"），
 * 靠 /[?？]|怎么|为什么/ 这种正则必然漏（实测 7 条全漏）。
 *
 * 做法：纯规则打分（无模型、无分词、无依赖），单条判定 < 0.05ms。
 * 依据：现代汉语四类疑问句（是非/特指/选择/正反）+ 吕叔湘《中国文法要略》
 * 的「疑·问」分离；工程实现参考 CCL2020《中文问句的形式分类和资源建设》
 * 与专利 CN107145514A 的特征集（语气词/疑问代词/正反格式/选择格式）。
 *
 * 关键设计：
 *  1. 不用「否定词+不」的固定串匹配，而是**逐位扫描**否定词两侧做反向比较，
 *     这样 忙不忙/来不来/困不困/行不行 全中，而 差不多/对不起/不得不 天然不中
 *     （两侧字不同）。这是识别正反问最省事又最准的写法。
 *  2. 每个信号给一个分数而非布尔，便于后续按场景调阈值；
 *     口语群里"吧"结尾的推测句、省略式"吃了没"这类高噪声情形单独降权。
 *  3. 只有"疑"没有"问"的句子要排除：我谁都不认识 / 没什么 / 不咋样。
 *  4. 单独提供「是不是在跟我说话」判定：第二人称、称呼、指名、以及
 *     上一轮是谁在对话（省略主语默认指向当前对话对象）。
 */

/** 判定结果 */
export interface QuestionSignal {
  /** 是否疑问句（score >= QUESTION_THRESHOLD） */
  isQuestion: boolean;
  /** 0~1 置信度 */
  score: number;
  /** 命中的信号名，便于日志排查（如 ['a-not-a:忙']） */
  signals: string[];
  /** 命中的那个分句 */
  clause: string;
}

/** 说话对象判定结果 */
export interface AddresseeSignal {
  /** 0~1，越大越像在跟"我"说 */
  score: number;
  signals: string[];
  /** 是否明确点名/第二人称 */
  explicit: boolean;
  /** 句子里明确点名了别人 → 不是在跟她说话，隐式路径必须让路 */
  excluded: boolean;
}

/** 上下文（可选，不传则只看句式） */
export interface AddresseeContext {
  /** 我的称呼（小羽/鲸鱼娘…），用于点名检测 */
  names?: string[];
  /** 群里其他人的昵称，用于"在跟别人说"的排除 */
  otherNames?: string[];
  /** 上一条消息是不是我发的（她刚说完话，下一句省略主语大概率还是对她） */
  botSpokeLast?: boolean;
  /** 上一条消息的发送者是不是当前这个人（连续追问） */
  sameSpeakerAsLast?: boolean;
  /** 上一轮对话对象是不是我（活跃对话窗口内） */
  inConversationWithMe?: boolean;
}

/** 阈值：>= 0.5 判为疑问句。可按场景调（群里怕吵就 0.6，私聊 0.4） */
export const QUESTION_THRESHOLD = 0.5;

// ── 词表 ──────────────────────────────────────────────────────────────

/** 疑问代词/疑问副词（特指问）。刻意收口语写法：咋/啥/干啥/有木有 */
const WH_WORDS = [
  '为什么', '为啥', '为毛', '为何', '凭什么', '怎么', '咋', '怎样', '怎么样', '怎么办',
  '咋办', '咋整', '怎么回事', '咋回事', '如何', '什么', '啥', '神马', '谁', '哪', '哪儿',
  '哪里', '哪些', '哪个', '哪种', '几', '几点', '几个', '多少', '多久', '多大', '多高',
  '多远', '多重', '多长', '干什么', '干嘛', '干吗', '干啥', '干啥子', '何时', '什么时候',
  '是否', '能否', '可否', '要不要', '有没有', '有木有',
];

const WH_RE = new RegExp(
  '(' + WH_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')',
);

/** 特指问的"非疑问"守卫：疑问代词表任指/否定/无所谓，不是在问 */
const WH_GUARD = /(都|也|不|没|无论|不管|随便|无所谓|任何|全都不)/;
/** "我哪知道""他怎么会知道"：疑问代词在"不知道"语境里 */
const WH_GUARD_HEAD = /^(我|俺|咱|我们|你|他|她)[^,，]{0,4}(哪知道|哪晓得|哪敢|怎么会知道)/;
/** 整句固定非问短语（含疑问代词但不提问） */
const WH_GUARD_FIXED =
  /(不咋样|不咋地|不咋的|不怎么|没什么|没啥|不怎么样|谁都不|谁也不|哪都|哪儿都|什么都|谁都|哪儿都不|哪都不|乱七八糟|什么玩意|什么鬼|什么东西|说什么就是什么|是什么就是什么|跟谁|和谁|谁说|谁说的|谁(啊|呀)?[^,，]{0,4}不认识)/;
/** 句尾"没关系/无所谓/不知道"：整句是陈述 */
const WH_GUARD_TAIL = /(没关系|无关|无所谓|不重要|我不知道|我不晓得|不晓得|谁知道|鬼知道)$/;

/** 反问句标记：形式是问、实际是强调，不该当普通提问回答 */
const RHET_RE = /(难道|难不成|岂|何必|何苦|怎能|怎么会|哪能|哪有|不是.*吗|不就.*吗)/;

/** 强疑问语气词（吗/么）。"么"要先排除 什么/怎么/这么/那么/多么 里的语素 */
const MA_CHAR_RE = /[吗麼么]/;
const MA_NOT_PARTICLE = /(这|那|怎|什|甚|多|要|干|为|哪)/;

/** 弱疑问语气词 */
const WEAK_TAIL_RE = /(吧|呢|啊|呗|嘛|哈)$/;
/** "吧"的祈使/建议（陈述或命令，不是提问） */
const IMPERATIVE_BA =
  /^(走|吃|睡|去|来|坐|休息|加油|早点|先|就|算了|这样|别|快|慢)|(先|快|赶紧|别|不要)[^,，]{0,4}吧$/;
/** "吧"的揣测求确认（累坏了吧/快到了吧）：弱问，降权处理 */
const CONFIRM_BA = /(了|过)$/;
/** "吧"结尾的弱陈述（还行吧/凑合吧） */
const SOFT_BA = /^(还行|还好|也行|还可以|凑合|一般|不错|挺好|可以)$|^(还|也|就)(行|好|可以)$/;
/** "吧"的附加问（是吧/对吧/懂我意思吧） */
const TAG_BA =
  /(是吧|对吧|好么|行么|可以吧|懂吧|懂我意思吧|明白吧|知道吧|没错吧)$|我意思|这样行|没问题吧/;

/** "呢"在代词后 = "……呢？"（你呢/然后呢/后来呢） */
const NE_AFTER_PRONOUN = /^(你|我|他|她|它|你们|我们|他们|她们|咱|大家|妈|爸|老师)$/;
/** "呢"在话题词后 = 追问（然后呢/后来呢/结果呢） */
const NE_AFTER_DISCOURSE = /(然后|后来|接着|结果|那|这个|那个)$/;
/** "呢"表进行（我在吃饭呢/上课呢）：陈述，不是问 */
const PROGRESSIVE_CUE = /(在|正在)/;
/** 第一人称开头 */
const FIRST_PERSON = /^(我|俺|咱|我们|老子|本人)/;
/** 纯答语（不能当问句） */
const ANSWER_ONLY =
  /^(没|没有|没事|没什么|没空|不|不是|不忙|不来|不去|不好|不行|不对|不要|不会|没有啊|没呢|还没|嗯|好|行|可以|对|是|在|在呢|在的)$/;

/** 含"不"但已词汇化为一个词，整体是陈述而非正反问 */
const LEXICAL_BU_NOT_ANOT = /(差不多|对不起|不得不|了不起|忍不住|恨不得|怪不得|巴不得|说不定|要不然|舍不得|恨不得|不外乎|不禁|不觉|不知不觉)/;

/** 正反问 A不A 的"让步"尾巴：来不来都行 / 好不好都一样 */
const ANOT_GUARD_TAIL = /^(都|也|无所谓|随便|一样|行|可以)/;

/** 省略式正反问的句尾：吃了没 / 有空没 / 走不 */
const TAIL_MEI = /([\u4e00-\u9fff]{1,4})(没|没有|木有)$/;
const TAIL_BU = /([\u4e00-\u9fff]{1,4})不$/;

/** 口语固定问法（正则直接用，命中即 0.9） */
const SPECIAL_Q: RegExp[] = [
  /真的假的/, /真假/, /尊嘟假嘟/, /是不是真的/, /你猜/, /猜猜/,
  /(你|您)(确定|确信|当真|认真的|说真的)/, /开什么玩笑/, /^当真/,
  /在吗/, /在么/, /在不在/, /有空吗/, /有空没/, /干嘛呢/, /干啥呢/,
  /咋了/, /咋啦/, /怎么了/, /咋回事/, /啥事/, /啥情况/, /啥意思/,
];

/** 第二人称 */
const SECOND_PERSON = /(你|您|妳|ni\b)/;
/** 句子开头的称呼（小羽/宝/哥/姐…） */
const VOCATIVE_HEAD = /^[，,。!！]?(小羽|宝|宝宝|哥|姐|亲|大佬|师傅|老师|兄弟|姐妹)/;

// ── 归一化 ────────────────────────────────────────────────────────────

/**
 * 归一化：全角→半角、去 @、去 [图片][表情]、去 emoji、压空白。
 * 注意保留 ASCII '?'，它是判断"有问号"的唯一依据。
 */
export function normalizeText(input: string): string {
  return String(input ?? '')
    // 全角 ASCII（？→? ，→, ０→0 …）
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    // QQ 表情占位 [图片][表情][动画表情]
    .replace(/\[[^\]]{1,10}\]/g, ' ')
    // emoji / 符号
    .replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F\u2B00-\u2BFF]/gu, ' ')
    // @某人
    .replace(/@[^\s,]{1,20}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去掉句末标点/空白 */
function stripTail(s: string): string {
  return s
    .replace(/[.,!?;:~、。，！？；：·'"“”‘’()（）]+$/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/** 切分句：按标点断句，长句里只要有一个分句是问，整句就是问 */
function splitClauses(s: string): string[] {
  const parts = s
    .split(/[.,!?;、。，！？；]+/)
    .map(stripTail)
    .filter((x) => x.length > 0);
  return parts.length > 0 ? parts : [stripTail(s)];
}

// ── 单分句打分 ────────────────────────────────────────────────────────

interface ClauseScore {
  w: number;
  notes: string[];
}

/** 正反问 A不A / A没A：逐位扫描否定词两侧，1~2 字对齐比较 */
function scoreANotA(c: string, add: (w: number, n: string) => void): void {
  if (LEXICAL_BU_NOT_ANOT.test(c)) return;
  for (const mm of c.matchAll(/不|没/g)) {
    const i = mm.index ?? 0;
    const neg = mm[0];
    for (let len = 2; len >= 1; len--) {
      const a = c.slice(i - len, i);
      const b = c.slice(i + 1, i + 1 + len);
      // 两侧必须完全相同 → 天然排除 差不多/对不起/不得不
      if (a.length === len && a === b) {
        const tail = c.slice(i + 1 + len);
        if (ANOT_GUARD_TAIL.test(tail)) add(0.12, 'a-not-a-guard');
        else add(1.0, `a-not-a:${a}${neg}${b}`);
        break;
      }
    }
  }
}

/** 疑问代词（特指问），带任指/否定守卫 */
function scoreWh(c: string, add: (w: number, n: string) => void): void {
  const m = WH_RE.exec(c);
  if (!m) return;
  const hit = m[1] ?? '';
  const at = m.index ?? 0;
  const before = c.slice(Math.max(0, at - 3), at);
  const after = c.slice(at + hit.length, at + hit.length + 4);

  if (WH_GUARD_HEAD.test(c) || WH_GUARD_FIXED.test(c)) return add(0.12, 'wh-guard:fixed');
  if (WH_GUARD_TAIL.test(c)) return add(0.15, 'wh-guard:tail');
  if (WH_GUARD.test(before) || /都|也/.test(after)) return add(0.2, 'wh-guard:redundant');
  add(0.9, `wh:${m[1]}`);
}

/** 单个分句 → 分数（取各信号最大值） */
function scoreClause(c: string): ClauseScore {
  const notes: string[] = [];
  let w = 0;
  const add = (x: number, n?: string): void => {
    if (x > w) w = x;
    if (n) notes.push(n);
  };

  if (!c) return { w: 0, notes };
  if (ANSWER_ONLY.test(c)) return { w: 0, notes: ['answer'] };

  // 1) 反问句（形式问、实际强调）
  if (RHET_RE.test(c)) add(0.75, 'rhet');

  // 2) 选择问：A 还是 B（排除"不管…还是…"）
  if (/还是/.test(c) && !/(不管|无论|不论|随便|要不)/.test(c)) add(0.95, 'choice');

  // 3) 正反问 A不A
  scoreANotA(c, add);

  // 4) 句末"吗/么"（强疑问语气词）
  {
    const m = MA_CHAR_RE.exec(c);
    if (m) {
      const at = m.index;
      const prev = c.slice(Math.max(0, at - 1), at);
      const after = c.slice(at + 1);
      const isParticle = !MA_NOT_PARTICLE.test(prev);
      if (isParticle && after.length <= 3) add(1.0, 'particle:ma');
      else if (isParticle && after.length <= 5) add(0.85, 'particle:ma-mid');
    }
  }

  // 5) 句末弱语气词 呢/吧/啊/嘛
  if (WEAK_TAIL_RE.test(c)) {
    const ch = c.slice(-1);
    const stem = c.slice(0, -1);
    if (ch === '呢') {
      if (NE_AFTER_PRONOUN.test(stem)) add(0.95, 'ne:pronoun');
      else if (NE_AFTER_DISCOURSE.test(stem)) add(0.9, 'ne:discourse');
      else if (WH_RE.test(stem)) add(0.9, 'ne:wh');
      else if (PROGRESSIVE_CUE.test(c) || /着$/.test(stem) || FIRST_PERSON.test(c)) add(0.15, 'ne:progressive');
      // 省略主语/省略"在"的进行体：上课呢 / 正忙呢 / 吃饭呢（短名词短语动词）
      else if (!SECOND_PERSON.test(c) && [...stem].length <= 6) add(0.2, 'ne:elliptical-progressive');
      else add(0.55, 'ne:weak');
    } else if (ch === '吧') {
      if (SOFT_BA.test(stem)) add(0.1, 'ba:soft-statement');
      else if (CONFIRM_BA.test(stem)) add(0.6, 'ba:confirm');
      else if (IMPERATIVE_BA.test(c)) add(0, 'imperative:ba');
      else if (TAG_BA.test(c)) add(0.8, 'tag:ba');
      else add(0.45, 'particle:ba');
    } else if (ch === '嘛') {
      if (/^(干嘛|干吗)$/.test(c)) add(0, 'wh:gànma');
      else add(0.5, 'particle:ma2');
    } else if (ch === '啊' || ch === '哈' || ch === '呗') {
      add(0.2, `weak:${ch}`);
    }
  }

  // 6) 省略式正反问：句末 没/没有/不（吃了没、有空没、走不）
  {
    const base = c.replace(/(啊|呀|啦|哈|嗷|哦)$/g, '');
    const lexical = LEXICAL_BU_NOT_ANOT.test(base);
    if (!FIRST_PERSON.test(base) && !/^(还|也|都|根本|并)/.test(base) && !/^没/.test(base) && !lexical) {
      if (TAIL_MEI.test(base)) add(0.95, 'tail:mei');
      // "不得不/要不" 这类以"不"收尾的固定词不是正反问
      if (TAIL_BU.test(base) && !/(不得|要不|再不|差点儿不)$/.test(base)) add(0.95, 'tail:bu');
    }
  }

  // 7) 特指问
  scoreWh(c, add);

  // 8) 口语固定问法
  for (const re of SPECIAL_Q) {
    if (re.test(c)) {
      add(0.9, `special:${re.source}`);
      break;
    }
  }

  return { w, notes };
}

// ── 对外：疑问句判定 ──────────────────────────────────────────────────

/**
 * 判定一句话是不是提问。
 * @param text 原始消息文本（可含 emoji/@/全角标点，内部会归一化）
 */
export function detectQuestion(text: string): QuestionSignal {
  const raw = String(text ?? '');
  const norm = normalizeText(raw);
  const hasQMark = normalizeText(raw).includes('?');

  let best: ClauseScore & { clause: string } = { w: 0, notes: [], clause: '' };
  for (const c of splitClauses(norm)) {
    const r = scoreClause(c);
    if (r.w > best.w) best = { ...r, clause: c };
  }

  let score = best.w;
  const signals = [...best.notes];
  if (hasQMark) {
    score = 1;
    signals.push('qmark');
  }

  // 长度门槛：单个"嗯""?"不参与
  if ([...stripTail(norm)].length < 2) score = 0;

  return {
    isQuestion: score >= QUESTION_THRESHOLD,
    score: Math.min(1, score),
    signals,
    clause: best.clause,
  };
}

/** 轻量布尔版本，直接替换 wake.ts 里的 QUESTION_HINTS.test(text) */
export function isQuestion(text: string): boolean {
  return detectQuestion(text).isQuestion;
}

// ── 对外：说话对象判定 ────────────────────────────────────────────────

/**
 * 判断"这句话是不是冲着『我』说的"。
 *
 * 群里判"在问她"靠三层证据，按可信度从高到低：
 *   A. 显式：@她 / 引用她 / 叫她的名字 / 第二人称"你"
 *   B. 排他：句子里点名了别人（"老张去不去"）→ 不是在问她
 *   C. 上下文：她刚说完话 / 正在和她对话 / 这人连续发言 → 省略主语默认指向她
 *      （这是补上"吃了吗""在干嘛"这类无标记句的关键）
 */
export function detectAddressee(text: string, ctx: AddresseeContext = {}): AddresseeSignal {
  const raw = String(text ?? '');
  const signals: string[] = [];
  let score = 0;
  let explicit = false;
  const add = (w: number, n: string): void => {
    score += w;
    if (w > 0 && score > 0) signals.push(n);
  };

  // A. 显式指向
  if (SECOND_PERSON.test(raw)) {
    add(0.5, 'second-person');
    explicit = true;
  }
  const names = (ctx.names ?? []).filter(Boolean);
  if (names.length > 0 && names.some((n) => raw.includes(n))) {
    add(0.7, 'name-mention');
    explicit = true;
  }
  if (VOCATIVE_HEAD.test(raw)) add(0.4, 'vocative-head');

  // B. 排他：点名了别人
  const others = (ctx.otherNames ?? []).filter(Boolean);
  const hitOthers = others.filter((n) => raw.includes(n));
  let excluded = false;
  if (hitOthers.length > 0) {
    add(-0.6, `other-name:${hitOthers[0]}`);
    explicit = false;
    excluded = true;
  }

  // C. 上下文
  if (ctx.botSpokeLast) add(0.3, 'bot-spoke-last');
  if (ctx.inConversationWithMe) add(0.25, 'in-conversation');
  if (ctx.sameSpeakerAsLast) add(0.2, 'same-speaker-streak');

  return {
    score: Math.max(0, Math.min(1, score)),
    signals,
    explicit,
    excluded,
  };
}

/** 组合判定：要不要接这句话 */
export interface UtteranceDecision {
  /** 是否疑问句 */
  question: QuestionSignal;
  /** 是否在跟她说 */
  addressee: AddresseeSignal;
  /** 建议：接话 */
  shouldReply: boolean;
  /** 给日志用的原因 */
  reason: string;
}

/**
 * 一条消息 → 要不要接。
 * 规则：
 *  - 明确在跟她说话（点名/你/@/她刚说完）且是问句 → 接
 *  - 明确在跟她说话且只是陈述 → 看场景（默认不接，避免应答器）
 *  - 问句但没指向她 → 只有在"正跟她对话"时才接（省略主语默认指向对话对象）
 *  - 什么都没指向 → 不接
 */
export function classifyUtterance(
  text: string,
  ctx: AddresseeContext = {},
  opts: { replyToStatement?: boolean } = {},
): UtteranceDecision {
  const question = detectQuestion(text);
  const addressee = detectAddressee(text, ctx);

  let shouldReply = false;
  let reason = 'irrelevant';

  if (addressee.explicit && addressee.score >= 0.5) {
    if (question.isQuestion) {
      shouldReply = true;
      reason = 'explicit:question';
    } else if (opts.replyToStatement && addressee.score >= 0.7) {
      shouldReply = true;
      reason = 'explicit:statement';
    } else {
      reason = 'explicit:statement-skip';
    }
  } else if (addressee.excluded) {
    // 明确在问别人（"老张吃了吗"），即使正处于对话窗口也不抢话
    reason = 'excluded:other-addressee';
  } else if (question.isQuestion && ctx.inConversationWithMe) {
    // 省略主语的问句，正在对话中 → 默认指向她
    shouldReply = true;
    reason = 'implicit:conversation-question';
  } else if (question.isQuestion && ctx.botSpokeLast && addressee.score >= 0.3) {
    shouldReply = true;
    reason = 'implicit:bot-spoke-last';
  }

  return { question, addressee, shouldReply, reason };
}
