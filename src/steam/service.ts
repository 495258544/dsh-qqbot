/**
 * Steam 服务 — 缓存 / 节流 / 主动感知快照
 * ─────────────────────────────────────────────────────────────
 * 为什么需要这一层：
 *   - GetRecentlyPlayedGames 只能一人一次，50 个绑定用户就是 50 次调用；
 *   - 群聊可能一分钟问三次"谁在玩啥"，没有缓存会直接打穿配额；
 *   - system prompt 注入不能阻塞 turn 组装，所以对外只暴露同步的 peekSection()。
 *
 * 缓存分层（TTL 见 config）：
 *   summary 60s   —— 在线状态和当前游戏变化快，但一次能覆盖 100 人，很便宜
 *   recent  15min —— Steam 侧本身不实时，且一人一次调用，必须压住
 *   负面结果 10min —— 私密/查不到也缓存，防止对隐私账号反复打空
 */
import { homedir } from 'node:os';
import path from 'node:path';
import type { SteamConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { BindingStore, type BindingHit } from './bindings.ts';
import { SettingsStore } from './settings.ts';
import { SteamApi, SteamApiError, type PlayerSummary, type RecentGame } from './steam-api.ts';
import { parseSteamInput, steam64ToSteam2, steamProfileUrl, isSteamId64 } from './steam-id.ts';

/** 一条给人看的 Steam 状态 */
export interface PersonStatus {
  openid: string;
  alias?: string;
  steamId: string;
  personaName: string;
  /** 在线状态文案（在线/忙碌/离开/离线…） */
  state: string;
  /** 正在玩的游戏；不在游戏中则没有 */
  inGame?: string;
  /**
   * Steam 资料是否公开（communityvisibilitystate === 3）。
   * 注意：资料公开 ≠ 游戏详情公开 —— 「游戏详情」是独立开关，API 层也没法区分
   * 「真的没在玩」和「详情设成仅好友」，所以这里只表达资料可见性。
   */
  profilePublic: boolean;
  profileUrl: string;
  /** 最近游戏（仅 includeRecent 时填充） */
  recent?: Array<{
    name: string;
    hours2Weeks: number;
    hoursForever: number;
    lastPlayed: string;
  }>;
  /** 该条结果的补充说明（隐私受限 / 未绑定等） */
  note?: string;
}

export interface SteamLookupResult {
  ok: boolean;
  people: PersonStatus[];
  /** 致命错误（没 key / key 失效 / 限流），tool 层据此决定是否抛给模型 */
  error?: { kind: string; message: string };
  /** 面向模型的行动建议（如引导群友改隐私设置） */
  hint?: string;
}

export interface SteamLookupOptions {
  /** openid / SteamID64 / 别名；空或 'all' 表示全部已绑定的人 */
  who?: string;
  includeRecent?: boolean;
  /** 每人返回几条最近游戏 */
  count?: number;
}

/** 好友列表里的一个人 */
export interface FriendEntry {
  steamId: string;
  /** 成为好友的时间（unix 秒；部分账号为 0） */
  friendSince: number;
  name: string;
  /** https://steamcommunity.com/id/xxx/ 或 /profiles/<id64>/ */
  profileUrl?: string;
  /** 在线 / 离线 / 游戏中… */
  stateText: string;
  /** 当前在玩的游戏名 */
  inGame?: string;
  /** 1 = 资料不可见，3 = 公开 */
  visibility: number;
  /**
   * 这个人已经和哪个 QQ 用户对上号了（绑定表里的称呼）。
   * 空 = 好友里有他，但群里还不知道是谁 —— 这正是"新朋友"要靠自助绑定补上的缺口。
   */
  boundAs?: string;
}

export interface FriendListResult {
  ok: boolean;
  /** 被查的那个人（好友列表的起点） */
  owner?: FriendEntry;
  friends: FriendEntry[];
  /** 好友里已经和 QQ 用户对上号的人数 */
  boundCount?: number;
  error?: { kind: string; message: string };
  /** 面向模型的行动建议（如引导改隐私设置） */
  hint?: string;
}

/** 主人账号的当前状态（qq_steam_owner 回执用） */
export interface OwnerInfo {
  steamId: string;
  /** config = 从插件选项采纳；runtime = 命令行/聊天里设定的；none = 还没设 */
  source: 'config' | 'runtime' | 'none';
  /** 落盘位置，方便备份/迁移 */
  file: string;
  /** 是否已配置 API Key（决定能不能真的查到东西） */
  hasKey: boolean;
  updatedAt?: number;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

/** 主动感知快照的最小刷新间隔（与 summary TTL 对齐，避免频繁打 API） */
const SNAPSHOT_MIN_INTERVAL_MS = 60_000;
/** 快照被视为"新鲜"的时长，超过则触发后台刷新但仍返回旧内容 */
const SNAPSHOT_FRESH_MS = 90_000;

export class SteamService {
  private readonly config: SteamConfig;
  private readonly logger: Logger;
  private readonly api: SteamApi;
  readonly bindings: BindingStore;
  /** 凭据与主人账号：跟着数据目录走，插件选项只做一次性采纳 */
  readonly settings: SettingsStore;

  /** 只存真实结果。"查不到"走 missingCache，避免两种 TTL 互相遮蔽 */
  private readonly summaryCache = new Map<string, CacheEntry<PlayerSummary>>();
  /** 隐私账号/查不到的负缓存，避免反复打空 */
  private readonly missingCache = new Map<string, CacheEntry<true>>();
  private readonly recentCache = new Map<string, CacheEntry<RecentGame[]>>();
  /** 同一 SteamID 的并发请求合并（单飞） */
  private readonly inFlight = new Map<string, Promise<RecentGame[]>>();
  /**
   * 批量摘要的串行锁。
   *
   * 不要用"轮次上限"来做并发合并：轮次只能靠猜，而排队长度是运行时才知道的
   * （按单次 id 数猜会让 4 路异批并发必然饿死第 4 路，已两轮复验复现）。
   * 这里改成真正的排队：一次只允许一个批量请求在飞，其余在锁上等。
   */
  private summaryLock: Promise<void> = Promise.resolve();

  /** 主动感知快照（供 system prompt 注入，同步读取） */
  private snapshot: { at: number; sections: string[] } | undefined;
  private refreshing: Promise<string[]> | undefined;

  constructor({ config, logger }: { config: SteamConfig; logger: Logger }) {
    this.config = config;
    this.logger = logger;

    const dir = config.dataDir !== ''
      ? path.resolve(config.dataDir)
      : path.resolve(homedir(), '.dsh-qqbot', 'steam');

    this.bindings = new BindingStore(dir, logger);
    this.bindings.syncFromConfig(config.friends);

    // 先结算凭据：插件选项里的值只在「和上次消费过的不同」时采纳一次，
    // 之后一切增删改都落在这个文件里，改 key / 换账号都不必再动 profile。
    this.settings = new SettingsStore(dir, logger);
    this.settings.applyConfig({ ownerSteamId: config.ownerSteamId, apiKey: config.apiKey });
    this.api = new SteamApi({ apiKey: this.settings.apiKey, timeoutMs: config.timeoutMs });

    if (!this.api.configured) {
      logger.warn('steam: 未配置 apiKey —— Steam 工具会提示用户去申请，绑定表仍可用');
    } else {
      logger.info(
        `steam: 已就绪（绑定 ${this.bindings.size()} 人，数据目录 ${dir}`
        + `${this.settings.ownerSteamId !== '' ? `，主人账号 ${this.settings.ownerSteamId}` : '，主人账号未设置'}）`,
      );
      // 预热一次快照，让第一轮对话就有内容；失败静默（没有 key 之外的错误大多可自愈）
      void this.refreshSnapshot().catch(() => {});
    }
  }

  /**
   * 把数据目录里的 key 同步给 API 客户端。
   *
   * 命令行脚本（另一个进程）改了 key 之后，这里靠 SettingsStore 的 mtime 热重读
   * 能立刻看到新值 —— 用户不必重启宿主。
   */
  private syncApiKey(): void {
    const key = this.settings.apiKey;
    if (key !== this.api.currentApiKey) this.api.setApiKey(key);
  }

  // ── 主人账号 / 凭据 ─────────────────────────────────────────

  /** 当前主人账号（没有则 steamId 为空串） */
  ownerInfo(): OwnerInfo {
    this.syncApiKey();
    const s = this.settings.get();
    return {
      steamId: s.ownerSteamId,
      source: s.ownerSteamId === '' ? 'none' : (s.ownerSource ?? 'runtime'),
      file: this.settings.filePath,
      hasKey: this.api.configured,
      ...(s.ownerUpdatedAt !== undefined ? { updatedAt: s.ownerUpdatedAt } : {}),
    };
  }

  /**
   * 设定主人账号（聊天里说一句就改，不用碰 YAML）。
   *
   * 接受一切 parseSteamInput 支持的形态，vanity 会就地解析成 SteamID64 ——
   * 只有 ID64 才落盘，因为 vanity 随时可能被对方改掉。
   */
  async setOwner(account: string): Promise<{ steamId: string; personaName?: string; hint?: string }> {
    this.syncApiKey();
    const raw = account.trim();
    if (raw === '') throw new Error('setOwner: 账号不能为空');
    const steamId = await this.resolveOneSteamId(raw);
    this.settings.setOwner(steamId, 'runtime');

    let personaName: string | undefined;
    let hint: string | undefined;
    if (this.api.configured) {
      try {
        const summary = (await this.summaries([steamId])).get(steamId);
        personaName = summary?.personaName;
      } catch {
        // 查昵称只是确认用，失败不影响写入
      }
      try {
        // 顺手验证一次好友列表能不能拉到 —— 拉不到通常是隐私没开，早知道比晚知道好
        await this.api.getFriendList(steamId);
      } catch (err) {
        if (err instanceof SteamApiError && err.kind === 'friendlist-private') {
          hint =
            '这个账号的「好友列表」不是公开的（Steam 返回 401）。去 Steam → 个人资料 → 编辑个人资料 → '
            + '隐私设置，把「好友列表」改成「公开」，否则查不到好友。';
        }
      }
    } else {
      hint = '还没配 API Key，账号已记下，但暂时查不了状态。';
    }
    return { steamId, ...(personaName !== undefined ? { personaName } : {}), ...(hint !== undefined ? { hint } : {}) };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get hasKey(): boolean {
    return this.api.configured;
  }

  // ── 缓存读写 ────────────────────────────────────────────────

  private fresh<T>(entry: CacheEntry<T> | undefined, ttlMs: number): T | undefined {
    if (entry === undefined) return undefined;
    return Date.now() - entry.at < ttlMs ? entry.value : undefined;
  }

  /** 纯读缓存，不联网 */
  private collectSummaries(steamIds: string[]): { result: Map<string, PlayerSummary>; need: string[] } {
    const ttl = this.config.summaryTtlSec * 1000;
    const missingTtl = this.config.negativeTtlSec * 1000;
    const result = new Map<string, PlayerSummary>();
    const need: string[] = [];

    for (const id of steamIds) {
      const cached = this.fresh(this.summaryCache.get(id), ttl);
      if (cached !== undefined) {
        result.set(id, cached);
        continue;
      }
      // 查不到（账号注销/被删）的短期内不再打。
      // 注意顺序：这里不能用 summaryCache 存空值，否则负缓存 TTL 会被摘要 TTL 遮蔽，
      // 配 negativeTtlSec 就只变长不变短（已被复验抓到的真实缺陷）。
      if (this.fresh(this.missingCache.get(id), missingTtl) !== undefined) continue;
      need.push(id);
    }
    return { result, need };
  }

  /**
   * 批量取摘要：缓存优先 + 单飞合并。
   *
   * 这里必须是有限次循环，不能"等一次在飞请求就返回"：
   * 在飞的那一批可能并不包含本次要的 id，等它落地后必须再看一眼还缺什么、
   * 自己补发。否则会静默丢人，还会对外谎报「查不到这个账号」—— 复验已复现。
   */
  private async summaries(steamIds: string[]): Promise<Map<string, PlayerSummary>> {
    const cached = this.collectSummaries(steamIds);
    if (cached.need.length === 0) return cached.result;

    // 排队等锁；拿到锁后必须**重新**读缓存：
    //   - 同一批人并发（如 3 路 who:'all'）：前一个请求已经把它们全查回来了，
    //     这里 need 变空，直接返回 —— 因此只发 1 次请求；
    //   - 不同批并发（A/B/C/D 各查各的）：前一个只查了 A，这里 need 仍是自己的，
    //     于是自己补发 —— 没有轮次上限，不会被饿死。
    const previous = this.summaryLock;
    let release!: () => void;
    this.summaryLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const { result, need } = this.collectSummaries(steamIds);
      if (need.length === 0) return result;

      const fetched = await this.api.getSummaries(need);
      const now = Date.now();
      for (const id of need) {
        const hit = fetched.get(id);
        if (hit !== undefined) {
          this.summaryCache.set(id, { at: now, value: hit });
        } else {
          // API 没返回这个 id：账号不存在，或对方把资料锁到连摘要都不给
          this.missingCache.set(id, { at: now, value: true });
        }
      }
      return this.collectSummaries(steamIds).result;
    } finally {
      // 无论成败都放锁，否则一个失败会把后面所有人堵死
      release();
    }
  }

  /** 该 id 是否已被 API 确认查不到（而不是"这次没来得及查"） */
  private isConfirmedMissing(steamId: string): boolean {
    return this.fresh(this.missingCache.get(steamId), this.config.negativeTtlSec * 1000) !== undefined;
  }

  /** 取最近游戏（带缓存 + 单飞，避免同一人并发打两次） */
  private async recentGames(steamId: string, count: number): Promise<RecentGame[]> {
    const cached = this.fresh(this.recentCache.get(steamId), this.config.recentTtlSec * 1000);
    if (cached !== undefined) return count > 0 ? cached.slice(0, count) : cached;

    const running = this.inFlight.get(steamId);
    if (running !== undefined) {
      const games = await running;
      return count > 0 ? games.slice(0, count) : games;
    }

    const task = this.api
      .getRecentlyPlayed(steamId)
      .then((games) => {
        this.recentCache.set(steamId, { at: Date.now(), value: games });
        return games;
      })
      .finally(() => {
        this.inFlight.delete(steamId);
      });

    this.inFlight.set(steamId, task);
    const games = await task;
    return count > 0 ? games.slice(0, count) : games;
  }

  // ── 绑定 ────────────────────────────────────────────────────

  /**
   * 绑定一条账号。
   * openid 必须来自消息发送者（tool 层从 SessionRecord.senderId 取），不接受模型传入。
   */
  async bind(openid: string, account: string, alias?: string): Promise<{
    steamId: string;
    vanityResolved: boolean;
    previous?: string;
  }> {
    const parsed = parseSteamInput(account);
    if (parsed.kind === 'invalid') throw new Error(parsed.reason);

    let steamId: string;
    let vanityResolved = false;
    if (parsed.kind === 'id64') {
      steamId = parsed.id64;
    } else {
      if (!this.api.configured) {
        throw new Error('解析自定义 ID 需要 Steam Web API Key，当前未配置；可以直接发 17 位 SteamID64 或个人主页链接');
      }
      steamId = await this.api.resolveVanity(parsed.vanity);
      vanityResolved = true;
    }

    const previous = this.bindings.get(openid)?.steamId;
    this.bindings.set(openid, {
      steamId,
      ...(alias !== undefined && alias !== '' ? { alias } : {}),
      boundAt: Date.now(),
      source: 'self',
    });
    // 绑完立刻把该用户的状态拉热，下一次聊天就能用上
    void this.summaries([steamId]).catch(() => {});
    this.logger.info(`steam: 绑定 openid=${openid.slice(0, 8)}… → ${steamId}${vanityResolved ? '（vanity 已解析）' : ''}`);

    return { steamId, vanityResolved, ...(previous !== undefined ? { previous } : {}) };
  }

  unbind(openid: string): boolean {
    const ok = this.bindings.remove(openid);
    if (ok) this.logger.info(`steam: 解绑 openid=${openid.slice(0, 8)}…`);
    return ok;
  }

  /**
   * 启动自检：确认「网络能出去」+「Key 可用」。
   *
   * 这两件事在部署时最容易出问题，而且失败时的表现是"查谁都查不到"，
   * 很难和"对方没公开资料"区分。所以启动时主动探一次，把结论写进日志。
   * 用 Gabe Newell 的公开账号作探针：资料公开、永远在线、不涉及任何群友。
   */
  async selfCheck(): Promise<void> {
    this.syncApiKey();
    if (!this.api.configured) {
      this.logger.info('steam: 未配置 apiKey，跳过连通性自检（绑定/解析仍可用，查询不可用）');
      return;
    }
    const probe = '76561197960287930';
    try {
      const map = await this.api.getSummaries([probe]);
      const hit = map.get(probe);
      if (hit === undefined) {
        this.logger.warn('steam: 自检请求成功但没返回数据，网络可能被中间设备改写，请留意查询结果');
        return;
      }
      this.logger.info(`steam: 自检通过（网络 OK，Key 有效，探针返回 "${hit.personaName}"）`);
    } catch (err) {
      const kind = err instanceof SteamApiError ? err.kind : 'unknown';
      const detail = err instanceof Error ? err.message : String(err);
      if (kind === 'network') {
        this.logger.warn(`steam: 自检失败——连不上 api.steampowered.com（${detail}）。国内网络可能需要代理才能访问 Steam，此时 Steam 查询全部不可用；Dota2 走 OpenDota，不受影响`);
      } else if (kind === 'unauthorized') {
        this.logger.warn(`steam: 自检失败——API Key 无效（${detail}）。去 https://steamcommunity.com/dev/apikey 重新申请`);
      } else {
        this.logger.warn(`steam: 自检失败（${kind}）：${detail}`);
      }
    }
  }

  // ── 好友列表 ────────────────────────────────────────────────
  /**
   * 拉某人的 Steam 好友列表（昵称 + 个人主页地址 + 当前状态）。
   *
   * 两个硬前提，缺一个都拿不到：
   *   1. 必须指定一个「起点」steamid（要查谁的好友）；不传就用 config.ownerSteamId；
   *   2. 这个人必须把 Steam 隐私里的「好友列表」设成公开 —— 否则 Steam 直接 401。
   *
   * 顺带说明：Steam 没有任何「按昵称查人」的接口，只有 GetFriendList 这一条路能批量拿到
   * 一串人，所以「主人是谁」必须显式配置，猜不出来。
   */
  async listFriends(input?: string): Promise<FriendListResult> {
    if (!this.config.enabled) {
      return { ok: false, friends: [], error: { kind: 'disabled', message: 'Steam 功能未启用（config.steam.enabled=false）' } };
    }
    if (!this.api.configured) {
      return {
        ok: false,
        friends: [],
        error: { kind: 'no-key', message: '未配置 Steam Web API Key' },
        hint: '去 https://steamcommunity.com/dev/apikey 申请（免费，2 分钟），填进 config.steam.apiKey',
      };
    }

    this.syncApiKey();
    // 确定起点账号：参数优先，其次用运行时存的主人账号
    const raw = (input ?? '').trim() || this.settings.ownerSteamId;
    if (raw === '') {
      return {
        ok: false,
        friends: [],
        error: { kind: 'no-owner', message: '还不知道要查谁的好友列表：还没设主人账号，也没有指定账号' },
        hint: '跟我说一句你的 Steam 主页地址（或者 SteamID64）就行，会存下来，以后不用再给。',
      };
    }

    let steamId: string;
    try {
      steamId = await this.resolveOneSteamId(raw);
    } catch (err) {
      return {
        ok: false,
        friends: [],
        error: { kind: 'bad-input', message: err instanceof Error ? err.message : String(err) },
      };
    }

    let records;
    try {
      records = await this.api.getFriendList(steamId);
    } catch (err) {
      if (err instanceof SteamApiError) {
        return {
          ok: false,
          friends: [],
          error: { kind: err.kind, message: err.message },
          ...(err.kind === 'friendlist-private'
            ? {
                hint:
                  '让 TA 打开 Steam → 个人资料 → 编辑个人资料 → 隐私设置，把「好友列表」改成「公开」，' +
                  '然后重新查一次。注意这和「个人资料」「游戏详情」是两个独立的开关。',
              }
            : {}),
        };
      }
      throw err;
    }

    // 好友列表只给 steamid，昵称/地址要再批量查一次（一次最多 100 个，内部已分批）
    const ids = records.map((r) => r.steamId);
    const summaries = ids.length > 0 ? await this.summaries(ids) : new Map<string, PlayerSummary>();

    // 反向索引：SteamID64 → 群里怎么称呼他。绑定表是"谁是谁"的唯一真相，
    // 有了它，好友列表才能直接回答"这个好友在群里叫什么"。
    const boundBySteamId = new Map<string, string>();
    for (const { openid, binding } of this.bindings.list()) {
      // 同一个人被多人绑（不该发生但防一手）：先登记的优先，不覆盖
      if (!boundBySteamId.has(binding.steamId)) {
        boundBySteamId.set(binding.steamId, binding.alias !== undefined && binding.alias !== '' ? binding.alias : openid);
      }
    }

    const friends: FriendEntry[] = records.map((r) => {
      const s = summaries.get(r.steamId);
      const entry: FriendEntry = {
        steamId: r.steamId,
        friendSince: r.friendSince,
        name: s?.personaName !== undefined && s.personaName !== '' ? s.personaName : '(昵称不可见)',
        stateText: s?.personaStateText ?? '未知',
        visibility: s?.visibility ?? 0,
      };
      if (s?.profileUrl !== undefined) entry.profileUrl = s.profileUrl;
      if (s?.gameName !== undefined) entry.inGame = s.gameName;
      const boundAs = boundBySteamId.get(r.steamId);
      if (boundAs !== undefined) entry.boundAs = boundAs;
      return entry;
    });

    // 正在玩的排前面，其次在线，最后离线；组内按名字排，方便人肉查找
    friends.sort((a, b) => {
      const rank = (f: FriendEntry): number => (f.inGame !== undefined ? 0 : f.stateText === '离线' ? 2 : 1);
      const d = rank(a) - rank(b);
      return d !== 0 ? d : a.name.localeCompare(b.name, 'zh-CN');
    });

    const ownerSummary = (await this.summaries([steamId]).catch(() => new Map<string, PlayerSummary>())).get(steamId);
    const owner: FriendEntry = {
      steamId,
      friendSince: 0,
      name: ownerSummary?.personaName ?? '',
      stateText: ownerSummary?.personaStateText ?? '未知',
      visibility: ownerSummary?.visibility ?? 0,
    };
    if (ownerSummary?.profileUrl !== undefined) owner.profileUrl = ownerSummary.profileUrl;

    this.logger.info(`steam: 好友列表 ${steamId} → ${friends.length} 人`);
    return { ok: true, owner, friends };
  }

  /**
   * 把一段用户输入（SteamID64 / STEAM_x / [U:1:x] / 主页链接 / 自定义 ID）解析成 SteamID64。
   * 和 bind() 复用同一套解析，避免两处标准不一致。
   */
  private async resolveOneSteamId(raw: string): Promise<string> {
    const parsed = parseSteamInput(raw);
    if (parsed.kind === 'invalid') throw new Error(`无法识别的账号「${raw}」：${parsed.reason}`);
    if (parsed.kind === 'id64') return parsed.id64;
    if (!this.api.configured) {
      throw new Error('解析自定义 ID 需要 Steam Web API Key，当前未配置；可以直接发 17 位 SteamID64 或个人主页链接');
    }
    return this.api.resolveVanity(parsed.vanity);
  }

  // ── 查询 ────────────────────────────────────────────────────

  /** 找出要查的人：who 为空语义 = 全部已绑定用户 */
  private resolveTargets(who: string | undefined): BindingHit[] {
    const query = (who ?? '').trim();
    if (query === '' || query.toLowerCase() === 'all' || query === '所有人' || query === '全部') {
      return this.bindings.list().map(({ openid, binding }) => ({ openid, binding, matchedBy: 'openid' as const }));
    }
    return this.bindings.find(query);
  }

  async lookup(options: SteamLookupOptions = {}): Promise<SteamLookupResult> {
    this.syncApiKey();
    if (!this.config.enabled) {
      return { ok: false, people: [], error: { kind: 'disabled', message: 'Steam 功能未启用（config.steam.enabled=false）' } };
    }
    if (!this.api.configured) {
      return {
        ok: false,
        people: [],
        error: { kind: 'no-key', message: '未配置 Steam Web API Key（config.steam.apiKey）' },
        hint: '让管理员去 https://steamcommunity.com/dev/apikey 申请一个 Key 填进配置；在配置好之前查不了任何人的状态。',
      };
    }

    const targets = this.resolveTargets(options.who);
    let hits = targets;
    // 绑定表没匹配，但 who 本身是 17 位 SteamID：允许临时直查，不写绑定表。
    // 群里偶尔有人贴一串 ID 问"这人在玩啥"，为这个场景专门建一条绑定是噪音。
    let adHoc = false;
    if (hits.length === 0) {
      const query = (options.who ?? '').trim();
      if (isSteamId64(query)) {
        hits = [{ openid: '', binding: { steamId: query, boundAt: 0, source: 'self' }, matchedBy: 'steamid' }];
        adHoc = true;
      }
    }
    if (hits.length === 0) {
      return {
        ok: false,
        people: [],
        error: { kind: 'not-found', message: `没有任何人匹配 "${options.who}"` },
        hint: this.bindings.size() === 0
          ? '绑定表还是空的：先让群友说自己的 Steam 账号，然后用 qq_steam_bind 存下来（工具会自动取当前发言人的身份）。'
          : `当前已绑定 ${this.bindings.size()} 人。可以传 openid、SteamID64 或群里对他的称呼；不确定就留空查全部。`,
      };
    }

    const steamIds = [...new Set(hits.map((h) => h.binding.steamId))];
    let summaries: Map<string, PlayerSummary>;
    try {
      summaries = await this.summaries(steamIds);
    } catch (err) {
      const kind = err instanceof SteamApiError ? err.kind : 'unknown';
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`steam: 查询失败 kind=${kind} ${message}`);
      return { ok: false, people: [], error: { kind, message } };
    }

    const count = Math.max(1, Math.min(10, options.count ?? this.config.maxRecentGames));
    const people: PersonStatus[] = [];

    for (const hit of hits) {
      const summary = summaries.get(hit.binding.steamId);
      const base: PersonStatus = {
        openid: hit.openid,
        ...(hit.binding.alias !== undefined ? { alias: hit.binding.alias } : {}),
        steamId: hit.binding.steamId,
        personaName: summary?.personaName ?? '',
        state: summary?.personaStateText ?? '未知',
        profilePublic: (summary?.visibility ?? 0) === 3,
        profileUrl: steamProfileUrl(hit.binding.steamId),
      };
      if (summary?.gameName !== undefined) base.inGame = summary.gameName;

      if (summary === undefined) {
        // 必须区分「确认不存在」和「这次没取到」：
        // 后者（并发排队 / 瞬时失败）如果说成"ID 填错了或账号已注销"，
        // 就是在给群友一个与事实相反的结论。
        base.note = this.isConfirmedMissing(hit.binding.steamId)
          ? '查不到这个账号：可能 SteamID 填错了，或账号已注销'
          : '这次没能取到状态（请求排队或瞬时失败），稍后再问一次就好';
        people.push(base);
        continue;
      }
      const notes: string[] = [];
      if (adHoc) notes.push('按 SteamID 临时查询，未绑定到任何人');
      if (summary.visibility === 1) {
        notes.push('对方把资料设为私密/仅好友：只能看到昵称和在线状态，看不到在玩什么');
      } else if (summary.visibility !== 3) {
        // 别把"字段缺失"说成"用户设了隐私"——这是两种不同的事实
        notes.push('Steam 没有返回资料可见性，拿到的信息可能不完整');
      }

      if (options.includeRecent === true) {
        if (!base.profilePublic) {
          // 资料不可见时 recent 端点只会回空对象 —— 这次调用纯属浪费。
          // 50 人规模下每个私密账号都在白烧配额，这里直接跳过。
          base.recent = [];
        } else {
          try {
            const games = await this.recentGames(hit.binding.steamId, count);
            base.recent = games.map((g) => ({
              name: g.name,
              hours2Weeks: Math.round((g.minutes2Weeks / 60) * 10) / 10,
              hoursForever: Math.round((g.minutesForever / 60) * 10) / 10,
              lastPlayed: formatPlayedAt(g.lastPlayedAt),
            }));
            if (games.length === 0) {
              notes.push('最近两周没有新游戏记录（或游戏详情未对第三方公开）');
            }
          } catch (err) {
            const kind = err instanceof SteamApiError ? err.kind : 'unknown';
            if (kind === 'rate-limit') {
              // 限流时不再逐个重试，直接中断整个查询，避免把配额打穿
              if (notes.length > 0) base.note = notes.join('；');
              people.push(base);
              return { ok: false, people, error: { kind, message: 'Steam API 限流，请稍后再查' } };
            }
            notes.push(`最近游戏获取失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      if (notes.length > 0) base.note = notes.join('；');
      people.push(base);
    }

    return { ok: true, people };
  }

  // ── 主动感知（system prompt 注入） ──────────────────────────

  /**
   * 同步读快照 —— 绝不发网络请求，因此可以安全地放进 turn 组装路径。
   * 快照过期时在后台刷新，本次仍然返回旧内容（下一轮才会更新）。
   */
  peekSection(): string[] {
    if (!this.config.proactiveEnabled || !this.api.configured || this.bindings.size() === 0) return [];
    const age = this.snapshot === undefined ? Number.POSITIVE_INFINITY : Date.now() - this.snapshot.at;
    if (age > SNAPSHOT_FRESH_MS) {
      // 后台刷新，不等结果
      void this.refreshSnapshot().catch(() => {});
    }
    if (age > 10 * 60 * 1000) return []; // 太久没刷新成功就别拿过期内容误导模型
    return this.snapshot?.sections ?? [];
  }

  /** 刷新快照：只拉摘要（1 次调用覆盖所有人），只保留"正在玩游戏"的人 */
  async refreshSnapshot(): Promise<string[]> {
    this.syncApiKey();
    if (this.refreshing !== undefined) return this.refreshing;
    if (!this.api.configured || this.bindings.size() === 0 || !this.config.proactiveEnabled) return [];

    const lastAt = this.snapshot?.at ?? 0;
    if (Date.now() - lastAt < SNAPSHOT_MIN_INTERVAL_MS) return this.snapshot?.sections ?? [];

    const task = (async (): Promise<string[]> => {
      const entries = this.bindings.list();
      const ids = [...new Set(entries.map((e) => e.binding.steamId))];
      const summaries = await this.summaries(ids);

      const playing: string[] = [];
      const online: string[] = [];
      for (const { openid, binding } of entries) {
        const s = summaries.get(binding.steamId);
        if (s === undefined) continue;
        const who = binding.alias ?? s.personaName ?? openid;
        if (s.gameName !== undefined) {
          playing.push(`${who} 正在玩 ${s.gameName}`);
        } else if (s.personaState === 1) {
          online.push(who);
        }
      }

      if (playing.length === 0 && online.length === 0) return [];

      // 只陈述事实，不替模型下结论：怎么接话是它自己的事
      const lines: string[] = ['【你平时会留意的事】这几个人的 Steam 状态（只是背景，不要主动复述）：'];
      if (playing.length > 0) lines.push(`- ${playing.join('；')}`);
      if (online.length > 0) lines.push(`- ${online.join('、')} 现在开着 Steam 但没在游戏里`);

      const text = lines.join('\n');
      const capped = text.length > this.config.proactiveMaxChars
        ? `${text.slice(0, this.config.proactiveMaxChars)}…`
        : text;
      return [capped];
    })()
      .then((sections) => {
        this.snapshot = { at: Date.now(), sections };
        return sections;
      })
      .finally(() => {
        this.refreshing = undefined;
      });

    this.refreshing = task;
    return task;
  }

  /** 展示用：某个人的 SteamID 两种形态（排查"绑错人"时很方便） */
  describeBinding(openid: string): string | undefined {
    const binding = this.bindings.get(openid);
    if (binding === undefined) return undefined;
    return `${binding.steamId}（${steam64ToSteam2(binding.steamId)}）`;
  }
}

/** unix 秒 → "3 天前" 这类相对时间；0 表示从未玩过 */
function formatPlayedAt(unixSeconds: number): string {
  if (unixSeconds <= 0) return '未知';
  const diffMs = Date.now() - unixSeconds * 1000;
  if (diffMs < 0) return '刚刚';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}
