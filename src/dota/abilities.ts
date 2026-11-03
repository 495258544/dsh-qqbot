/**
 * 技能解析 —— 给 OMG（技能征召）模式用
 * ─────────────────────────────────────────────────────────────
 * 为什么需要：
 *   这个群 80 局里 80 局都是「技能征召」。在这种模式下，英雄只是个壳子，
 *   真正决定强弱的是**拿了哪四个技能**。只看 KDA 去分析，说出来全是空话
 *   （「暗影恶魔这局 11/6/18，打得很凶」——凶在哪？不知道）。
 *
 * 数据从哪来：
 *   OpenDota 的 `players[].ability_uses` 是 `{技能内部名: 使用次数}`。
 *   这份数据比 `ability_upgrades_arr`（加点顺序）有用得多：
 *     · 加点顺序里混着天赋（special_bonus_unique_xxx），要另外剔
 *     · 使用次数直接反映**这套技能的重心**：谁用了 126 次影压，谁就是核心输出
 *
 * 为什么用英文技能名：
 *   OpenDota 只给英文 dname。硬翻译要维护上千条中英对照，且新技能一上线就过时。
 *   她输出的是中文，英文技能名进上下文她会自己转述成「影压」「妖术」。
 */
import type { AbilityMeta } from './opendota.ts';

export interface ParsedAbility {
  /** 内部名，如 nevermore_shadowraze2 */
  key: string;
  /** 展示名，如 Shadowraze（没有 dname 时回退成 key） */
  name: string;
  /** 本局使用次数（被动技能不会出现在这里） */
  uses: number;
  /** 施法类型，如 "No Target" / "Unit Target" */
  behavior?: string;
  /** 伤害类型：Magical / Physical / Pure */
  damageType?: string;
}

/**
 * 明确不是「英雄技能」的条目。
 * 只用前缀 + 精确名单，**不要**用宽松正则 —— 真实技能名里也有 ability 字样，
 * 误杀一个就等于让她少看见一个技能。
 */
const NOISE_PREFIXES = ['special_bonus_', 'dota_', 'generic_', 'item_', 'plus_'];

/** 已知的机制类条目（它们不以噪声前缀开头，但同样不是英雄技能） */
const NOISE_EXACT = new Set([
  'ability_lamp_use',
  'ability_lamp_use_outpost',
  'ability_lamp_use_ward',
  'ability_creep_stun',
  'ability_pluck_famango',
]);

/** 这一条是不是「不是英雄技能」的噪声 */
export function isNoiseAbility(key: string): boolean {
  if (key === '') return true;
  if (NOISE_EXACT.has(key)) return true;
  return NOISE_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * `ability_uses` → 排好序的技能列表（用得最多的在前）。
 *
 * 排序的意义：OMG 里「用了 126 次的技能」和「顺手点了一下」是两回事，
 * 前者才是这套组合的核心。限流到 limit 条，避免把 15 个杂项全塞进上下文。
 */
export function parseAbilities(
  uses: Record<string, unknown> | undefined | null,
  meta: Map<string, AbilityMeta>,
  limit = 8,
): ParsedAbility[] {
  if (uses === null || uses === undefined || typeof uses !== 'object') return [];

  const out: ParsedAbility[] = [];
  for (const [key, raw] of Object.entries(uses)) {
    if (typeof key !== 'string' || isNoiseAbility(key)) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    const m = meta.get(key);
    const dname = m?.dname ?? '';
    out.push({
      key,
      name: dname !== '' ? dname : key,
      uses: Math.round(n),
      ...(m?.behavior !== undefined && m.behavior !== '' ? { behavior: m.behavior } : {}),
      ...(m?.dmgType !== undefined && m.dmgType !== '' ? { damageType: m.dmgType } : {}),
    });
  }

  out.sort((a, b) => b.uses - a.uses);
  return out.slice(0, Math.max(1, Math.floor(limit)));
}

/**
 * 一句话概括这套技能是什么路子，给她一个「怎么看」的起点（不是结论）。
 * 只做粗分类：控制 / 爆发 / 持续输出 / 靠平A。分类依据是施法类型和伤害类型，
 * 拿不到就老实说拿不到，不要硬编。
 */
export function describeAbilityMix(abilities: ParsedAbility[]): string {
  if (abilities.length === 0) return '';
  const tags: string[] = [];

  const unitTarget = abilities.filter((a) => (a.behavior ?? '').includes('Unit Target')).length;
  const noTarget = abilities.filter((a) => (a.behavior ?? '').includes('No Target')).length;
  const magical = abilities.filter((a) => (a.damageType ?? '') === 'Magical').length;
  const physical = abilities.filter((a) => (a.damageType ?? '') === 'Physical').length;

  if (unitTarget >= 2) tags.push(`${unitTarget} 个指向性技能（多半带控或单体爆发）`);
  else if (unitTarget === 1) tags.push('有 1 个指向性技能');
  if (noTarget >= 2) tags.push(`${noTarget} 个无目标技能（AOE / 自增益）`);
  if (magical >= 3) tags.push(`魔法伤害为主（${magical} 个）`);
  else if (physical >= 3) tags.push(`物理伤害为主（${physical} 个）`);
  else if (magical > 0 && physical > 0) tags.push('魔法物理混着来');

  // 用得最多的那个单独点出来 —— 这才是这局的重心
  const top = abilities[0];
  if (top !== undefined && top.uses >= 20) {
    tags.push(`用得最多的是 ${top.name}（${top.uses} 次）`);
  }
  return tags.join('；');
}
