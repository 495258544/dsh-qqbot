/**
 * 技能名的官方简体中文对照（按 OpenDota 的英文 dname 匹配）
 * ─────────────────────────────────────────────────────────────
 * 为什么需要（2026-11-08 实锤）：
 *   原先的设计是「OpenDota 只给英文 dname，让她自己转述成中文」——
 *   实测翻车：sven_gods_strength 的 dname 是 `God's Strength`（官方简体中文
 *   「神之力量」，斯温大招），她把 God's 当成复数所有格，直译成「众神之力」。
 *   OMG 里技能名是识别技能组合的唯一凭据，译错等于把数据说错，
 *   和「钩子拉得太准」那类瞎编是同一类问题。
 *
 * 为什么只收一小张表、而不是全量中英对照：
 *   · 全量上千条要跟版本维护，写错一条就是用错误的中文覆盖正确的英文；
 *   · 没收录的技能**保留英文原名**，工具输出里也明说「照抄，不要自己翻译」；
 *   · 表里每一条都同时给出英文原名（输出格式 `神之力量（God's Strength）`），
 *     即便中文名有争议，群里也能靠英文对上号。
 *
 * 收录标准：DOTA2 国服官方简体中文名 / 群内无歧义的共识叫法。
 * 没把握的一律不收 —— 宁可留英文，不要造译名。
 */
/** key 是归一化后的英文 dname；新增条目时写归一化形式（小写、无撇号、单空格）。 */
const BY_DNAME = Object.freeze({
    "gods strength": '神之力量',
    bloodlust: '嗜血术',
    ignite: '引燃',
    fireblast: '火焰爆轰',
    rot: '腐烂',
    'meat hook': '肉钩',
    'phantom strike': '幻影突袭',
    'stifling dagger': '窒息之刃',
    toss: '投掷',
    duel: '决斗',
    vacuum: '真空',
    'ice path': '冰封路径',
    'wall of replica': '复制之墙',
    shadowraze: '毁灭阴影（影压）',
    hex: '妖术',
    disruption: '崩裂禁锢',
    'demonic purge': '邪恶净化',
});
/** 归一化 dname：小写、去掉各种撇号、合并空白。 */
function normalize(dname) {
    return dname.trim().toLowerCase().replace(/['’`´]/g, '').replace(/\s+/g, ' ');
}
/**
 * 查官方简体中文名；没收录返回 undefined（调用方保留英文原名）。
 * 只按 dname 查，不按内部名 —— 同一技能可能有多个内部名（影压 1/2/3），
 * 但 dname 稳定且就是群里认的那个名字。
 */
export function abilityZh(dname) {
    const key = normalize(dname);
    return key === '' ? undefined : BY_DNAME[key];
}
//# sourceMappingURL=ability-zh.js.map