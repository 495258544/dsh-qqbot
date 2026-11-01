/**
 * Steam Web API 客户端（零依赖，只用 fetch）
 * ─────────────────────────────────────────────────────────────
 * 只用三个端点，全部是只读：
 *   ISteamUser/GetPlayerSummaries/v2      昵称 / 在线状态 / 当前游戏（批量，单次上限 100）
 *   IPlayerService/GetRecentlyPlayedGames 最近两周玩过的游戏（单账号）
 *   ISteamUser/ResolveVanityURL/v1        自定义 ID → SteamID64
 *
 * 刻意不引入 steamapi 之类的封装库：
 *   - 它们是 ESM-only，且不做分批 / 不做限流，省不了多少事；
 *   - 批量返回不保证顺序，封装库也不帮你按 steamid 重排，容易把 A 的状态贴到 B 头上；
 *   - 这里需要把「空 response（隐私限制）」和「网络错误」分开，好给群友准确的回复文案。
 *
 * 速率：官方条款 100,000 次/天（按 key 计），未公布每秒限制。
 * 本文件只做单次请求的可靠性，缓存与节流在 service 层。
 */

const API_BASE = 'https://api.steampowered.com';

/** 批量查询单次上限（官方文档 max: 100） */
const MAX_IDS_PER_CALL = 100;

export type SteamErrorKind =
  | 'no-key'      // 没配 API key
  | 'unauthorized' // key 无效 / 被吊销（HTTP 403）
  | 'rate-limit'  // 触发限流（HTTP 429）
  | 'friendlist-private' // 对方把「好友列表」设为私密（GetFriendList 返回 401）
  | 'network'     // 超时 / 连接失败
  | 'http';       // 其它非 2xx

export class SteamApiError extends Error {
  readonly kind: SteamErrorKind;
  readonly status?: number;

  constructor(kind: SteamErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'SteamApiError';
    this.kind = kind;
    this.status = status;
  }
}

/** GetPlayerSummaries 的裁剪结果（只留聊天用得上的字段） */
export interface PlayerSummary {
  steamId: string;
  personaName: string;
  /**
   * 资料完整地址，形如 https://steamcommunity.com/id/GabeLoganNewell/
   * 走 ID 自定义名的会带 /id/，没设自定义名的自动是 /profiles/<id64>/。
   * 这是唯一能拿到「对方自定义 ID」的字段——ResolveVanityURL 只能正查，不能反查。
   */
  profileUrl?: string;
  /** 0 离线 / 1 在线 / 2 忙碌 / 3 离开 / 4 打盹 / 5 想交易 / 6 想组队 */
  personaState: number;
  personaStateText: string;
  /** 1 = 不可见（私密/仅好友），3 = 公开 */
  visibility: number;
  /** 当前在玩的 AppID（不在游戏中则没有） */
  gameId?: string;
  /** 当前在玩的游戏名 */
  gameName?: string;
  /** 上次下线时间（unix 秒） */
  lastLogoffAt?: number;
  avatar?: string;
}

/** 好友列表的一条 record */
export interface FriendRecord {
  steamId: string;
  /** 成为好友的时间（unix 秒，部分账号为 0） */
  friendSince: number;
}

/** 最近游戏的一条记录 */
export interface RecentGame {
  appId: number;
  name: string;
  /** 最近两周游戏分钟数 */
  minutes2Weeks: number;
  /** 总游戏分钟数 */
  minutesForever: number;
  /** 最后一次游玩时间（unix 秒，0 = 未知） */
  lastPlayedAt: number;
  iconUrl: string;
}

/** personastate → 中文状态 */
export function personaStateText(state: number): string {
  switch (state) {
    case 1: return '在线';
    case 2: return '忙碌';
    case 3: return '离开';
    case 4: return '打盹';
    case 5: return '想交易';
    case 6: return '想组队';
    default: return '离线';
  }
}

export interface SteamApiOptions {
  apiKey: string;
  timeoutMs?: number;
}

export class SteamApi {
  /** 可变：key 是运行时数据（存在数据目录里），换 key 不该重建整个 service */
  private apiKey: string;
  private readonly timeoutMs: number;

  constructor({ apiKey, timeoutMs = 8000 }: SteamApiOptions) {
    this.apiKey = apiKey.trim();
    this.timeoutMs = timeoutMs;
  }

  get configured(): boolean {
    return this.apiKey !== '';
  }

  /** 运行时换 key（命令行 / 选项面板改了之后即刻生效，不用重启宿主） */
  setApiKey(apiKey: string): void {
    this.apiKey = (apiKey ?? '').trim();
  }

  /** 当前生效的 key（仅用于与数据目录比对判断是否需要换，不要拿去打印） */
  get currentApiKey(): string {
    return this.apiKey;
  }

  /** 统一 GET + 错误分类 + 超时 */
  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    if (!this.configured) {
      throw new SteamApiError('no-key', '未配置 Steam Web API Key');
    }
    const url = new URL(`${API_BASE}${path}`);
    url.searchParams.set('key', this.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SteamApiError('network', `请求 Steam API 失败: ${reason}`);
    }

    if (res.status === 403) {
      throw new SteamApiError('unauthorized', 'Steam API Key 无效或已被吊销（HTTP 403）', 403);
    }
    if (res.status === 429) {
      throw new SteamApiError('rate-limit', 'Steam API 限流（HTTP 429），稍后再试', 429);
    }
    if (!res.ok) {
      throw new SteamApiError('http', `Steam API 返回 HTTP ${res.status}`, res.status);
    }

    try {
      return (await res.json()) as T;
    } catch {
      throw new SteamApiError('http', 'Steam API 返回的不是合法 JSON');
    }
  }

  /**
   * 批量查玩家摘要。超过 100 个会自动分批。
   * 返回 Map 而不是数组：Steam 不保证返回顺序，按 id 建索引才不会串人。
   */
  async getSummaries(steamIds: string[]): Promise<Map<string, PlayerSummary>> {
    const unique = [...new Set(steamIds.filter((id) => id !== ''))];
    const result = new Map<string, PlayerSummary>();

    for (let i = 0; i < unique.length; i += MAX_IDS_PER_CALL) {
      const batch = unique.slice(i, i + MAX_IDS_PER_CALL);
      const data = await this.get<{
        response?: { players?: RawPlayer[] };
      }>('/ISteamUser/GetPlayerSummaries/v2/', { steamids: batch.join(',') });

      for (const p of data.response?.players ?? []) {
        const steamId = String(p.steamid ?? '');
        if (steamId === '') continue;
        result.set(steamId, toSummary(p));
      }
    }

    return result;
  }

  /** 最近两周玩过的游戏。单账号端点，不支持批量。 */
  async getRecentlyPlayed(steamId: string, count = 0): Promise<RecentGame[]> {
    const data = await this.get<{
      response?: { games?: RawRecentGame[] };
    }>('/IPlayerService/GetRecentlyPlayedGames/v1/', {
      steamid: steamId,
      ...(count > 0 ? { count: String(count) } : {}),
    });

    // 隐私受限时 response 是空对象 {}，不是错误——返回空数组由上层解释
    const games = data.response?.games;
    if (!Array.isArray(games)) return [];

    return games
      .filter((g) => typeof g.appid === 'number')
      .map((g) => ({
        appId: g.appid as number,
        name: String(g.name ?? `App ${g.appid}`),
        minutes2Weeks: Number(g.playtime_2weeks ?? 0),
        minutesForever: Number(g.playtime_forever ?? 0),
        lastPlayedAt: Number(g.rtime_last_played ?? 0),
        iconUrl: `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${String(g.img_icon_url ?? '')}.jpg`,
      }));
  }

  /**
   * 拉好友列表。**只有对方把「好友列表」设成公开时才拿得到**。
   *
   * 实测行为（2026-10）：
   *   - 好友列表公开 → 200 + friends 数组
   *   - 好友列表私密 → 401 + 空 body `{}`（不是 403，别混淆成 key 无效）
   *   - steamid 不是个人号（群组号等）→ 400 + HTML 错误页
   *
   * 注意：只返回 steamid，昵称/头像要再调 getSummaries。
   */
  async getFriendList(steamId: string): Promise<FriendRecord[]> {
    let data: { friendslist?: { friends?: Array<{ steamid?: string; friend_since?: number }> } };
    try {
      data = await this.get('/ISteamUser/GetFriendList/v1/', { steamid: steamId, relationship: 'friend' });
    } catch (err) {
      if (err instanceof SteamApiError && err.status === 401) {
        // 401 在别的端点意味着鉴权失败，但 GetFriendList 用它表示「好友列表不可见」
        throw new SteamApiError(
          'friendlist-private',
          '对方把「好友列表」设成了私密，Steam 不允许第三方读取',
          401,
        );
      }
      if (err instanceof SteamApiError && err.status === 400) {
        throw new SteamApiError('http', `${steamId} 不是有效的个人 Steam 账号（可能是群组号或已注销）`, 400);
      }
      throw err;
    }

    return (data.friendslist?.friends ?? [])
      .filter((f) => typeof f.steamid === 'string' && f.steamid !== '')
      .map((f) => ({ steamId: f.steamid as string, friendSince: Number(f.friend_since ?? 0) }));
  }

  /** 自定义 ID → SteamID64；找不到抛 not-found 语义的 http 错误 */
  async resolveVanity(vanity: string): Promise<string> {
    const data = await this.get<{
      response?: { success?: number; steamid?: string; message?: string };
    }>('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: vanity });

    const resp = data.response;
    if (resp?.success === 1 && typeof resp.steamid === 'string' && resp.steamid !== '') {
      return resp.steamid;
    }
    throw new SteamApiError('http', `找不到自定义 ID "${vanity}" 对应的账号${resp?.message ? `（${resp.message}）` : ''}`);
  }
}

interface RawPlayer {
  steamid?: string;
  personaname?: string;
  profileurl?: string;
  personastate?: number;
  communityvisibilitystate?: number;
  gameid?: string;
  gameextrainfo?: string;
  lastlogoff?: number;
  avatarfull?: string;
  avatar?: string;
}

interface RawRecentGame {
  appid?: number;
  name?: string;
  playtime_2weeks?: number;
  playtime_forever?: number;
  rtime_last_played?: number;
  img_icon_url?: string;
}

function toSummary(p: RawPlayer): PlayerSummary {
  const state = Number(p.personastate ?? 0);
  const summary: PlayerSummary = {
    steamId: String(p.steamid ?? ''),
    personaName: String(p.personaname ?? ''),
    personaState: state,
    personaStateText: personaStateText(state),
    visibility: Number(p.communityvisibilitystate ?? 0),
  };
  if (p.gameid !== undefined) summary.gameId = String(p.gameid);
  if (p.gameextrainfo !== undefined && p.gameextrainfo !== '') summary.gameName = p.gameextrainfo;
  if (typeof p.profileurl === 'string' && p.profileurl !== '') summary.profileUrl = p.profileurl;
  if (typeof p.lastlogoff === 'number') summary.lastLogoffAt = p.lastlogoff;
  const avatar = p.avatarfull ?? p.avatar;
  if (avatar !== undefined && avatar !== '') summary.avatar = avatar;
  return summary;
}
