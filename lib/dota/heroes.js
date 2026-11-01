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
//# sourceMappingURL=heroes.js.map