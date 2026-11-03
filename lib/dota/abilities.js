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
export function isNoiseAbility(key) {
    if (key === '')
        return true;
    if (NOISE_EXACT.has(key))
        return true;
    return NOISE_PREFIXES.some((p) => key.startsWith(p));
}
/**
 * `ability_uses` → 排好序的技能列表（用得最多的在前）。
 *
 * 排序的意义：OMG 里「用了 126 次的技能」和「顺手点了一下」是两回事，
 * 前者才是这套组合的核心。限流到 limit 条，避免把 15 个杂项全塞进上下文。
 */
export function parseAbilities(uses, meta, limit = 8) {
    if (uses === null || uses === undefined || typeof uses !== 'object')
        return [];
    const out = [];
    for (const [key, raw] of Object.entries(uses)) {
        if (typeof key !== 'string' || isNoiseAbility(key))
            continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0)
            continue;
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
export function describeAbilityMix(abilities) {
    if (abilities.length === 0)
        return '';
    const tags = [];
    const unitTarget = abilities.filter((a) => (a.behavior ?? '').includes('Unit Target')).length;
    const noTarget = abilities.filter((a) => (a.behavior ?? '').includes('No Target')).length;
    const magical = abilities.filter((a) => (a.damageType ?? '') === 'Magical').length;
    const physical = abilities.filter((a) => (a.damageType ?? '') === 'Physical').length;
    if (unitTarget >= 2)
        tags.push(`${unitTarget} 个指向性技能（多半带控或单体爆发）`);
    else if (unitTarget === 1)
        tags.push('有 1 个指向性技能');
    if (noTarget >= 2)
        tags.push(`${noTarget} 个无目标技能（AOE / 自增益）`);
    if (magical >= 3)
        tags.push(`魔法伤害为主（${magical} 个）`);
    else if (physical >= 3)
        tags.push(`物理伤害为主（${physical} 个）`);
    else if (magical > 0 && physical > 0)
        tags.push('魔法物理混着来');
    // 用得最多的那个单独点出来 —— 这才是这局的重心
    const top = abilities[0];
    if (top !== undefined && top.uses >= 20) {
        tags.push(`用得最多的是 ${top.name}（${top.uses} 次）`);
    }
    return tags.join('；');
}
//# sourceMappingURL=abilities.js.map