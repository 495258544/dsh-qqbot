/**
 * 自主冲浪（M6）— 低峰时段上网搜集她感兴趣的内容
 * ─────────────────────────────────────────────────────────────
 * 分层设计（子代理实测验证）：
 *   Layer 0  宿主 web 服务（ctx.web.search）—— **首选**。
 *            走 dsh-free-search 注册的 provider（27 个引擎 + 空结果自动 fallback）。
 *            为什么必须排在最前：见下面「Bing RSS 的中文断词坑」。
 *   Layer 1  Bing RSS（**兜底**，521ms，10 条结构化结果，无反爬/无乱码）
 *            curl -sL "https://cn.bing.com/search?q=<词>&format=rss"
 *   Layer 2  ego-browser 抓正文（要深度见闻时用，冷启2.4s/热复用1.0s）
 *   Layer 3  备用 RSS 源（机核/少数派/B站番剧/知乎日报/HN）
 *
 * ## Bing RSS 的中文断词坑（2026-11-05 实测，这是加 Layer 0 的直接原因）
 *
 *   「手冲咖啡的细节参数」→ 10 条**全是「手」字的字典释义**
 *     （百度百科·汉语文字 / 汉典 / 汉语国学 / 字典网 …）
 *   「手冲咖啡参数」（缩短两个字）→ **依然全是字典页**
 *   「咖啡萃取水温多少合适」→ 正常
 *
 *   规律：Bing 的中文分段把「手冲咖啡」切成了「手」，**首字权重压过整词**。
 *   关键结论：`isMeaningful` 挡不住这种结果 —— 标题长度 > 8、描述 > 40 字，
 *   形态上完全像正常结果。**过滤层修不了搜索结果本身**，只能换搜索源。
 *   同一个查询走 ctx.web（auto 路由）拿到的是粉水比/水温/研磨度全套真教程。
 *
 * 关键设计：冲浪结果**只写摘要**（100字内），不把原始 HTML 塞进上下文。
 * 结果落盘到 self.json 的 findings，主上下文零消耗。
 *
 * 时段（用户确认）：凌晨 3:00–7:00
 *   - 亮屏：可随意玩
 *   - 息屏：只能走 curl / ego-browser（虚拟屏1分钟后也会黑）
 */
import { execFileSync } from 'node:child_process';
import type { SelfProfileService } from './self.ts';
import { DEFAULT_TZ, hourInTz, isHourInRange } from './clock.ts';

/** ego-browser 入口（vendored Linux 版，package.json 无 bin 字段） */
const EGO_BIN =
  '/root/.dsh/profiles/web/node_modules/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs';
/** root 下必须用的 chrome wrapper（否则 --no-sandbox 缺失会假装 DevTools 超时） */
const EGO_CHROME =
  '/root/.dsh/profiles/web/node_modules/dsh-ego-browser/bin/ego-chrome-wrapper.sh';

/**
 * 宿主 web 搜索的最小接口（只取我们要用的那一个方法）。
 *
 * 结构对齐 `ctx.web.search(request, signal)`：按 searchProvider 配置解析 provider，
 * `sources[]` 每条含 url/title/snippet/publishedAt。写成结构化最小接口而不是
 * import 宿主包，是为了让 surf.ts 在单测里能直接注入一个假实现（不装宿主也能测）。
 */
export interface WebSearchLike {
  search(
    /**
     * `engine` 是 dsh-free-search 认的字段：它**优先于 profile 的 `cfg.provider`**。
     *
     * 为什么必须显式传（2026-11-05 实测踩的坑）：
     *   profile 里写的是 `web.searchProvider: ddg`，而 ddg 在这台机器上**完全不可达**
     *   （curl 两条路都 0 字节）。只传 query 时，free-search 回落到 `cfg.provider`=ddg
     *   → 失败退到 Bing → 返回的全是「手」的字典页，跟没改一样。
     *   传 `engine: 'auto'` 走它的智能路由（语言/时间规则分组 + 全引擎 fallback 链），
     *   才会像 web_search 工具那样自动绕到能通的引擎（实测 exa 可用）。
     */
    request: { query: string; maxResults?: number; engine?: string },
    signal?: AbortSignal,
  ): Promise<{ sources: Array<{ url: string; title?: string; snippet?: string; publishedAt?: string }> }>;
}

/** 一条冲浪成果 */
export interface SurfFinding {
  title: string;
  url: string;
  /** 摘要（≤100字） */
  summary: string;
}

/** 一轮冲浪结果 */
export interface SurfResult {
  topic: string;
  findings: SurfFinding[];
  /** 用的哪一层 */
  layer: 'web' | 'bili' | 'rss' | 'browser' | 'none';
  error?: string;
}

/** Bing RSS 条目 */
interface RssItem {
  title: string;
  link: string;
  description: string;
}

/** 去掉 XML 标签 + 实体转义 */
function stripXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Layer 0：走宿主的 web 搜索（ctx.web.search）。
 *
 * 为什么这是首选而 Bing RSS 降为兜底 —— 2026-11-05 实测的中文断词坑：
 *   「手冲咖啡的细节参数」→ Bing RSS 10 条全是「手」字的字典释义；
 *   「手冲咖啡参数」（只缩两个字）→ **依然全是字典页**；
 *   「咖啡萃取水温多少合适」→ 正常。
 * 规律是 Bing 把「手冲咖啡」切成了「手」，首字权重压过整词。
 * 而 `isMeaningful` 挡不住：那些字典页标题 >8 字、描述 >40 字，形态完全像正常结果。
 * **过滤层修不了搜索结果本身**，只能换搜索源 —— 同一 query 走 ctx.web
 * （auto 路由 + 空结果自动 fallback）拿到的是粉水比/水温/研磨度全套真教程。
 *
 * 返回 null 表示"这一层不可用/没结果"，调用方继续往下走（B站 → Bing RSS），
 * 所以宿主 web 服务缺失（单测、纯 CLI）时行为与原来完全一致。
 */
export async function searchViaWeb(
  web: WebSearchLike | undefined,
  topic: string,
  opts: { maxResults?: number; intent?: QueryIntent; timeoutMs?: number } = {},
): Promise<RssItem[] | null> {
  if (!web || typeof web.search !== 'function') return null;
  const maxResults = opts.maxResults ?? 10;
  const intent = opts.intent ?? 'experience';
  const timeoutMs = opts.timeoutMs ?? 15000;
  try {
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), timeoutMs);
    // engine:'auto' 是关键 —— 见 WebSearchLike 的注释：
    // 不传就会回落到 profile 的 cfg.provider（本机是 ddg，不可达）→ 退回 Bing → 字典页。
    const res = await web.search({ query: topic, maxResults, engine: 'auto' }, timer.signal);
    clearTimeout(t);
    const sources = res?.sources ?? [];
    if (sources.length === 0) return null;
    const items: RssItem[] = sources
      .filter((s) => typeof s?.url === 'string' && s.url !== '')
      .map((s) => ({
        title: String(s.title ?? '').trim() || s.url,
        link: s.url,
        description: String(s.snippet ?? '').trim(),
      }));
    // 仍过一遍原有质量闸：web provider 也会掺百科/导航（概念型查询放行）。
    // 阈值用 web 口径（12 字）：ctx.web 的 snippet 是短摘要，不是 RSS 的整段富文本，
    // 沿用 40 会把所有结果误杀（实测导致本层恒返回 null，白白退回 Bing）。
    const kept = items.filter((it) => isMeaningful(it, intent, 12));
    return kept.length > 0 ? kept : null;
  } catch {
    // 宿主没装 provider / provider 报错 → 交给下一层，不影响冲浪
    return null;
  }
}

/**
 * Layer 1：Bing 搜索结果 RSS。
 *
 * ⚠️ 现在是**兜底层**（Layer 0 走宿主 web 搜索）。保留它是因为：
 * 宿主 web 服务不可用（纯 CLI、单测、provider 全挂）时冲浪不能直接死掉。
 *
 * 已知局限（2026-11-05 实测）：中文长尾查询会被 Bing 断成单字 →
 * 返回全是该字的字典释义，且形如正常结果、`isMeaningful` 拦不住。
 * 所以这条路只在 Layer 0 不可用时才走，且建议配合 refineQuery 用短核心词。
 */
export function fetchBingRss(topic: string, timeoutMs = 15000, intent: QueryIntent = 'experience'): RssItem[] {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(topic)}&format=rss`;
  const xml = execFileSync('curl', ['-sL', '--max-time', String(Math.floor(timeoutMs / 1000)), url], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const items: RssItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1] ?? '';
    const title = stripXml((block.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '');
    const link = stripXml((block.match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? '');
    const desc = stripXml((block.match(/<description>([\s\S]*?)<\/description>/) ?? [])[1] ?? '');
    if (title) items.push({ title, link, description: desc });
  }
  return items.filter((it) => isMeaningful(it, intent));
}

/**
 * Layer 0：真的刷 B 站（M36）。
 *
 * ## 为什么需要这一层
 *
 * 原来 surf 只有一条路：Bing RSS 搜网页。对"咖啡""AI 技术"这类泛话题够用，
 * 但小羽的兴趣经常是**视频型**的（新番、游戏新作、UP 主的连载），
 * 用 Bing 搜出来的是百科和导航页 —— 而 B 站的 `hot popular/weekly`
 * 就是"首页推荐"的等价物，免登录、零 token、还带官方推荐理由（"百万播放"）。
 *
 * ## 为什么不直接用 `feed recommend`
 *
 * `recommend` 是**为当前 bili 账号个性化**的，但那个账号是 level 0 的新号
 * （实测 `bili_91077024781`，投稿 0、关注 0），推荐质量等于没有。
 * `hot popular` 是全站热门，虽然不个性化，但至少是真的"B 站在推什么"。
 *
 * ## 触发条件
 *
 * 不是所有话题都该走 B 站 —— "咖啡"应该查经验帖，"新番"才该刷 B 站。
 * 所以用一个保守的关键词表：命中才走 B 站，否则仍然走 Bing。
 * 宁可漏（走 Bing 也不会错），不要错（把咖啡刷成 B 站视频）。
 */
const BILI_TOPIC_RE = /(番|动画|动漫|游戏|实况|攻略|评测|手书|MMD|鬼畜|UP主|up主|视频|纪录片|电影|剧|音乐|MV|唱见|V家|虚拟主播|VUP|直播|B站|b站)/;

function biliHot(topic: string, timeoutMs: number): Array<{ title: string; bvid: string; reason: string }> {
  // 先试关键词搜索（更贴近话题），失败再退到全站热门
  const tryRun = (args: string[]): Array<{ title: string; bvid: string; reason: string }> => {
    const r = JSON.parse(
      execFileSync('bili', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }),
    ) as { ok?: boolean; data?: { items?: Array<{ title?: string; bvid?: string; reason?: string }> } };
    if (!r?.ok) return [];
    return (r.data?.items ?? [])
      .filter((x) => x.bvid && x.title)
      .map((x) => ({ title: String(x.title), bvid: String(x.bvid), reason: String(x.reason ?? '') }));
  };
  try {
    const byKeyword = tryRun(['search', 'video', topic, '--size', '10']);
    if (byKeyword.length) return byKeyword;
  } catch {
    /* 搜索失败不影响兜底 */
  }
  try {
    return tryRun(['hot', 'popular']);
  } catch {
    return [];
  }
}

/**
 * 结果质量过滤（M26）。
 *
 * 实测问题（2026-11-02）：抓回来的"见闻"是 SEO 垃圾 ——
 *   [咖啡] → "咖啡（百度百科）"、"咖啡推荐：分不清意式、美式…"
 *   [AI]  → "AI工具集官网 | 1000+ AI工具集合"、"阿里云AI"
 *   [游戏] → "Poki 在线游戏"、"TapTap 今日游戏"
 * 这些是导航站/百科首页，**内容量为零**，她拿去聊天只能说空话。
 *
 * 判据（宁可少留，不留垃圾）：
 *   ① 标题像导航/聚合页 → 丢
 *   ② 域名是百科/导航 → 丢
 *   ③ 描述太短（少于 40 字）说明只是标题堆砌 → 丢
 */
/**
 * 把裸关键词加工成"更容易搜到真内容"的查询。
 *
 * 原则：只加"人写的东西"的标记词，不改原意。
 * 如果一个词已经有这类修饰，就不重复加。
 */
/**
 * 从"口语化长话题"里提取可搜索的核心词（M36）。
 *
 * 踩过的坑（2026-11-03）：她的兴趣被记成「把小事讲得很慢的散文和随笔」，
 * 拿去搜索时，搜索引擎把整句拆成单字「把」，返回的是
 * 「把的意思,把的解释,把的拼音-汉语国学」—— 完全无关的字典页。
 *
 * 判据：话题超过 12 字且含口语连接词（的/和/很/把/讲/…) 时，
 * 提取其中的**名词性实词**（散文、随笔），丢掉修饰和虚词。
 */
export function coreKeywords(topic: string): string {
  const t = String(topic ?? '').trim();
  if ([...t].length <= 12) return t;   // 短话题不用处理

  // 口语虚词：整句里出现这些，说明不是术语而是描述
  const COLLOQUIAL = /(?:把|讲得|得很|那种|的事儿|东西)/;
  if (!COLLOQUIAL.test(t)) return t;

  // 按虚词/连接词切开，留下实词块
  const parts = t
    .split(/[的把和与讲得了是很那种]+/)
    .map((w) => w.trim())
    .filter((w) => [...w].length >= 2);

  // 只留最后 2 个（口语描述里核心名词通常在后半段：散文、随笔）
  const core = parts.slice(-2);
  return core.length > 0 ? core.join(' ') : t;
}

export function refineQuery(topic: string): string {
  // M36：先把口语化长句压成核心词，否则会搜出单字字典页
  const t = coreKeywords(String(topic ?? '').trim());
  if (!t) return t;
  // 概念型查询**不加**"经验 心得" —— 否则会把百科挤掉，
  // 而查"什么是X"时百科恰恰是最佳来源（用户指出过这个坑）。
  if (queryIntent(t) === 'concept') return t;
  const ALREADY = /(经验|心得|推荐|攻略|怎么|如何|教程|评测|分享|讨论)/;
  if (ALREADY.test(t)) return t;
  return `${t} 经验 心得`;
}

/**
 * 查询意图：决定"百科/词条"该不该留。
 *
 * 踩过的坑（2026-11-02，用户指出）：我原来把百科域名一刀切进黑名单，
 * 结果「量子纠缠」「什么是通货膨胀」这类**正需要百科**的查询也被挡了。
 *
 * 正确的做法是按查询意图分类，而不是按域名判死刑。
 */
export type QueryIntent = 'concept' | 'experience';

/** 概念/定义型查询（该允许百科、词条、维基） */
export function queryIntent(topic: string): QueryIntent {
  const t = String(topic ?? '');
  // ① 明确的"求解释"信号 → concept
  if (/(是什么|什么是|的定义|定义|含义|意思|原理|区别|为什么|怎么解释|科普)/.test(t)) return 'concept';
  // ② 明确的"求经验"信号 → experience
  if (/(经验|心得|推荐|攻略|评测|怎么用|怎么选|哪个好|入坑|避雷)/.test(t)) return 'experience';
  // ③ 裸关键词：默认按 experience 处理
  //
  // 这里踩过一次坑（2026-11-02）：原来把裸词判成 concept ，
  // 于是「咖啡」不加修饰词、直接搜百科和导航 —— 正是要治的问题。
  // 实践上，人搜一个裸词通常是"想看看别人怎么说"，
  // 真的想查定义时会带"是什么/原理"这类词（被 ① 捕获）。
  return 'experience';
}

/**
 * 结果质量闸。**阈值随数据源自适应** —— 这是 2026-11-05 踩出来的坑：
 *
 * - Bing RSS 的 `<description>` 是**整段富文本摘要**，实测 83~143 字；
 * - 宿主 `ctx.web` 的 `snippet` 是**一句话短摘要**，通常 15~30 字。
 *
 * 原来统一按 `desc >= 40 字` 卡，接上 ctx.web 之后**所有结果都被误杀**，
 * `searchViaWeb` 恒返回 null、自动退回 Bing RSS —— 等于新功能上线即失效
 * （和 DESIGN-PERSONA §16.5 警告的"接线通了但跑不通"一模一样）。
 * 所以把最短正文要求做成参数：RSS 用 40，web snippet 用 12。
 */
export function isMeaningful(
  item: { title: string; link: string; description?: string },
  intent: QueryIntent = 'experience',
  /** 正文最少字数（RSS 富文本传 40，web snippet 传 12，默认按 RSS 口径） */
  minDescChars = 40,
): boolean {
  const title = String(item.title ?? '');
  const link = String(item.link ?? '');
  const desc = String(item.description ?? '');

  // ① 导航/聚合型标题 —— 永远不要（这类页面没有内容量）
  const JUNK_TITLE = /(官网|导航|大全|首页|聚合|工具集|网址大全|下载站|专题页)/;
  if (JUNK_TITLE.test(title)) return false;

  // ② 纯导航站域名 —— 永远不要
  const NAV_DOMAIN = /(poki\.com|playhop|taptap\.cn\/app-calendar|ai-bot\.cn|\/tag\/|\/list\/|\/category\/)/i;
  if (NAV_DOMAIN.test(link)) return false;

  // ③ 百科/词条：**只有概念型查询才允许**
  //    （查"什么是通货膨胀"时百科就是最佳答案；查"咖啡推荐"时百科没用）
  const WIKI_DOMAIN = /(baike\.baidu\.com|zhidao\.baidu\.com|wikipedia\.org|wiki)/i;
  if (WIKI_DOMAIN.test(link) && intent !== 'concept') return false;

  // ④ 描述太短 = 只有标题没有正文
  //    概念型查询再放宽一点（百科摘要通常更短）
  const minDesc = intent === 'concept' ? Math.min(minDescChars, 25) : minDescChars;
  if (desc.replace(/\s+/g, '').length < minDesc) return false;

  // ⑤ 标题就是个裸关键词
  //    web snippet 场景标题往往更短（"手冲参数对照表" 7 字），放宽到 5
  const minTitle = minDescChars < 40 ? 5 : 8;
  if (title.replace(/\s+/g, '').length < minTitle) return false;

  return true;
}

/**
 * Layer 2：用 ego-browser 抓某个 URL 的正文（返回纯文本，截断）。
 * 前置：EGO_LINUX_HEADLESS=1 + EGO_LINUX_CHROME=wrapper，否则必失败。
 */
export function fetchPageText(url: string, maxChars = 2000, timeoutMs = 120000): string {
  const q = JSON.stringify(url);
  const script = `
await taskSpaces.useOrCreate('surf')
await page.goto(${q}, {wait:true})
await page.waitForTimeout(400)
const body = await page.evaluate('document.body.innerText.slice(0, ${Number(maxChars)})')
console.log(JSON.stringify({body}))
`;
  const out = execFileSync('node', [EGO_BIN], {
    input: script,
    env: { ...process.env, EGO_LINUX_HEADLESS: '1', EGO_LINUX_CHROME: EGO_CHROME },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  try {
    const parsed = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { body?: string };
    return (parsed.body ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/** 把一段正文压缩成 ≤100 字摘要（不调模型，纯抽取式，零成本） */
function abstract(text: string, max = 100): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  // 优先在句号/句末标点处截断，读起来更自然
  const cut = clean.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('.'));
  return lastStop > max * 0.6 ? cut.slice(0, lastStop + 1) : `${cut}…`;
}

/**
 * 冲浪一个话题：宿主 web 搜索（Layer 0）→ B 站（视频型）→ Bing RSS（兜底）
 * → 挑第 1 条抓正文 → 组合成见闻。
 * deep=true 时才跑 ego-browser（更慢但内容更实）。
 *
 * 改为 async 是因为 Layer 0 走 `ctx.web.search`（异步接口）。
 * 同步的 Bing RSS 仍保留在调用链里做兜底，所以 web 服务缺失时行为不变。
 */
export async function surfTopic(
  topic: string,
  opts: { deep?: boolean; maxFindings?: number; web?: WebSearchLike } = {},
): Promise<SurfResult> {
  const maxFindings = opts.maxFindings ?? 2;
  try {
    // 查询词加工（M26）：
    // 直接用「咖啡」搜出来的是百科和导航；加「经验/心得/推荐/攻略」这类词，
    // 结果才会偏向真实用户写的长文——实测「咖啡推荐：分不清意式…」这种
    // 百科式列表就会沉下去，换成知乎/博客的实际经验帖。
    const refined = refineQuery(topic);
    const intent = queryIntent(topic);

    // M36 Layer 0（视频型先走 B 站）：这才是"刷 B 站"，不是在网页上搜 B 站
    if (BILI_TOPIC_RE.test(topic)) {
      const vids = biliHot(topic, 20000);
      if (vids.length) {
        const findings: SurfFinding[] = vids.slice(0, maxFindings).map((v) => ({
          title: v.title,
          url: `https://www.bilibili.com/video/${v.bvid}`,
          // 官方推荐理由（"百万播放"）比我们编的摘要可信
          summary: v.reason ? `[B站·${v.reason}] ${v.title}` : `[B站] ${v.title}`,
        }));
        return { topic, findings, layer: 'bili' };
      }
      // B 站没拿到就继续往下走，不直接失败
    }

    // Layer 0：宿主 web 搜索（27 引擎 + 自动 fallback）。
    // 放在 Bing RSS 之前，专治「手冲咖啡」被断成「手」的字典页问题。
    const viaWeb = await searchViaWeb(opts.web, refined, { maxResults: 10, intent });
    if (viaWeb !== null && viaWeb.length > 0) {
      const findings: SurfFinding[] = viaWeb.slice(0, maxFindings).map((it) => ({
        title: it.title,
        url: it.link,
        summary: abstract(it.description || it.title),
      }));
      if (opts.deep && findings.length > 0) {
        try {
          const first = findings[0];
          if (first) {
            const text = fetchPageText(first.url);
            if (text) first.summary = abstract(text);
          }
        } catch {
          /* 抓正文失败就用列表摘要，不中断 */
        }
      }
      return { topic, findings, layer: 'web' };
    }

    // Layer 1（兜底）：Bing RSS
    const items = fetchBingRss(refined, 15000, intent);
    if (items.length === 0) {
      return { topic, findings: [], layer: 'none', error: 'web 与 Bing RSS 均无结果' };
    }
    const findings: SurfFinding[] = items.slice(0, maxFindings).map((it) => ({
      title: it.title,
      url: it.link,
      summary: abstract(it.description || it.title),
    }));

    // 深度模式：抓第一条的正文，补一个更实的摘要
    if (opts.deep && findings.length > 0) {
      try {
        const first = findings[0];
        if (first) {
          const text = fetchPageText(first.url);
          if (text) first.summary = abstract(text);
        }
      } catch {
        /* 抓正文失败不影响已有摘要 */
      }
    }
    return { topic, findings, layer: 'rss' };
  } catch (err) {
    return { topic, findings: [], layer: 'none', error: err instanceof Error ? err.message : String(err) };
  }
}

/** 现在是否在冲浪时段（默认凌晨 3:00–7:00，**按北京时间**，启动时未设 TZ） */
export function inSurfWindow(now = new Date(), from = 3, to = 7, tz = DEFAULT_TZ): boolean {
  return isHourInRange(hourInTz(now, tz), from, to);
}

/**
 * 跑一轮冲浪：按 self.json 里权重最高的兴趣逐个冲，结果写回 findings。
 * 返回这一轮收集到的内容（供上层决定要不要告知用户）。
 */
export async function runSurfRound(
  self: SelfProfileService,
  opts: { maxTopics?: number; deep?: boolean; log?: (m: string) => void; web?: WebSearchLike } = {},
): Promise<SurfResult[]> {
  const maxTopics = opts.maxTopics ?? 2;
  // M30：不追自己讨厌的东西。
  // 场景：兴趣里同时有「短视频」，厌恶里后来也记了「短视频」（她自己烦了）——
  // 纯按兴趣权重排序会继续半夜去搜她讨厌的内容，这种自相矛盾在这里掐掉。
  const hated = new Set(self.topDislikes(20).map((d) => d.topic));
  const topics = self
    .topInterests(maxTopics + hated.size)
    .filter((i) => i.weight >= 0.3 && !hated.has(i.topic))
    .slice(0, maxTopics);
  if (topics.length === 0) {
    opts.log?.('surf: 没有足够权重的兴趣，这轮跳过');
    return [];
  }
  const results: SurfResult[] = [];
  for (const t of topics) {
    const r = await surfTopic(t.topic, { deep: opts.deep, web: opts.web });
    opts.log?.(`surf: 「${t.topic}」${r.layer} 拿到 ${r.findings.length} 条${r.error ? `（${r.error}）` : ''}`);
    // 写回 findings（只存摘要，不存原始正文）
    for (const f of r.findings) {
      self.addFinding(t.topic, `[${f.title}] ${f.summary}`, f.url);
    }
    results.push(r);
  }
  return results;
}
