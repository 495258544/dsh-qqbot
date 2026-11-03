/**
 * 英雄名映射 — 给聊天文案用的中文名
 * ─────────────────────────────────────────────────────────────
 * 数据固化在 heroes-data.ts（由 scripts 一次性从 dota2.com datafeed 生成），
 * 运行时零网络请求。
 *
 * 为什么不用 OpenDota 的 /constants/heroes：
 *   它只有英文 localized_name（Anti-Mage 之类），群里聊 Dota2 要的是「敌法师」。
 *   能给中文的只有 dota2.com 的 datafeed，而那个端点慢、不在 OpenDota 的限流体系里，
 *   放启动路径上等于给自己加一个外部依赖。
 *
 * 未收录的 ID（新英雄上线但表还没更新）不抛错，回退成「英雄#<id>」——
 * 战绩查询的主流程不能因为一个名字缺失就整体失败。
 */
import { HERO_NAMES, HERO_NAMES_EN } from "./heroes-data.js";
import { HERO_ALIASES } from "./hero-aliases.js";
/** 已收录的英雄 ID 集合（校验用：判断某个 id 是不是真的存在） */
export const HERO_IDS = new Set(Object.keys(HERO_NAMES).map(Number));
/** 已收录的英雄 ID 数量 */
export const HERO_COUNT = HERO_IDS.size;
/** 未知 ID 的展示名。不叫「未知英雄」是因为 id 本身有诊断价值（能看出表该更新了） */
export function fallbackHeroName(id) {
    return Number.isFinite(id) && id > 0 ? `英雄#${Math.floor(id)}` : '未知英雄';
}
/**
 * 英雄 ID → 中文名。
 * 未收录回退为 `英雄#<id>`；非法 id（非正数/NaN）回退为「未知英雄」。
 * 注意 player_slot 里的英雄 0 是「未选/随机前」，所以 0 也走回退。
 */
export function heroName(id) {
    const key = Number(id);
    if (!Number.isFinite(key))
        return '未知英雄';
    const name = HERO_NAMES[Math.floor(key)];
    return name !== undefined ? name : fallbackHeroName(key);
}
/** 英雄 ID → 英文名；未收录返回 undefined（日志/排查用，不参与文案） */
export function heroNameEn(id) {
    return HERO_NAMES_EN[Math.floor(Number(id))];
}
/** 这个 ID 是否是已知英雄 */
export function isKnownHero(id) {
    return HERO_IDS.has(Math.floor(Number(id)));
}
// ── 名字 → ID 的反查（群友用黑话聊英雄时对上号）──────────────────
/**
 * 名字归一化：忽略大小写、空格、连字符、点、撇号、下划线、全角空格。
 * 「Anti-Mage」「anti mage」「ANTIMAGE」归一化后都是 `antimage`。
 */
function normName(s) {
    return String(s ?? '').toLowerCase().replace(/[\s\-'’.·_\u3000]/g, '');
}
/** 官方中文名集合（归一化后），用于校验别名表有没有写错字 */
const OFFICIAL_CN = new Set(Object.values(HERO_NAMES).map(normName));
/**
 * 名字索引：官方中文名 / 英文名 / 黑话 → 英雄 ID。
 * 先到先得 —— 官方名优先，黑话只补官方名没占用的键，避免别名把官方名覆盖掉。
 */
const NAME_INDEX = (() => {
    const map = new Map();
    for (const [idStr, cn] of Object.entries(HERO_NAMES)) {
        const k = normName(cn);
        if (k !== '' && !map.has(k))
            map.set(k, Number(idStr));
    }
    for (const [idStr, en] of Object.entries(HERO_NAMES_EN)) {
        const k = normName(en);
        if (k !== '' && !map.has(k))
            map.set(k, Number(idStr));
    }
    for (const [alias, cn] of Object.entries(HERO_ALIASES)) {
        const id = map.get(normName(cn));
        if (id === undefined)
            continue; // 官方名写错了 —— unresolvedAliases() 会报出来
        const k = normName(alias);
        if (k !== '' && !map.has(k))
            map.set(k, id);
    }
    return map;
})();
/**
 * 名字 → 英雄 ID。接受官方中文名、英文名、群里的黑话（敌法/剑圣/白牛/AM/SF…）。
 *
 * 找不到返回 undefined —— 调用方自己决定怎么说"没认出来"，
 * 不要猜一个最像的（猜错比不认更糟：她会照着错英雄编一段分析）。
 */
export function heroIdByName(name) {
    const k = normName(name);
    return k === '' ? undefined : NAME_INDEX.get(k);
}
/**
 * 别名表里"官方中文名对不上"的条目（诊断用，正常应为空）。
 * 写错一个字，这条别名就会静默失效 —— 测试里用它兜底。
 */
export function unresolvedAliases() {
    return Object.entries(HERO_ALIASES)
        .filter(([, cn]) => !OFFICIAL_CN.has(normName(cn)))
        .map(([alias, cn]) => `${alias} → ${cn}`);
}
//# sourceMappingURL=heroes.js.map