/**
 * 群友关联场次的「完整简报」构建器（方案 B，2026-11-12）
 * ─────────────────────────────────────────────────────────────
 * 目标：把窗口内**去重后的每一场**完整数据交给模型自己判断，而不是由脚本
 * 替她挑「唯一一局」再给 9 个数字。用户原话：「完整的数据他才不会把辅助
 * 当成核心去分析」。
 *
 * 数据流：
 *   tickQuery 收集所有绑定群友窗口内的局 → 按 matchId 去重 → 这里逐场取详情
 *   → 每个群友调一次 DotaService.matchDetail（matchRaw 有单飞+TTL 缓存，
 *      同一场只打一次 /matches/{id}；abilityMeta/itemNames 也有进程内缓存）
 *   → 从 abilityRecords 取该场 10 人的真实技能明细（中文名 + 次数口径）
 *   → 关联同场群友、落进 matchCache 的 briefing 字段
 *
 * 三个护栏：
 *   - 本地已完整解析（parsed=true）的场直接复用，不再打 OpenDota；
 *   - 限并发 3，避免 15–30 场一起打出去触发 429（11-12 出过 8 次）；
 *   - 一份技能明细都没拿到的场标 parsed=false，提示词会限制成「只说 KDA」。
 *
 * 本文件属于 dota 平台层，只吐 CachedBriefSession；persona 侧有自己的
 * 结构契约（DigestBriefing），由 bootstrap 做形状对接，不反向 import。
 */
import type { MatchDetailForm, DotaService } from './service.ts';
import type {
  CachedBriefAbility,
  CachedBriefPlayer,
  CachedBriefSession,
  MatchCacheStore,
} from './match-cache.ts';

const DEFAULT_TZ = 'Asia/Shanghai';
/** 同时最多几场在取详情：OpenDota 免费额度 + 11-12 的 429 教训 */
const CONCURRENCY = 3;

export interface BriefingBuilderDeps {
  service: DotaService;
  matchCache: MatchCacheStore;
  logger: { info(msg: string): void; warn(msg: string): void };
  tz?: string;
}

/** 「11月11日 21:08」——用 Intl 逐字段取，不依赖宿主进程时区 */
function formatWhen(startSec: number, tz: string): string {
  if (!Number.isFinite(startSec) || startSec <= 0) return '';
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(startSec * 1000));
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('month')}月${get('day')}日 ${get('hour').padStart(2, '0')}:${get('minute').padStart(2, '0')}`;
  } catch {
    return '';
  }
}

/** 半解析局的数值字段运行时可能是 undefined，类型上却是 number —— 别写进 JSON 变成 null */
function num(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 固定并发的小 map：失败返回 undefined 的项会被丢掉，不中断整批 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R | undefined>,
): Promise<R[]> {
  const out: Array<R | undefined> = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out.filter((v): v is R => v !== undefined);
}

/** 把一个人的详情投影成「给模型看的事实」，不给任何现成文案 */
function playerOf(
  form: MatchDetailForm,
  alias: string,
  abilities: CachedBriefAbility[],
  mix: string | undefined,
  basis: 'uses' | 'levels' | undefined,
): CachedBriefPlayer {
  return {
    name: alias,
    hero: form.player.heroName,
    kda: `${form.player.kills}/${form.player.deaths}/${form.player.assists}`,
    win: form.player.win,
    abilities,
    ...(num(form.player.gpm) !== undefined ? { gpm: form.player.gpm } : {}),
    ...(num(form.player.xpm) !== undefined ? { xpm: form.player.xpm } : {}),
    ...(num(form.player.netWorth) !== undefined ? { netWorth: form.player.netWorth } : {}),
    ...(num(form.player.heroDamage) !== undefined ? { heroDamage: form.player.heroDamage } : {}),
    ...(form.teamRank.netWorth > 0 ? { teamRank: form.teamRank.netWorth } : {}),
    ...(form.teamRank.heroDamage > 0 ? { damageRank: form.teamRank.heroDamage } : {}),
    ...(form.teamRank.teamSize > 0 ? { teamSize: form.teamRank.teamSize } : {}),
    ...(form.teamfights !== null
      ? { teamfight: `参团 ${form.teamfights.participated}/${form.teamfights.count}` }
      : {}),
    ...(mix !== undefined && mix !== '' ? { abilityMix: mix } : {}),
    ...(basis !== undefined ? { abilityBasis: basis } : {}),
  };
}

/**
 * 返回一个批量取数函数。传给 persona 的 buildBriefing 注入点。
 * `windowHours` 只用于签名对齐（窗口裁剪已在 tickQuery 做过）。
 */
export function createBriefingBuilder(
  deps: BriefingBuilderDeps,
): (matchIds: number[], windowHours: number) => Promise<CachedBriefSession[]> {
  const tz = deps.tz ?? DEFAULT_TZ;

  return async (matchIds: number[], _windowHours: number): Promise<CachedBriefSession[]> => {
    let reused = 0;
    let fetched = 0;
    let failed = 0;

    const sessions = await mapLimit(matchIds, CONCURRENCY, async (matchId) => {
      // 这一场有哪些绑定群友（人数不固定，可能只有两三个）
      const participants = deps.matchCache.participantsOf(matchId);
      if (participants.length === 0) return undefined;

      // 已完整解析且参与者没变 → 直接复用本地简报，一次网络请求都不打。
      // 本地战绩库是逐轮攒人的：同场后来又认出一个群友时，简报必须重取，
      // 否则缓存里永远是「这场只有 1 个人」。
      const cached = deps.matchCache.getBriefing(matchId);
      if (cached !== undefined && cached.parsed && cached.boundPlayers.length === participants.length) {
        reused += 1;
        return cached;
      }

      const boundPlayers: CachedBriefPlayer[] = [];
      let first: MatchDetailForm | undefined;
      for (const p of participants) {
        try {
          // matchRaw 单飞 + TTL 缓存：同一场多个群友只打一次 /matches/{id}
          const form = await deps.service.matchDetail(matchId, p.accountId);
          first ??= form;

          // matchDetail 会把该场全队 10 人的技能写进 abilityRecords，
          // 这里直接读，不需要再解析一次 OpenDota 原始数据。
          const record = deps.service.abilityRecords.get(matchId);
          const rec = record?.players.find((x) => x.accountId === p.accountId);
          const abilities: CachedBriefAbility[] = (rec?.abilities ?? []).map((a) => ({
            name: a.name,
            ...(a.nameZh !== undefined ? { nameZh: a.nameZh } : {}),
            uses: a.uses,
            ...(a.behavior !== undefined ? { behavior: a.behavior } : {}),
            ...(a.damageType !== undefined ? { damageType: a.damageType } : {}),
          }));
          const basis = rec?.basis ?? record?.basis;
          boundPlayers.push(playerOf(
            form,
            p.alias ?? String(p.accountId),
            abilities,
            rec?.mix,
            basis === 'uses' || basis === 'levels' ? basis : undefined,
          ));
        } catch (err) {
          // 单个群友失败不影响这场其他人；整场都失败就不写缓存，明天再取
          deps.logger.warn(
            `dota: 简报取单场失败 match=${matchId} account=${p.accountId}: `
            + `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (first === undefined || boundPlayers.length === 0) {
        failed += 1;
        return undefined;
      }

      // 只要有真实技能明细（uses 或 levels 都算）就允许深入评价；
      // 一份都没有才标 parsed=false —— 这时提示词只允许说英雄/KDA/胜负。
      const parsed = boundPlayers.some((p) => p.abilities.length > 0);
      const session: CachedBriefSession = {
        matchId,
        when: formatWhen(first.startTimeSec, tz),
        gameMode: first.gameModeText,
        durationMin: Math.round(first.durationSec / 60),
        parsed,
        boundPlayers,
        lineup: first.lineup,
        fetchedAt: Date.now(),
      };
      deps.matchCache.putBriefing(session);
      fetched += 1;
      return session;
    });

    deps.logger.info(
      `dota: 完整简报 ${sessions.length}/${matchIds.length} 场`
      + `（复用缓存 ${reused} · 新取 ${fetched} · 失败 ${failed}）`,
    );
    return sessions;
  };
}
