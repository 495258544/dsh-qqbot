/**
 * OpenDota 解析预热 —— 凌晨把昨天的比赛提前请求一遍
 * ─────────────────────────────────────────────────────────────
 * 为什么需要（2026-11-06 用户点破 + 当天实测验证）：
 *
 *   OpenDota 的比赛解析是**按需的**：一场比赛只有在第一次被请求后才会入队解析。
 *   这个群全打技能征召，白天的战绩查询/播报经常需要「这局拿了什么技能」，
 *   而 `ability_uses` / `teamfights` 恰恰是解析的最后一步 ——
 *   局后半天到一天内查，拿到的都是"半解析"数据（KDA 有、技能没有）。
 *   实锤案例：11-05 小周 PA 那局（9075953759）局后 12 小时还是半解析，
 *   第二天有人问起，工具拿不到技能段，她只能按英雄默认印象编了个
 *   "钩子拉得太准"——而那局根本没抽到肉钩。
 *
 *   解法：凌晨 3 点（用户指定）把所有人昨天打过的局逐场请求一遍。
 *   请求本身就会让 OpenDota 入队解析，到白天查询时数据就齐了。
 *
 * 幂等性：
 *   · 每天只跑一次（内存记 lastDay；重启最多多重跑一遍，重复请求无害）
 *   · 单场请求失败不中断（下一晚还会再试）
 *   · 限流由 DotaService 的本地闸门统一控制（匿名额度 60/min，配置留余量）
 */
import type { Logger } from '../types.ts';
import type { DotaService } from './service.ts';
import { DEFAULT_TZ, dayInTz, hourInTz } from '../persona/clock.ts';

export interface DotaWarmupConfig {
  enabled: boolean;
  /** 触发时刻（几点整的窗口内跑一次），默认 3 —— 用户指定的凌晨时段 */
  hour: number;
  /** 预热最近多少小时内的局，默认 30（覆盖"昨天白天 + 昨晚"） */
  withinHours: number;
  tz: string;
}

export const DEFAULT_WARMUP_CONFIG: DotaWarmupConfig = {
  enabled: true,
  hour: 3,
  withinHours: 30,
  tz: DEFAULT_TZ,
};

export interface WarmupDeps {
  config: Partial<DotaWarmupConfig>;
  logger: Logger;
  bindings: () => Array<{ openid: string; alias?: string; steamId: string }>;
  service: DotaService;
}

export interface WarmupResult {
  ran: boolean;
  people: number;
  matches: number;
  reason?: string;
}

export function createDotaWarmup(deps: WarmupDeps) {
  // Partial 输入 + 内部兜底：上层（Schema / 旧 profile）少传字段不崩
  const cfg: DotaWarmupConfig = {
    enabled: deps.config.enabled ?? true,
    hour: deps.config.hour ?? 3,
    withinHours: deps.config.withinHours ?? 30,
    tz: deps.config.tz ?? DEFAULT_TZ,
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  /** 当天已跑过就不再跑（内存即可：重启最多重复一遍，请求幂等） */
  let lastDay = '';

  async function tick(nowTs?: number): Promise<WarmupResult> {
    if (!cfg.enabled) return { ran: false, people: 0, matches: 0, reason: 'disabled' };
    if (running) return { ran: false, people: 0, matches: 0, reason: 'already-running' };
    const now = Number(nowTs ?? Date.now()) || Date.now();
    if (hourInTz(new Date(now), cfg.tz) !== cfg.hour) {
      return { ran: false, people: 0, matches: 0, reason: 'not-window' };
    }
    const today = dayInTz(new Date(now), cfg.tz);
    if (lastDay === today) return { ran: false, people: 0, matches: 0, reason: 'already-ran' };

    running = true;
    try {
      // 同一个 steamId 只预热一次（一个 QQ 号只绑一个 Steam；万一有重复绑定也不多打）
      const seen = new Set<string>();
      const accounts = deps.bindings().filter((b) => {
        if (seen.has(b.steamId)) return false;
        seen.add(b.steamId);
        return true;
      });

      let matches = 0;
      for (const a of accounts) {
        const accountId = Number(BigInt(a.steamId) - 76561197960265728n);
        try {
          matches += await deps.service.warmRecent(accountId, cfg.withinHours);
        } catch (err) {
          // 单人失败不中断：预热是锦上添花，别因为一个账号把整批拖死
          deps.logger.warn(
            `dota-warmup: ${a.alias ?? a.steamId} 预热失败（跳过）: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      lastDay = today;
      deps.logger.info(
        `dota-warmup: 预热完成 ${accounts.length} 人 ${matches} 场（触发 OpenDota 解析，白天查询就有完整技能/团战数据）`,
      );
      return { ran: true, people: accounts.length, matches };
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      void tick().catch((err) => {
        deps.logger.warn(`dota-warmup: tick 异常（忽略）: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 60_000);
  }

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { tick, start, stop };
}
