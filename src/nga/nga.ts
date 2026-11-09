/**
 * NGA 艾泽拉斯国家地理 —— 只读浏览客户端（游客态优先，凭证可选）
 * ─────────────────────────────────────────────────────────────
 * 为什么自建而不是装现成 MCP（2026-11-08 实测调研结论）：
 *   GitHub 上只有两个沾边的（yixiaowang2001/nga-mcp-server 8★、beckyeeky/nga-hub-skill 0★），
 *   前者依赖 playwright + chromium（容器里没装，还会另起一个浏览器进程），
 *   后者要**登录后的** ngaPassportCid。她本来就有 ego 浏览器，再塞一份 Playwright 是纯负担。
 *   而 NGA 的 JSON 接口其实裸 fetch 就能打 —— 实测见下。
 *
 * ## 实测出来的三条硬事实（2026-11-08，逐条 curl 验过）
 *
 * 1. **没有 X-User-Agent 会吃 code=46「游客不能直接访问」**
 *    `POST app_api.php?__lib=post&__act=list` 不带这个头 → `{"code":46,...}`；
 *    带上 `X-User-Agent: NGA_skull/7.3.1(iPhone17,1;iOS17.0)` → `{"code":0, msg:"操作成功"}`。
 *    这是官方 APP 的标识，缺了它服务端就当你是可疑游客。**别"优化"掉这一行。**
 *
 * 2. **不需要 cookie 也不需要账号：guest_token 自己会发**
 *    上面那次 46 的响应里就带着 `guest_token: "guest06af078522768a"`。
 *    把它追加到 query（`&guest_token=...`）再请求，**不带任何 cookie** 也能拿到 code=0、
 *    50 条主题、12 层楼。也就是说游客态完全可用，凭证只影响"搜索/收藏/发帖"这类要登录的动作。
 *    （自身把自己发的 token 复用，所以这个模块对没有凭证的部署也是零配置可用的。）
 *
 * 3. **搜索不走 `nuke.php?__lib=search`，走 `thread.php`**
 *    `__lib=search&__act=*` 实测全是 `ACTION NOT FOUND`（网页版 `search.php`
 *    只给百度/谷歌外链）。真正的站内搜索参数在**官方客户端源码**里
 *    （`Justwen/NGA-CLIENT-VER-OPEN-SOURCE` 的 `TopicListModel.getUrl()`）：
 *
 *      thread.php?key=<关键词>&content=1&page=N&lite=js&noprefix
 *                [&fid=<版面>] [&fidgroup=<版面组>] [&searchpost=1] [&author=<作者>]
 *
 *    我一开始拿 `q=` / `func=search` 去试，全被忽略（回的就是普通列表面），
 *    于是误判成"NGA 没有站内搜索"。**参数名是 `key`，不是 `q`。**
 *    实测三种模式有真实差异：仅标题 33 条 / 含正文 34 条 / 版面限定 35 条。
 *    `lite=js` 返回 **GBK 编码的 JSON**，主题在 `data.__T`（`{序号: 帖子}` 字典）。
 *
 * ## 边界（有意为之）
 *
 * - **只读**。不实现发帖/回帖/点赞：她自己有 bash 和 ego 浏览器，真要动账号得走
 *   用户的明确同意，不该藏在一个 `qq_nga` 工具里。
 * - **不发自己的 cookie**。凭证只从 `~/.dsh-qqbot/nga/credentials.json` 读，
 *   由用户在浏览器里登录后人工落盘；文件不存在 = 游客态，功能照常。
 * - NGA 对突发流量敏感（社区实现普遍用 330ms 间隔）。这里做了两件事：
 *   单 host 串行化 + 最小间隔，避免她一次读多个帖子把 IP 打进黑名单。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** NGA 官方 APP 的 User-Agent，**带着它才不算"游客不能直接访问"** */
const NGA_X_UA = 'NGA_skull/7.3.1(iPhone17,1;iOS17.0)';

/** 浏览器 UA，服务端会看 Referer/UA 组合 */
const NGA_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const NGA_BASE = 'https://bbs.nga.cn';

/** 相邻两次请求的最小间隔（ms）。NGA 对突发敏感，第三方实现都用这个量级 */
const MIN_INTERVAL_MS = 330;

/** 默认目录：~/.dsh-qqbot/nga */
export function defaultNgaDir(): string {
  return join(homedir(), '.dsh-qqbot', 'nga');
}

// ────────────────────────────────────────────────────────────────
// 凭证
// ────────────────────────────────────────────────────────────────

/**
 * 登录凭证。**只有这两个 cookie**，没有密码。
 * 用户自己在浏览器里登录 NGA 后，从 DevTools 复制名字进来即可。
 */
export interface NgaCredentials {
  /** ngaPassportUid，形如 12345678（游客是 guest 开头） */
  uid: string;
  /** ngaPassportCid，形如 xxxxxxxxxxxxxxxx */
  cid: string;
}

/** 从磁盘读凭证；不存在或形状不对 → undefined（=游客态，不算错误） */
export function loadCredentials(dir = defaultNgaDir()): NgaCredentials | undefined {
  const file = join(dir, 'credentials.json');
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<NgaCredentials>;
    const uid = String(raw.uid ?? '').trim();
    const cid = String(raw.cid ?? '').trim();
    if (!uid || !cid) return undefined;
    return { uid, cid };
  } catch {
    return undefined;
  }
}

// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export interface NgaTopic {
  tid: number;
  subject: string;
  author: string;
  authorId: number;
  replies: number;
  /** NGA 返回的是 unix 秒 */
  lastPostAt: number;
}

export interface NgaFloor {
  lou: number;
  author: string;
  postDate: string;
  /** BBCode 原文 → 已转纯文本 */
  content: string;
  /** 这层楼的楼中楼（只保留前几条，防爆） */
  comments: Array<{ author: string; content: string }>;
}

export interface NgaThread {
  tid: number;
  subject: string;
  forumName: string;
  totalPage: number;
  currentPage: number;
  /**
   * 总楼层数（服务端 `__ROWS`）。
   *
   * 坑 4.2：`totalPage` 是页数，而她常问"这帖一共多少楼"。
   * 两个数是不同的东西 —— 混用会导致"第 300 楼"算错页。
   */
  totalFloors?: number;
  /** 每页楼层数（服务端 `__R__ROWS_PAGE`，实测 20） */
  perPage?: number;
  floors: NgaFloor[];
}

export interface NgaTopicList {
  fid: number;
  forumName: string;
  totalPage: number;
  topics: NgaTopic[];
}

/** 搜索选项 —— 参数名对齐官方客户端 `TopicListModel.getUrl()` */
export interface NgaSearchOptions {
  /**
   * 限定版面（fid）。**不传 = 搜全站**。
   *
   * 为什么默认给版面、但允许全站：版面内搜又快又准（她要「这版最近聊什么」时
   * 版面限定就够了）；全站搜覆盖广但噪音大、也更容易撞限流。
   * 两者价格一样（都是同一次 HTTP 请求），差别在谁更容易找到。
   */
  fid?: number;
  /** 限定版面组（fidgroup）。"搜索全站"在客户端里就是靠它 */
  fidGroup?: string;
  /** 页码，从 1 开始 */
  page?: number;
  /**
   * 搜索是否包含**正文**（content=1）。
   *
   * 实测差异真实存在：同一个词「结算」仅标题 33 条、含正文 34 条 ——
   * 多出来的那条正文里提到了词但标题没有。默认 true：她要找"有没有人聊过 X"，
   * 只搜标题会漏掉大量实际讨论。
   */
  withContent?: boolean;
  /**
   * 搜**回复**而不是主题（searchpost=1）。
   * 用它回答"有没有人在评论里提到过 X"。
   */
  searchPost?: boolean;
  /** 只看某位作者（按用户名） */
  author?: string;
}

/**
 * 常用版面表 —— 全部**实测验证过**（2026-11-09 用 `thread.php?fid=N` 的页面标题认名）。
 *
 * 为什么内置一张表，而不是让她去"列出版面目录"：
 *   NGA **没有**版面目录接口（`__lib=forum&__act=list` 等实测全是
 *   `未定义服务` / `ACTION NOT FOUND`）。她第一次用 `{"action":"list"}`
 *   想"看看有哪些版"，只能拿到一句"需要 fid"，然后就卡住了。
 *   把常用的十个版钉在这里，她至少有个可用的起点，也知道 fid 是数字。
 *
 * 这**不是**完整目录（NGA 有上千个版），只是"确定能用的那一小撮"。
 * 表里没有的版，让她 list 试一次就知道对不对 —— 版面名会从页面标题自动解析。
 */
export interface NgaForum {
  fid: number;
  name: string;
  /** 一句话说明这版在聊什么（给她判断"我要去这儿吗"） */
  about: string;
}

export const KNOWN_FORUMS: readonly NgaForum[] = [
  { fid: -608808, name: '恩基爱厨艺美食交流', about: '做饭、家常菜、食材、厨房经验' },
  { fid: 436, name: '消费电子 IT新闻', about: '手机、电脑、硬件、数码新品' },
  { fid: 843, name: '国际新闻', about: '国际时事（注意立场嘈杂）' },
  { fid: -8725919, name: '小窗视界', about: '摄影、旅行、看世界' },
  { fid: 847, name: '历史研究', about: '历史讨论' },
  { fid: 524, name: '漩涡书院', about: '网络文学、小说讨论' },
  { fid: -202020, name: '一只IT喵的自我修养', about: '程序员职业交流、技术吐槽' },
  { fid: 7, name: '艾泽拉斯议事厅', about: '魔兽世界主版' },
  { fid: 621, name: '狂野模式讨论', about: '炉石传说狂野模式' },
  { fid: 255, name: '团队管理经验交流专区', about: '团队管理、管理经验' },
];

/** 搜索结果：主题列表 + 用于告诉她"还有多少"的总量 */
export interface NgaSearchResult {
  keyword: string;
  /** 本次实际搜的范围（用于如实告诉她"我只在版 X 里搜了"） */
  scope: NgaSearchScope;
  totalPage: number;
  topics: NgaTopic[];
}

export type NgaSearchScope =
  | { kind: 'forum'; fid: number }
  | { kind: 'fidGroup'; fidGroup: string }
  | { kind: 'site' }
  | { kind: 'author'; author: string };

export type NgaErrorKind =
  | 'network'
  | 'timeout'
  | 'server'
  | 'guest-denied'   // code 46：连游客态都不给（多半是 IP 被限或 UA 被识别）
  | 'not-found'      // code 56 / 版面或帖子不存在、无权限
  | 'bad-response'   // 2xx 但形状不是预期
  | 'bad-request';   // 调用方参数非法

export class NgaError extends Error {
  readonly kind: NgaErrorKind;
  readonly status?: number;
  readonly ngaCode?: number;

  constructor(kind: NgaErrorKind, message: string, status?: number, ngaCode?: number) {
    super(message);
    this.name = 'NgaError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (ngaCode !== undefined) this.ngaCode = ngaCode;
  }
}

// ────────────────────────────────────────────────────────────────
// BBCode → 纯文本
// ────────────────────────────────────────────────────────────────

/**
 * 把 NGA 的 BBCode 压成她读得懂的纯文本。
 *
 * 为什么必须做：原文字面上长这样 ——
 *   `[randomblock][table][tr][td19][align=center][img]./mon_201708/29/-3zj1sQ2h-jgvhK3Su-u.png[/img]`
 * 直接给她看，等于把两千字标签塞进上下文。她读的是内容，不是标记。
 *
 * 处理原则：
 *   - 链接保留 `文字 (url)`，丢掉纯裸 url 的重复
 *   - 图片只留 `[图]`，不留 URL（她看不到图，长 URL 纯占 token）
 *   - 表格/随机块/样式类标签整体剥掉
 *   - 引用保留（`[quote]` 是"他在回谁"的关键线索）
 */
export function bbcodeToText(input: string, attachPrefix?: string | undefined): string {
  let s = input ?? '';

  // NGA 会把某些字符转成字面 `\u0026` 这类转义（JSON 里双重转义导致）。
  // 不还原的话，链接里的 `&` 会变成字面的 \u0026，她点开是坏链接。
  s = s.replace(/\\u0026/g, '&').replace(/\\u003c/g, '<').replace(/\\u003e/g, '>');

  // 骰子（[dice]…[/dice] 或服务端渲染的 <div class='dice'>）—— 保留结果，别整段删
  s = s.replace(/<div class=['"]dice['"]>[\s\S]*?<b>([\s\S]*?)<\/b>\s*=\s*([\s\S]*?)\s*=\s*<b>([\s\S]*?)<\/b>[\s\S]*?<\/div>/gi,
    (_m, a: string, b: string, c: string) => `[骰子 ${a} = ${b} = ${c}]`);
  s = s.replace(/\[dice\]([\s\S]*?)\[\/dice\]/gi, '[骰子 $1]');

  // 折叠块：展开标题 + 内容都留着（她要是认真在读，折叠里的正文往往才是干货）
  s = s.replace(/<div class=['"]foldBox[^'"]*['"]>[\s\S]*?(?:\+)?([\s\S]*?)\.\.\.<\/div>\s*<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/div>/gi,
    (_m, title: string, body: string) => `\n【折叠: ${String(title).replace(/<[^>]+>/g, '').trim()}】\n${body}\n`);
  s = s.replace(/\[collapse(?:=[^\]]*)?\]([\s\S]*?)\[\/collapse\]/gi,
    (_m, body: string) => `\n【折叠】\n${body}\n`);

  // 链接：`[url=xxx]文字[/url]` → `文字 (xxx)`；`[url]xxx[/url]` → xxx
  s = s.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_m, url: string, text: string) => {
    const t = text.trim();
    return t && t !== url ? `${t} (${url})` : url;
  });
  s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '$1');

  // 图片：**保留可点开的地址**（不是只留一个 [图] 占位）。
  //
  // 为什么改：早先整个换成 `[图]`，她只知道"这里有张图"，说不出是什么、
  // 也没法让我去看。给个 URL 至少她能判断要不要问一句。
  //
  // 相对路径必须补全（坑 3.4）：正文里写 `[img]./mon_201708/29/-x.jpg[/img]`，
  // 前缀**从服务端回包的 `attachPrefix` 拿**（实测 https://img.nga.cn/attachments/），
  // 不硬编码域名 —— img4 / attachments 都见过。
  //
  // 顺序很重要：先把 `[img]…[/img]` 整体处理掉，**再**清残留的开标签 ——
  // 否则 `[/img]` 会先被后面那条"成对剥标签"吃掉，剩个孤零零的 URL 在正文里。
  s = s.replace(/\[img[^\]]*\]([\s\S]*?)\[\/img\]/gi, (_m, url: string) => {
    const u = String(url).trim();
    if (!u) return '[图]';
    return `[图: ${normalizeImageUrl(resolveAttachUrl(u, attachPrefix))}]`;
  });
  s = s.replace(/\[img[^\]]*\]/gi, '[图]');

  // 引用块 —— 真实格式**比想象中脏得多**（2026-11-09 扫 101 层楼实测，31 次引用）：
  //
  //   [quote][pid=887251660,47873940,1]Reply[/pid] <b>Post by
  //   [uid=5528287]大部分网友[/uid] (2026-11-08 10:23):</b><br/><br/>你醒了？…[/quote]
  //
  // 直接剥标签会得到 `> Reply Post by 大部分网友 (…)` —— **混着英文噪音**。
  // 人读引用只需要两件事：**谁**说的、**说了什么**。
  // 所以这里先专门抠出作者与时间，再只保留正文。
  s = s.replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, (_m, inner: string) => {
    let body = String(inner);
    let who = '';
    let when = '';
    // 作者：`Post by [uid=123]名字[/uid]` 或 `Post by 名字<span...`
    const byUid = body.match(/Post by\s*\[uid=\d+\]([\s\S]*?)\[\/uid\]/i);
    const byPlain = body.match(/Post by\s*([^<(\[]+)/i);
    if (byUid) who = byUid[1] ?? '';
    else if (byPlain) who = byPlain[1] ?? '';
    // 时间：括号里的 `2026-11-08 10:23`
    const tm = body.match(/\((\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\)/);
    if (tm) when = tm[1] ?? '';

    // 砍掉头部那一坨元信息（从 `[pid=` / `[tid=` 到 `:` 后面的 <br>）
    body = body.replace(/^\s*\[(?:pid|tid)=[\s\S]*?\(\d{4}-\d{2}-\d{2}[^)]*\):?\s*/i, '');
    body = body.replace(/^\s*\[(?:pid|tid)=[^\]]*\][\s\S]*?Reply\[\/(?:pid|tid)\]/i, '');
    body = body.replace(/<\/?b>/gi, '');
    body = body.replace(/<br\s*\/?>/gi, ' ');
    body = body.replace(/\s+/g, ' ').trim();

    const head = who ? `${who.trim()}${when ? ` (${when})` : ''}: ` : '';
    // 必须补换行：不补会得到 `> 饭还是拼的香。那当然`，引用和被引的字粘成一句，
    // 读起来像他自己接了半句，语义直接错。
    return `> ${head}${body}\n`;
  });

  // 表情：`[s:xx]` / `[表情]` → 丢掉（渲染不了，还占位）
  s = s.replace(/\[s:[^\]]*\]/gi, '');
  s = s.replace(/\[(表情|img|pic)[^\]]*\]/gi, '');

  // 纯格式标签（成对）先剥
  s = s.replace(
    /\[\/(?:b|i|u|del|h|size|color|font|align|center|left|right|table|tr|td|th|list|\*|collapse|randomblock|code|tid|pid|uid|quote|flash|lessernuke|read|url|img|s)\]/gi,
    '',
  );
  // 残留开标签：[align=center] [td19] [size=120%] [color=royalblue] [tid=123] …
  s = s.replace(/\[(?:b|i|u|del|h|size|color|font|align|center|left|right|table|tr|td[0-9]*|th|list|\*|collapse|randomblock|code|tid|pid|uid|flash|lessernuke|read|s)(?:=[^\]]*)?\]/gi, '');

  // HTML 残留（NGA 偶尔夹 <br/>）
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');

  // 空白归一：连续空行压成一个，**行首行尾空格都要去掉**
  // （实测 `a   \n\n\n\n b` 只去行尾会留成 `a\n\n b` —— 行首那个空格一样是垃圾，
  //   NGA 的表格/对齐标签炸出来的缩进全堆在行首）
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/[ \t]*\n/g, '\n');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ────────────────────────────────────────────────────────────────
// 客户端
// ────────────────────────────────────────────────────────────────

export interface NgaClientOptions {
  /** 凭证（缺省=游客态；游客态也能读帖与列版面） */
  credentials?: NgaCredentials | undefined;
  /** 单次请求超时(ms) */
  timeoutMs?: number;
  /** 相邻请求最小间隔(ms)，默认 330 */
  minIntervalMs?: number;
  /** 注入给测试用的 fetch */
  fetchImpl?: typeof fetch;
  /** 现在几点（测试用） */
  now?: () => number;
  /** 睡眠（测试里别真睡） */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 游客 token 是服务端在下发 46 时给的，STA 进程内复用。
 * 为什么放模块级：同一个 app 进程里所有会话共用一个客户端就够了；
 * 每次调用都重新换 token 会多打一次请求（对 NGA 是白给的压力）。
 */
let cachedGuestToken: string | undefined;

export class NgaClient {
  private readonly credentials: NgaCredentials | undefined;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** 串行化：NGA 最怕的就是并发打进去 */
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(opts: NgaClientOptions = {}) {
    this.credentials = opts.credentials;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.minIntervalMs = opts.minIntervalMs ?? MIN_INTERVAL_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /** 有没有凭证（决定搜索/收藏这类动作能不能用） */
  get authenticated(): boolean {
    return this.credentials !== undefined;
  }

  // ── 楼层/主题列表 ──

  /** 读一个版面的主题列表 */
  async listTopics(fid: number, page = 1): Promise<NgaTopicList> {
    this.assertFid(fid, 'fid');
    this.assertPositiveInt(page, 'page');
    const raw = await this.post<RawSubjectList>('app_api.php?__lib=subject&__act=list', {
      fid: String(fid),
      page: String(page),
    });
    const result = raw.result ?? {};
    const data = Array.isArray(result.data) ? result.data : [];
    const topics: NgaTopic[] = data.map((t) => ({
      tid: num(t.tid),
      subject: str(t.subject),
      author: str(t.author),
      authorId: num(t.authorid),
      replies: num(t.replies),
      lastPostAt: num(t.lastpost),
    }));
    return {
      fid,
      forumName: str(raw.forumname) || (typeof result.header === 'object' && result.header ? str((result.header as Record<string, unknown>).forumname) : ''),
      totalPage: num(raw.totalPage),
      topics,
    };
  }

  /**
   * 站内搜索（`thread.php?key=...&lite=js`）。
   *
   * 参数名与范围**全部对齐官方客户端**（`TopicListModel.getUrl()`），
   * 详见文件头第 3 条的实测记录 —— 这里不是猜的。
   *
   * 为什么不传 fid 就叫"全站"：客户端里"搜索全站"走的是 `fidgroup`，
   * 但实测不带 fid 也不带 fidgroup 时服务端就是全站范围，
   * 所以这里用"带 fid / 带 fidgroup / 都不带"三态来表达范围，语义最接近真值。
   */
  async searchTopics(keyword: string, opts: NgaSearchOptions = {}): Promise<NgaSearchResult> {
    const key = keyword.trim();
    if (!key) throw new NgaError('bad-request', '关键词不能为空');
    const page = opts.page ?? 1;
    this.assertPositiveInt(page, 'page');
    if (opts.fid !== undefined) this.assertFid(opts.fid, 'fid');

    // 拼参数：顺序无关，但保留客户端的顺序方便和源码对照
    const params: string[] = [`key=${encodeURIComponent(key)}`];
    if (opts.withContent !== false) params.push('content=1');
    if (opts.searchPost === true) params.push('searchpost=1');
    if (opts.author) params.push(`author=${encodeURIComponent(opts.author)}`);
    if (opts.fid !== undefined) params.push(`fid=${opts.fid}`);
    if (opts.fidGroup) params.push(`fidgroup=${encodeURIComponent(opts.fidGroup)}`);
    params.push(`page=${page}`, 'lite=js', 'noprefix');

    const body = await this.getText(`thread.php?${params.join('&')}`);
    let parsed: RawLiteList;
    try {
      // lite=js 回的是 **GBK 编码的 JSON**（decodeGbk 已经在 getText 里做了）
      // parseNgaJson 会兜住"正文里含字面制表符"那种偶发失败
      parsed = parseNgaJson(body) as RawLiteList;
    } catch {
      throw new NgaError('bad-response', `NGA 搜索返回的不是 JSON（前 80 字：${body.slice(0, 80)}）`);
    }
    const data = parsed.data ?? {};
    const table = data.__T ?? {};
    // 过滤 NGA 的**占位帖**。
    //
    // 实测（2026-11-09，搜「手冲咖啡」）：29 条里大半的 subject 是
    // 「帖子发布或回复时间超过限制」—— 原帖已删/过久，服务端只给个占位标题，
    // 点进去也打不开。不滤掉的话她看到的搜索结果一半是这种废条目，
    // 等于"搜到了但什么也没搜到"，比直接说没搜到更糟。
    const PLACEHOLDER = /^(帖子发布或回复时间超过限制|帖子已被删除|该帖已被删除|此帖已删除)$/;
    const topics: NgaTopic[] = Object.values(table)
      .map((t) => ({
        tid: num(t.tid),
        subject: str(t.subject),
        author: str(t.author),
        authorId: num(t.authorid),
        replies: num(t.replies),
        lastPostAt: num(t.lastpost),
      }))
      .filter((t) => t.tid > 0 && t.subject.trim() !== '' && !PLACEHOLDER.test(t.subject.trim()));

    const scope: NgaSearchScope = opts.author
      ? { kind: 'author', author: opts.author }
      : opts.fid !== undefined ? { kind: 'forum', fid: opts.fid }
        : opts.fidGroup ? { kind: 'fidGroup', fidGroup: opts.fidGroup }
          : { kind: 'site' };

    return {
      keyword: key,
      scope,
      // 服务端给的是"命中总条数"（__T__ROWS），按每页 35 条换算成页数给上层做"还有更多"的判断
      totalPage: Math.max(1, Math.ceil(num(data.__T__ROWS) / 35)),
      topics,
    };
  }

  /** 读一个帖子的一页楼层 */
  async readThread(tid: number, page = 1, maxFloors = 20): Promise<NgaThread> {
    this.assertPositiveInt(tid, 'tid');
    this.assertPositiveInt(page, 'page');
    const raw = await this.post<RawPostList>('app_api.php?__lib=post&__act=list', {
      tid: String(tid),
      page: String(page),
    });
    const floors = Array.isArray(raw.result) ? raw.result : [];
    // 坑 2.7：有些回包只有 authorid 没有 author，要用 __U（uid→名字 映射表）反查。
    // app_api.php 目前给的 author 是完整对象，但这条路径的服务端行为会变 ——
    // 拿不到名字时至少别显示空白（空名字会让"谁说的"彻底丢失）。
    const uidName = raw.__U && typeof raw.__U === 'object' ? raw.__U : undefined;
    const authorOf = (f: RawFloor): string => {
      const a = f.author;
      if (typeof a === 'string' && a.trim()) return a;
      if (a && typeof a === 'object') {
        const byObj = str(a.username) || str(a.nickname);
        if (byObj) return byObj;
      }
      const uid = num(f.authorid) || (a && typeof a === 'object' ? num(a.uid) : 0);
      if (uid && uidName) {
        const mapped = uidName[String(uid)];
        if (typeof mapped === 'string' && mapped.trim()) return mapped;
      }
      return uid ? `UID:${uid}` : '';
    };
    // 图片前缀由服务端给（坑 3.4），拿不到才退回实测默认值
    const attachPrefix = str(raw.attachPrefix) || undefined;
    const out: NgaFloor[] = [];
    for (const f of floors) {
      if (out.length >= maxFloors) break;
      const comments = (Array.isArray(f.comments) ? f.comments : []).slice(0, 3).map((c) => ({
        author: str(c.author) || str((c.author as unknown as Record<string, unknown>)?.username) || '',
        content: bbcodeToText(str(c.content), attachPrefix),
      }));
      out.push({
        lou: num(f.lou),
        author: authorOf(f),
        postDate: str(f.postdate),
        content: bbcodeToText(str(f.content), attachPrefix),
        comments,
      });
    }
    return {
      tid,
      subject: str(raw.tsubject),
      forumName: str(raw.forum_name),
      totalPage: num(raw.totalPage),
      currentPage: num(raw.currentPage) || page,
      // vrows 是 app_api.php 的实测字段名；__ROWS 是 thread.php 那套的说法，两个都认
      ...(num(raw.vrows) > 0 ? { totalFloors: num(raw.vrows) }
        : num(raw.__ROWS) > 0 ? { totalFloors: num(raw.__ROWS) } : {}),
      ...(num(raw.__R__ROWS_PAGE) > 0 ? { perPage: num(raw.__R__ROWS_PAGE) }
        : num(raw.perPage) > 0 ? { perPage: num(raw.perPage) } : {}),
      floors: out,
    };
  }

  /**
   * 解析版面名：抓 `thread.php?fid=N` 的页面标题（`XXX NGA玩家社区` → `XXX`）。
   * 比维护一张手写 fid 表可靠 —— NGA 的版面增减我们追不上，标题是服务端给的。
   */
  async resolveForumName(fid: number): Promise<string> {
    const html = await this.getText(`thread.php?fid=${fid}`);
    const m = html.match(/<title>([^<]*)<\/title>/i);
    const title = (m?.[1] ?? '').replace(/\s*NGA玩家社区\s*$/, '').trim();
    return title;
  }

  // ── 底层 ──

  /** 串行化 + 限速 */
  private async gate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
      return fn();
    });
    // 队尾吞掉错误：一个请求失败不该把后面的队列全堵死
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async post<T>(path: string, form: Record<string, string>): Promise<T> {
    return this.gate(async () => {
      const body = new URLSearchParams(form).toString();
      const first = await this.doPost<T>(path, body);
      if (first.guestToken) {
        // 服务端说"你得带 guest_token"，那就带上重打一次（**不带 cookie 也能过**）
        cachedGuestToken = first.guestToken;
        const retry = await this.doPost<T>(path, body, first.guestToken);
        return retry.json;
      }
      return first.json;
    });
  }

  private async doPost<T>(
    path: string,
    body: string,
    guestToken?: string,
  ): Promise<{ json: T; guestToken?: string }> {
    const url = `${NGA_BASE}/${path}${guestToken || cachedGuestToken ? `&guest_token=${guestToken ?? cachedGuestToken}` : ''}`;
    const res = await this.send(url, { method: 'POST', body });
    // app_api.php 是 UTF-8、nuke.php 是 GBK —— 按 charset 解，别猜
    const text = decodeByCharset(await res.arrayBuffer(), res.headers.get('content-type'));
    let json: unknown;
    try {
      json = parseNgaJson(text);
    } catch {
      throw new NgaError('bad-response', `NGA 返回的不是 JSON（HTTP ${res.status}，前 80 字：${text.slice(0, 80)}）`, res.status);
    }
    const obj = json as Record<string, unknown>;

    // 46：游客被挡，但响应里给了 token
    const code = num(obj.code);
    if (code === 46) {
      const tok = str(obj.guest_token);
      if (tok && !guestToken) return { json: obj as T, guestToken: tok };
      throw new NgaError('guest-denied', 'NGA 拒绝访问（连游客态都不给，可能 IP 被限流）', res.status, code);
    }
    if (code !== 0) {
      throw new NgaError(
        code === 56 ? 'not-found' : 'bad-response',
        `NGA 返回 code=${code}：${str(obj.msg) || '未知错误'}`,
        res.status,
        code,
      );
    }
    return { json: obj as T };
  }

  private async getText(path: string): Promise<string> {
    return this.gate(async () => {
      const res = await this.send(`${NGA_BASE}/${path}`, { method: 'GET' });
      // 按响应头的 charset 解（不同接口 UTF-8/GBK 混用，见 decodeByCharset 的说明）
      return decodeByCharset(await res.arrayBuffer(), res.headers.get('content-type'));
    });
  }

  private async send(url: string, init: { method: string; body?: string }): Promise<Response> {
    const headers: Record<string, string> = {
      'User-Agent': NGA_UA,
      // 这一行是关键：不带它就 code=46「游客不能直接访问」（实测）
      'X-User-Agent': NGA_X_UA,
      Referer: `${NGA_BASE}/`,
      Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (this.credentials) {
      headers.Cookie = `ngaPassportUid=${this.credentials.uid}; ngaPassportCid=${this.credentials.cid}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const kind: NgaErrorKind = /timeout|aborted|abort/i.test(msg) ? 'timeout' : 'network';
      throw new NgaError(kind, `请求 NGA 失败：${msg}`);
    }
    if (res.status >= 500) {
      throw new NgaError('server', `NGA 服务端 ${res.status}`, res.status);
    }
    return res;
  }

  private assertPositiveInt(v: number, name: string): void {
    if (!Number.isInteger(v) || v <= 0) {
      throw new NgaError('bad-request', `${name} 必须是正整数（收到 ${String(v)}）`);
    }
  }

  /**
   * fid 校验 —— **允许负数**。
   *
   * 实测（2026-11-09）：NGA 有大量版面 fid 是负的
   * （厨艺美食 -608808、小窗视界 -8725919、程序员版 -202020…）。
   * 我一开始图省事复用了 assertPositiveInt，结果这些版一个都打不开，
   * 报"fid 必须是正整数"—— 那是拿 tid 的规则套在 fid 上，属于搞错了类型。
   * fid 唯一的要求是"非零整数"（0 表示没有指定版面）。
   */
  private assertFid(v: number, name: string): void {
    if (!Number.isInteger(v) || v === 0) {
      throw new NgaError('bad-request', `${name} 必须是非零整数（NGA 部分版面 fid 是负数，如厨艺 -608808；收到 ${String(v)}）`);
    }
  }
}

// ────────────────────────────────────────────────────────────────
// 回包形状（只声明用到的字段）
// ────────────────────────────────────────────────────────────────

interface RawAuthor {
  uid?: number;
  username?: string;
  nickname?: string;
}
interface RawComment {
  author?: string | RawAuthor;
  content?: string;
}
interface RawFloor {
  pid?: number;
  lou?: number;
  author?: string | RawAuthor;
  authorid?: number;
  postdate?: string;
  subject?: string;
  content?: string;
  comments?: RawComment[];
}
interface RawTopic {
  tid?: number;
  subject?: string;
  author?: string;
  authorid?: number;
  replies?: number;
  lastpost?: number;
}
interface RawPostList {
  code?: number;
  attachPrefix?: string;
  msg?: string;
  result?: RawFloor[];
  totalPage?: number;
  currentPage?: number;
  /** 每页楼层数（实测 20）；坑 4.2 说 `__R__ROWS_PAGE` 是权威值 */
  perPage?: number;
  /**
   * 总楼层数。
   *
   * 坑 4.2 说字段叫 `__ROWS`，但**实测 app_api.php 叫 `vrows`**
   * （2026-11-09 抓回包：`vrows: 21`, totalPage:2, perPage:20）。
   * 两个都认，避免哪天服务端换回去。
   */
  vrows?: number;
  __ROWS?: number;
  /** 每页楼层数（坑 4.2 的权威字段名） */
  __R__ROWS_PAGE?: number;
  /** uid → 用户名 映射（坑 2.7：author 只给 id 时反查） */
  __U?: Record<string, string>;
  tsubject?: string;
  forum_name?: string;
}
interface RawLiteList {
  data?: {
    __T?: Record<string, RawTopic>;
    __T__ROWS?: number;
    __ROWS?: number;
  };
}
interface RawSubjectList {
  code?: number;
  msg?: string;
  totalPage?: number;
  forumname?: string;
  result?: {
    data?: RawTopic[];
    header?: Record<string, unknown>;
  };
}

// ────────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────────

/**
 * 容错的 JSON 解析 —— 抄别人的实测经验（leungjunbob/dsh-nga-sidebar 的
 * `docs/NGA-PARSING-PITFALLS.md` 第 2.2 条）：
 *
 * > `alterinfo` 字段含**字面制表符** → `JSON.parse` 报错。
 * > 解法：解析前把 `\t` 替换成私用区字符（NGA 的 JSON 是压缩格式，
 * > 制表符只可能出现在字符串内，替换是安全的）。
 *
 * 我实测我们走的这两条路径（`app_api.php` 与 `thread.php?lite=js`）
 * 现在**没有**触发（各抓 10+ 次都是干净 JSON）。但这是**帖子内容相关的随机性**：
 * 某天某个帖子的 alterinfo 带上制表符，整条链路就会突然 parse 失败。
 * 所以先手做掉，别等它偶发。
 *
 * 顺序刻意如此（也是那份文档的建议）：
 *   1. 直接 parse（正常路径零成本）
 *   2. 失败 → 制表符替换后重试
 *   3. 仍失败 → 抛错（上层降级/透传原因，不静默吞掉）
 */
export function parseNgaJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // 只把**字面**制表符（U+0009）换成私用区字符 U+E009，
    // 它不会被 JSON 语法误认为分隔符，也不会和正文里的正常字符冲突
    const sanitized = text.replace(/\t/g, '\uE009');
    return JSON.parse(sanitized);
  }
}

/**
 * 把 NGA 正文里的图片路径补成可访问 URL。
 *
 * 实测（2026-11-09）：`app_api.php` 回包带 `attachPrefix: "https://img.nga.cn/attachments/"`，
 * 而正文里写的是 `[img]./mon_201708/29/-x.jpg[/img]` —— 不补全根本打不开（坑 3.4）。
 * 前缀优先用服务端给的，拿不到才用实测默认值。
 */
/**
 * 去掉 NGA 的缩略图后缀。
 *
 * `xxx.jpg.medium.jpg` 是 NGA 的"中等尺寸"变体（她们抄的 dsh-nga-fish 也这么处理）。
 * 保留它只会让 URL 更长、有时还 404 —— 原图地址才是能打开的。
 */
export function normalizeImageUrl(url: string): string {
  return url.replace(/\.medium\.jpg$/i, '');
}

export function resolveAttachUrl(raw: string, attachPrefix?: string | undefined): string {
  const u = raw.trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  const prefix = (attachPrefix && attachPrefix.trim()) || 'https://img.nga.cn/attachments/';
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return base + u.replace(/^\.\//, '');
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/**
 * GBK 解码。Node 内置的 TextDecoder 支持 'gb18030'（ICU 完整），
 * 但**探针式**：不支持就退回 UTF-8，绝不抛错把整条链路带崩。
 */
/**
 * 解码 NGA 的响应体。
 *
 * ## 服务端给的 charset **会说谎**（2026-11-09 实测，这是最重要的一条）
 *
 * NGA 各接口的 charset 本来就不统一：
 *   app_api.php（读帖/列版面）      → UTF-8   ✓ 真的
 *   nuke.php（登录/用户信息）        → GBK     ✓ 真的
 *   thread.php（HTML 版面页）        → GBK     ✓ 真的
 *   **thread.php?lite=js（搜索）    → UTF-8    ✗ 假的！实际是 GBK**
 *
 * 最后一条实测：`content-type: text/html; charset=UTF-8`，
 * 但字节解出来的中文全是 `����Ҳ����...`。所以**不能盲信 header**。
 * （这也解释了为什么"编码嗅探"不是 hack 而是必需品 —— 服务端确实在说谎。）
 *
 * ## 所以顺序是：先按 header 解 → 解出乱码就换另一个 → 取没乱码的那个
 */
export function decodeByCharset(buf: ArrayBuffer, contentType: string | null | undefined): string {
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(String(contentType ?? ''));
  const charset = (m?.[1] ?? '').toLowerCase();

  // 没有 charset 提示：两个都试，取干净的那个
  if (!charset) return pickClean([decodeOne(buf, 'gb18030'), decodeOne(buf, 'utf-8')]);

  // 有提示：**先信它**，但**必须验货** —— 解出乱码就说明它在说谎
  const claimed = charset === 'utf-8' || charset === 'utf8' ? 'utf-8' : 'gb18030';
  const other = claimed === 'utf-8' ? 'gb18030' : 'utf-8';

  const primary = decodeOne(buf, claimed);
  if (primary !== undefined && !looksMojibake(primary)) return primary;
  const fallback = decodeOne(buf, other);
  if (fallback !== undefined && !looksMojibake(fallback)) return fallback;

  // 两个都像乱码（极少见）：退回主提示的解析结果，至少形状是对的
  return primary ?? fallback ?? '';
}

/** 按给定编码解；编码不支持时返回 undefined */
function decodeOne(buf: ArrayBuffer, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch {
    return undefined;
  }
}

/** 从候选里挑第一个看起来不是乱码的；全乱就返回第一个 */
function pickClean(candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    if (c !== undefined && !looksMojibake(c)) return c;
  }
  return candidates.find((c) => c !== undefined) ?? '';
}

export function decodeGbk(buf: ArrayBuffer): string {
  // 为什么不能"傻解 GBK"：NGA 绝大多数端点回 GBK，但个别端点（以及我们自己的
  // 测试替身）会回 UTF-8。硬按 GBK 解会把 UTF-8 中文变成"鏈壘鍒扮櫥褰曡鍙"这种
  // 乱码，而且**不会报错** —— 于是上层文案匹配（如"未找到登录许可"）静默失败，
  // 把"还没扫码"误判成"二维码过期"。实测踩过：测试里用 TextEncoder 编 UTF-8
  // 打进来，pollQrSession 直接返回 expired。
  //
  // 判据：用 GBK 解一遍，如果出现替换符(U+FFFD)或典型的 GBK 解 UTF-8 乱码特征，
  // 就改用 UTF-8 重解。这是启发式，但对"中文 + ASCII"这类回包足够可靠。
  const gbk = tryDecode(buf, 'gb18030');
  if (gbk !== undefined && !looksMojibake(gbk)) return gbk;
  const utf8 = tryDecode(buf, 'utf-8');
  if (utf8 !== undefined) return utf8;
  return gbk ?? '';
}

function tryDecode(buf: ArrayBuffer, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch {
    return undefined;
  }
}

/**
 * 判断"这是不是把 UTF-8 当 GBK 解出来的乱码"。
 *
 * 特征：出现替换符，或者命中一批 UTF-8 双字节被 GBK 误解后的典型汉字
 * （"鏈"、"鍒"、"櫥"、"褰"…这些字几乎只在这种错配里成组出现）。
 * 宁可漏判（退回原样）也不要误判：误判会让本来正常的 GBK 文本被重解。
 */
function looksMojibake(s: string): boolean {
  if (s.includes('\uFFFD')) return true;
  // 这些字在中日文正常文本里极少成组出现，却是 UTF-8→GBK 错配的招牌
  const signs = ['鏈', '鍒', '櫥', '褰', '曡', '鍙', '鏄', '鐨', '涓', '浣'];
  let hit = 0;
  for (const c of signs) if (s.includes(c)) hit += 1;
  return hit >= 2;
}

/** unix 秒 → 北京时间的 `MM-DD HH:mm`（容器 TZ 不可信，显式换算） */
export function formatNgaTime(unixSec: number, timeZone = 'Asia/Shanghai'): string {
  if (!unixSec) return '';
  const d = new Date(unixSec * 1000);
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return d.toISOString().slice(5, 16).replace('T', ' ');
  }
}
