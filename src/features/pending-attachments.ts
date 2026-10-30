/**
 * 待领附件缓存（"先发图、后 @ 我"场景）
 * ─────────────────────────────────────────────────────────────
 * 手机端无法同时 @ + 发图，用户常先发一张图，再补一句"@小羽 看这个"。
 * 图片先到时会因为未唤醒被 wake-gate 拦掉。本模块把这类消息的**已下载附件**
 * 暂存一小段时间（默认 3 分钟），等同一发送者随后唤醒 bot 时，把图一起交给 agent。
 *
 * 键：`${scope}:${peerId}:${senderId}`（同一群里同一个人的图）
 * 值：{ files, at }
 * 纯内存，随进程生命周期；过期自动丢弃。
 */
import type { DownloadedFile } from '../transport/attachment.ts';

/** 待领附件保留时长（毫秒） */
const TTL_MS = 3 * 60 * 1000;

interface PendingEntry {
  files: DownloadedFile[];
  at: number;
}

const pending = new Map<string, PendingEntry>();

/** 生成缓存键 */
export function pendingKey(scope: string, peerId: string, senderId: string): string {
  return `${scope}:${peerId}:${senderId}`;
}

/** 存入一批待领附件（同键合并，只保留最近的） */
export function stashPendingAttachments(key: string, files: DownloadedFile[]): void {
  if (files.length === 0) return;
  const prev = pending.get(key);
  const now = Date.now();
  // 丢弃过期数据后再合并
  const kept = prev && now - prev.at < TTL_MS ? prev.files : [];
  pending.set(key, { files: [...kept, ...files], at: now });
}

/**
 * 取出并清空某键下的待领附件（唤醒时调用）。
 * 过期的不返回。
 */
export function takePendingAttachments(key: string): DownloadedFile[] {
  const e = pending.get(key);
  if (!e) return [];
  pending.delete(key);
  if (Date.now() - e.at >= TTL_MS) return [];
  return e.files;
}

/** 清理过期条目（定时调用，避免内存滞留） */
export function prunePendingAttachments(): number {
  const now = Date.now();
  let n = 0;
  for (const [k, e] of pending) {
    if (now - e.at >= TTL_MS) {
      pending.delete(k);
      n += 1;
    }
  }
  return n;
}
