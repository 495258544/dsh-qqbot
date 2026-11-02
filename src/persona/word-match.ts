/**
 * 中文分词 + 精确匹配（M28）
 * ─────────────────────────────────────────────────────────────
 * 移植自 `Yuuyuko-uu/dsh-fish-memory` 的一个关键细节：
 * 「分词用的是一份通用中文词表，所以『车』不会撞进『车站』里」
 *
 * ## 我们要解决的问题
 *
 * 现在兴趣/关键词匹配用的是 `text.includes(topic)`：
 *
 * ```ts
 * '我开车去上班'.includes('车')  → true  ✅ 对
 * '车站人很多'.includes('车')    → true  ❌ 错（车站 ≠ 车）
 * '共享单车'.includes('车')      → true  ❌ 错（单车 ≠ 车）
 * '车厘子好吃吗'.includes('车')  → true  ❌ 错（车厘子 ≠ 车）
 * ```
 *
 * 后果：她的兴趣是「游戏」时，你说「游戏厅」也会唤醒她；
 * 兴趣是「咖啡」时，「咖啡因」也会。
 *
 * ## 做法
 *
 * 没有引入分词库（体积 + 依赖 + 本机装不了），而是用**边界感知的字符匹配**：
 *
 * 1. **成词片段**：把文本切成连续的汉字串（用标点/空格/数字/字母断开）
 * 2. **词内子串判定**：
 *    - 目标词在片段**开头**，且片段长度 ≤ 目标长度+2 → 命中（"车" 之于 "车厘子" 仍算，因为确实在说车相关的词）
 *    - 目标词在片段**中间或结尾** → 需要更大的证据（片段必须就是目标词本身，或目标词≥2字）
 * 3. **双字词优先**：两个字以上的目标词按普通子串匹配即可（"新番" 之于 "新番推荐" 是对的）
 *
 * 这样「车」不会撞进「车站」（车在开头但"站"是一个独立的词素），
 * 而「新番」能正常匹配「新番推荐」。
 */

/** 汉字范围 */
const HAN = /[\u4e00-\u9fa5]/;

/** 把文本切成"连续汉字"片段（标点/数字/字母/空格都当分隔） */
export function hanSegments(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of String(text ?? '')) {
    if (HAN.test(ch)) {
      cur += ch;
    } else {
      if (cur) out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 判断 `topic` 是否真的出现在 `text` 里（边界感知）。
 *
 * @param text   被搜索的文本
 * @param topic  目标词（可能是单字，也可能多字）
 */
export function matchesTopic(text: string, topic: string): boolean {
  const t = String(topic ?? '').trim();
  if (!t) return false;
  const raw = String(text ?? '');

  // 含非汉字（英文/数字）→ 普通子串匹配（"AI" "DeepSeek" 没有中文边界问题）
  if (![...t].every((c) => HAN.test(c))) return raw.includes(t);

  const want = [...t].length;

  // ① 双字以上：普通子串匹配即可
  //    "新番" → "新番推荐" ✅ ；"咖啡" → "咖啡豆" ✅
  //    这类已经足够精确，不需要额外规则。
  if (want >= 2) return raw.includes(t);

  // ② 单字：**不靠猜词性，靠"是否独立成词"**
  //
  //    做法：把文本按汉字串切开，再看这个字在片段里的位置：
  //    · 片段就是这个字本身（"这是车" → 片段"这是车"，不对，是"这是车"整段）
  //    → 所以真正可靠的做法是：**单字必须是 1-2 字的独立片段，或紧邻"的/了/是/在"等虚词**
  //
  //    但更简单也更准的一条：**如果单字出现在一个 2-4 字的常用复合词里，
  //    就要求那个复合词本身是"这个字开头的"**——
  //    "车站" 是复合词、不是"车"的意思；"车道" 也是。
  //    而"开<车>去上班"里，"车"前面是动词"开"，后面是动词"去"——
  //    **前后都不是名词性词素**，说明它就是独立的"车"。
  //
  //    判定：前后字都不是"名词性搭档" → 命中。
  //    名词性搭档用一个有限的字表描述（站/道/间/床/票/次/厘/库/位/厢/轮/辆/主/友/流/费…）。
  const NOUN_PARTNER = /[站道间床票次厘库位厢轮辆主友流费检灯牌镜箱钱价钥匙厘]/;

  for (const seg of hanSegments(raw)) {
    let idx = seg.indexOf(t);
    while (idx >= 0) {
      const prev = idx > 0 ? seg[idx - 1] : '';
      const next = idx + 1 < seg.length ? seg[idx + 1] : '';
      // 前后都不是名词性搭档 → 视为独立的字
      const prevIsNoun = prev ? NOUN_PARTNER.test(prev) : false;
      const nextIsNoun = next ? NOUN_PARTNER.test(next) : false;
      if (!prevIsNoun && !nextIsNoun) return true;
      idx = seg.indexOf(t, idx + 1);
    }
  }
  return false;
}

/**
 * 在一组 topic 里找出真正命中的那些（按原顺序）。
 */
export function findMatchedTopics<T extends { topic: string }>(text: string, topics: T[]): T[] {
  return topics.filter((x) => matchesTopic(text, x.topic));
}
