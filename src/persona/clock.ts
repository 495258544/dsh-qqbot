/**
 * 时区工具（显式 IANA 时区，不依赖进程环境）
 * ─────────────────────────────────────────────────────────────
 * 问题：`new Date().getHours()` 返回的是 **UTC**，不是北京时间。
 *
 * 原因（2026-11-03 更正）：**启动时没有设 TZ 环境变量**。
 *   早先这里写的是"容器没有 /usr/share/zoneinfo、TZ 被静默忽略"——
 *   那是错的，已实测证伪：
 *     · /usr/share/zoneinfo 存在（2.0M）
 *     · TZ=Asia/Shanghai date → Tue Nov  3 02:05:20 CST 2026 ✓
 *     · 不设 TZ 时 date → Mon Nov  2 18:05:20 UTC 2026
 *   而且那句话本身自相矛盾：TZ 若真被忽略，恰恰说明系统不认识 TZ。
 *
 * 后果（实测）：
 *   配置写"凌晨 3-7 点冲浪"，实际会在 UTC 3-7 点跑 = **北京时间 11-15 点**。
 *
 * 解法：用 `Intl.DateTimeFormat` 显式指定 IANA 时区。
 *   Node 自带完整 ICU，**不依赖进程环境**——这样无论宿主有没有设 TZ、
 *   以后换到别的容器，行为都不变。
 *   （也可以在启动时补 `process.env.TZ ??= 'Asia/Shanghai'`，
 *     但那只影响之后 new Date() 的本地方法，已经写死的代码仍要走这里。）
 */

/** 默认时区（用户在北京） */
export const DEFAULT_TZ = 'Asia/Shanghai';

/**
 * 取指定时区下的「小时」（0-23）。
 * @param date 时间点，默认当前
 * @param tz IANA 时区名
 */
export function hourInTz(date: Date = new Date(), tz: string = DEFAULT_TZ): number {
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
export function minuteInTz(date: Date = new Date(), tz: string = DEFAULT_TZ): number {
  return Number.parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: '2-digit' }).format(date),
    10,
  );
}

/**
 * 取指定时区下的「星期几」索引（0=周日, 6=周六）。
 */
export function weekdayInTz(date: Date = new Date(), tz: string = DEFAULT_TZ): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  return idx >= 0 ? idx : 0;
}

/**
 * 取指定时区下的「HH:mm」字符串（时间感注入用）。
 */
export function clockInTz(date: Date = new Date(), tz: string = DEFAULT_TZ): string {
  const h = String(hourInTz(date, tz)).padStart(2, '0');
  const m = String(minuteInTz(date, tz)).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 取指定时区下的「YYYY-MM-DD」（日记按天分组用）。
 */
export function dayInTz(date: Date = new Date(), tz: string = DEFAULT_TZ): string {
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
export function isHourInRange(hour: number, from: number, to: number): boolean {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

