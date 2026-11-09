/**
 * NGA 工具注册 — 她的 NGA 通道（读帖 / 列版面 / 站内搜 / 请求扫码登录）
 * ─────────────────────────────────────────────────────────────
 * 为什么从 persona/tools.ts 拆出来（2026-11-10，模块边界整理）：
 *
 * NGA 是**平台扩展**，不是聊天人格的一部分。Steam / Dota / 小黑盒都是
 * 「模块自带 register*Tools、bootstrap 直接调」的模式，NGA 是唯一一个把
 * 实现塞进 persona/tools.ts、客户端还挤进 registerPersonaTools 签名的 ——
 * 导致「只同步聊天核心修订」的分支不得不背走 400 行 NGA 代码。
 * 现在对齐：本文件自包含，bootstrap 直接 registerNgaTools(ctx, {...})。
 *
 * 依赖面（刻意收窄）：
 *   - nga.ts / nga-capture.ts（同目录，纯 NGA 协议实现）
 *   - 不引 persona 的任何东西 —— NGA 挂了不该影响她聊天
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  NgaClient,
  NgaError,
  formatNgaTime,
  loadCredentials,
  defaultNgaDir,
  KNOWN_FORUMS,
} from './nga.ts';
import { genQrSession, renderQrBuffer, type QrSession } from './nga-capture.ts';
import type { Logger } from '../types.ts';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

/**
 * 进程内的扫码会话表 —— 工具与面板**共用这一张**。
 *
 * 共用是刻意的：她在聊天里生成的那张二维码，主人扫完之后，
 * 面板那边轮询也能同一个 key 拿到结果；反之亦然。
 * 分成两张表会导致"面板说没生成过、但其实她发过"。
 */
const qrSessions = new Map<string, QrSession>();

/** NGA 的 qrkey 约 2-3 分钟失效；取 120 秒并在本地也判一次，别让人对着死码干等 */
export const QR_TTL_SEC = 120;

/** 记一次会话（键固定为 owner：目前只有主人在扫码） */
export function rememberQrSession(session: QrSession, key = 'owner'): void {
  qrSessions.set(key, session);
}

/** 取会话（面板/工具轮询用） */
export function currentQrSession(key = 'owner'): QrSession | undefined {
  return qrSessions.get(key);
}

/** 清会话（成功或过期后调） */
export function forgetQrSession(key = 'owner'): void {
  qrSessions.delete(key);
}

/**
 * NGA 现在是不是登录态。
 *
 * 单独抽出来是因为它要在两处用（搜索分支 + 工具描述），而且**判据必须是磁盘**
 * 而不是内存快照：用户刚扫完码落盘，这个 client 实例的 credentials 还是旧的。
 */
function ngaAuthenticated(): boolean {
  return loadCredentials() !== undefined;
}

/** 把可选数字参数夹到 [min, max]，undefined/NaN 走默认值 */
function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export interface RegisterNgaToolsOptions {
  /** 注入客户端（测试用；生产留空即按磁盘凭证自建，没有就是游客态） */
  ngaClient?: NgaClient;
  logger: Logger;
}

/**
 * 注册 NGA 的两个工具：qq_nga（读帖/列版面/站内搜）+ qq_nga_login（请求扫码）。
 *
 * 独立于 registerPersonaTools 调用 —— 聊天核心的修订不应该带着 NGA 走。
 */
export function registerNgaTools(ctx: Context, opts: RegisterNgaToolsOptions): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    opts.logger.warn('im-qqbot: tools 服务不可用，NGA 工具未注册');
    return;
  }
  const reg = (def: unknown): void => { tools.register(def); };
  // NGA：懒建一次，凭证从磁盘读（没有就是游客态，功能照样可用）
  const nga = opts.ngaClient ?? new NgaClient({ credentials: loadCredentials() });

  /**
   * qq_nga —— 去 NGA（艾泽拉斯国家地理 / bbs.nga.cn）看看。
   *
   * ## 为什么做成工具，而不是再挂一个 NGA MCP
   *
   * 2026-11-08 实测调研：GitHub 上只有两个沾边的，
   *   - `yixiaowang2001/nga-mcp-server`（8★）走 playwright + chromium，
   *     容器里没装，还会另起一个浏览器进程；
   *   - `beckyeeky/nga-hub-skill`（0★）要登录后的 ngaPassportCid 才能用。
   * 而 NGA 的 JSON 接口裸 fetch 就能打（见 `nga.ts` 的三条实测）。
   * 她本来就有 ego 浏览器与 bash，再塞一份 Playwright 是纯负担。
   *
   * ## 为什么只有「列版面 / 读帖子」两个动作
   *
   * 游客态能做的只有这两个（`app_api.php` 的 `post/list` 与 `subject/list`）。
   * 搜索接口 `__lib=search` 在游客态返回 `ACTION NOT FOUND`——**不是权限不够，是动作不存在**。
   * 与其给她一个"看起来能用、永远返回空"的 search，不如不给：
   * 她要是因此编出"NGA 上有人说……"，比老实说"搜不了"糟得多。
   * 发帖/回帖同理：那属于动用户账号，得走明确的同意，不能藏在一个工具里。
   */
  reg({
    name: 'qq_nga',
    description:
      '去 NGA（艾泽拉斯国家地理，bbs.nga.cn）看看。三种用法（**都要传对应的 id，别空着调**）：'
      + '① action=list **必须带 fid** 列某个版面的最新主题（"这版今天在聊什么"）；'
      + '② action=read **必须带 tid** 读帖子的正文和回复（要看完整内容时）；'
      + '③ action=search **必须带 keyword** 站内搜帖子（"有没有人聊过 X"）。'
      + '\n'
      + '**【重要】list 不带 fid 会直接报错，不会"列出所有版面"。**'
      + '这个工具没有"版面目录"功能 —— 想认识 NGA 有哪些版，就用 qq_browse 搜'
      + '"NGA 版面 fid 列表"，或者直接问主人某类话题在哪个版。'
      + '\n'
      + '搜索：传 fid 就在那个版面里搜（又快又准），不传 fid 才是全站（覆盖广但噪音大）。'
      + '搜索**需要登录**；游客态只能 list/read，搜不了，会明确告诉你没登录 ——'
      + '那时候你可以用 qq_nga_login 请主人扫一次码。'
      + '\n'
      + '常用 fid：魔兽世界艾泽拉斯议事厅=7、消费电子IT新闻=436、炉石狂野模式=621、'
      + '团队管理=255。不确定 fid 对不对，先 list 试一次看是不是想看的那个版面。'
      + '\n'
      + '**只能读**：不能发帖、不能回帖、不能点赞。'
      + '查不到就如实说查不到，不要凭印象编"论坛上有人说"。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'search'], description: 'list=列版面主题（需 fid）；read=读一个帖子（需 tid）；search=站内搜帖子（需 keyword）' },
        keyword: { type: 'string', description: 'search 用：搜什么词' },
        withContent: { type: 'boolean', description: 'search 用：是否搜正文（默认 true；false 只搜标题更快但会漏）' },
        searchPost: { type: 'boolean', description: 'search 用：搜回复而不是主题（想找"评论区里提到过的"时用）' },
        fid: { type: 'number', description: 'list 必填 / search 选填：版面 id（艾泽拉斯议事厅=7、消费电子IT新闻=436）' },
        tid: { type: 'number', description: 'read 用：帖子 id（tid，从链接 read.php?tid=xxx 里拿）' },
        page: { type: 'number', description: '可选：第几页，默认 1' },
        limit: { type: 'number', description: '可选：list 最多返回几条主题（默认 10）；read 最多返回几层楼（默认 8）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          error: { type: 'string' },
          // ── list 的实际结果 ──
          forumName: { type: 'string' },
          totalPage: { type: 'number' },
          topics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tid: { type: 'number' },
                subject: { type: 'string' },
                author: { type: 'string' },
                replies: { type: 'number' },
                lastAt: { type: 'string' },
              },
              required: ['tid', 'subject', 'author', 'replies', 'lastAt'],
              additionalProperties: false,
            },
          },
          // ── search 的实际结果 ──
          keyword: { type: 'string' },
          scope: {
            type: 'object',
            properties: { kind: { type: 'string' }, fid: { type: 'number' }, fidGroup: { type: 'string' }, author: { type: 'string' } },
            required: ['kind'],
            additionalProperties: false,
          },
          needLogin: { type: 'boolean' },
          // ── "list 没给 fid" 时返回的内置版面表 ──
          forums: {
            type: 'array',
            items: {
              type: 'object',
              properties: { fid: { type: 'number' }, name: { type: 'string' }, about: { type: 'string' } },
              required: ['fid', 'name', 'about'],
              additionalProperties: false,
            },
          },
          note: { type: 'string' },
          // ── read 的实际结果 ──
          subject: { type: 'string' },
          totalFloors: { type: 'number' },
          floors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                author: { type: 'string' },
                at: { type: 'string' },
                content: { type: 'string' },
                comments: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      author: { type: 'string' },
                      content: { type: 'string' },
                    },
                    required: ['author', 'content'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['author', 'at', 'content', 'comments'],
              additionalProperties: false,
            },
          },
        },
        required: ['ok', 'action'],
        additionalProperties: false,
      },

      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as {
          ok: boolean;
          action: string;
          error?: string;
          forumName?: string;
          totalPage?: number;
          topics?: Array<{ tid: number; subject: string; author: string; replies: number; lastAt: string }>;
          subject?: string;
          floors?: Array<{ author: string; at: string; content: string; comments: Array<{ author: string; content: string }> }>;
        };
        if (!r.ok) {
          const hint = (r as { needLogin?: boolean }).needLogin === true
            ? '\n（你可以用 qq_nga_login 请主人扫码登录）'
            : '';
          return [{ type: 'text', text: `NGA 没看成：${r.error ?? '未知原因'}${hint}` }];
        }
        if ((r as { forums?: unknown }).forums !== undefined) {
          const fr = r as unknown as { forums: Array<{ fid: number; name: string; about: string }>; note?: string };
          const lines = fr.forums.map((f, i) => `${i + 1}. ${f.name}（fid=${f.fid}）—— ${f.about}`);
          return [{ type: 'text', text: `常用版面：\n${lines.join('\n')}\n\n${fr.note ?? ''}` }];
        }
        if (r.action === 'search') {
          const sr = r as unknown as {
            keyword: string;
            scope: { kind: string; fid?: number; author?: string; fidGroup?: string };
            totalPage: number;
            topics: Array<{ tid: number; subject: string; author: string; replies: number; lastAt: string }>;
          };
          const where = sr.scope.kind === 'forum' ? `版 ${sr.scope.fid}`
            : sr.scope.kind === 'author' ? `作者 ${sr.scope.author}`
              : sr.scope.kind === 'fidGroup' ? `版面组 ${sr.scope.fidGroup}`
                : '全站';
          const lines = (sr.topics ?? []).map((t, i) =>
            `${i + 1}. [tid=${t.tid}] ${t.subject} —— ${t.author}（${t.replies} 回，${t.lastAt}）`);
          const head = `「${sr.keyword}」在${where}搜到 ${lines.length} 条（共约 ${sr.totalPage} 页）`;
          return [{ type: 'text', text: lines.length > 0 ? `${head}\n${lines.join('\n')}` : `${head}：没搜到` }];
        }
        if (r.action === 'list') {
          const lines = (r.topics ?? []).map((t, i) =>
            `${i + 1}. [tid=${t.tid}] ${t.subject} —— ${t.author}（${t.replies} 回，${t.lastAt}）`);
          const head = `${r.forumName ?? '版'}（共 ${r.totalPage ?? '?'} 页）`;
          return [{ type: 'text', text: `${head}\n${lines.join('\n')}` }];
        }
        const floors = (r.floors ?? []).map((f) => {
          const c = f.comments.length > 0
            ? `\n  楼中楼：${f.comments.map((x) => `${x.author}：${x.content}`).join(' / ')}`
            : '';
          return `【${f.author} · ${f.at}】${f.content}${c}`;
        });
        const tf = (r as { totalFloors?: number }).totalFloors;
        const head = `《${r.subject ?? '?'}》`
          + (tf !== undefined ? `（共 ${tf} 楼，第 ${(r as { totalPage?: number }).totalPage ?? '?'} 页）` : '');
        return [{ type: 'text', text: `${head}\n\n${floors.join('\n\n')}` }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as {
        action?: string; fid?: number; tid?: number; page?: number; limit?: number;
        keyword?: string; withContent?: boolean; searchPost?: boolean;
      };
      const action = String(a.action ?? '').toLowerCase();
      if (action !== 'list' && action !== 'read' && action !== 'search') {
        return { ok: false, action, error: 'action 只能是 list / read / search' };
      }
      const page = clampInt(a.page, 1, 1, 200);
      try {
        if (action === 'list') {
          const fid = Math.trunc(Number(a.fid ?? 0));
          // 注意：**不能用 fid <= 0 判断**。NGA 有大量版面 fid 是负数
          // （厨艺 -608808、小窗视界 -8725919、程序员版 -202020…），
          // 用 <=0 会把它们全当成"没给 fid"，然后返回版面表 —— 她会以为版打不开。
          // 0 才是"没指定"的哨兵值。
          if (!Number.isInteger(fid) || fid === 0) {
            // 她第一次调 {"action":"list"} 想让工具"列出所有版面"，实测拿到一句
            // "需要 fid" 就卡住了 —— NGA 根本没有版面目录接口，她没地方找 fid。
            // 所以这里**不报错**，直接把内置的已验证版面表给她当起点。
            return {
              ok: true,
              action,
              forums: KNOWN_FORUMS.map((f) => ({ fid: f.fid, name: f.name, about: f.about })),
              note: '这是内置的常用版面表（都验证过能用），不是 NGA 的全部版面。'
                + '挑一个 fid 再调 list；想找表里没有的版，可以直接问主人。',
            };
          }
          const limit = clampInt(a.limit, 10, 1, 40);
          const list = await nga.listTopics(fid, page);
          return {
            ok: true,
            action,
            forumName: list.forumName,
            totalPage: list.totalPage,
            topics: list.topics.slice(0, limit).map((t) => ({
              tid: t.tid,
              subject: t.subject,
              author: t.author,
              replies: t.replies,
              lastAt: formatNgaTime(t.lastPostAt),
            })),
          };
        }
        if (action === 'search') {
          const keyword = String(a.keyword ?? '').trim();
          if (!keyword) return { ok: false, action, error: 'search 需要 keyword' };
          // 游客态能读帖、能列版面，但**搜不了** —— 直接说清楚，别让她以为"NGA 上没有"
          if (!ngaAuthenticated()) {
            return {
              ok: false,
              action,
              error: 'NGA 搜索需要登录，现在是游客态。你可以用 qq_nga_login 请主人扫一次码。',
              needLogin: true,
            };
          }
          const limit = clampInt(a.limit, 10, 1, 30);
          const fidNum = Math.trunc(Number(a.fid ?? 0));
          const result = await nga.searchTopics(keyword, {
            // 同上：负数 fid 是合法版面，只有 0 表示"没指定、搜全站"
            ...(Number.isInteger(fidNum) && fidNum !== 0 ? { fid: fidNum } : {}),
            page,
            ...(a.withContent === false ? { withContent: false } : {}),
            ...(a.searchPost === true ? { searchPost: true } : {}),
          });
          return {
            ok: true,
            action,
            keyword: result.keyword,
            scope: result.scope,
            totalPage: result.totalPage,
            topics: result.topics.slice(0, limit).map((t) => ({
              tid: t.tid,
              subject: t.subject,
              author: t.author,
              replies: t.replies,
              lastAt: formatNgaTime(t.lastPostAt),
            })),
          };
        }
        const tid = Math.trunc(Number(a.tid ?? 0));
        if (!Number.isInteger(tid) || tid <= 0) {
          return { ok: false, action, error: 'read 需要 tid（帖子 id，从 read.php?tid=xxx 里拿）' };
        }
        const limit = clampInt(a.limit, 8, 1, 30);
        const thread = await nga.readThread(tid, page, limit);
        return {
          ok: true,
          action,
          subject: thread.subject || `tid=${tid}`,
          totalPage: thread.totalPage,
          // 坑 4.2：楼层总数和页数是两个数，她问"一共多少楼"要用前者
          ...(thread.totalFloors !== undefined ? { totalFloors: thread.totalFloors } : {}),
          floors: thread.floors.map((f) => ({
            author: f.author,
            at: f.postDate,
            content: f.content,
            comments: f.comments,
          })),
        };
      } catch (err) {
        if (err instanceof NgaError) {
          // 把 kind 翻成人话 —— 她不该看到 'guest-denied' 这种内部词
          const why =
            err.kind === 'timeout' ? 'NGA 响应超时'
              : err.kind === 'network' ? '连不上 NGA'
                : err.kind === 'guest-denied' ? 'NGA 把这次请求挡了（游客限制或 IP 限流），过一会儿再试'
                  : err.kind === 'not-found' ? '这个版面/帖子不存在，或你的账号看不到它'
                    : err.kind === 'bad-request' ? '参数不对'
                      : 'NGA 回了个看不懂的东西';
          return { ok: false, action, error: `${why}（${err.message}）` };
        }
        return { ok: false, action, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  /**
   * qq_nga_login —— 她可以**主动**请主人扫码登录 NGA。
   *
   * ## 为什么给她这个权力（而不是做成面板上的按钮）
   *
   * 用户的原话是"由小羽决定，聊天或者其他时候发现，可以主动发消息给 owner 请求登录"。
   * 也就是说：**发现需要登录的时机归她判断**，不是归代码判断。
   * 所以这里只提供能力，不设触发条件 —— 她在聊天里发现"要搜 NGA 但没登录"、
   * 或者自由时间想上山看看却上不去，都可以自己决定要不要打扰主人。
   *
   * ## 为什么走 qqbot_send_file 而不是普通回复
   *
   * 二维码是**图片**，普通文字回复传不了。而 `qqbot_send_file` 支持显式
   * `target=c2c:<openid>`，正好是"指定发给某个人"的通道。
   * 但这里不由工具自己发 —— 工具只负责生成并把路径交回去，
   * 让她在回复里自然地说一句"你扫一下这个"，比机器弹一条通知更像她。
   *
   * ## 边界
   *
   * 只发私聊（`c2c`），绝不发群 —— 扫码是主人本人的事，不该在群里打扰别人。
   */
  reg({
    name: 'qq_nga_login',
    description:
      '生成一张 NGA 登录二维码，让主人用手机扫一下，你就能搜 NGA 了。'
      + '什么时候用由你自己判断：比如你想搜 NGA 却发现没登录，'
      + '或者自由时间想上山看看却进不去。'
      + '**别为了登录而登录** —— 只有你真要用 NGA 搜索时才值得打扰他。'
      + '调用后会返回图片路径，你用 qqbot_send_file（target=c2c:<主人的openid>）发给主人，'
      + '再简短说一句请他扫；二维码约 2 分钟有效，过期了再调一次就行。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          filePath: { type: 'string' },
          expiresInSec: { type: 'number' },
          alreadyLoggedIn: { type: 'boolean' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_a: unknown, v: unknown): ContentBlock[] => {
        const r = v as { ok: boolean; filePath?: string; expiresInSec?: number; alreadyLoggedIn?: boolean; error?: string };
        if (r.alreadyLoggedIn === true) {
          return [{ type: 'text', text: 'NGA 已经是登录状态了，不用再扫。' }];
        }
        if (!r.ok) return [{ type: 'text', text: `二维码没生成出来：${r.error ?? '未知原因'}` }];
        return [{
          type: 'text',
          text: `二维码已生成：${r.filePath}\n约 ${r.expiresInSec ?? 120} 秒内有效。`
            + '用 qqbot_send_file 发给主人（target=c2c:<主人的openid>），再请他扫一下。',
        }];
      },
    },
    async execute(): Promise<Record<string, unknown>> {
      try {
        if (loadCredentials() !== undefined) return { ok: true, alreadyLoggedIn: true };
        const session = await genQrSession();
        const png = await renderQrBuffer(session.content, 480);
        // 落盘到一个可发送的位置（send_file 的白名单里有 media 目录）
        const dir = join(defaultNgaDir(), 'qr');
        mkdirSync(dir, { recursive: true });
        const filePath = join(dir, `login-${session.qrkey.slice(0, 8)}.png`);
        writeFileSync(filePath, png);
        // 记住这次会话，供轮询用（面板和工具共用同一张表）
        rememberQrSession(session);
        return { ok: true, filePath, expiresInSec: QR_TTL_SEC };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
