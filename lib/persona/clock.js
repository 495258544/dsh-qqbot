/**
 * 时区工具（容器无 tzdata 的正确解法）
 * ─────────────────────────────────────────────────────────────
 * 问题：这个 Ubuntu proot 容器**没有 /usr/share/zoneinfo**，
 *      `TZ=Asia/Shanghai` 被静默忽略，`new Date().getHours()` 返回的是 **UTC**。
 *
 * 后果（已实测）：
 *   配置写"凌晨 3-7 点冲浪"，实际会在 UTC 3-7 点跑 = **北京时间 11-15 点**。
 *
 * 解法：用 `Intl.DateTimeFormat` 显式指定 IANA 时区。
 *      Node 自带完整 ICU，不依赖系统 tzdata（已实测 UTC 2:25 → 北京 10:25 正确）。
 */
/** 默认时区（用户在北京） */
export const DEFAULT_TZ = 'Asia/Shanghai';
/**
 * 取指定时区下的「小时」（0-23）。
 * @param date 时间点，默认当前
 * @param tz IANA 时区名
 */
export function hourInTz(date = new Date(), tz = DEFAULT_TZ) {
    const s = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: '2-digit',
        hour12: false,
    }).format(date);
    // "en-US" 的 24 点会格式化成 "24"，归一到 0
    const h = Number.parseInt(s, 10);
    return h === 24 ? 0 : h;
}
/**
 * 取指定时区下的「分钟」。
 */
export function minuteInTz(date = new Date(), tz = DEFAULT_TZ) {
    return Number.parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: '2-digit' }).format(date), 10);
}
/**
 * 取指定时区下的「星期几」索引（0=周日, 6=周六）。
 */
export function weekdayInTz(date = new Date(), tz = DEFAULT_TZ) {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
    const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
    return idx >= 0 ? idx : 0;
}
/**
 * 取指定时区下的「HH:mm」字符串（时间感注入用）。
 */
export function clockInTz(date = new Date(), tz = DEFAULT_TZ) {
    const h = String(hourInTz(date, tz)).padStart(2, '0');
    const m = String(minuteInTz(date, tz)).padStart(2, '0');
    return `${h}:${m}`;
}
/**
 * 取指定时区下的「YYYY-MM-DD」（日记按天分组用）。
 */
export function dayInTz(date = new Date(), tz = DEFAULT_TZ) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
    return parts; // en-CA 输出 YYYY-MM-DD
}
/**
 * 判断某个时间点是否落在 [from, to) 小时区间内（支持跨午夜的反向区间）。
 * 例如 isHourInRange(h, 7, 3) 表示"3-7 点"（quiet 的语义）。
 */
export function isHourInRange(hour, from, to) {
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}
/**
 * 当前是否在指定的"活跃时段"内（用正确时区）。
 * @param from 起始小时（含）
 * @param to 结束小时（不含）
 */
export function isActiveWindow(from, to, date = new Date(), tz = DEFAULT_TZ) {
    return isHourInRange(hourInTz(date, tz), from, to);
}
//# sourceMappingURL=clock.js.map