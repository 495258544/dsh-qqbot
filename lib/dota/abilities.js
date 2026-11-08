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
    'ability_capture',
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
 * 兜底：从加点顺序（`ability_upgrades_arr`）提技能。
 *
 * 为什么需要：OpenDota 对**部分局处于半解析状态** —— `ability_uses` 和
 * `teamfights` 都还没算出来，但加点顺序是原始终端数据、一直都在
 * （2026-11-05 实测 matchId 9075953759，局后 12 小时仍是这个状态）。
 * 只认 ability_uses 的话，这种局就整个拿不到技能。
 *
 * 语义差别必须说清楚：这里的次数是**加点次数**（点了 4 级的技能是这个组合的主力），
 * 不是使用次数。展示层要用「按加点」措辞，别让人以为是他按了 126 次。
 *
 * 过滤仍在映射成内部名之后做 —— 加点数组里混着天赋 id（special_bonus_*），
 * 映射前没法认出来。
 */
export function parseAbilityUpgrades(upgrades, ids, meta) {
    if (!Array.isArray(upgrades) || upgrades.length === 0)
        return [];
    // 数字 id → 内部名 → 计数（映射后过滤噪声，天赋自然被剔掉）
    const counts = new Map();
    for (const raw of upgrades) {
        const id = Number(raw);
        if (!Number.isInteger(id) || id <= 0)
            continue;
        const key = ids.get(id);
        if (key === undefined || isNoiseAbility(key))
            continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const out = [];
    for (const [key, levels] of counts) {
        const m = meta.get(key);
        const dname = m?.dname ?? '';
        out.push({
            key,
            name: dname !== '' ? dname : key,
            uses: levels, // 这里复用字段表示"加点次数"，调用方要按 basis='levels' 措辞
            ...(m?.behavior !== undefined && m.behavior !== '' ? { behavior: m.behavior } : {}),
            ...(m?.dmgType !== undefined && m.dmgType !== '' ? { damageType: m.dmgType } : {}),
        });
    }
    out.sort((a, b) => b.uses - a.uses);
    return out;
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
    // 「指向类」= 要选目标或选点的技能 —— 这类多，套路通常是控场/单体爆发；
    // 反之全是 No Target / Toggle / Passive 的话就是无脑按或者光环流。
    const aimed = abilities.filter((a) => {
        const b = a.behavior ?? '';
        return b.includes('Unit Target') || b.includes('Point Target');
    }).length;
    const noTarget = abilities.filter((a) => (a.behavior ?? '').includes('No Target')).length;
    const magical = abilities.filter((a) => (a.damageType ?? '') === 'Magical').length;
    const physical = abilities.filter((a) => (a.damageType ?? '') === 'Physical').length;
    if (aimed >= 3)
        tags.push(`${aimed} 个选目标/选点的技能（控场或单体爆发味道很重）`);
    else if (aimed === 2)
        tags.push('2 个需要选目标/选点的技能');
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