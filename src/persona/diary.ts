/**
 * 日记本 · 让她有一件「不为了谁而做的事」
 * ─────────────────────────────────────────────────────────────
 * 移植自 ai-companion-kit（MIT）packages/companion/src/diary.js（存储层）。
 *
 * 记忆账本写的是「关于你的事」，日记写的是「她自己的一天」——两回事。
 * 混在一起，AI 就会把所有事都写成汇报。
 *
 * dsh-qqbot 适配：不移植原版的 diary-author（独立 LLM 自动生成）——
 * 在 dsh 里 agent 就是大脑，通过 qq_write_diary 工具自己写。
 * 存储保持原样：index.jsonl 追加 + YYYY-MM-DD.md 可读版。
 */
import fs from 'node:fs';
import path from 'node:path';

const pad = (n: number): string => String(n).padStart(2, '0');

function dayOf(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clockOf(d = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface DiaryEntry {
  t: number;
  day: string;
  time: string;
  title: string;
  mood: string;
  tags: string[];
  text: string;
}

export interface DiaryInput {
  text: string;
  mood?: string;
  title?: string;
  tags?: string[];
  day?: string;
  time?: string;
  t?: number;
}

export class Diary {
  private readonly file: string;
  private readonly maxChars: number;
  private readonly writeMd: boolean;

  constructor(private readonly dir: string, { maxChars = 2000, md = true }: { maxChars?: number; md?: boolean } = {}) {
    this.file = path.join(dir, 'index.jsonl');
    this.maxChars = maxChars;
    this.writeMd = md;
    fs.mkdirSync(dir, { recursive: true });
  }

  private readAll(): DiaryEntry[] {
    let raw = '';
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const rows: DiaryEntry[] = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        rows.push(JSON.parse(s) as DiaryEntry);
      } catch {
        /* 坏行跳过，不炸整本 */
      }
    }
    return rows;
  }

  private mdPath(day: string): string {
    return path.join(this.dir, `${day}.md`);
  }

  private appendMd(entry: DiaryEntry): void {
    if (!this.writeMd) return;
    const p = this.mdPath(entry.day);
    const fresh = !fs.existsSync(p);
    const head = fresh ? `# ${entry.day}\n` : '';
    const bits: string[] = [];
    bits.push(`\n## ${entry.time}${entry.mood ? ' · ' + entry.mood : ''}\n`);
    if (entry.title) bits.push(`**${entry.title}**\n\n`);
    bits.push(entry.text.trim() + '\n');
    if (entry.tags?.length) bits.push(`\n\`${entry.tags.join('` `')}\`\n`);
    fs.appendFileSync(p, head + bits.join(''), 'utf8');
  }

  /** 写一条日记 */
  add(entry: DiaryInput): DiaryEntry {
    const text = String(entry.text ?? '').trim();
    if (!text) throw new Error('日记正文是空的');
    if (text.length > this.maxChars) throw new Error(`日记太长（${text.length} > ${this.maxChars}）`);

    const now = new Date();
    const t = entry.t ? new Date(entry.t) : now;
    const row: DiaryEntry = {
      t: t.getTime(),
      day: entry.day || dayOf(t),
      time: entry.time || clockOf(t),
      title: entry.title ? String(entry.title).slice(0, 40) : '',
      mood: entry.mood ? String(entry.mood).slice(0, 8) : '',
      tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 8).map(String) : [],
      text,
    };
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf8');
    this.appendMd(row);
    return row;
  }

  /** 最近 n 条（新的在后） */
  recent(n = 10): DiaryEntry[] {
    const all = this.readAll();
    return all.slice(Math.max(0, all.length - n));
  }

  /** 某一天的全部条目 */
  day(day: string): DiaryEntry[] {
    return this.readAll().filter((r) => r.day === day);
  }

  /** 条数与首条日期（算"认识第几天"用） */
  stats(): { count: number; firstDay: string | null; firstT: number | null; lastT: number | null; days: number } {
    const all = this.readAll();
    if (!all.length) return { count: 0, firstDay: null, firstT: null, lastT: null, days: 0 };
    const days = new Set(all.map((r) => r.day));
    return {
      count: all.length,
      firstDay: all[0]?.day ?? null,
      firstT: all[0]?.t ?? null,
      lastT: all[all.length - 1]?.t ?? null,
      days: days.size,
    };
  }

  /**
   * 渲染成能直接塞进 prompt 的一段话。只给最近几条——
   * 日记不该变成第二本记忆账本。
   */
  context(n = 3, days = 3): string {
    const all = this.readAll();
    if (!all.length) return '';
    const keepDays = [...new Set(all.map((r) => r.day))].slice(-days);
    const rows = all.filter((r) => keepDays.includes(r.day)).slice(-n);
    if (!rows.length) return '';
    const L = rows.map((r) => {
      const head = `${r.day.slice(5)} ${r.time}${r.mood ? '（' + r.mood + '）' : ''}`;
      const title = r.title ? `「${r.title}」` : '';
      return `· ${head} ${title}\n  ${r.text.replace(/\n/g, '\n  ')}`;
    });
    return '【你自己最近写的日记】\n' + L.join('\n')
      + '\n（这是你写的，别装作不记得；今天的日记还没写的话，找机会写一条）\n';
  }
}
