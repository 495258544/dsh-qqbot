/**
 * 归属索引 · 引用消息的发送者反查（M21）
 * ─────────────────────────────────────────────────────────────
 * 问题：QQ 合并转发（msgType=103）的 `msg_elements` **只有 content 字符串**，
 * 不含每条消息的发送者/nickname/timestamp。SDK 类型定义就是：
 *
 *     interface RawMsgElement { msg_idx?; content?; attachments? }
 *
 * 拿不到发送者 → 模型只能看到"某人" → 会瞎猜归属。
 * 真实事故（2026-10-31）：小羽把 jmx 说的「卡了就别催了」算成群主说的，
 * 回了句「刚不是你那边卡了」。
 *
 * 曾经用群历史缓冲反查，但 `clearGroupHistory` 每轮回复后都会清空它，
 * 导致反查永远命中不了。所以这里单独存一份**只用于反查**的小索引：
 *   - 与 historyBuffer 完全分离，不被清理
 *   - 不进模型上下文（只喂给 buildQuotePart 做归属判定）
 *   - 环形保存最近 N 条
 *   - **落盘持久化**：重启后仍能反查「重启前说过的话」
 *     （实测踩过：纯内存版重启清空，用户重启后再引用就认不出来）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface AttributionEntry {
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
  /**
   * 这条消息带的图片指纹（MD5）。
   *
   * 实测发现（2026-11-01）：QQ 下发的图片文件名本身就是**图片内容的 MD5**，
   * 与本地归档算出来的 md5 完全一致（逐字节核对过：
   *   4b859167d7bf796ef62ee84377c1224e  == 归档文件的实际 MD5）。
   * 所以"引用一张图是谁发的"可以直接用文件名对指纹，**不需要下载图片**，
   * 也不需要跑视觉模型 —— 事后 URL 会过期（实测返回 download url has expired）。
   */
  imageMd5?: string[];
}

/** 每个群保留多少条用于反查（用户要求放大到 100 条） */
const MAX_PER_GROUP = 100;

/** 内存里最多保留多少个群（防内存无界增长） */
const MAX_GROUPS = 200;

/*
 * 存储量核算（放大到 100 条/群之后）：
 *   每群 100 × 200 字 ≈ 20 KB
 *   全局 200 群      ≈ 4 MB（理论上限）
 *   实测单群 100 条约 20 KB 落盘，完全可接受
 */

const index = new Map<string, AttributionEntry[]>();

/** 落盘位置：默认 ~/.dsh-qqbot/persona/attribution-index.json */
function storePath(): string {
  return process.env.QQBOT_ATTRIBUTION_PATH
    ?? join(homedir(), '.dsh-qqbot', 'persona', 'attribution-index.json');
}

let loaded = false;

/** 首次使用时从磁盘载入（惰性，避免模块加载时做 IO） */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const file = storePath();
  if (!existsSync(file)) return;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, AttributionEntry[]>;
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) index.set(k, v.slice(-MAX_PER_GROUP));
    }
  } catch {
    /* 文件损坏就当空的，不影响主流程 */
  }
}

/** 落盘（原子替换：先写临时文件再 rename，避免写一半被读到） */
function persist(): void {
  const file = storePath();
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj: Record<string, AttributionEntry[]> = {};
    for (const [k, v] of index) obj[k] = v.slice(-MAX_PER_GROUP);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* 落盘失败不影响内存查询 */
  }
}

function groupKey(appId: string, groupId: string): string {
  return `${appId}:${groupId}`;
}

/**
 * 记一条消息，供后续引用时反查归属。
 *
 * 用户消息和机器人自己的消息都要记 —— 否则「引用小羽说过的话」查不到，
 * 她就会把自己的话当成别人说的。
 */
export function rememberForAttribution(
  appId: string,
  groupId: string,
  entry: { senderId: string; senderName?: string; content: string; imageMd5?: string[] },
): void {
  const body = String(entry.content ?? '').trim();
  if (!body || !entry.senderId) return;

  ensureLoaded();
  const key = groupKey(appId, groupId);
  let list = index.get(key);
  if (!list) {
    // 群数上限：挤掉最久没更新的那个
    if (index.size >= MAX_GROUPS) {
      let oldestKey: string | undefined;
      let oldestTs = Infinity;
      for (const [k, v] of index) {
        const ts = v[v.length - 1]?.timestamp ?? 0;
        if (ts < oldestTs) { oldestTs = ts; oldestKey = k; }
      }
      if (oldestKey !== undefined) index.delete(oldestKey);
    }
    list = [];
    index.set(key, list);
  }

  list.push({
    senderId: entry.senderId,
    ...(entry.senderName ? { senderName: entry.senderName } : {}),
    content: body.slice(0, 200),
    timestamp: Date.now(),
    ...(entry.imageMd5 && entry.imageMd5.length > 0 ? { imageMd5: entry.imageMd5 } : {}),
  });
  if (list.length > MAX_PER_GROUP) list.splice(0, list.length - MAX_PER_GROUP);
  persist();
}

/** 归一化：去合并转发头、去标签、压空白，用于内容比对 */
function norm(text: string): string {
  return String(text ?? '')
    .replace(/^===\s*消息\s*\d+\s*===\s*$/gm, '')
    .replace(/\[消息类型\][^\n]*/g, '')
    .replace(/\[消息内容\]/g, '')
    .replace(/\[图片\]|\[表情\]|\[动画表情\]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * 按内容反查这条引文是谁说的。
 *
 * 匹配策略（从严格到宽松）：
 *   1. 完全包含（引文里含历史某条的完整内容）→ 最可信
 *   2. 历史条目包含引文（引文被截断过）
 *   3. 前面若干字的公共前缀足够长 → 应对"预览被省略号截断"
 *
 * 命中多个时取**最近**的那条（同一个群里同一句话更可能是最近说的）。
 */
export function lookupAttribution(
  appId: string,
  groupId: string,
  quotedText: string,
): AttributionEntry | undefined {
  ensureLoaded();
  const list = index.get(groupKey(appId, groupId));
  if (!list?.length) return undefined;

  const probe = norm(quotedText);
  if (probe.length < 4) return undefined;

  // 从新到旧找，第一个命中的就是最近说的
  for (let i = list.length - 1; i >= 0; i--) {
    const h = list[i];
    if (!h) continue;
    const body = norm(h.content);
    if (!body || body.length < 4) continue;

    if (probe.includes(body)) return h;                       // 引文含完整原文
    if (body.includes(probe)) return h;                       // 引文是原文的一部分
    // 预览被截断（QQ 引用预览会省略后半段）：比公共前缀
    const minLen = Math.min(body.length, probe.length);
    if (minLen >= 8) {
      let same = 0;
      while (same < minLen && body[same] === probe[same]) same += 1;
      // 前缀几乎一致（允许末尾差一两个字）→ 认定同一句
      if (same >= Math.max(10, minLen - 3)) return h;
    }
  }
  return undefined;
}

/**
 * 按图片指纹反查这条图是谁发的。
 *
 * 引用的图片在 msgElements 里带文件名（= 内容 MD5）与 URL，
 * 但 URL 会过期（实测 "download url has expired"），下载并不可靠。
 * 用 MD5 对索引即可，零网络开销。
 */
export function lookupByImageMd5(
  appId: string,
  groupId: string,
  md5s: string[],
): AttributionEntry | undefined {
  ensureLoaded();
  if (md5s.length === 0) return undefined;
  const list = index.get(groupKey(appId, groupId));
  if (!list?.length) return undefined;

  const targets = new Set(md5s.map((m) => m.toLowerCase()));
  for (let i = list.length - 1; i >= 0; i--) {
    const h = list[i];
    if (!h?.imageMd5?.length) continue;
    if (h.imageMd5.some((m) => targets.has(m.toLowerCase()))) return h;
  }
  return undefined;
}

/** 清掉某群的索引（群解散/重置时用；正常回复**不要**调用） */
export function clearAttribution(appId: string, groupId: string): void {
  ensureLoaded();
  index.delete(groupKey(appId, groupId));
  persist();
}

/** 仅供测试/诊断：当前索引规模 */
export function attributionSize(appId: string, groupId: string): number {
  return index.get(groupKey(appId, groupId))?.length ?? 0;
}

/** 仅供测试：强制下次访问重新从磁盘载入（模拟重启） */
export function reloadForTest(): void {
  loaded = false;
}

/** 仅供测试：清空全部（避免测试间互相污染） */
export function resetAttributionForTest(): void {
  index.clear();
  loaded = true;   // 测试里不再从磁盘载入，避免互相污染
}
