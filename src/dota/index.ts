/**
 * Dota2 战绩查询模块（`src/dota/`）的统一入口
 * ─────────────────────────────────────────────────────────────
 * 数据源：OpenDota（免 key，匿名 60 次/分钟、3000 次/天）。
 * Valve 官方的 IDOTA2Match_570 用普通 Web API Key 会 403，所以不走官方。
 *
 * 这个模块**不**碰配置 Schema、不碰工具注册时机、不碰"谁绑了哪个 QQ"：
 *   - 配置形状由下面的 DotaConfig 描述，Schema 由上层（src/config.ts）定义；
 *   - 工具注册由上层调 registerDotaTools；
 *   - 账号归属是上层的事，这里只认 account_id。
 */
import type { Logger } from '../types.ts';
import { HERO_COUNT, HERO_IDS, heroName, heroNameEn, isKnownHero } from './heroes.ts';
import {
  OpenDotaApi,
  OpenDotaError,
  accountIdToSteamId,
  isWin,
  rankTierText,
  steamIdToAccountId,
  type DotaQuota,
  type OpenDotaErrorKind,
  type PlayerProfile,
  type RawMatch,
  type RawMatchDetail,
  type RawMatchPlayer,
  type RawObjective,
} from './opendota.ts';
import {
  DotaService,
  type DotaConfig,
  type DotaForm,
  type DotaFormOutcome,
  type DotaMatchSummary,
  type MatchDetailForm,
} from './service.ts';
import { registerDotaTools } from './tools.ts';

/** 配置默认值（上层 Schema 可直接复用，避免两处写死不同数字） */
export const DEFAULT_DOTA_CONFIG: DotaConfig = {
  enabled: true,
  cacheTtlSec: 180,
  timeoutMs: 8000,
  defaultLimit: 5,
  maxLimit: 20,
  rateLimitPerMin: 50,
  includeWinLoss: true,
};

/** 补齐缺省字段：容许上层只传部分配置（Schema 演化时不会因为少一个字段就崩） */
export function resolveDotaConfig(partial: Partial<DotaConfig> | undefined): DotaConfig {
  const src = partial ?? {};
  // 逐字段兜底而不是 {...默认, ...partial}：后者遇到显式 undefined 会把默认值也覆盖掉
  const pick = <K extends keyof DotaConfig>(key: K): DotaConfig[K] => {
    const value = src[key];
    return value === undefined ? DEFAULT_DOTA_CONFIG[key] : value;
  };
  return {
    enabled: pick('enabled'),
    cacheTtlSec: pick('cacheTtlSec'),
    timeoutMs: pick('timeoutMs'),
    defaultLimit: pick('defaultLimit'),
    maxLimit: pick('maxLimit'),
    rateLimitPerMin: pick('rateLimitPerMin'),
    includeWinLoss: pick('includeWinLoss'),
  };
}

/** 工厂：上层拿到 config.dota 后直接 createDotaService(config.dota, logger) */
export function createDotaService(config: Partial<DotaConfig> | undefined, logger: Logger): DotaService {
  return new DotaService({ config: resolveDotaConfig(config), logger });
}

// ── 账号换算（实现在 opendota.ts，这里只是统一出口） ─────────
export { steamIdToAccountId, accountIdToSteamId };

export {
  DotaService,
  registerDotaTools,
  heroName,
  heroNameEn,
  isKnownHero,
  HERO_IDS,
  HERO_COUNT,
  OpenDotaApi,
  OpenDotaError,
  isWin,
  rankTierText,
};

export type {
  DotaConfig,
  DotaForm,
  DotaFormOutcome,
  DotaMatchSummary,
  DotaQuota,
  MatchDetailForm,
  OpenDotaErrorKind,
  PlayerProfile,
  RawMatch,
  RawMatchDetail,
  RawMatchPlayer,
  RawObjective,
};
