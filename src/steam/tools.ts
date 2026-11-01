/**
 * Steam 工具注册 — 让 agent 在聊天里查群友在玩什么
 * ─────────────────────────────────────────────────────────────
 * 三个工具，刻意保持少而明确（工具描述本身要吃 token）：
 *   qq_steam_bind    群友说「我 Steam 是 xxx」时存下来
 *   qq_steam_forget  解绑
 *   qq_steam_lookup  查状态 / 最近游戏
 *
 * 身份安全：绑定的 key 永远取 SessionRecord.senderId（消息发送者），
 * 不接受模型传 openid —— 否则群里任何人说一句"帮张三绑上"就能篡改别人的绑定。
 *
 * 主人账号（qq_steam_owner）只能由主人自己改：它决定了"拉谁的好友列表"，
 * 群里随便一个人改了就能把整个群友名单指向别人的 Steam 好友。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import type { SteamService, FriendEntry } from './service.ts';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

/** 取当前会话的发送者 openid（工具身份的唯一来源） */
function senderOf(exec: { agent?: unknown }, manager: SessionManager): string | undefined {
  if (exec.agent === undefined) return undefined;
  return manager.findByAgent(exec.agent as DshAgent)?.senderId;
}

/**
 * 判断当前发言人能不能改主人账号。
 *
 * ownerOpenids 来自 access.c2cAllow（私聊白名单，也就是"主人是谁"）。
 * 没配白名单时退化为"只在私聊里允许"——群聊里绝不默认放行。
 */
function isOwner(exec: { agent?: unknown }, manager: SessionManager, ownerOpenids: string[]): boolean {
  const record = exec.agent === undefined ? undefined : manager.findByAgent(exec.agent as DshAgent);
  if (record === undefined) return false;
  if (ownerOpenids.length > 0) return ownerOpenids.includes(record.senderId);
  return record.scope === 'c2c';
}

export function registerSteamTools(
  ctx: Context,
  steam: SteamService,
  manager: SessionManager,
  logger: Logger,
  ownerOpenids: string[] = [],
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，Steam 工具未注册');
    return;
  }

  // ── qq_steam_bind ─────────────────────────────────────────
  tools.register({
    name: 'qq_steam_bind',
    description:
      '把**当前发言人**的 Steam 账号存进群友绑定表。只有在对方明确说出自己的 Steam 账号时才调用。'
      + 'account 接受 17 位 SteamID64、STEAM_0:1:xxx、[U:1:xxx]、个人主页链接、或自定义 ID（vanity）。'
      + '不能替别人绑定——身份永远取当前发言人。',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: '对方的 Steam 账号：SteamID64 / STEAM_0:1:xxx / [U:1:xxx] / 主页链接 / 自定义 ID',
        },
        alias: {
          type: 'string',
          description: '可选：群里平时怎么叫他（用于以后按名字查）。留空则用 Steam 昵称',
        },
      },
      required: ['account'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          steamId: { type: 'string' },
          personaName: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['steamId'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { personaName?: string; steamId: string };
        return [{ type: 'text', text: `已绑定 Steam 账号 ${v.personaName ?? v.steamId}` }];
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown>> {
      const { account, alias } = args as { account?: string; alias?: string };
      if (typeof account !== 'string' || account.trim() === '') {
        throw new Error('qq_steam_bind: `account` 不能为空');
      }
      const openid = senderOf(exec, manager);
      if (openid === undefined || openid === '') {
        throw new Error('qq_steam_bind: 取不到当前发言人身份，无法绑定');
      }

      const result = await steam.bind(openid, account, alias);

      // 回查昵称确认"绑对人"了 —— 绑错 SteamID 是这里最常见的错
      let personaName = '';
      if (steam.hasKey) {
        try {
          const check = await steam.lookup({ who: openid });
          personaName = check.people[0]?.personaName ?? '';
        } catch {
          // 查询失败不影响绑定结果，静默
        }
      }

      const notes: string[] = [];
      if (result.vanityResolved) notes.push('自定义 ID 已解析成 SteamID64');
      if (result.previous !== undefined && result.previous !== result.steamId) {
        notes.push(`已覆盖之前的绑定 ${result.previous}`);
      }
      if (personaName !== '') notes.push(`账号昵称是「${personaName}」，可让对方确认是不是本人`);
      else if (!steam.hasKey) notes.push('未配置 API Key，暂时无法回查昵称确认');

      return {
        steamId: result.steamId,
        ...(personaName !== '' ? { personaName } : {}),
        ...(notes.length > 0 ? { note: notes.join('；') } : {}),
      };
    },
  });

  // ── qq_steam_forget ───────────────────────────────────────
  tools.register({
    name: 'qq_steam_forget',
    description: '解除**当前发言人**自己的 Steam 绑定。对方说"别记我的 Steam 了"之类的话时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { removed: { type: 'boolean' } },
        required: ['removed'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { removed: boolean };
        return [{ type: 'text', text: v.removed ? '已解除 Steam 绑定' : '本来就没有绑定' }];
      },
    },
    async execute(_args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown>> {
      const openid = senderOf(exec, manager);
      if (openid === undefined || openid === '') {
        throw new Error('qq_steam_forget: 取不到当前发言人身份');
      }
      return { removed: steam.unbind(openid) };
    },
  });

  // ── qq_steam_owner ────────────────────────────────────────
  tools.register({
    name: 'qq_steam_owner',
    description:
      '查看或设置主人自己的 Steam 账号——它是「拉好友列表」的起点（Steam 没有按昵称找人的接口，必须有这么一个起点）。'
      + '不传 account 就是查看当前设置。只有主人本人能改，其他人说也不能改。'
      + 'account 接受 17 位 SteamID64、个人主页链接、或自定义 ID。',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: '要设成的账号：SteamID64 / 主页链接 / 自定义 ID。留空 = 只查看不改动',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          steamId: { type: 'string' },
          personaName: { type: 'string' },
          source: { type: 'string' },
          file: { type: 'string' },
          hasKey: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['steamId'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { personaName?: string; steamId: string; note?: string };
        const who = v.personaName !== undefined ? `${v.personaName}（${v.steamId}）` : v.steamId;
        return [{ type: 'text', text: v.note !== undefined ? `${who}。${v.note}` : who }];
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown>> {
      const { account } = args as { account?: string };

      // 查看：谁都能看（这只是"当前用的是哪个账号"，不是凭据）
      if (account === undefined || account.trim() === '') {
        const info = steam.ownerInfo();
        const notes: string[] = [];
        if (info.steamId === '') {
          notes.push('还没设主人账号。跟我说一句你的 Steam 主页地址就行，会记住，以后不用再给。');
        } else if (!info.hasKey) {
          notes.push('账号已记下，但还没配 API Key，暂时查不到状态。');
        }
        return {
          steamId: info.steamId,
          source: info.source,
          file: info.file,
          hasKey: info.hasKey,
          ...(notes.length > 0 ? { note: notes.join('') } : {}),
        };
      }

      // 修改：只有主人本人
      const openid = senderOf(exec, manager);
      if (openid === undefined || openid === '') {
        throw new Error('qq_steam_owner: 取不到当前发言人身份，无法判断是否有权限修改');
      }
      if (!isOwner(exec, manager, ownerOpenids)) {
        throw new Error('qq_steam_owner: 主人账号只有主人本人能改，请让他在私聊里说');
      }

      const result = await steam.setOwner(account);
      logger.info(`steam: 主人账号已改为 ${result.steamId}`);
      return {
        steamId: result.steamId,
        source: 'runtime',
        file: steam.ownerInfo().file,
        hasKey: steam.hasKey,
        ...(result.personaName !== undefined ? { personaName: result.personaName } : {}),
        ...(result.hint !== undefined ? { note: result.hint } : {}),
      };
    },
  });

  // ── qq_steam_lookup ───────────────────────────────────────
  tools.register({
    name: 'qq_steam_lookup',
    description:
      '查群友的 Steam 状态：谁在线、正在玩什么游戏、最近在玩什么。'
      + '适合在群里聊到游戏、有人问"最近玩什么"、或你想顺着游戏话题接一句话时用。'
      + 'who 留空 = 查所有已绑定的人，适合回答"群友最近都在玩啥"。'
      + '只看当前状态时不要传 include_recent（更快）；要聊"最近在玩什么"才传 true。',
    parameters: {
      type: 'object',
      properties: {
        who: {
          type: 'string',
          description: '要查的人：群里对他的称呼 / openid / SteamID64。留空或填 all 表示所有已绑定的人',
        },
        include_recent: {
          type: 'boolean',
          description: '是否附带最近两周玩过的游戏（每个账号一次 API 调用，较慢，按需使用）',
        },
        count: {
          type: 'integer',
          description: '每人返回几条最近游戏，默认 5，上限 10',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          people: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                alias: { type: 'string' },
                state: { type: 'string' },
                inGame: { type: 'string' },
                recent: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      hours2Weeks: { type: 'number' },
                      hoursForever: { type: 'number' },
                      lastPlayed: { type: 'string' },
                    },
                    additionalProperties: false,
                  },
                },
                note: { type: 'string' },
              },
              required: ['name', 'state'],
              additionalProperties: false,
            },
          },
          hint: { type: 'string' },
        },
        required: ['ok', 'summary'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { summary: string };
        return [{ type: 'text', text: v.summary }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { who, include_recent, count } = args as {
        who?: string;
        include_recent?: boolean;
        count?: number;
      };

      const result = await steam.lookup({
        ...(who !== undefined ? { who } : {}),
        includeRecent: include_recent === true,
        ...(count !== undefined ? { count } : {}),
      });

      // 致命问题要明确抛给模型，让它如实告诉群友。
      // 例外：限流但已经查到一部分人时，宁可把半截结果给出去，也不要整条丢弃。
      const partialOnRateLimit = result.error?.kind === 'rate-limit' && result.people.length > 0;
      if (!result.ok && result.error !== undefined && !partialOnRateLimit) {
        const { kind, message } = result.error;
        if (kind === 'no-key' || kind === 'unauthorized' || kind === 'rate-limit' || kind === 'disabled') {
          throw new Error(`${message}${result.hint !== undefined ? `。${result.hint}` : ''}`);
        }
      }

      const people = result.people.map((p) => ({
        name: p.personaName !== '' ? p.personaName : (p.alias ?? p.steamId),
        ...(p.alias !== undefined ? { alias: p.alias } : {}),
        state: p.state,
        ...(p.inGame !== undefined ? { inGame: p.inGame } : {}),
        ...(p.recent !== undefined ? { recent: p.recent } : {}),
        ...(p.note !== undefined ? { note: p.note } : {}),
      }));

      const summary = buildSummary(people, result.ok, result.error?.message);
      logger.info(`steam: 查询 ${who ?? 'all'} → ${people.length} 人${include_recent === true ? '（含最近游戏）' : ''}`);

      return {
        ok: result.ok,
        summary,
        people,
        ...(result.hint !== undefined ? { hint: result.hint } : {}),
      };
    },
  });

  // ── qq_steam_friends ───────────────────────────────────────
  tools.register({
    name: 'qq_steam_friends',
    description:
      '拉某个人的 Steam 好友列表：昵称、个人主页地址（steamcommunity.com/id/…）、当前在玩什么。'
      + '适合回答"我好友里有谁""谁在打游戏"。'
      + '前提：对方的 Steam 隐私里「好友列表」必须是公开的，否则 Steam 直接拒绝（返回 401），'
      + '这时要提醒对方去改设置，不要编造好友名单。',
    parameters: {
      type: 'object',
      properties: {
        who: {
          type: 'string',
          description: '查谁的好友列表：SteamID64 / 个人主页链接 / 自定义 ID。留空则用配置里的主人账号',
        },
        only_in_game: {
          type: 'boolean',
          description: '只要正在玩游戏的（筛掉离线的人）。默认 false 返回全部',
        },
        limit: {
          type: 'integer',
          description: '最多返回多少人，默认 50，上限 200',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          total: { type: 'integer' },
          /** 其中已经和 QQ 用户对上号的人数 */
          boundCount: { type: 'integer' },
          filtered: { type: 'boolean' },
          hint: { type: 'string' },
          friends: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                steamId: { type: 'string' },
                profileUrl: { type: 'string' },
                state: { type: 'string' },
                inGame: { type: 'string' },
                /** 已经绑定时的群内称呼；没有 = 还不知道这人是群里的谁 */
                boundAs: { type: 'string' },
              },
              required: ['name', 'steamId'],
              additionalProperties: false,
            },
          },
        },
        required: ['ok', 'summary'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { summary: string };
        return [{ type: 'text', text: v.summary }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { who, only_in_game, limit } = args as {
        who?: string;
        only_in_game?: boolean;
        limit?: number;
      };

      const result = await steam.listFriends(who);

      // 这些是「必须让模型知道真相」的失败，不能让模型编个名单糊过去
      if (!result.ok && result.error !== undefined) {
        const { kind, message } = result.error;
        if (kind === 'friendlist-private' || kind === 'no-key' || kind === 'no-owner' || kind === 'unauthorized' || kind === 'rate-limit' || kind === 'disabled') {
          throw new Error(`${message}${result.hint !== undefined ? `。${result.hint}` : ''}`);
        }
      }

      const cap = Math.min(Math.max(limit ?? 50, 1), 200);
      const all = result.friends;
      const filtered = only_in_game === true;
      const shown = (filtered ? all.filter((f) => f.inGame !== undefined) : all).slice(0, cap);

      const friends = shown.map((f) => ({
        name: f.name,
        steamId: f.steamId,
        ...(f.profileUrl !== undefined ? { profileUrl: f.profileUrl } : {}),
        state: f.stateText,
        ...(f.inGame !== undefined ? { inGame: f.inGame } : {}),
        ...(f.boundAs !== undefined ? { boundAs: f.boundAs } : {}),
      }));

      // 已绑定人数只作为结构化数据返回，不写进 summary：
      // 群里不是人人都有 Steam 账号，主动念"还有 N 人没对上号"是骚扰，
      // 绑定一律等对方自己说（qq_steam_bind）。
      const boundCount = all.filter((f) => f.boundAs !== undefined).length;
      const summary = buildFriendSummary(result.owner, all, shown, filtered, cap);
      logger.info(
        `steam: 好友列表 → 共 ${all.length} 人（已绑定 ${boundCount} 人），返回 ${shown.length} 人`
        + `${filtered ? '（只看游戏中）' : ''}`,
      );

      return {
        ok: result.ok,
        summary,
        total: all.length,
        boundCount,
        filtered,
        friends,
        ...(result.hint !== undefined ? { hint: result.hint } : {}),
      };
    },
  });

  logger.info('im-qqbot: Steam 工具已注册（qq_steam_bind / qq_steam_forget / qq_steam_lookup / qq_steam_friends / qq_steam_owner）');
}

/** 好友列表的摘要：先按「正在玩 / 在线 / 离线」分层，模型最常直接复述这段 */
function buildFriendSummary(
  owner: FriendEntry | undefined,
  all: FriendEntry[],
  shown: FriendEntry[],
  filtered: boolean,
  cap: number,
): string {
  if (all.length === 0) return '好友列表是空的（或者对方一个好友都没有）';

  const ownerText = owner !== undefined && owner.name !== '' ? `「${owner.name}」的` : '';
  const lines: string[] = [`${ownerText}好友列表：共 ${all.length} 人`];

  const playing = all.filter((f) => f.inGame !== undefined);
  if (playing.length > 0) {
    lines.push(`🎮 正在玩：${playing.map((f) => `${f.name}（${f.inGame as string}）`).join('、')}`);
  }

  const online = all.filter((f) => f.inGame === undefined && f.stateText !== '离线');
  if (online.length > 0) {
    lines.push(`在线：${online.map((f) => `${f.name}（${f.stateText}）`).join('、')}`);
  }

  const offlineCount = all.length - playing.length - online.length;
  if (offlineCount > 0) lines.push(`离线：${offlineCount} 人`);

  if (shown.length < (filtered ? playing.length : all.length)) {
    lines.push(`（下面只列出前 ${cap} 人，需要更多可以说一声）`);
  }
  return lines.join('\n');
}

interface RenderedPerson {
  name: string;
  alias?: string;
  state: string;
  inGame?: string;
  recent?: Array<{ name: string; hours2Weeks: number; hoursForever: number; lastPlayed: string }>;
  note?: string;
}

/** 拼一句人话摘要（工具结果同时给模型看，summary 是它最可能直接复述的部分） */
function buildSummary(people: RenderedPerson[], ok: boolean, warning?: string): string {
  if (people.length === 0) return ok ? '没有可查的人' : '查询失败';

  const parts = people.map((p) => {
    const head = p.alias !== undefined && p.alias !== p.name ? `${p.alias}（${p.name}）` : p.name;
    const playing = p.inGame !== undefined ? `正在玩 ${p.inGame}` : p.state;
    const recent = p.recent !== undefined && p.recent.length > 0
      ? `；最近玩过 ${p.recent.slice(0, 3).map((g) => g.name).join('、')}`
      : '';
    const note = p.note !== undefined ? `（${p.note}）` : '';
    return `${head}：${playing}${recent}${note}`;
  });

  // 只在"有不完整结果"时补一句，避免模型把半截数据当成全部
  const tail = !ok && warning !== undefined ? `\n（注意：${warning}，以上结果可能不完整）` : '';
  return parts.join('\n') + tail;
}
