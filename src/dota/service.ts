/**
 * Dota2 服务 — 缓存 / 单飞 / 本地限流闸门 / 文案渲染
 * ─────────────────────────────────────────────────────────────
 * 为什么要这一层：
 *   - OpenDota 一分钟只给 60 次，而**一个账号一次请求**（recentMatches、profile、wl 各一次），
 *     群里连问三个人就能吃掉 6 次。没有缓存和闸门，一次热闹的聊天就能把当天额度打穿。
 *   - 渲染要随 limit 变化，所以缓存必须存**原始 RawMatch 数组**，不能存渲染结果。
 *     存渲染结果的话，"先查 5 局再查 20 局"就要重新打一次 API。
 *
 * 缓存分层：
 *   recentMatches  cacheTtlSec（默认 180s）—— 存 maxLimit 条，任意 limit 都从里面切
 *   profile        同 TTL —— 昵称/段位不打紧，但不缓存就等于把请求数翻倍
 *   失败不缓存 —— 网络抖动不该让用户 3 分钟内都看不到数据
 *
 * 本地闸门是**保守**的：只按 HTTP 请求数计，429 内部重试那次不额外计数。
 * 宁可少算（真实用量略高于本地计数），也不要把一次请求算两次导致误伤。
 */
import type { Logger } from '../types.ts';
import { heroName } from './heroes.ts';
import { parseAbilities, parseAbilityUpgrades, describeAbilityMix, abilityLabel, type ParsedAbility } from './abilities.ts';
import { AbilityRecordStore, type AbilityRecordPlayer } from './ability-records.ts';
import { itemNameZh } from './item-zh.ts';
import type { DotaWarmupConfig } from './warmup.ts';
import {
  OpenDotaApi,
  OpenDotaError,
  isWin,
  type DotaQuota,
  type PlayerProfile,
  type RequestPolicy,
  type RawMatch,
  type RawMatchDetail,
  type RawMatchPlayer,
  type RawObjective,
  type AbilityMeta,
} from './opendota.ts';

/** Dota2 集成配置（Schema 在 src/config.ts 里定义，这里只描述形状） */
export interface DotaConfig {
  /** 总开关（关 = 不注册工具、service 直接拒绝查询） */
  enabled: boolean;
  /** 最近比赛缓存秒数（默认 180） */
  cacheTtlSec: number;
  /** 单次 OpenDota 请求超时(ms) */
  timeoutMs: number;
  /** 默认查几局（默认 5） */
  defaultLimit: number;
  /** 上限（默认 20；OpenDota 自己默认给 20 条） */
  maxLimit: number;
  /** 本地滑动窗口闸门：每分钟最多发多少次请求（默认 50，给远端 60 留余量） */
  rateLimitPerMin: number;
  /** 是否额外查生涯总胜负（多一次请求） */
  includeWinLoss: boolean;
  /**
   * 凌晨预热（默认 3 点，用户指定）：把所有人昨天打过的局提前请求一遍，
   * 触发 OpenDota 入队解析 —— 第二天白天查询才有完整技能/团战数据。
   * OpenDota 的解析是按需的：一场比赛不被请求就永远停在"半解析"
   * （2026-11-05/06 两次实测：局后 12~35 小时 ability_uses 仍缺）。
   */
  warmup?: Partial<DotaWarmupConfig>;
}

/** 同一账号的 recentMatches 缓存 */
interface CacheEntry<T> {
  at: number;
  value: T;
}

/** 一条给人看的战绩 */
export interface DotaMatchSummary {
  matchId: number;
  heroId: number;
  heroName: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  /** (kills+assists)/max(1,deaths)，保留 2 位 */
  kdaRatio: number;
  durationSec: number;
  durationText: string;
  /** ISO 时间（可序列化） */
  startedAt: string;
  /** 「2 小时前」这种相对时间 */
  startedAtText: string;
  gameMode: number;
  gameModeText: string;
  lobbyType: number;
  lobbyTypeText: string;
  isRanked: boolean;
}

export interface DotaForm {
  accountId: number;
  /** 拿不到 profile 时为空字符串（不是 'unknown'，上层好判断） */
  displayName: string;
  rankTier: number | null;
  rankText: string | null;
  /** 只有 includeWinLoss 开启且拿到了才有 */
  totalWin?: number;
  totalLose?: number;
  matches: DotaMatchSummary[];
  /** 本批次（最近 N 局）内的胜场数 */
  wins: number;
  losses: number;
  /** 胜率，整数百分比 */
  winRate: number;
  /** 平均 KDA，保留 2 位 */
  avgKda: number;
  /** 正数=连胜局数，负数=连败局数 */
  streak: number;
  /** KDA 最高的一局（matches >= 2 时给） */
  bestMatch?: DotaMatchSummary;
  /** KDA 最低的一局 */
  worstMatch?: DotaMatchSummary;
  /** 一条空数据（没打过 / 未公开），文案要按"查不到"处理，不要断言隐私 */
  empty: boolean;
  /** 面向模型/群友的补充说明 */
  note?: string;
  /** 直接可发群的整段中文 */
  summaryText: string;
}

export type DotaFormOutcome =
  | { ok: true; form: DotaForm }
  | { ok: false; accountId: number; errorKind: string; message: string };

/**
 * 一局里的实际定位。靠客观行为判，不靠英雄名 —— 赏金猎人、暗影恶魔这种
 * 英雄既能打核心也能打辅助，只看英雄名必错。
 */
export type MatchRole = 'core' | 'support' | 'unknown';

/**
 * 本人这一队的一个人（用于区分「群友」和「路人」）。
 *
 * 2026-11-16 修（用户原话：「你把队友当路人了」）：
 *   以前阵容只有 `lineup.radiant/dire` 两个英雄名数组，谁都看不出哪几个是群里的人。
 *   模型于是把一起开黑的群友（铭鑫、芋头）说成「路人」，还把群友的功劳安到路人头上。
 *   这里给出**本人这一队**五个人的账号/英雄/阵营/是否绑定群友，由上层注入 alias。
 */
export interface MatchTeamPlayer {
  /** 匿名玩家（OpenDota 里 account_id 为 null）就是 null */
  accountId: number | null;
  heroName: string;
  isRadiant: boolean;
  /** true = 群里绑过 Steam 的人（由 annotateBoundPlayers 标记） */
  isBound: boolean;
  /** 群里的称呼（isBound 时才有，取绑定表的 alias） */
  alias?: string;
}

/**
 * 局内数据突出的**非群友**玩家（路人队友 / 对手），供播报补一两句锐评。
 *
 * 2026-11-20 加（用户原话：「路人队友或者对手数据很突出，比如乱杀或者巨坑，
 * 也可以补上一两句锐评，但是要注意不要认错人」）。
 *
 * 「不认错人」靠三条硬保证，全在脚本侧做，不指望模型自觉：
 *   1. accountId 命中绑定群的**一律不进这张表** —— 群友只会出现在 teamPlayers/boundPlayers，
 *      模型不会在路人表里看到熟人的名字；
 *   2. 只有 `relation` 和英雄名，没有 alias 字段 —— 模型压根拿不到路人的"名字"去乱认；
 *   3. `reason` 是脚本按客观数据算的（如「16/2/9，全场击杀最高」），不带褒贬。
 */
export interface MatchStandoutPlayer {
  heroName: string;
  /** 相对被查的这位群友：同队路人 / 对面玩家 */
  relation: 'teammate' | 'opponent';
  kda: string;
  kills: number;
  deaths: number;
  assists: number;
  gpm: number;
  heroDamage: number;
  /** 脚本给的客观理由（纯数据，不含「乱杀/巨坑」这类定性，定性交给模型） */
  reason: string;
}

/** 单场详细解析（比 recentForm 细：经济/输出/对位/目标/曲线/团战/阵容） */
export interface MatchDetailForm {
  matchId: number;
  startTimeSec: number;
  startText: string;
  durationSec: number;
  durationText: string;
  gameMode: number;
  gameModeText: string;
  lobbyType: number;
  lobbyTypeText: string;
  isRanked: boolean;
  radiantWin: boolean;
  player: {
    accountId: number;
    heroId: number;
    heroName: string;
    isRadiant: boolean;
    win: boolean;
    kills: number;
    deaths: number;
    assists: number;
    kdaRatio: number;
    gpm: number;
    xpm: number;
    lastHits: number;
    denies: number;
    heroDamage: number;
    towerDamage: number;
    heroHealing: number;
    netWorth: number;
    level: number;
    /** 英文原名（OpenDota dname），保持原样不动：老调用方/老测试都依赖它 */
    items: string[];
    /**
     * 装备的官方简体中文名，长度与 `items` 一一对应；没收录的位置放英文原名。
     * 2026-11-16 新增：模型自己"翻译"装备名翻过车（Maelstrom 被说成「狂战斧」，
     * 正确是「漩涡」，狂战斧是 Battle Fury），所以直接把中文名给出去。
     */
    itemsZh?: string[];
    backpack: string[];
    /**
     * 技能组合（按使用次数降序）。技能征召（OMG）模式里英雄只是个壳子，
     * 真正决定强弱的是拿了哪些技能 —— 没有这个就只能靠 KDA 说空话。
     */
    abilities?: ParsedAbility[];
    /** 一句话概括这套技能的路子（空 = 没拿到技能数据） */
    abilityMix?: string;
    /** 分路：1=优势路 2=中路 3=劣势路 4=打野（OpenDota 口径），未知为 null */
    laneRole?: number | null;
    /** 插眼数（观察者 + 岗哨） */
    obsPlaced?: number;
    senPlaced?: number;
    /** 屯野次数 */
    campsStacked?: number;
    /**
     * 这一局的实际定位：core / support / unknown。
     * 2026-11-15 修：以前没有任何定位字段，模型只能靠英雄名猜，
     * 于是「赏金猎人 2/6/19」被当成主输出骂了一场。判据用客观行为
     * （正补占比、插眼、屯野、经济排名），不看英雄名。
     */
    role?: MatchRole;
    /** 判定理由（一句话，给模型看，不要照抄进群里） */
    roleReason?: string;
  };
  /** 队内排名（1 = 最好，按净资产 / 英雄伤害） */
  teamRank: { netWorth: number; heroDamage: number; teamSize: number };
  /** 对位（同 lane_role 的敌方玩家）对比，找不到为 null */
  laneOpponent: { heroName: string; gpmDiff: number; damageDiff: number } | null;
  objectives: {
    firstBlood: 'radiant' | 'dire' | null;
    roshan: { radiant: number; dire: number };
    towers: { radiant: number; dire: number };
  };
  /** 经济曲线（玩家视角）：最大领先 / 最大落后 + 对应分钟；未解析为 null */
  goldSwing: { maxLead: number; maxDeficit: number; leadMinute: number; deficitMinute: number } | null;
  /** 团战次数与参与次数；未解析为 null */
  teamfights: { count: number; participated: number } | null;
  lineup: { radiant: string[]; dire: string[] };
  /**
   * 本人这一队的五个人（按 player_slot 顺序），标明谁是绑定的群友、谁是路人。
   * 2026-11-16 新增：阵容只有英雄名时，模型分不清队友里哪几个是群友，会把
   * 一起开黑的人说成「路人」，还把功劳安到路人头上。
   */
  teamPlayers: MatchTeamPlayer[];
  /**
   * 局内数据突出的路人和对手（已排除全部绑定群友），脚本按客观阈值挑的。
   * 播报用来补一两句锐评；没挑到就是空数组。判定逻辑见 pickStandouts。
   */
  standoutPlayers: MatchStandoutPlayer[];
  /**
   * 事实清单：把这一局能收集到的数据逐项压成「纯数据 + 优势/劣势/无异常」。
   *
   * 2026-11-16 新增，必填。群里的原话是「我看他从来没有综合分析过能收集的数据吧，
   * 不都是抓一两条就开始评么」——根因不是数据拿不到（经济曲线、伤害、补刀、插眼、
   * 屯野、团战、出装、分路其实都在手上），而是模型拿到的是一堆散字段，它就挑最好
   * 念的那一两个说（KDA、伤害），于是「0/7/25 是混子」「赏金伤害垫底是主输出菜」
   * 这类错评反复出现。这份清单逼它逐项对照一遍再开口。
   */
  factSheet: MatchFactSheet;
  notes: string[];
  /** 直接可发群的整段中文 */
  summaryText: string;
}

/**
 * factSheet 的一行：一个维度、一句纯数据、一个三态结论。
 *
 * 为什么 fact 必须是纯数据、不带褒贬：同一个数字谁看都是同一个结论，
 * 形容词一进来就没法复核了，而且模型会把形容词直接抄进群里当点评。
 */
export interface MatchFactLine {
  /** 维度名，如「经济」「输出」「补刀」「视野」「团战」「出装」「分路」「目标」 */
  dim: string;
  /** 这一项的事实陈述（纯数据，不带褒贬） */
  fact: string;
  /** 这个人本局在这一项上是明显优势 / 明显劣势 / 无异常 */
  verdict: 'plus' | 'minus' | 'flat';
}

export interface MatchFactSheet {
  lines: MatchFactLine[];
  /** 由数据推出的 2~3 条结论候选（每条必须能指回具体 lines 的下标） */
  findings: Array<{ text: string; evidence: number[] }>;
}

/**
 * 队内对比基线：算 factSheet 时需要的「别人的数值」快照。
 *
 * 为什么不复用 teamRank：teamRank 只留本人「第几名」，而 factSheet 要的是
 * 「比队内第一差多少 GPM」「同定位队友补了多少刀」「全队平均死几次」——
 * 这些只有在还拿得到 RawMatchPlayer 全队原始数据的时候才算得出来。
 * 造完之后 MatchDetailForm 里已经没有别人的数值了，所以留一份快照在这里。
 */
export interface MatchTeamBaseline {
  teamSize: number;
  /** 队内最高 GPM */
  gpmTop: number;
  /** 队内 GPM 中位数（定位判不出时给模型一个参照，免得它只能拿「比第一低多少」瞎猜） */
  gpmMedian: number;
  /** 本人 GPM 队内排名（1=最高） */
  gpmRank: number;
  /** 同定位（core / support / unknown）队友的 GPM，不含本人 */
  sameRoleGpm: number[];
  /** 队内最高英雄伤害 */
  damageTop: number;
  /** 队内最多插眼数（观察 + 岗哨） */
  wardsTop: number;
  /**
   * 这一局的插眼字段是否真的有值。
   * OpenDota 未解析完时 obs/sen/camps 整列是 null —— 那时「插眼 0 个」是假的，
   * 只能记 flat 并写明未解析，绝不能说「他没插眼」。
   */
  wardsKnown: boolean;
  /** 本人插眼数队内排名（1=最多） */
  wardRank: number;
  /** 队内最高正补 */
  lastHitsTop: number;
  /** 全队正补总和（算「正补占全队百分之几」用，定位判不出时靠它识别辅助） */
  lastHitsTotal: number;
  /** 同定位（core / support / unknown）队友的正补，不含本人 */
  sameRoleLastHits: number[];
  /** 全队平均死亡数 */
  deathsAvg: number;
  /** 队内最高建筑伤害 */
  towerTop: number;
}

/** 多人查询之间的间隔：OpenDota 没有批量端点，连续打容易踩到 429 */
const MULTI_QUERY_DELAY_MS = 250;

/** 滑动窗口长度 */
const RATE_WINDOW_MS = 60_000;

export class DotaService {
  private readonly config: DotaConfig;
  private readonly logger: Logger;
  private readonly api: OpenDotaApi;

  /** 原始比赛数组（不是渲染结果） */
  private readonly recentCache = new Map<number, CacheEntry<RawMatch[]>>();
  private readonly profileCache = new Map<number, CacheEntry<PlayerProfile | null>>();
  /** 同一账号的并发请求合并 */
  private readonly inFlight = new Map<number, Promise<RawMatch[]>>();
  /** 单场详情缓存（key = matchId，TTL 同上） */
  private readonly detailCache = new Map<number, CacheEntry<RawMatchDetail>>();
  /** 单场详情并发合并 */
  private readonly detailInFlight = new Map<number, Promise<RawMatchDetail>>();
  /** 滑动窗口内的请求时间戳 */
  private readonly requestLog: number[] = [];
  /**
   * 技能记录：每次解析单场就把技能组合存一份（OMG 局尤其重要）。
   * 落盘失败只记 warn，绝不影响查询本身。
   */
  public readonly abilityRecords: AbilityRecordStore;

  constructor({ config, logger }: { config: DotaConfig; logger: Logger }) {
    this.config = config;
    this.logger = logger;
    this.api = new OpenDotaApi({ timeoutMs: config.timeoutMs });
    this.abilityRecords = new AbilityRecordStore(undefined, { warn: (m: string) => logger.warn(m) });
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** 工具描述要跟着配置走，否则改了 defaultLimit 描述还在说 5 */
  get limits(): { defaultLimit: number; maxLimit: number } {
    return { defaultLimit: this.config.defaultLimit, maxLimit: this.config.maxLimit };
  }

  /** 最近一次响应的 OpenDota 剩余额度（日志/降级判断用） */
  get quota(): DotaQuota | undefined {
    return this.api.quota;
  }

  // ── 本地限流闸门 ────────────────────────────────────────────

  /**
   * 发请求前的闸门。超限时**不发请求**直接抛 rate-limit：
   * 让远端 429 打过来再处理，等于把额度浪费在一眼就能算出来的事情上。
   */
  private gate(): void {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;
    while (this.requestLog.length > 0 && (this.requestLog[0] ?? Number.POSITIVE_INFINITY) <= windowStart) {
      this.requestLog.shift();
    }
    const limit = Math.max(1, Math.floor(this.config.rateLimitPerMin));
    if (this.requestLog.length >= limit) {
      throw new OpenDotaError(
        'rate-limit',
        `本地限流保护：最近 60 秒内已发出 ${this.requestLog.length} 次 OpenDota 请求（上限 ${limit} 次），过一会儿再查`,
      );
    }
    this.requestLog.push(now);
  }

  private fresh<T>(entry: CacheEntry<T> | undefined, ttlMs: number): T | undefined {
    if (entry === undefined) return undefined;
    return Date.now() - entry.at < ttlMs ? entry.value : undefined;
  }

  // ── 取数 ────────────────────────────────────────────────────

  /**
   * 取原始比赛数组（带缓存 + 单飞）。
   * 一次就拉满 maxLimit 条，之后任何更小的 limit 都从缓存切片 —— 这也是
   * "缓存原始数组而不是渲染结果"的目的。
   */
  private async matches(accountId: number, limit: number, policy?: RequestPolicy): Promise<RawMatch[]> {
    const ttl = this.config.cacheTtlSec * 1000;
    const cached = this.fresh(this.recentCache.get(accountId), ttl);
    if (cached !== undefined) return cached;

    const running = this.inFlight.get(accountId);
    if (running !== undefined) return running;

    const task = (async (): Promise<RawMatch[]> => {
      this.gate();
      const full = await this.api.recentMatches(accountId, Math.max(limit, this.config.maxLimit), policy);
      this.recentCache.set(accountId, { at: Date.now(), value: full });
      return full;
    })().finally(() => {
      this.inFlight.delete(accountId);
    });

    this.inFlight.set(accountId, task);
    return task;
  }

  /** profile 失败不该毁掉整条战绩：返回 null 由调用方降级 */
  private async profile(accountId: number): Promise<PlayerProfile | null> {
    const ttl = this.config.cacheTtlSec * 1000;
    const cached = this.profileCache.get(accountId);
    if (cached !== undefined && Date.now() - cached.at < ttl) return cached.value;

    this.gate();
    const value = await this.api.playerProfile(accountId);
    this.profileCache.set(accountId, { at: Date.now(), value });
    return value;
  }

  // ── 主流程 ──────────────────────────────────────────────────

  /**
   * 最近 N 局战绩。
   * 错误策略：recentMatches 失败 → 抛（没有核心数据，报错比给空结果诚实）；
   *          profile / wl 失败 → 降级（昵称段位缺了也能聊战绩）。
   */
  async recentForm(accountId: number, limit?: number, heroId?: number): Promise<DotaForm> {
    if (!this.config.enabled) {
      throw new OpenDotaError('bad-request', 'Dota2 战绩功能未启用（config.dota.enabled=false）');
    }
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new OpenDotaError('bad-request', `account_id 必须是正整数，收到 ${String(accountId)}`);
    }

    const capped = clampLimit(limit, this.config.defaultLimit, this.config.maxLimit);
    const raw = await this.matches(accountId, capped);
    const picked = raw.slice(0, capped);
    const all = picked.map(toSummary);
    // 按英雄筛选：必须在 buildForm **之前**过滤，统计才会跟着重算。
    // 若在工具层过滤明细、stats 仍用全量，就会出现「最近 3 局 2 胜」但明细只有 1 局的自相矛盾。
    const matches = heroId === undefined ? all : all.filter((m) => m.heroId === heroId);
    const heroLabel = heroId === undefined ? undefined : heroName(heroId);

    const notes: string[] = [];
    let profile: PlayerProfile | null = null;
    try {
      profile = await this.profile(accountId);
    } catch (err) {
      // 限流/网络问题都只降级：战绩已经在手上了，没必要整条丢掉
      notes.push(`资料（昵称/段位）没取到：${err instanceof Error ? err.message : String(err)}`);
    }

    let totalWin: number | undefined;
    let totalLose: number | undefined;
    if (this.config.includeWinLoss && matches.length > 0) {
      try {
        this.gate();
        const wl = await this.api.winLoss(accountId);
        if (wl !== null) {
          totalWin = wl.win;
          totalLose = wl.lose;
        }
      } catch (err) {
        notes.push(`总胜负没取到：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (this.api.quota !== undefined) {
      const q = this.api.quota;
      this.logger.debug(`dota: quota minute=${String(q.minute)} day=${String(q.day)}`);
    }

    const form = buildForm({
      accountId,
      profile,
      matches,
      ...(heroLabel !== undefined ? { heroFilter: heroLabel } : {}),
      ...(totalWin !== undefined && totalLose !== undefined ? { totalWin, totalLose } : {}),
      notes,
    });
    this.logger.info(
      `dota: ${accountId} ${form.displayName || '(无昵称)'} → ${matches.length} 局 ${form.wins}W/${form.losses}L`
      + (heroLabel !== undefined ? `（只看 ${heroLabel}）` : ''),
    );
    return form;
  }

  /**
   * 预热：对某人最近 withinHours 小时内打过的局逐场请求一次。
   * 请求本身就会让 OpenDota 入队解析 —— 这正是"凌晨预热、白天查才有完整数据"的原理。
   * 单场失败不中断（下一晚还会再试）；限流由本地闸门统一控制。
   */
  /**
   * `seen` 是**本轮预热共享**的去重集合（warmup 为所有账号传同一个 Set）。
   * 几个人开黑时，各自的 recentMatches 都会列出同一场，但 OpenDota 的解析
   * 队列是按 match_id 的 —— 重复请求只是白耗额度，还容易撞 429。
   */
  async warmRecent(
    accountId: number,
    withinHours: number,
    policy?: RequestPolicy,
    seen?: Set<number>,
  ): Promise<number> {
    if (!this.config.enabled) {
      throw new OpenDotaError('bad-request', 'Dota2 战绩功能未启用（config.dota.enabled=false）');
    }
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new OpenDotaError('bad-request', `account_id 必须是正整数，收到 ${String(accountId)}`);
    }
    const raw = await this.matches(accountId, this.config.maxLimit, policy);
    const cutoffSec = Math.floor(Date.now() / 1000) - withinHours * 3600;
    const targets = raw.filter((m) => m.start_time >= cutoffSec);
    // 返回「真的请求成功」的场数，不是命中的场数。
    // 2026-11-10 事故：整批 recentMatches 超时、日志却报"预热完成 N 人 0 场
    // （白天查询就有完整技能数据）"。命中数会让人误以为预热成功，必须按成功数计。
    let triggered = 0;
    for (const m of targets) {
      if (seen !== undefined && seen.has(m.match_id)) continue;
      if (seen !== undefined) seen.add(m.match_id);
      try {
        await this.matchRaw(m.match_id, policy);
        triggered += 1;
      } catch {
        // 失败就从去重集合里撤掉，让同轮下一个账号还有机会重试这场；
        // 单场失败不中断：预热是锦上添花，明天还会再试
        seen?.delete(m.match_id);
      }
    }
    return triggered;
  }

  /**
   * 单场详细解析。
   * matchId 必填；accountId 用来定位"这局里的哪个人"（不传就没法算队内排名/对位）。
   */
  async matchDetail(
    matchId: number,
    accountId: number,
    /**
     * 这场所有绑定群友的 accountId（2026-11-20 认错人防线）。
     * 传入时，pickStandouts 会排除这些人，只留真路人/对手；不传则一个都不挑。
     * 播报链路（briefing）传，手动查询（tools）不传 —— 手动查询另有用处。
     */
    boundAccountIds?: ReadonlySet<number>,
  ): Promise<MatchDetailForm> {
    if (!this.config.enabled) {
      throw new OpenDotaError('bad-request', 'Dota2 战绩功能未启用（config.dota.enabled=false）');
    }
    if (!Number.isSafeInteger(matchId) || matchId <= 0) {
      throw new OpenDotaError('bad-request', `match_id 必须是正整数，收到 ${String(matchId)}`);
    }
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new OpenDotaError('bad-request', `account_id 必须是正整数，收到 ${String(accountId)}`);
    }

    const raw = await this.matchRaw(matchId);
    const itemName = await this.itemNameResolver();
    const form = buildMatchDetailForm(raw, accountId, itemName);

    // 突出的路人/对手（2026-11-20）：绑定账号集合由调用方传入，命中者一律排除。
    // 没传就是空 —— 认错人的代价太高，宁可不说。
    if (boundAccountIds !== undefined && boundAccountIds.size > 0) {
      const me = raw.players.find((p) => p.account_id === accountId);
      if (me !== undefined) form.standoutPlayers = pickStandouts(raw, me, boundAccountIds);
    }

    // 装备名护栏（2026-11-16）：中文名是脚本按官方译名给的，模型自己译会翻车
    // （Maelstrom 被说成「狂战斧」，而狂战斧是 Battle Fury）。
    // 和技能名那条同一个思路：不是"没数据"，而是明确要求照抄。
    // 放在这里而不是 buildMatchDetailForm 里，是因为角色判据那套 notes 有
    // 「2 条以内」的上限 —— 通用护栏不该跟战况点评抢位置（2026-11-16）。
    if (form.player.items.length > 0) {
      form.notes.push(
        '装备名按上面给的写法照抄：括号前是官方简体中文名，括号里是英文原名；'
        + '只有英文原名的那件就是没收录中文名，直接用英文。不要自行翻译或换成别的说法。',
      );
    }
    // 队友护栏（2026-11-16）：队里谁是群友由 teamPlayers 标，别一律当路人；
    // 反过来也别把路人当熟人瞎认亲。文案会随 summaryText 一起给到模型。
    if (form.teamPlayers.length > 0) {
      form.notes.push(
        '队友里 isBound=true 的是群里绑过 Steam 的人（alias 是群里怎么叫的），isBound=false 的是路人；'
        + '点评时别把群友说成路人，也别把群友的功劳安到路人头上。',
      );
    }

    // 技能组合（技能征召/OMG 的核心信息）。
    // 常量拉取失败就留空并记一条 note —— 不能因为拿不到技能名就让整条战绩查询失败。
    try {
      // 一次 match 详情里 10 个人的 ability_uses 都在（normalizeMatchDetail 逐人保留），
      // 常量表也只拉一次：把全队一起存下来不需要多打任何一次网络请求。
      // 以前只存被查的那一个人，结果"几个人开黑同一局"要分别查四五次才凑得齐，
      // 而实际群里往往只问其中一个人 —— 那局其他人的技能就永远缺着。
      const meta: Map<string, AbilityMeta> = await this.api.abilityMeta();
      let ids: Map<number, string> | undefined;

      /** 单个玩家的技能组合；半解析局回退到加点顺序，口径单独标出来 */
      const parseOne = async (
        p: RawMatchPlayer,
      ): Promise<{ abilities: ParsedAbility[]; basis: 'uses' | 'levels' }> => {
        const uses = p.ability_uses;
        if (uses !== undefined && uses !== null && Object.keys(uses).length > 0) {
          return { abilities: parseAbilities(uses, meta), basis: 'uses' };
        }
        // 兜底：OpenDota 对不少局处于半解析状态 —— ability_uses / teamfights 都还没算，
        // 但加点顺序（原始终端数据）一直在。只认 ability_uses 的话这种局整个拿不到技能。
        // （2026-11-05 实测：局后 12 小时的 9075953759 仍是这个状态。）
        const upgrades = p.ability_upgrades_arr;
        if (Array.isArray(upgrades) && upgrades.length > 0) {
          if (ids === undefined) ids = await this.api.abilityIds();
          return { abilities: parseAbilityUpgrades(upgrades, ids, meta), basis: 'levels' };
        }
        return { abilities: [], basis: 'uses' };
      };

      const me = raw.players.find((p) => p.account_id === accountId);
      const mine = me !== undefined
        ? await parseOne(me)
        : { abilities: [] as ParsedAbility[], basis: 'uses' as const };
      const { abilities, basis } = mine;

      const toEntries = (list: ParsedAbility[]): AbilityRecordPlayer['abilities'] =>
        list.map((a) => ({
          name: a.name,
          ...(a.nameZh !== undefined ? { nameZh: a.nameZh } : {}),
          uses: a.uses,
          ...(a.behavior !== undefined ? { behavior: a.behavior } : {}),
          ...(a.damageType !== undefined ? { damageType: a.damageType } : {}),
        }));

      if (abilities.length > 0) {
        form.player.abilities = abilities;
        const mix = describeAbilityMix(abilities);
        if (mix !== '') form.player.abilityMix = mix;
        // 接进"可直接发群"的摘要 —— OMG 局里技能恰恰是最该说的部分，
        // 只放在结构化字段里的话她很可能压根不去看。
        // 兜底路径的次数口径不同（加点数 ≠ 使用数），措辞必须分开，别让人以为他按了 126 次。
        const label = basis === 'levels' ? '技能（按加点）' : '技能';
        form.summaryText += `\n${label}｜${abilities.map((a) => `${abilityLabel(a)}×${a.uses}`).join(' / ')}`;
        if (mix !== '') form.summaryText += `\n路子｜${mix}`;
        // 技能名是识别 OMG 组合的凭据：给权威中文名，别让她自己译。
        // 2026-11-08 实锤：God's Strength 被译成「众神之力」，官方是「神之力量」。
        form.notes.push(
          '技能名按上面给的写法照抄：括号前是官方简体中文名，括号里是英文原名；'
          + '没给中文名的技能直接用英文原名。不要自行翻译、改名或换成别的说法。',
        );
      } else {
        // 技能缺失时的护栏（2026-11-06 实锤：GDL 帕吉 24/3/12 那局，她把
        // 「帕吉=钩子」的默认印象编成"钩子拉得太准了"——而那局根本没抽到肉钩。
        // OMG 里英雄不一定有招牌技能，按默认技能描述必然翻车）。
        // 不是简单的"没数据"：要明确告诉模型**不许怎么编**，只给"没数据"她还是会脑补。
        form.notes.push(
          '技能数据还没出来（OpenDota 对这局还没完成解析）。'
          + '技能征召模式下英雄不一定有它的招牌技能 —— 在拿到真实技能列表之前，'
          + '只聊 KDA / 伤害 / 装备这些数据，**不要提任何具体技能名**，'
          + '也不要说"钩子准""大招放得好"这类默认联想；可以照实说"技能数据还没解析出来"。',
        );
      }

      // 落一份记录：整场所有解析出技能的人一起存（按 accountId 合并，幂等）。
      // 只跳过匿名玩家和半解析到连加点都没有的人；不认识的对手也存 ——
      // 查询时能按账号/英雄筛，"这局对面拿了什么"同样是有效信息。
      const roster: AbilityRecordPlayer[] = [];
      for (const p of raw.players) {
        const pid = p.account_id;
        if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) continue;
        const parsed = pid === accountId ? mine : await parseOne(p);
        if (parsed.abilities.length === 0) continue;
        const mix = describeAbilityMix(parsed.abilities);
        roster.push({
          accountId: pid,
          heroName: heroName(p.hero_id),
          // 天辉 slot 0-4，夜魇 >=128；胜负按队取，不能全用被查那个人的
          win: p.player_slot < 128 ? raw.radiantWin : !raw.radiantWin,
          basis: parsed.basis,
          abilities: toEntries(parsed.abilities),
          ...(mix !== '' ? { mix } : {}),
        });
      }
      if (roster.length > 0) {
        this.abilityRecords.put({
          matchId,
          at: Date.now(),
          gameMode: form.gameMode,
          basis,
          players: roster,
        });
      }
    } catch (err) {
      form.notes.push(`技能没解析出来：${err instanceof Error ? err.message : String(err)}`);
    }
    this.logger.info(
      `dota: 单场 ${matchId} → ${form.player.heroName} `
      + `${form.player.kills}/${form.player.deaths}/${form.player.assists}（${form.player.win ? '胜' : '负'}）`
      + `，技能记录 ${this.abilityRecords.get(matchId)?.players.length ?? 0} 人`,
    );
    return form;
  }

  /** 取单场原始数据（缓存 + 单飞 + 本地闸门） */
  private async matchRaw(matchId: number, policy?: RequestPolicy): Promise<RawMatchDetail> {
    const ttl = this.config.cacheTtlSec * 1000;
    const cached = this.fresh(this.detailCache.get(matchId), ttl);
    if (cached !== undefined) return cached;

    const running = this.detailInFlight.get(matchId);
    if (running !== undefined) return running;

    const task = (async (): Promise<RawMatchDetail> => {
      this.gate();
      const raw = await this.api.matchDetails(matchId, policy);
      this.detailCache.set(matchId, { at: Date.now(), value: raw });
      return raw;
    })().finally(() => {
      this.detailInFlight.delete(matchId);
    });

    this.detailInFlight.set(matchId, task);
    return task;
  }

  /** 物品 id → 名称；拉一次常量后进程内永久缓存，失败降级为「#id」 */
  private async itemNameResolver(): Promise<(id: number) => string> {
    try {
      const map = await this.api.itemNames();
      return (id: number) => map.get(id) ?? `#${id}`;
    } catch {
      return (id: number) => `#${id}`;
    }
  }

  /**
   * 多人查询。OpenDota 不支持批量，所以串行 + 间隔；
   * 单人失败不中断整批（群里问 5 个人，不该因为 1 个人 ID 填错就全查不到）。
   */
  async recentFormMulti(accountIds: number[], limit?: number): Promise<DotaFormOutcome[]> {
    const unique = [...new Set(accountIds)];
    const out: DotaFormOutcome[] = [];
    for (let i = 0; i < unique.length; i += 1) {
      const accountId = unique[i];
      if (accountId === undefined) continue;
      if (i > 0) await delay(MULTI_QUERY_DELAY_MS);
      try {
        out.push({ ok: true, form: await this.recentForm(accountId, limit) });
      } catch (err) {
        const errorKind = err instanceof OpenDotaError ? err.kind : 'unknown';
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`dota: ${accountId} 查询失败 kind=${errorKind} ${message}`);
        out.push({ ok: false, accountId, errorKind, message });
        // 远端限流时后面几个必然也失败，继续打只会更糟
        if (errorKind === 'rate-limit') {
          for (const rest of unique.slice(i + 1)) {
            out.push({ ok: false, accountId: rest, errorKind, message });
          }
          break;
        }
      }
    }
    return out;
  }

  /** 清掉某个账号的缓存（想强制刷新时用） */
  invalidate(accountId: number): void {
    this.recentCache.delete(accountId);
    this.profileCache.delete(accountId);
  }
}

// ── 渲染 ────────────────────────────────────────────────────

/** 游戏模式 → 中文（只列群聊里真的会遇到的，其余用编号兜底） */
const GAME_MODE_TEXT: Record<number, string> = {
  0: '未知模式',
  1: '全阵营选择',
  2: '队长模式',
  3: '随机征召',
  4: '单一征召',
  5: '全随机',
  11: '中路单挑',
  12: '最少选用',
  16: '队长征召',
  18: '技能征召',
  19: '活动模式',
  20: '全随机死亡竞赛',
  21: '中路 1v1',
  22: '全英雄选择',
  23: '加速模式',
};

/** 房间类型 → 中文 */
const LOBBY_TYPE_TEXT: Record<number, string> = {
  0: '普通匹配',
  1: '练习房',
  2: '锦标赛',
  4: '人机',
  5: '团队匹配',
  6: '单人匹配',
  7: '天梯',
  8: '1v1',
  9: '战斗杯',
};

/** 天梯 lobby_type */
const RANKED_LOBBY = 7;

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  const base = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(Math.max(1, Math.floor(max)), base));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function kdaOf(m: Pick<RawMatch, 'kills' | 'deaths' | 'assists'>): number {
  // 零死亡按 1 计：否则 10/0/5 会变成 Infinity，JS 里 JSON 序列化直接 null
  return round2((m.kills + m.assists) / Math.max(1, m.deaths));
}

function toSummary(m: RawMatch): DotaMatchSummary {
  const durationSec = Math.max(0, m.duration);
  return {
    matchId: m.match_id,
    heroId: m.hero_id,
    heroName: heroName(m.hero_id),
    win: isWin(m),
    kills: m.kills,
    deaths: m.deaths,
    assists: m.assists,
    kdaRatio: kdaOf(m),
    durationSec,
    durationText: `${Math.max(1, Math.round(durationSec / 60))} 分钟`,
    startedAt: new Date(m.start_time * 1000).toISOString(),
    startedAtText: formatRelative(m.start_time),
    gameMode: m.game_mode,
    gameModeText: GAME_MODE_TEXT[m.game_mode] ?? `模式 ${m.game_mode}`,
    lobbyType: m.lobby_type,
    lobbyTypeText: LOBBY_TYPE_TEXT[m.lobby_type] ?? `房间 ${m.lobby_type}`,
    isRanked: m.lobby_type === RANKED_LOBBY,
  };
}

/** unix 秒 → 相对时间 */
function formatRelative(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '时间未知';
  const diffMs = Date.now() - unixSeconds * 1000;
  if (diffMs < 0) return '刚刚';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

interface BuildInput {
  accountId: number;
  profile: PlayerProfile | null;
  /** 已按时间倒序、已裁剪到 limit */
  matches: DotaMatchSummary[];
  totalWin?: number;
  totalLose?: number;
  notes: string[];
  /** 按英雄筛选时的英雄名（只用于"筛完为空"的说法，避免说成"这人没打过"） */
  heroFilter?: string;
}

function buildForm(input: BuildInput): DotaForm {
  const { accountId, profile, matches, totalWin, totalLose } = input;
  const notes = [...input.notes];

  const wins = matches.filter((m) => m.win).length;
  const losses = matches.length - wins;
  const winRate = matches.length === 0 ? 0 : Math.round((wins / matches.length) * 100);
  const avgKda = matches.length === 0 ? 0 : round2(matches.reduce((s, m) => s + m.kdaRatio, 0) / matches.length);

  // 连击：从最近一局往回数，遇到不同结果就停
  let streak = 0;
  const first = matches[0];
  if (first !== undefined) {
    let n = 0;
    for (const m of matches) {
      if (m.win !== first.win) break;
      n += 1;
    }
    streak = first.win ? n : -n;
  }

  let bestMatch: DotaMatchSummary | undefined;
  let worstMatch: DotaMatchSummary | undefined;
  if (matches.length >= 2) {
    for (const m of matches) {
      if (bestMatch === undefined || m.kdaRatio > bestMatch.kdaRatio) bestMatch = m;
      if (worstMatch === undefined || m.kdaRatio < worstMatch.kdaRatio) worstMatch = m;
    }
  }

  const empty = matches.length === 0;
  if (empty) {
    if (input.heroFilter !== undefined) {
      // 筛完为空 ≠ 没打过。说错这句，她会照着"这人没玩过这个英雄"去编。
      notes.push(
        `最近查的这批局里没有「${input.heroFilter}」——不是没玩过，是这几局里没有。`
        + '想看更早的就把 limit 放大（OpenDota 一次最多 20 局）。',
      );
    } else {
      notes.push(
        'OpenDota 上这个账号没有任何最近比赛记录 —— 可能是没打过 Dota2，也可能是对方在设置里关掉了「公开比赛数据」；'
        + '这两种情况在 OpenDota 看来完全一样，没法区分，别替对方下结论。',
      );
    }
  }

  const base: Omit<DotaForm, 'summaryText'> = {
    accountId,
    displayName: profile?.personaName ?? '',
    rankTier: profile?.rankTier ?? null,
    rankText: profile?.rankText ?? null,
    ...(totalWin !== undefined && totalLose !== undefined ? { totalWin, totalLose } : {}),
    matches,
    wins,
    losses,
    winRate,
    avgKda,
    streak,
    ...(bestMatch !== undefined ? { bestMatch } : {}),
    ...(worstMatch !== undefined ? { worstMatch } : {}),
    empty,
    ...(notes.length > 0 ? { note: notes.join('；') } : {}),
  };

  return { ...base, summaryText: renderSummary(base) };
}

/**
 * 渲染成"像人说的话"。
 * 原则：先给结论（几胜几负、连胜连败），再逐条战绩，最后一句对比。
 * 每行只有"英雄 KDA 时长"，模式/房间类型放结构化数据里 —— 文案里塞满字段就没人看了。
 */
function renderSummary(form: Omit<DotaForm, 'summaryText'>): string {
  const who = form.displayName !== '' ? form.displayName : `账号 ${form.accountId}`;

  if (form.empty) {
    return `${who}：在 OpenDota 上查不到最近的比赛记录。`
      + '可能是这个账号没打过 Dota2，也可能是在设置里把「公开比赛数据」关掉了 —— 两种情况从公开数据上完全分不出来。';
  }

  const head: string[] = [];
  head.push(`最近 ${form.matches.length} 局 ${form.wins} 胜 ${form.losses} 负（胜率 ${form.winRate}%）`);
  if (form.streak >= 2) head.push(`当前 ${form.streak} 连胜`);
  else if (form.streak <= -2) head.push(`当前 ${-form.streak} 连败`);

  const meta: string[] = [];
  if (form.rankText !== null) meta.push(form.rankText);
  const rankedCount = form.matches.filter((m) => m.isRanked).length;
  if (rankedCount > 0) meta.push(`${rankedCount}/${form.matches.length} 局天梯`);
  if (form.totalWin !== undefined && form.totalLose !== undefined) {
    const total = form.totalWin + form.totalLose;
    const rate = total === 0 ? 0 : Math.round((form.totalWin / total) * 100);
    meta.push(`生涯 ${form.totalWin} 胜 ${form.totalLose} 负（${rate}%）`);
  }

  const lines: string[] = [];
  lines.push(`${who}｜${head.join('，')}`);
  if (meta.length > 0) lines.push(meta.join(' · '));

  for (const m of form.matches) {
    const mark = m.win ? '✅' : '❌';
    const tease = teaseLine(m);
    const tail = tease === '' ? '' : `｜${tease}`;
    lines.push(`${mark} ${m.heroName} ${m.kills}/${m.deaths}/${m.assists}（KDA ${m.kdaRatio.toFixed(2)} · ${m.durationText}）${tail}`);
  }

  const best = form.bestMatch;
  const worst = form.worstMatch;
  if (best !== undefined && worst !== undefined && best.matchId !== worst.matchId) {
    const gap = best.kdaRatio - worst.kdaRatio;
    // 只有差距明显时才点出来，否则每局都差不多还硬凹对比很假
    if (gap >= 1) {
      const contrast = `最猛的是${best.heroName}（KDA ${best.kdaRatio.toFixed(2)}），`
        + `最差的是${worst.heroName}（KDA ${worst.kdaRatio.toFixed(2)}）`;
      const jibe = jibeOf(worst);
      lines.push(jibe === '' ? contrast : `${contrast}，${jibe}`);
    }
  }

  return lines.join('\n');
}

/**
 * 单局短评：只在明显好/明显糟时给，中间的留白。
 *
 * 2026-11-16 改：这里原来有一条 `kdaRatio < 1.5 → 「这局有点划水」`，
 * 和 buildMatchNotes 里被用户骂掉的那条是同一句话、同一个毛病 ——
 * 最近战绩列表（/players/{id}/recentMatches）里**没有任何队内数据**，
 * 拿纯 KDA 判「划水」就是抓一条数字给人定性。线上 9091501690 的巫医
 * （7/15/9 → KDA 1.07，实际满参团、伤害队内第二）正好落在这一档。
 * 既然这一层拿不到证据，就按「有证据才说」闭嘴：只留「送」这档
 * （KDA < 0.8 时死亡数确实压过击杀+助攻，说的是比分不是人）。
 * 想给这局定性就让上层走单场解析 —— 那里有 factSheet 撑腰。
 */
function teaseLine(m: DotaMatchSummary): string {
  if (m.win) {
    if (m.kdaRatio >= 5) return '这局带飞';
    if (m.kdaRatio >= 3) return '打得挺稳';
    // 赢了就不埋汰 —— "躺赢" 这类词在群里容易被当真
    return '';
  }
  if (m.kdaRatio < 0.8) return '这局有点送';
  return '';
}

/**
 * 给"最差那局"配一句话。
 * 只对**输局**开口：赢了还说人家掉链子，读起来像找茬。
 *
 * 2026-11-16 同上：去掉「那局有点划水」那一档（纯 KDA 定性，没有队内数据支撑），
 * 「死得有点多」是死亡数直接说的，留着。
 */
function jibeOf(m: DotaMatchSummary): string {
  if (m.win) return '';
  if (m.kdaRatio < 0.8) return '那局基本被按着打';
  if (m.deaths >= 10) return '死得有点多';
  return '';
}

// ── 单场详细解析 ────────────────────────────────────────────

/** 事件属于哪方：优先 team，其次 player_slot（OpenDota 常只给后者） */
function objectiveTeam(o: RawObjective): number | null {
  if (o.team === 2 || o.team === 3) return o.team;
  if (o.playerSlot !== null) return o.playerSlot < 128 ? 2 : 3;
  return null;
}

/**
 * 推塔归属：`badguys_*` 是夜魇的建筑（被天辉拆）→ 2；
 * `goodguys_*` 是天辉的建筑（被夜魇拆）→ 3。
 */
function towerTeam(key: string | null): number | null {
  if (key === null) return null;
  if (key.includes('badguys')) return 2;
  if (key.includes('goodguys')) return 3;
  return null;
}

/**
 * 判断这局他打的是核心还是辅助。
 *
 * 2026-11-15 修（用户原话：「你看清楚这局谁是辅助谁是输出」）：
 * 之前 MatchDetailForm 里根本没有定位信息，简报只给 KDA/经济/伤害排名，
 * 模型只能靠英雄名猜，把「赏金猎人 2/6/19」当成主输出骂了一整轮。
 *
 * 判据只用客观行为，**不看英雄名**（OMG 里英雄更是个壳子）：
 *   1. 插眼 + 屯野 —— 只要明显在铺视野，就是辅助；
 *   2. 正补占全队比例 —— 队内两位主力刷钱的一眼能看出来；
 *   3. 经济排名兜底（队内第 4/5 且正补不多 = 辅助位）。
 * 判不出来就返回 unknown，宁可不说话也别让模型瞎猜。
 */
function inferRole(
  player: RawMatchPlayer,
  teamPlayers: RawMatchPlayer[],
  worthOf: (p: RawMatchPlayer) => number,
): { role: MatchRole; reason: string } {
  const wards = (player.obs_placed ?? 0) + (player.sen_placed ?? 0);
  const camps = player.camps_stacked ?? 0;

  // 队内两位刷钱主力（按净资产）
  const sortedWorth = [...teamPlayers].sort((a, b) => worthOf(b) - worthOf(a));
  const worthRank = sortedWorth.indexOf(player) + 1;
  const topTwo = new Set(sortedWorth.slice(0, 2));

  // 正补占全队比例：核心一般占 20% 以上，辅助常年在 10% 以下
  const teamLastHits = teamPlayers.reduce((s, p) => s + p.last_hits, 0);
  const lhShare = teamLastHits > 0 ? player.last_hits / teamLastHits : 0;

  // 队列视野 / 屯野：确实在干辅助的活
  if (wards >= 6 && lhShare < 0.18) {
    return { role: 'support', reason: `插了 ${wards} 个眼，明显在铺视野` };
  }
  if (wards >= 4 && worthRank >= 4 && lhShare < 0.15) {
    return { role: 'support', reason: `插了 ${wards} 个眼、队内经济第 ${worthRank}` };
  }
  if (camps >= 3 && worthRank >= 4) {
    return { role: 'support', reason: `屯野 ${camps} 次、队内经济第 ${worthRank}` };
  }
  // 刷钱主力：正补占比高 + 经济在前二
  if (topTwo.has(player) && lhShare >= 0.15) {
    return { role: 'core', reason: `正补占全队 ${Math.round(lhShare * 100)}%，队内经济第 ${worthRank}` };
  }
  if (worthRank >= 4 && lhShare < 0.12) {
    return {
      role: 'support',
      reason: `正补只占全队 ${Math.round(lhShare * 100)}%、队内经济第 ${worthRank}`,
    };
  }
  if (worthRank <= 3 && lhShare >= 0.12) {
    return { role: 'core', reason: `正补占全队 ${Math.round(lhShare * 100)}%、队内经济第 ${worthRank}` };
  }
  return { role: 'unknown', reason: '经济与补刀都夹在中间，看不出明显定位' };
}

/**
 * factSheet 的客观阈值表（2026-11-16 新增）。
 *
 * 为什么要把它写成常量对象、而且每条都注明依据：
 *   1. 这些数字决定「优势 / 劣势 / 无异常」，模型会照着它评价人，必须能查、能调；
 *   2. 散在 if 里的魔法数字没人敢动，调一次要全文搜；
 *   3. 群里那几条错评（「0/7/25 是混子」「赏金伤害垫底是主输出菜」）的根子就是
 *      没人定义过「什么叫低」—— 现在有定义，就能反驳模型，也能以后按群的实际水平调。
 *
 * 取值的来历：都是「明显偏离队友」的经验分界，不是精确统计。宁可少判 plus，
 * 也别把平庸当亮点 —— 判错的成本是一整轮群聊的嘲讽，不是测试用例。
 */
export const FACT_THRESHOLDS = {
  // ── 输出 ──
  /** 伤害占队内最高 >= 85% 才叫「主要输出」：五个人里排第一的那个是 100%，85% ≈ 与第一几乎并驾 */
  damageSharePlus: 0.85,
  /** 伤害不到队内最高的 40% ≈ 不到第一的一半，五人均分是 20% 上下，40% 已经明显掉队 */
  damageShareMinus: 0.40,
  /**
   * 「队内垫底」这条单独判 minus：伤害排最后一名（5 人队）就是这一项他是队里最少的，
   * 数字上无争议；但只在这个比例以下才算 —— 60% 是「第二梯队」的上沿，
   * 比这还低的垫底才是真的没什么输出（对照 9089522269：赏金 18821 / 队内最高 36054 = 52%，
   * 排 5/5，这一项就该记 minus，再由 findings 说明「辅助位不靠伤害说话」）。
   */
  damageShareLastMinus: 0.60,

  // ── 经济 ──
  /** GPM 与队内第一差距 <= 10% 且排名前二 → 经济没掉队（同一档） */
  gpmGapPlus: 0.10,
  /** 比队内第一低 25% 以上 → 经济确实掉队（核心位这条最刺眼，辅助位改看同定位队友） */
  gpmGapMinus: 0.25,
  /** 与同定位（同为辅助 / 同为核心）队友的人均值比：>= 1.2 倍算 plus，<= 0.8 倍算 minus */
  sameRoleRatioPlus: 1.20,
  sameRoleRatioMinus: 0.80,

  // ── 补刀 ──
  /** 同定位队友人均正补的 1.2 倍以上算吃得多，0.8 倍以下算明显没补上 */
  lastHitsRatioPlus: 1.20,
  lastHitsRatioMinus: 0.80,

  // ── 视野 ──
  /** 插眼数占队内最多的 60% 以上 → 视野这局是他撑的（辅助的活就是这个） */
  wardSharePlus: 0.60,
  /**
   * 辅助位的放宽口径：一局插到 5 个眼（观察+岗哨）且队内前二，也算视野是加分项。
   * 为什么不硬按 60% 卡：队里两个辅助常常一个主铺、一个游走，游走辅助眼少不代表没干活；
   * 5 个眼在 35 分钟以上的局里已经是真在铺视野了（对照 11-16 的 9089522269：赏金 5 个、
   * 同队光法 12 个，按 60% 会把「他在插眼」直接判成无异常）。
   */
  wardSupportMin: 5,
  wardSupportRankMax: 2,
  /** 辅助位插眼不到队内最多的 15% → 基本没铺视野，这才是真该说的 */
  wardShareMinus: 0.15,

  // ── 团战 ──
  /** 参团率 >= 85% 算全程在场；< 50% 算基本没跟团 */
  teamfightRatePlus: 0.85,
  teamfightRateMinus: 0.50,

  // ── 死亡 ──
  /** 死亡数 <= 全队平均的 60% → 这局很难死；>= 平均的 1.3 倍 → 死得明显多 */
  deathsAvgPlus: 0.60,
  deathsAvgMinus: 1.30,

  // ── 目标 ──
  /** 建筑伤害占队内最多的 60% 以上 → 推塔是他推的；治疗 >= 3000 也算一项实打实的贡献 */
  towerSharePlus: 0.60,
  healingPlus: 3000,

  // ── 长度上限（上下文不能爆，2026-11-16 用户要求）──
  /** 每条 fact 最多多少字（汉字/字符），超了截断加「…」 */
  maxFactChars: 40,
  /** 整份 factSheet 序列化后最多多少字；超了先丢 flat 行（plus/minus 优先留） */
  maxSerializedChars: 1200,
  /** findings 条数：2~3 条，多了模型反而只念最后一条 */
  minFindings: 2,
  maxFindings: 3,
} as const;

/** verdict → 给人看的三个词。刻意不用 emoji/符号：模型会跟着抄，群里看着就脏 */
const VERDICT_TEXT: Record<MatchFactLine['verdict'], string> = {
  plus: '优势',
  minus: '劣势',
  flat: '无异常',
};

/** lane_role（OpenDota 口径）→ 分路中文；未知就是未知，不许猜 */
const LANE_ROLE_TEXT: Record<number, string> = {
  1: '优势路',
  2: '中路',
  3: '劣势路',
  4: '打野',
};

/** 按「字符」算长度（汉字、数字、标点都算 1 个），用于事实清单的长度上限 */
function charLen(s: string): number {
  return [...s].length;
}

/** 超长就截断并加「…」，保证单条 fact 不超 maxFactChars */
function clampText(s: string, max: number): string {
  if (charLen(s) <= max) return s;
  return `${[...s].slice(0, max - 1).join('')}…`;
}

/** 角色 → 中文，只在 fact/finding 里说话用 */
function roleText(role: MatchRole | undefined): string {
  if (role === 'core') return '核心位';
  if (role === 'support') return '辅助位';
  return '定位看不出';
}

/** buildFactSheet 的入参：单场数据的全部已知字段 + 队内对比基线 */
export type FactSheetInput = Omit<MatchDetailForm, 'summaryText' | 'factSheet'> & {
  /** 队内「别人的数值」快照；缺了就只能退化成只看本人排名（不崩） */
  baseline?: MatchTeamBaseline;
};

/**
 * 生成事实清单（2026-11-16 新增）。
 *
 * 设计要点，改之前先看这段：
 *   1. **只用客观阈值，不写褒贬形容词** —— 「GPM 364（队内第 4/5，比队内第一低 153）」
 *      这种话说出口谁都能复核；「经济拉胯」没法复核，还会被模型直接抄进群里。
 *   2. **没有数据 ≠ 数据不好** —— 未解析局（goldSwing/teamfights 为 null、插眼字段是
 *      null）一律记 flat 并写明「未解析」，绝不因为读不到就判 minus。
 *   3. **辅助不看核心的尺子** —— 经济/补刀对辅助改成跟同定位队友比；伤害一项对辅助
 *      仍然会记 minus（数字确实低），但 findings 里必须点明「辅助位不靠伤害说话」，
 *      不许推出「他菜」。
 *   4. findings 每条都挂 evidence（lines 下标），保证模型说的每句结论都能指回一行数据。
 */
export function buildFactSheet(form: FactSheetInput): MatchFactSheet {
  const p = form.player;
  const tr = form.teamRank;
  const b = form.baseline;
  const size = Math.max(1, tr.teamSize);
  const isSupport = p.role === 'support';
  const lines: MatchFactLine[] = [];

  // ── 经济 ──
  const gpmRank = b?.gpmRank ?? tr.netWorth;
  const gpmTop = b?.gpmTop ?? 0;
  const gpmGap = gpmTop > 0 ? Math.max(0, gpmTop - p.gpm) : 0;
  const gpmGapPct = gpmTop > 0 ? gpmGap / gpmTop : 0;
  {
    let verdict: MatchFactLine['verdict'] = 'flat';
    let fact: string;
    const mates = b?.sameRoleGpm ?? [];
    const mateAvg = mates.length > 0 ? mates.reduce((s, v) => s + v, 0) / mates.length : 0;
    if (isSupport && mateAvg > 0) {
      // 辅助跟辅助比：拿核心的 GPM 当尺子，辅助在这项上永远是「垫底」，
      // 那是位置决定的，不是问题（11-16 那局的赏金就是这么被骂的）。
      const ratio = p.gpm / mateAvg;
      if (ratio >= FACT_THRESHOLDS.sameRoleRatioPlus) verdict = 'plus';
      else if (ratio <= FACT_THRESHOLDS.sameRoleRatioMinus) verdict = 'minus';
      fact = `GPM ${p.gpm}（辅助位同定位队友人均 ${Math.round(mateAvg)}，队内第 ${gpmRank}/${size}）`;
    } else if (p.role === 'core' && gpmTop > 0) {
      if (gpmGapPct >= FACT_THRESHOLDS.gpmGapMinus) verdict = 'minus';
      else if (gpmGapPct <= FACT_THRESHOLDS.gpmGapPlus && gpmRank <= 2) verdict = 'plus';
      fact = `GPM ${p.gpm}（队内第 ${gpmRank}/${size}，比队内第一低 ${gpmGap}）`;
    } else {
      // 定位看不出（role=unknown）：不知道他是核心还是辅助，就没法说这个 GPM 算不算低。
      // 记 flat，只陈述数字 —— 把「没判出定位」当成「经济差」正是要杜绝的那种错评。
      // 但补一句队内中位数当参照：模型自己看一眼就知道 364 在 5 人队里属于哪一档。
      const medText = b !== undefined && b.gpmMedian > 0 ? `，队内中位数 ${b.gpmMedian}` : '';
      fact = gpmTop > 0
        ? `GPM ${p.gpm}（队内第 ${gpmRank}/${size}${medText}；定位未判出）`
        : `GPM ${p.gpm}（缺队内对比数据）`;
    }
    lines.push({ dim: '经济', fact: clampText(fact, FACT_THRESHOLDS.maxFactChars), verdict });
  }

  // ── 输出 ──
  const dmgTop = b?.damageTop ?? 0;
  const dmgShare = dmgTop > 0 ? p.heroDamage / dmgTop : 0;
  {
    let verdict: MatchFactLine['verdict'] = 'flat';
    if (dmgTop > 0) {
      if (dmgShare >= FACT_THRESHOLDS.damageSharePlus) {
        verdict = 'plus';
      } else if (dmgShare < FACT_THRESHOLDS.damageShareMinus) {
        verdict = 'minus';
      } else if (
        // 队内垫底 + 比例也在第二梯队以下 —— 数字上确实是他最少，记 minus。
        // 对辅助也照记（数据不能改），但 findings 必须点明「辅助不靠伤害说话」，
        // 不许由此推出「他菜」。
        tr.heroDamage >= size
        && dmgShare < FACT_THRESHOLDS.damageShareLastMinus
      ) {
        verdict = 'minus';
      }
    }
    lines.push({
      dim: '输出',
      fact: clampText(
        dmgTop > 0
          ? `伤害 ${p.heroDamage}（队内第 ${tr.heroDamage}/${size}，占队内最高 ${Math.round(dmgShare * 100)}%）`
          : `伤害 ${p.heroDamage}（缺队内对比数据）`,
        FACT_THRESHOLDS.maxFactChars,
      ),
      verdict,
    });
  }

  // ── 补刀 ──
  {
    let verdict: MatchFactLine['verdict'] = 'flat';
    const mates = b?.sameRoleLastHits ?? [];
    const top = b?.lastHitsTop ?? p.lastHits;
    let fact: string;
    if (isSupport) {
      // 辅助不参与补刀比较：正补本来就是让给核心的，拿这条量辅助就是错评
      fact = `正补 ${p.lastHits}/反补 ${p.denies}（辅助位不计入比较）`;
    } else if (p.role === 'core' && mates.length > 0) {
      const avg = mates.reduce((s, v) => s + v, 0) / mates.length;
      if (avg > 0) {
        const ratio = p.lastHits / avg;
        if (ratio >= FACT_THRESHOLDS.lastHitsRatioPlus) verdict = 'plus';
        else if (ratio <= FACT_THRESHOLDS.lastHitsRatioMinus) verdict = 'minus';
      }
      fact = `正补 ${p.lastHits}/反补 ${p.denies}（同定位队友人均 ${Math.round(avg)}）`;
    } else {
      // 定位看不出：不判好坏，只给数字（队内最多 + 占全队比例）。
      // 「占全队 7%」这种比例本身就是客观事实，模型拿它自己就能看出这是辅助位，
      // 不需要我们替它下结论，也就不会出现「补刀少所以他菜」这种没有依据的因果。
      const share = (b?.lastHitsTotal ?? 0) > 0 ? p.lastHits / (b?.lastHitsTotal ?? 1) : 0;
      fact = `正补 ${p.lastHits}/反补 ${p.denies}（队内最多 ${top}，占全队 ${Math.round(share * 100)}%；定位未判出）`;
    }
    lines.push({ dim: '补刀', fact: clampText(fact, FACT_THRESHOLDS.maxFactChars), verdict });
  }

  // ── 视野 ──
  const wards = (p.obsPlaced ?? 0) + (p.senPlaced ?? 0);
  const wardsKnown = b?.wardsKnown ?? false;
  const wardsTop = b?.wardsTop ?? 0;
  const wardShare = wardsTop > 0 ? wards / wardsTop : 0;
  const wardRank = b?.wardRank ?? (wards > 0 ? 1 : size);
  {
    let verdict: MatchFactLine['verdict'] = 'flat';
    if (!wardsKnown) {
      // 未解析局：插眼字段整列是 null，这里只能如实说没数据，不能说"他没插眼"
      verdict = 'flat';
    } else if (wardShare >= FACT_THRESHOLDS.wardSharePlus) {
      verdict = 'plus';
    } else if (
      isSupport
      && wards >= FACT_THRESHOLDS.wardSupportMin
      && wardRank <= FACT_THRESHOLDS.wardSupportRankMax
    ) {
      verdict = 'plus';
    } else if (isSupport && wardsTop >= FACT_THRESHOLDS.wardSupportMin && wardShare < FACT_THRESHOLDS.wardShareMinus) {
      verdict = 'minus';
    }
    lines.push({
      dim: '视野',
      fact: clampText(
        wardsKnown
          ? `插眼 ${wards} 个（观察 ${p.obsPlaced ?? 0}/岗哨 ${p.senPlaced ?? 0}，队内最多 ${wardsTop}）`
          : '插眼数据未解析（字段为空）',
        FACT_THRESHOLDS.maxFactChars,
      ),
      verdict,
    });
  }

  // ── 团战 ──
  {
    let verdict: MatchFactLine['verdict'] = 'flat';
    let fact: string;
    if (form.teamfights === null) {
      fact = '团战数据未解析';
    } else if (form.teamfights.count === 0) {
      fact = '这场没记录到团战';
    } else {
      const rate = form.teamfights.participated / form.teamfights.count;
      if (rate >= FACT_THRESHOLDS.teamfightRatePlus) verdict = 'plus';
      else if (rate < FACT_THRESHOLDS.teamfightRateMinus) verdict = 'minus';
      fact = `参团 ${form.teamfights.participated}/${form.teamfights.count}（${Math.round(rate * 100)}%）`;
    }
    lines.push({ dim: '团战', fact: clampText(fact, FACT_THRESHOLDS.maxFactChars), verdict });
  }

  // ── 目标 ──
  const towerTop = b?.towerTop ?? 0;
  {
    const ob = form.objectives;
    let verdict: MatchFactLine['verdict'] = 'flat';
    if (towerTop > 0 && p.towerDamage / towerTop >= FACT_THRESHOLDS.towerSharePlus) verdict = 'plus';
    else if (p.heroHealing >= FACT_THRESHOLDS.healingPlus) verdict = 'plus';
    lines.push({
      dim: '目标',
      fact: clampText(
        `建筑 ${p.towerDamage} · 治疗 ${p.heroHealing} · 肉山 天辉 ${ob.roshan.radiant}/夜魇 ${ob.roshan.dire}`,
        FACT_THRESHOLDS.maxFactChars,
      ),
      verdict,
    });
  }

  // ── 死亡 ──
  const deathsAvg = b?.deathsAvg ?? p.deaths;
  {
    let verdict: MatchFactLine['verdict'] = 'flat';
    if (deathsAvg > 0) {
      if (p.deaths >= deathsAvg * FACT_THRESHOLDS.deathsAvgMinus) verdict = 'minus';
      else if (p.deaths <= deathsAvg * FACT_THRESHOLDS.deathsAvgPlus) verdict = 'plus';
    }
    lines.push({
      dim: '死亡',
      fact: clampText(
        `死亡 ${p.deaths}（全队平均 ${Math.round(deathsAvg * 10) / 10}）`,
        FACT_THRESHOLDS.maxFactChars,
      ),
      verdict,
    });
  }

  // ── 出装：只陈述买了什么 ──
  // 「同一件装备在同类英雄里的出场率」这种要跨局统计，本局数据里根本没有，
  // 硬编就是造数据 —— 所以这里只列表，不加任何推断。
  // 只列前 3 件：fact 上限 40 字，4 件中文名就撑爆截断了（实测 9091501690 会把
  // 「弗拉迪米尔的祭品」截成半个词，读起来像乱码）。
  if (p.items.length > 0) {
    const zh = p.itemsZh ?? p.items;
    const head = zh.slice(0, 3).join('、');
    lines.push({
      dim: '出装',
      fact: clampText(`出装 ${head}${zh.length > 3 ? ` 等 ${zh.length} 件` : ''}`, FACT_THRESHOLDS.maxFactChars),
      verdict: 'flat',
    });
  }

  // ── 分路：未知就说未知 ──
  {
    const lane = p.laneRole ?? null;
    const laneText = lane !== null && LANE_ROLE_TEXT[lane] !== undefined
      ? `${LANE_ROLE_TEXT[lane]}（lane_role=${lane}）`
      : '未知（lane_role 没给）';
    lines.push({ dim: '分路', fact: clampText(`分路 ${laneText}`, FACT_THRESHOLDS.maxFactChars), verdict: 'flat' });
  }

  // ── 未解析说明：单独一行，免得模型把「未解析」当「打得差」 ──
  if (form.goldSwing === null) {
    lines.push({ dim: '解析', fact: '这局 OpenDota 未解析完：经济曲线/团战/技能缺席', verdict: 'flat' });
  }

  return finalizeFactSheet(lines, form);
}

/** 取某个维度的行号；没有就 -1（findings 的 evidence 只用真实存在的下标） */
function dimIndex(lines: MatchFactLine[], dim: string): number {
  return lines.findIndex((l) => l.dim === dim);
}

/**
 * 收敛长度。
 *
 * 长度上限是硬要求（2026-11-16 用户原话「别让上下文爆掉」）：这份东西会跟着
 * 每条简报走，一场 5 个群友、窗口 8 场 —— 不管住就会把上下文吃光，
 * 模型反而更不敢细看。
 *
 * 截断顺序刻意是「**按 verdict 排序**」而不是简单砍尾巴：
 *   1. 先丢 flat（无异常/无数据的行信息量最低，砍了最不心疼）；
 *   2. 还超就从后往前继续丢（分路/出装/解析 这些维度排在后面，本来就是背景信息）；
 *   3. plus/minus 是这局的真问题与真亮点，最后才动。
 * 每丢一行都必须把 findings 的 evidence 下标整体往前挪一格 —— 下标错位等于让模型
 * 指着 A 行说 B 行的话，那比不截断还糟。
 *
 * 导出是为了单测能直接喂一份超长的清单验证截断（自然生成的 9~10 行凑不到 1200 字，
 * 走不到这条分支，留着不验就等于没写）。
 */
export function enforceFactSheetLimits(
  lines: MatchFactLine[],
  findings: Array<{ text: string; evidence: number[] }>,
): MatchFactSheet {
  const size = (ls: MatchFactLine[], fs: Array<{ text: string; evidence: number[] }>): number =>
    JSON.stringify({ lines: ls, findings: fs }).length;

  const kept = [...lines];
  const out = findings.map((f) => ({ text: f.text, evidence: [...f.evidence] }));
  if (size(kept, out) <= FACT_THRESHOLDS.maxSerializedChars) return { lines: kept, findings: out };

  /** 丢掉 kept[at]，同时把 findings 的 evidence 下标挪正 */
  const dropAt = (at: number): void => {
    kept.splice(at, 1);
    const shifted: Array<{ text: string; evidence: number[] }> = [];
    for (const f of out) {
      const ev = f.evidence.filter((e) => e !== at).map((e) => (e > at ? e - 1 : e));
      // evidence 被清空的 finding 就没法指回数据了，宁可不要（不许留无凭据的结论）
      if (ev.length > 0) shifted.push({ text: f.text, evidence: ev });
    }
    out.length = 0;
    out.push(...shifted.slice(0, FACT_THRESHOLDS.maxFindings));
  };

  // 第一轮：flat 从后往前丢
  for (const at of kept.map((l, i) => ({ i, v: l.verdict })).filter((x) => x.v === 'flat').map((x) => x.i).reverse()) {
    if (size(kept, out) <= FACT_THRESHOLDS.maxSerializedChars) break;
    dropAt(at);
  }
  // 第二轮：还超就继续从后往前丢（plus/minus 留到最后）
  while (kept.length > 1 && size(kept, out) > FACT_THRESHOLDS.maxSerializedChars) {
    dropAt(kept.length - 1);
  }
  // 第三轮：行已经砍到只剩一行还超，就把 findings 文本也砍掉（宁可没结论候选，
  // 也不能把整段提示词撑爆；事实清单本身仍然在，模型照样能逐项说）
  if (size(kept, out) > FACT_THRESHOLDS.maxSerializedChars) {
    out.length = 0;
  }
  return { lines: kept, findings: out };
}

/**
 * 生成 findings 后统一过一遍限长。
 * 顺序上必须先有 findings 再截断：findings 要用「还没被砍掉的行」当下标基准。
 */
function finalizeFactSheet(
  lines: MatchFactLine[],
  form: FactSheetInput,
): MatchFactSheet {
  return enforceFactSheetLimits(lines, buildFindings(lines, form));
}

/**
 * 结论候选：2~3 条，每条挂 evidence（lines 下标）。
 *
 * weight 是「这条值得先说」的排序，不是重要性的绝对值：
 *   输出/经济是群里最爱聊的，但辅助位的「伤害低」必须先说清不构成问题 ——
 *   否则模型自己会把它推成「他菜」（11-16 那两局错评都是这么来的）。
 */
function buildFindings(
  lines: MatchFactLine[],
  form: FactSheetInput,
): Array<{ text: string; evidence: number[] }> {
  const p = form.player;
  const size = Math.max(1, form.teamRank.teamSize);
  const isSupport = p.role === 'support';
  const dmgTop = form.baseline?.damageTop ?? 0;
  const dmgShare = dmgTop > 0 ? Math.round((p.heroDamage / dmgTop) * 100) : 0;
  const wards = (p.obsPlaced ?? 0) + (p.senPlaced ?? 0);
  const iEco = dimIndex(lines, '经济');
  const iDmg = dimIndex(lines, '输出');
  const iLh = dimIndex(lines, '补刀');
  const iWard = dimIndex(lines, '视野');
  const iTf = dimIndex(lines, '团战');
  const iObj = dimIndex(lines, '目标');
  const iDeath = dimIndex(lines, '死亡');

  const cands: Array<{ text: string; evidence: number[]; weight: number }> = [];
  const push = (text: string, evidence: number[], weight: number): void => {
    // evidence 只留真实存在的下标：造一个不存在的下标等于让模型指错行
    const ev = [...new Set(evidence.filter((i) => i >= 0))];
    if (ev.length === 0) return;
    cands.push({ text, evidence: ev, weight });
  };

  const dmgVerdict = lines[iDmg]?.verdict;
  const ecoVerdict = lines[iEco]?.verdict;
  const wardVerdict = lines[iWard]?.verdict;
  const tfVerdict = lines[iTf]?.verdict;
  const lhVerdict = lines[iLh]?.verdict;
  const deathVerdict = lines[iDeath]?.verdict;
  const objVerdict = lines[iObj]?.verdict;

  if (dmgVerdict === 'plus') {
    push(`伤害 ${p.heroDamage} 占队内最高的 ${dmgShare}%（队内第 ${form.teamRank.heroDamage}/${size}），这局输出靠他`, [iDmg, iEco], 95);
  }
  if (dmgVerdict === 'minus' && isSupport) {
    // 辅助伤害低是位置决定的：这里必须点明，否则模型会自己补一句「菜」
    push(`伤害占队内最高只有 ${dmgShare}%，但他是辅助位（插眼 ${wards} 个），辅助不靠伤害说话`, [iDmg, iWard].filter((i) => i >= 0), 90);
  }
  if (dmgVerdict === 'minus' && !isSupport) {
    push(`伤害只占队内最高的 ${dmgShare}%（队内第 ${form.teamRank.heroDamage}/${size}），${roleText(p.role)}这输出偏低`, [iDmg, iLh], 88);
  }
  if (wardVerdict === 'plus') {
    push(`插眼 ${wards} 个，视野是这局的加分项`, [iWard, iDmg], 80);
  }
  if (ecoVerdict === 'plus') {
    push(`GPM ${p.gpm} 队内第 ${form.teamRank.netWorth}/${size}，经济没掉队`, [iEco], 78);
  }
  if (ecoVerdict === 'minus') {
    push(`GPM ${p.gpm} 比队内第一低 ${Math.max(0, (form.baseline?.gpmTop ?? p.gpm) - p.gpm)}，经济确实掉队`, [iEco], 76);
  }
  if (tfVerdict === 'minus' && form.teamfights !== null) {
    const tf = form.teamfights;
    push(`团战只赶上 ${tf.participated}/${tf.count}，参团偏少`, [iTf], 74);
  }
  if (tfVerdict === 'plus' && form.teamfights !== null) {
    const tf = form.teamfights;
    push(`团战 ${tf.participated}/${tf.count} 全程在场`, [iTf], 60);
  }
  if (lhVerdict === 'minus' && !isSupport) {
    push(`正补 ${p.lastHits}，同定位队友人均 ${Math.round(avgOf(form.baseline?.sameRoleLastHits ?? []))}`, [iLh, iEco], 66);
  }
  if (lhVerdict === 'plus' && !isSupport) {
    push(`正补 ${p.lastHits}，同定位里补得最多`, [iLh], 58);
  }
  if (deathVerdict === 'minus') {
    push(`死了 ${p.deaths} 次，全队平均 ${Math.round((form.baseline?.deathsAvg ?? p.deaths) * 10) / 10}`, [iDeath], 70);
  }
  if (objVerdict === 'plus') {
    push(`建筑伤害 ${p.towerDamage} / 治疗 ${p.heroHealing}，目标是他在推`, [iObj], 55);
  }

  cands.sort((a, b) => b.weight - a.weight);
  const out = cands.slice(0, FACT_THRESHOLDS.maxFindings).map((c) => ({ text: c.text, evidence: c.evidence }));

  // 太平淡的局也得给够 2 条：否则模型只剩 KDA 可说，又会回到「抓一条就评」。
  // 兜底这两条只用一定存在的「经济/输出」两行，不编任何因果。
  if (out.length < FACT_THRESHOLDS.minFindings && iEco >= 0 && iDmg >= 0) {
    const base1 = `伤害 ${p.heroDamage}（队内第 ${form.teamRank.heroDamage}/${size}，占队内最高 ${dmgShare}%），GPM ${p.gpm}（队内第 ${form.teamRank.netWorth}/${size}）`;
    if (!out.some((f) => f.text.includes('GPM'))) {
      out.push({ text: base1, evidence: [iEco, iDmg] });
    }
  }
  if (out.length < FACT_THRESHOLDS.minFindings && iEco >= 0) {
    out.push({
      text: `这局 KDA ${p.kills}/${p.deaths}/${p.assists}，${VERDICT_TEXT[lines[iEco]?.verdict ?? 'flat']}项很少，逐项看下来没有明显异常`,
      evidence: [iEco],
    });
  }
  return out.slice(0, FACT_THRESHOLDS.maxFindings);
}

function avgOf(list: number[]): number {
  if (list.length === 0) return 0;
  return list.reduce((s, v) => s + v, 0) / list.length;
}

/**
 * 从一场里挑「数据突出的非群友」—— 乱杀或巨坑的路人/对手（2026-11-20）。
 *
 * 认错人防线：传入的 `boundIds` 是这场所有**绑定群友**的 accountId；命中即跳过。
 * 注意 buildMatchDetailForm 是纯函数、看不到绑定表，所以由调用方（matchDetail）
 * 在查完绑定后把 boundIds 传进来；没传时就一个都不挑（宁可不说，不可认错人）。
 *
 * 挑的是「相对极端」的人，不是随便谁：
 *   - 击杀 >= 12 且死亡 <= 6（乱杀），或
 *   - 死亡 >= 10（巨坑），或
 *   - 全场伤害最高且 >= 对手方营收线（数据碾压）。
 * 最多 2 个，避免喧宾夺主 —— 播报主角还是群友。
 */
export function pickStandouts(
  raw: RawMatchDetail,
  me: RawMatchPlayer,
  boundIds: ReadonlySet<number>,
): MatchStandoutPlayer[] {
  if (boundIds.size === 0) return [];
  const mySide = me.player_slot < 128;
  const candidates = raw.players
    .filter((p) => p !== me && p.account_id !== null && !boundIds.has(p.account_id))
    .map((p) => {
      const dmg = p.hero_damage ?? 0;
      let reason = '';
      if (p.kills >= 12 && p.deaths <= 6) reason = `${p.kills}/${p.deaths}/${p.assists}，全场乱杀级击杀`;
      else if (p.deaths >= 10) reason = `${p.kills}/${p.deaths}/${p.assists}，死亡偏多`;
      return { p, dmg, reason };
    })
    .filter((x) => x.reason !== '');

  // 伤害碾压单独挑一个（不和上面的重复）：全场伤害最高、且明显高过第二名
  const byDamage = [...raw.players].sort((a, b) => (b.hero_damage ?? 0) - (a.hero_damage ?? 0));
  const top = byDamage[0];
  const second = byDamage[1];
  if (
    top !== undefined && top !== me && top.account_id !== null && !boundIds.has(top.account_id)
    && (top.hero_damage ?? 0) >= 20000
    && second !== undefined && (top.hero_damage ?? 0) >= (second.hero_damage ?? 0) * 1.5
    && !candidates.some((c) => c.p === top)
  ) {
    candidates.push({
      p: top,
      dmg: top.hero_damage ?? 0,
      reason: `${top.kills}/${top.deaths}/${top.assists}，全场伤害最高 ${Math.round((top.hero_damage ?? 0) / 1000)}k`,
    });
  }

  return candidates.slice(0, 2).map(({ p, reason }): MatchStandoutPlayer => ({
    heroName: heroName(p.hero_id),
    relation: (p.player_slot < 128) === mySide ? 'teammate' : 'opponent',
    kda: `${p.kills}/${p.deaths}/${p.assists}`,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    gpm: p.gold_per_min,
    heroDamage: p.hero_damage ?? 0,
    reason,
  }));
}

export function buildMatchDetailForm(
  raw: RawMatchDetail,
  accountId: number,
  itemName: (id: number) => string,
): MatchDetailForm {
  const player = raw.players.find((p) => p.account_id === accountId);
  if (player === undefined) {
    throw new OpenDotaError(
      'bad-request',
      `这场对局里没有 account_id=${accountId} 的玩家（可能没参与，或该场数据未收录）`,
    );
  }

  const isRadiant = player.player_slot < 128;
  const playerIndex = raw.players.indexOf(player);
  const win = isRadiant === raw.radiantWin;
  const teamPlayers = raw.players.filter((p) => (p.player_slot < 128) === isRadiant);

  // 净资产缺失时用 GPM × 分钟估算，保证排名不因缺字段全变 0
  const minutes = Math.max(1, Math.round(raw.durationSec / 60));
  const worthOf = (p: RawMatchPlayer): number => p.net_worth ?? p.gold_per_min * minutes;
  const dmgOf = (p: RawMatchPlayer): number => p.hero_damage ?? 0;

  const rankBy = (list: RawMatchPlayer[], get: (p: RawMatchPlayer) => number): number => {
    const sorted = [...list].sort((a, b) => get(b) - get(a));
    return sorted.indexOf(player) + 1;
  };

  const role = inferRole(player, teamPlayers, worthOf);

  // 对位：同 lane_role 的敌方玩家（多人则取经济最高的那个）
  let laneOpponent: MatchDetailForm['laneOpponent'] = null;
  if (player.lane_role !== null) {
    const foes = raw.players
      .filter((p) => (p.player_slot < 128) !== isRadiant && p.lane_role === player.lane_role)
      .sort((a, b) => worthOf(b) - worthOf(a));
    const opp = foes[0];
    if (opp !== undefined) {
      laneOpponent = {
        heroName: heroName(opp.hero_id),
        gpmDiff: player.gold_per_min - opp.gold_per_min,
        damageDiff: dmgOf(player) - dmgOf(opp),
      };
    }
  }

  // 目标事件：首血 / 肉山 / 推塔
  // 注意 OpenDota 的坑：building_kill 没有 team，首血也常常没有 —— 要按 key / player_slot 推，
  // 直接读 o.team 会得到全场 0（第一版就踩了这个）。
  let firstBlood: 'radiant' | 'dire' | null = null;
  let roshanRadiant = 0;
  let roshanDire = 0;
  let towersRadiant = 0;
  let towersDire = 0;
  for (const o of raw.objectives) {
    if (o.type === 'CHAT_MESSAGE_FIRSTBLOOD') {
      const team = objectiveTeam(o);
      if (team === 2) firstBlood = 'radiant';
      else if (team === 3) firstBlood = 'dire';
    } else if (o.type.includes('ROSHAN_KILL')) {
      const team = objectiveTeam(o);
      if (team === 2) roshanRadiant += 1;
      else if (team === 3) roshanDire += 1;
    } else if (o.type === 'building_kill' && (o.key ?? '').includes('tower')) {
      // team 2 = 天辉拆的，team 3 = 夜魇拆的
      const team = towerTeam(o.key);
      if (team === 2) towersRadiant += 1;
      else if (team === 3) towersDire += 1;
    }
  }

  // 经济曲线（玩家视角：领先为正，落后为负）
  let goldSwing: MatchDetailForm['goldSwing'] = null;
  if (raw.radiantGoldAdv !== null && raw.radiantGoldAdv.length > 0) {
    let maxLead = 0;
    let maxDeficit = 0;
    let leadMinute = 0;
    let deficitMinute = 0;
    raw.radiantGoldAdv.forEach((adv, index) => {
      const lead = isRadiant ? adv : -adv;
      if (lead > maxLead) {
        maxLead = lead;
        leadMinute = index;
      }
      if (lead < maxDeficit) {
        maxDeficit = lead;
        deficitMinute = index;
      }
    });
    goldSwing = { maxLead, maxDeficit: Math.abs(maxDeficit), leadMinute, deficitMinute };
  }

  // 团战参与：该玩家在这段团战里造成过伤害或治疗即算参与。
  // OpenDota 的 teamfights.players 没有 player_slot，是按 players 数组顺序排的，
  // 所以优先按 slot 找（有的版本带），找不到就按下标取。
  let teamfights: MatchDetailForm['teamfights'] = null;
  if (raw.teamfights !== null) {
    let participated = 0;
    for (const fight of raw.teamfights) {
      const entries = fight.players ?? [];
      const entry = entries.find((p) => p.player_slot === player.player_slot) ?? entries[playerIndex];
      if (entry !== undefined && (Number(entry.damage ?? 0) > 0 || Number(entry.healing ?? 0) > 0)) {
        participated += 1;
      }
    }
    teamfights = { count: raw.teamfights.length, participated };
  }

  const items = [player.item_0, player.item_1, player.item_2, player.item_3, player.item_4, player.item_5]
    .filter((id) => id > 0)
    .map((id) => itemName(id));
  // 中文名与英文原名**同时**保留：items 是老字段（向后兼容，其它地方按英文名比对），
  // itemsZh 才是给人/模型看的那份。没收录中文名的位置放英文原名，长度严格对齐 ——
  // 长度不一致的话，"第 N 件装备"这种话就会对错位（2026-11-16）。
  const itemsZh = items.map((en) => itemNameZh(en) ?? en);
  const backpack = [player.backpack_0, player.backpack_1, player.backpack_2]
    .filter((id): id is number => id !== null && id > 0)
    .map((id) => itemName(id));

  // 注意这里先不含 factSheet：它要读 base 里的 KDA/伤害/排名/目标这些算好的字段，
  // 而且 teamRank 又要先算出来 —— 顺序是 base → factSheet → notes → 渲染。
  // baseline（队内别人的数值快照）必须在这之前算：出了这个函数就没有全队原始数据了。
  const baseline = buildTeamBaseline(player, teamPlayers, worthOf);
  const base: Omit<MatchDetailForm, 'summaryText' | 'factSheet'> = {
    matchId: raw.matchId,
    startTimeSec: raw.startTime,
    startText: formatRelative(raw.startTime),
    durationSec: raw.durationSec,
    durationText: `${minutes} 分钟`,
    gameMode: raw.gameMode,
    gameModeText: GAME_MODE_TEXT[raw.gameMode] ?? `模式 ${raw.gameMode}`,
    lobbyType: raw.lobbyType,
    lobbyTypeText: LOBBY_TYPE_TEXT[raw.lobbyType] ?? `房间 ${raw.lobbyType}`,
    isRanked: raw.lobbyType === RANKED_LOBBY,
    radiantWin: raw.radiantWin,
    player: {
      accountId,
      heroId: player.hero_id,
      heroName: heroName(player.hero_id),
      isRadiant,
      win,
      kills: player.kills,
      deaths: player.deaths,
      assists: player.assists,
      kdaRatio: kdaOf(player),
      gpm: player.gold_per_min,
      xpm: player.xp_per_min,
      lastHits: player.last_hits,
      denies: player.denies,
      heroDamage: dmgOf(player),
      towerDamage: player.tower_damage ?? 0,
      heroHealing: player.hero_healing ?? 0,
      netWorth: worthOf(player),
      level: player.level ?? 0,
      items,
      itemsZh,
      backpack,
      laneRole: player.lane_role,
      obsPlaced: player.obs_placed ?? 0,
      senPlaced: player.sen_placed ?? 0,
      campsStacked: player.camps_stacked ?? 0,
      role: role.role,
      roleReason: role.reason,
    },
    teamRank: {
      netWorth: rankBy(teamPlayers, worthOf),
      heroDamage: rankBy(teamPlayers, dmgOf),
      teamSize: teamPlayers.length,
    },
    laneOpponent,
    objectives: {
      firstBlood,
      roshan: { radiant: roshanRadiant, dire: roshanDire },
      towers: { radiant: towersRadiant, dire: towersDire },
    },
    goldSwing,
    teamfights,
    lineup: {
      radiant: raw.players.filter((p) => p.player_slot < 128).map((p) => heroName(p.hero_id)),
      dire: raw.players.filter((p) => p.player_slot >= 128).map((p) => heroName(p.hero_id)),
    },
    // 本人这一队（按 player_slot 顺序）。这里先一律标成"路人"：
    // buildMatchDetailForm 是纯函数、不碰绑定表（签名不能改，很多地方在调），
    // 谁是群友由上层用 annotateBoundPlayers 注入（2026-11-16）。
    teamPlayers: [...teamPlayers]
      .sort((a, b) => a.player_slot - b.player_slot)
      .map((p) => ({
        accountId: p.account_id,
        heroName: heroName(p.hero_id),
        isRadiant: p.player_slot < 128,
        isBound: false,
      })),
    // 突出路人/对手：buildMatchDetailForm 看不到绑定表，先留空，
    // 由 matchDetail 在拿到绑定账号集合后调 pickStandouts 注入（认错人防线）。
    standoutPlayers: [],
    notes: [],
  };

  // 顺序（2026-11-16 改）：factSheet 必须先算出来，notes 才有「证据」可比对。
  // 老顺序是 notes → factSheet，于是点评只能靠 KDA 拍脑袋，和「数据对照」自相矛盾
  // （match 9091501690：满参团 + 伤害队内第二，点评却写「这局有点划水」）。
  // factSheet 本身不读 notes，这里不会形成循环依赖。
  const factSheet = buildFactSheet({ ...base, notes: [], baseline: baseline });
  const notes = buildMatchNotes(base, factSheet);
  const withFacts: Omit<MatchDetailForm, 'summaryText'> = {
    ...base,
    notes,
    factSheet,
  };
  return { ...withFacts, summaryText: renderMatchSummary(withFacts) };
}

/**
 * 造队内对比基线（2026-11-16 新增，供 buildFactSheet 用）。
 *
 * 为什么要在 buildMatchDetailForm 里现算、而不是让 buildFactSheet 自己从
 * MatchDetailForm 推：form 里只有本人数值 + 本人排名，队友的 GPM/正补/插眼
 * 一个都没留（早就丢了）。等出了这个函数，原始 RawMatchPlayer 已经不在了。
 *
 * 同定位队友的口径：给每个队友也跑一遍 inferRole —— 拿「跟同为辅助的人比经济」
 * 取代「跟全队第一比」，这正是「赏金 2/6/19 被当主输出骂」那条错评的解药。
 */
function buildTeamBaseline(
  player: RawMatchPlayer,
  teamPlayers: RawMatchPlayer[],
  worthOf: (p: RawMatchPlayer) => number,
): MatchTeamBaseline {
  const gpmOf = (p: RawMatchPlayer): number => p.gold_per_min;
  const dmgOf = (p: RawMatchPlayer): number => p.hero_damage ?? 0;
  const wardsOf = (p: RawMatchPlayer): number => (p.obs_placed ?? 0) + (p.sen_placed ?? 0);
  const towerOf = (p: RawMatchPlayer): number => p.tower_damage ?? 0;
  const top = (list: RawMatchPlayer[], get: (p: RawMatchPlayer) => number): number =>
    list.reduce((m, p) => Math.max(m, get(p)), 0);
  /**
   * 队内排名。同分算并列：默认 indexOf 会把并列第一里的第二个判成第二名，
   * 「队内第 1/5」这种话说错一次就要在群里被指出来。
   */
  const rankOf = (get: (p: RawMatchPlayer) => number): number => {
    const mine = get(player);
    const higher = teamPlayers.filter((p) => get(p) > mine).length;
    return higher + 1;
  };

  const role = inferRole(player, teamPlayers, worthOf).role;
  // 同定位的队友：口径跟本人一致（都是按客观行为判出来的角色，不看英雄名）。
  // 只跟「判得出定位」的队友比 —— 把 unknown 拉进来当同类，等于拿猜的当基准。
  const sameRole = teamPlayers.filter(
    (p) => p !== player && inferRole(p, teamPlayers, worthOf).role === role,
  );

  return {
    teamSize: teamPlayers.length,
    gpmTop: top(teamPlayers, gpmOf),
    gpmMedian: median(teamPlayers.map(gpmOf)),
    gpmRank: rankOf(gpmOf),
    sameRoleGpm: sameRole.map(gpmOf),
    damageTop: top(teamPlayers, dmgOf),
    wardsTop: top(teamPlayers, wardsOf),
    // 插眼是否真的有值：整列都是 null 时说明这局没解析到，那时「插眼 0 个」是假的
    wardsKnown: teamPlayers.some((p) => p.obs_placed !== null || p.sen_placed !== null),
    wardRank: rankOf(wardsOf),
    lastHitsTop: top(teamPlayers, (p) => p.last_hits),
    lastHitsTotal: teamPlayers.reduce((s, p) => s + p.last_hits, 0),
    sameRoleLastHits: sameRole.map((p) => p.last_hits),
    deathsAvg: teamPlayers.reduce((s, p) => s + p.deaths, 0) / Math.max(1, teamPlayers.length),
    towerTop: top(teamPlayers, towerOf),
  };
}

/** 中位数（偶数个取中间两个的平均，四舍五入到整数 —— 展示用不需要小数） */
function median(list: number[]): number {
  if (list.length === 0) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const v = sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.round(v);
}

/**
 * 把本人这一队里"绑过 Steam 的群友"标出来，并重算摘要里那一行队友。
 *
 * 2026-11-16 新增。为什么单独一个函数、而不是塞进 buildMatchDetailForm：
 *   · buildMatchDetailForm 是纯函数（只认 RawMatchDetail + accountId + itemName），
 *     很多地方在调它，签名叫「不要改」；绑定表是上层（gateway/bootstrap）的事，
 *     往下塞就等于让 dota/ 反向依赖 steam/ 的存储形态。
 *   · 这里只吃一个 `resolveAlias` 回调，谁提供都行，测试里塞个 Map 就能验。
 *
 * 返回新对象（不改入参）：form 可能在缓存/多路径共享，就地改会串场。
 *
 * 只**换掉摘要里那一行「队友：」**，不整段重渲 —— 因为 DotaService.matchDetail
 * 会在 renderMatchSummary 之后往 summaryText 追加「技能｜…」「路子｜…」几行，
 * 整段重渲会把技能那几行弄丢（技能恰恰是 OMG 局最该说的部分）。
 */
export function annotateBoundPlayers(
  form: MatchDetailForm,
  resolveAlias: (accountId: number) => string | undefined,
): MatchDetailForm {
  const teamPlayers: MatchTeamPlayer[] = form.teamPlayers.map((p) => {
    if (p.accountId === null) return p;
    const alias = resolveAlias(p.accountId);
    // alias 为空/空白当成没绑定：宁可说"路人"，也不要在群里叫一个空名字
    if (alias === undefined || alias.trim() === '') return p;
    return { ...p, isBound: true, alias: alias.trim() };
  });

  const line = `队友：${teamPlayersText(teamPlayers)}`;
  const lines = form.summaryText.split('\n');
  const at = lines.findIndex((l) => l.startsWith('队友：'));
  if (at >= 0) {
    lines[at] = line;
  } else if (teamPlayers.length > 0) {
    // 老摘要里没有这一行（理论上不会：renderMatchSummary 已经会加），
    // 兜底插在「点评：」之前，没有点评就放最后。
    const noteAt = lines.findIndex((l) => l.startsWith('点评：'));
    if (noteAt >= 0) lines.splice(noteAt, 0, line);
    else lines.push(line);
  }

  return { ...form, teamPlayers, summaryText: lines.join('\n') };
}

/**
 * 赢局里按队内排名给的正面判语。
 * 排名是硬数据（「经济第一」就是第一），所以无论有没有 factSheet 都留着。
 *
 * 唯一的例外是「肥得很」：排名第一但 factSheet 判了经济 minus 的极端局
 * （辅助跟同定位队友比、队列里有人更富）下，说「肥」就是自相矛盾 —— 闭嘴。
 */
function rankNotes(
  form: Omit<MatchDetailForm, 'summaryText' | 'factSheet'>,
  gates?: { gpmAllowed?: boolean },
): string[] {
  const p = form.player;
  if (!p.win) return [];
  const fatOk = gates?.gpmAllowed !== false;
  if (form.teamRank.netWorth === 1 && form.teamRank.heroDamage === 1) {
    return [fatOk ? '队内经济和输出双第一，这局你带的' : '队内经济和输出双第一'];
  }
  if (form.teamRank.netWorth === 1) return [fatOk ? '队内经济第一，肥得很' : '队内经济第一'];
  if (form.teamRank.heroDamage === 1) return ['队内输出第一'];
  return [];
}

/**
 * 只看 KDA 就下的判语（送 / 划水）。
 *
 * 2026-11-16：**只留给没有 factSheet 的老路径**。这条 `!win && kdaRatio < 1.5 → 划水`
 * 就是线上那条错评的源头（满参团、伤害队内第二的巫医被判「这局有点划水」），
 * 有事实清单时一律改走 buildMatchNotes 的证据判定。
 */
function kdaOnlyNotes(form: Omit<MatchDetailForm, 'summaryText' | 'factSheet'>): string[] {
  const p = form.player;
  if (p.win) return [];
  if (p.kdaRatio < 0.8) return ['这局有点送'];
  if (p.kdaRatio < 1.5) return ['这局有点划水'];
  return [];
}

/** 兜底文案的取舍开关：不传 = 老路径，照旧按老条件开口（向后兼容） */
interface DataNoteGate {
  /** 允许说「死了 N 次，有点多」；false = factSheet 没判死亡 minus，这句就跟「数据对照」打架 */
  deathsAllowed?: boolean;
  /** 允许说「经济很肥」；false = factSheet 判了经济 minus，再说肥就是自相矛盾 */
  gpmAllowed?: boolean;
}

/**
 * 有具体数字支撑的兜底文案：队内排名、GPM、死亡数、参团数都写在句子里，
 * 说出口能复核，所以两条路径（有/没有 factSheet）都能用。
 * 参数 gates 只用来在 factSheet 已经否掉某项时闭嘴。
 */
function dataBackedNotes(
  form: Omit<MatchDetailForm, 'summaryText' | 'factSheet'>,
  gates?: DataNoteGate,
): string[] {
  const p = form.player;
  const notes: string[] = [];
  if (gates?.deathsAllowed !== false && p.deaths >= 8) notes.push(`死了 ${p.deaths} 次，有点多`);
  if (gates?.gpmAllowed !== false && p.gpm >= 600) notes.push(`GPM ${p.gpm}，经济很肥`);
  // 辅助伤害低不是毛病 —— 先给出定位，别让人拿核心的尺子量辅助
  if (p.role === 'support' && form.teamRank.heroDamage === form.teamRank.teamSize) {
    notes.push(`辅助位，伤害垫底正常（${p.roleReason ?? '插眼补视野'}）`);
  }
  if (form.teamfights !== null && form.teamfights.count > 0) {
    const rate = form.teamfights.participated / form.teamfights.count;
    if (rate < 0.5) notes.push(`团战只赶上 ${form.teamfights.participated}/${form.teamfights.count}，参团偏少`);
  }
  return notes;
}

/** 2026-11-16 之前的老点评：行为原样保留，供不传 factSheet 的调用方（含老缓存）用 */
function legacyMatchNotes(form: Omit<MatchDetailForm, 'summaryText' | 'factSheet'>): string[] {
  // 顺序就是老顺序：赢局排名 → 输局看 KDA → 死亡/GPM/辅助/参团
  const notes = [...rankNotes(form), ...kdaOnlyNotes(form), ...dataBackedNotes(form)];
  // 同一件事不重复说（比如"送"和"死得多"）
  return [...new Set(notes)].slice(0, 2);
}

/** 取事实清单里某一维的 verdict；没有清单、没有这一维都返回 undefined（= 没有证据） */
function verdictOf(sheet: MatchFactSheet | undefined, dim: string): MatchFactLine['verdict'] | undefined {
  if (sheet === undefined) return undefined;
  return sheet.lines.find((l) => l.dim === dim)?.verdict;
}

/**
 * 2 条以内的点评：只在数据明显偏某一边时开口，避免每局都硬凹。
 *
 * 2026-11-16 改（线上实锤 match 9091501690 小周巫医 7/15/9）：
 * 老逻辑 `!win && kdaRatio < 1.5 → 「这局有点划水」`，而那局满参团 11/11、
 * 伤害队内第二（占队内最高 84%），摘要里「点评：这局有点划水」紧挨着
 * 「[团战] 100% → 优势」，两段自己打自己。
 *   · 用户骂的「不综合分析、抓一两条就评」，这次写死在代码里的就是那一两条。
 *
 * 所以这里改成**先看事实清单再开口**：
 *   1. 「划水」必须有证据 —— 只有 [输出] minus 或 [团战] minus 才允许说；
 *      满参团 + 输出不差（flat/plus）时禁止说，KDA 再难看也不说。
 *   2. 死亡 minus 时保留「死了 N 次」；死亡 minus 而输出/团战都是 plus 时，
 *      宁可只说死亡那一句 —— 用命开团也是打法，不能叠加「划水」定性。
 *   3. 「视野」plus 时加一条「插眼 N 个，视野做得不错」，并且排序上给它位置：
 *      **真实 minus > 真实 plus > 老兜底**，否则永远挤不进这 2 条上限。
 *
 * 辅助位另有一道闸：factSheet 对辅助的伤害项照样记 minus（数字确实低），
 * 但 findings 里写着「辅助不靠伤害说话」。所以视野 plus 的辅助不能只凭
 * 输出 minus 被判划水，否则又是一条新的自相矛盾（对照 9089522269 赏金）。
 */
export function buildMatchNotes(
  form: Omit<MatchDetailForm, 'summaryText' | 'factSheet'>,
  factSheet?: MatchFactSheet,
): string[] {
  // 不传清单 → 老行为原样返回，别把老缓存/老调用方改味
  if (factSheet === undefined) return legacyMatchNotes(form);

  const p = form.player;
  const dmgV = verdictOf(factSheet, '输出');
  const tfV = verdictOf(factSheet, '团战');
  const deathV = verdictOf(factSheet, '死亡');
  const wardV = verdictOf(factSheet, '视野');
  const ecoV = verdictOf(factSheet, '经济');
  const wards = (p.obsPlaced ?? 0) + (p.senPlaced ?? 0);
  const isSupport = p.role === 'support';
  // 视野做得好的辅助：伤害低是位置决定的，不能拿它当「划水」的证据
  const wardSaved = isSupport && wardV === 'plus';
  const slackEvidence = tfV === 'minus' || (dmgV === 'minus' && !wardSaved);

  /** tier 0 = 有证据的 minus，1 = 有证据的 plus，2 = 老兜底（只在没证据时露头） */
  const cands: Array<{ text: string; tier: 0 | 1 | 2; weight: number }> = [];
  const push = (text: string, tier: 0 | 1 | 2, weight: number): void => {
    cands.push({ text, tier, weight });
  };

  // ── tier 0：factSheet 判了 minus 的，才允许说「不好」 ──
  if (deathV === 'minus') push(`死了 ${p.deaths} 次，有点多`, 0, 100);
  // 「送」和「划水」是同一件事的两档说法（老代码就是 if/else if），只出其中一条：
  // 两条都推会把仅有的 2 个位置占满，视野 plus 这类真亮点永远挤不进来。
  if (slackEvidence && p.kdaRatio < 0.8) {
    push('这局有点送', 0, 96);
  } else if (slackEvidence && p.kdaRatio < 1.5) {
    push('这局有点划水', 0, 92);
  }

  // ── tier 1：factSheet 判了 plus 的，实话实说的加分项 ──
  // 只放视野这一条：输出/团战 plus 已有 tier 2 的「队内输出第一」等着，
  // 再塞一条「全程在场」只会把更有信息量的项挤出这 2 条上限。
  if (wardV === 'plus' && wards > 0) push(`插眼 ${wards} 个，视野做得不错`, 1, 90);

  // ── tier 2：老兜底文案，但被 factSheet 否掉的项要闭嘴 ──
  const fatOk = ecoV !== 'minus';
  const fallback = [
    ...rankNotes(form, { gpmAllowed: fatOk }),
    ...dataBackedNotes(form, { deathsAllowed: deathV === 'minus', gpmAllowed: fatOk }),
  ];
  fallback.forEach((text, i) => push(text, 2, 80 - i));

  const sorted = cands
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => (a.tier - b.tier) || (b.weight - a.weight) || (a.i - b.i));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of sorted) {
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    out.push(c.text);
    if (out.length >= 2) break;
  }
  return out;
}

/**
 * 渲染摘要。
 *
 * 参数里 factSheet 是**可选**的：老缓存/别处构造的对象可能没有它，
 * 没有就跳过「数据对照」段，不能因为缺一份清单就整段摘要渲染不出来。
 * （2026-11-16 起 buildMatchDetailForm 的顺序是 base → factSheet → notes → render，
 * factSheet 一定已经算好；这里可选是为了兼容老调用方。）
 */
function renderMatchSummary(
  form: Omit<MatchDetailForm, 'summaryText' | 'factSheet'> & { factSheet?: MatchFactSheet },
): string {
  const p = form.player;
  const lines: string[] = [];
  const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

  lines.push(
    `${p.heroName}（${p.isRadiant ? '天辉' : '夜魇'}）${p.win ? '胜' : '负'} · ${form.gameModeText}`
    + `${form.isRanked ? ' · 天梯' : ` · ${form.lobbyTypeText}`} · ${form.durationText} · ${form.startText}`,
  );
  lines.push(
    `KDA ${p.kills}/${p.deaths}/${p.assists}（${p.kdaRatio.toFixed(2)}）· GPM ${p.gpm} · XPM ${p.xpm}`
    + ` · 正补 ${p.lastHits}/${p.denies} · ${p.level} 级`,
  );
  if (p.role !== undefined && p.role !== 'unknown') {
    const roleText = p.role === 'core' ? '核心位' : '辅助位';
    lines.push(`定位：${roleText}（${p.roleReason ?? ''}）`);
  }
  lines.push(
    `伤害 ${p.heroDamage}${form.teamRank.heroDamage > 0 ? `（队内第 ${form.teamRank.heroDamage}）` : ''}`
    + ` · 建筑 ${p.towerDamage} · 治疗 ${p.heroHealing}`
    + ` · 净资产 ${p.netWorth}${form.teamRank.netWorth > 0 ? `（队内第 ${form.teamRank.netWorth}）` : ''}`,
  );
  if (p.items.length > 0) lines.push(`装备：${itemsText(p.items, p.itemsZh)}`);
  if (form.laneOpponent !== null) {
    const o = form.laneOpponent;
    lines.push(`对位 ${o.heroName}：经济 ${sign(o.gpmDiff)} GPM · 输出 ${sign(o.damageDiff)}`);
  }

  const ob = form.objectives;
  const fb = ob.firstBlood === null ? '未知' : ob.firstBlood === 'radiant' ? '天辉' : '夜魇';
  lines.push(`首血 ${fb} · 肉山 天辉 ${ob.roshan.radiant} / 夜魇 ${ob.roshan.dire} · 推塔 天辉 ${ob.towers.radiant} / 夜魇 ${ob.towers.dire}`);

  if (form.goldSwing !== null) {
    const g = form.goldSwing;
    lines.push(`经济曲线：最多领先 ${g.maxLead}（约第 ${g.leadMinute} 分）· 最多落后 ${g.maxDeficit}（约第 ${g.deficitMinute} 分）`);
  } else {
    lines.push('这场没被解析，经济曲线和团战看不到（基础数据仍然准确）');
  }
  if (form.teamfights !== null) lines.push(`团战 ${form.teamfights.count} 次，参与 ${form.teamfights.participated} 次`);

  if (form.lineup.radiant.length > 0) {
    lines.push(`阵容｜天辉 ${form.lineup.radiant.join('、')}｜夜魇 ${form.lineup.dire.join('、')}`);
  }
  // 队友那行：只列本人这一队，绑过的群友写群里称呼，其余写「路人」。
  // 2026-11-16 加：以前只有英雄名，模型分不清谁是群友，把一起开黑的人说成路人。
  if (form.teamPlayers.length > 0) lines.push(`队友：${teamPlayersText(form.teamPlayers)}`);
  if (form.notes.length > 0) lines.push(`点评：${form.notes.join('；')}`);
  // 数据对照（2026-11-16 加）：群里吐槽「不都是抓一两条就开始评么」，根子就在
  // 摘要里只有 KDA/伤害两行醒目的数字，模型懒得往下看。这里把 factSheet 逐项摊开，
  // 让它开口之前必须先横着比一遍。
  //
  // 关键约束：这段**必须在 renderMatchSummary 里直接拼**，不能在 annotateBoundPlayers
  // 阶段重渲 —— DotaService.matchDetail 会在渲染后往 summaryText 追加「技能｜…」
  // 「路子｜…」几行，整段重渲会把技能行弄丢（OMG 局最该说的就是技能）。
  if (form.factSheet !== undefined && form.factSheet.lines.length > 0) {
    lines.push('数据对照：');
    for (const l of form.factSheet.lines) {
      lines.push(`  · [${l.dim}] ${l.fact} → ${VERDICT_TEXT[l.verdict]}`);
    }
  }

  return lines.join('\n');
}

/**
 * 装备行：`中文名（英文原名）`，中文名与英文相同时不加括号。
 *
 * 2026-11-16 新增。为什么要括号里再带英文：
 *   · 中文名给模型照抄，杜绝「Maelstrom → 狂战斧」这类错译；
 *   · 括号里的原名让群友能对上号，中文译名有争议时也不至于说不清是哪件。
 * itemsZh 缺失（老缓存/别处构造的对象）就退回纯英文原名，别炸。
 */
function itemsText(items: string[], itemsZh?: string[]): string {
  return items
    .map((en, i) => {
      const zh = itemsZh?.[i];
      if (zh === undefined || zh === '' || zh === en) return en;
      return `${zh}（${en}）`;
    })
    .join('、');
}

/**
 * 队友行：`恐怖利刃（铭鑫）、巫医（小周）、沙王（路人）`。
 * 没绑定的写「路人」—— 这是要重点传达的信息：模型别再把群友当路人点评。
 */
function teamPlayersText(teamPlayers: MatchTeamPlayer[]): string {
  return teamPlayers
    .map((p) => {
      const who = p.isBound && p.alias !== undefined && p.alias !== '' ? p.alias : '路人';
      return `${p.heroName}（${who}）`;
    })
    .join('、');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
