/**
 * 模型内部独白泄漏护栏
 * ─────────────────────────────────────────────────────────────
 * 2026-11-12 实测：主动播报战绩后的一轮锐评里，模型把自我对话直接写进了正文，
 * 群里收到的是：
 *
 *   「…是真不给人留活路。 also i keep repeating this. Let me vary — but the
 *    instruction says one person only. Actually I already output two lines.
 *    Let me just pick one and be brief. But this is a fresh turn — need to
 *    answer this turn only.小周这幻影刺客…」
 *
 * 成因是模型把 reasoning 混进了 content，出站链路没有任何过滤，humanize 又按
 * 中文句号切分（切不断英文），整段就发出去了。
 *
 * 设计原则：**只按强特征短语定位，不按语言比例判**。
 * 群里正常说英文、或者她引用英文原文，都不该被误伤；只有出现
 * 「let me vary / the instruction says / i already output」这类
 * 典型自我对话时，才把那一小段英文挖掉，前后中文原样保留。
 */

/** 强特征：出现任意一条，基本可以断定是模型的内部独白，不是给用户看的话 */
const MONOLOGUE_PATTERNS: readonly RegExp[] = [
  /\b(?:also\s+)?i\s+keep\s+repeating\b/i,
  /\blet\s+me\s+(?:vary|re-?read|just\s+(?:pick|be|keep|answer|say))\b/i,
  /\bthe\s+instruction\s+says\b/i,
  /\bi\s+already\s+output\b/i,
  /\bneed\s+to\s+answer\s+this\s+turn\b/i,
  /\bthis\s+is\s+a\s+fresh\s+turn\b/i,
  /\b(?:i\s+should|i'll)\s+just\s+pick\b/i,
  /\bone\s+person\s+only\b/i,
  /\bneed\s+to\s+be\s+brief\b/i,
];

const CJK = /[\u4e00-\u9fff]/;
const SENTENCE_END = /[。！？!?…\n]/;

/** 找最靠前的一处命中位置，没有则 -1 */
function firstHit(text: string): number {
  let hit = -1;
  for (const re of MONOLOGUE_PATTERNS) {
    const m = re.exec(text);
    if (m !== null && (hit < 0 || m.index < hit)) hit = m.index;
  }
  return hit;
}

/**
 * 挖掉一处独白：从命中点往前找最近的句末标点，往后找最近的汉字，
 * 中间这段（英文自我对话）整段删除。
 *
 * 之所以不「截断到命中点」：独白常常插在两句中文中间，截断会把后半句
 * 有用的中文一起丢掉。挖掉中段能同时保住前后两截。
 */
function stripOnce(text: string): string | null {
  const hit = firstHit(text);
  if (hit < 0) return null;

  let start = 0;
  for (let i = hit - 1; i >= 0; i -= 1) {
    if (SENTENCE_END.test(text[i] ?? '')) {
      start = i + 1;
      break;
    }
  }

  let end = text.length;
  for (let i = hit; i < text.length; i += 1) {
    if (CJK.test(text[i] ?? '')) {
      end = i;
      break;
    }
  }

  return `${text.slice(0, start)}${text.slice(end)}`.trim();
}

/**
 * 清理出站文本里的模型独白。
 *
 * - 纯英文（没有汉字）原样返回：可能是她正常用英文回话，不碰。
 * - 命中后最多挖 3 处，避免病态输入下反复循环。
 * - 清理后只剩空白则返回空串，由调用方决定丢弃（不要发空消息）。
 */
export function stripModelMonologue(text: string): string {
  const raw = String(text ?? '');
  if (raw === '') return '';
  // 没有汉字就不判：这条护栏只处理「中文正文里混进英文独白」的场景
  if (!CJK.test(raw)) return raw;

  let out = raw;
  for (let i = 0; i < 3; i += 1) {
    const next = stripOnce(out);
    if (next === null) break;
    out = next;
    if (out === '') break;
  }
  return out;
}
