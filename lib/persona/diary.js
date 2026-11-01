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
/**
 * 显式时区换算（容器无 tzdata，getHours() 返回 UTC，会差 8 小时）。
 *
 * 实测后果（2026-11-02）：她的"一天"从**北京 08:00** 才开始，
 * 而不是零点 —— 早上 8 点前写的日记会被算进前一天。
 */
const TZ = 'Asia/Shanghai';
function partsOf(d) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    });
    const kv = {};
    for (const p of fmt.formatToParts(d))
        kv[p.type] = p.value;
    return {
        y: kv.year ?? '0000', m: kv.month ?? '01', day: kv.day ?? '01',
        hh: kv.hour === '24' ? '00' : (kv.hour ?? '00'), mm: kv.minute ?? '00',
    };
}
function dayOf(d = new Date()) {
    const p = partsOf(d);
    return `${p.y}-${p.m}-${p.day}`;
}
function clockOf(d = new Date()) {
    const p = partsOf(d);
    return `${p.hh}:${p.mm}`;
}
export class Diary {
    dir;
    file;
    maxChars;
    writeMd;
    constructor(dir, { maxChars = 2000, md = true } = {}) {
        this.dir = dir;
        this.file = path.join(dir, 'index.jsonl');
        this.maxChars = maxChars;
        this.writeMd = md;
        fs.mkdirSync(dir, { recursive: true });
    }
    readAll() {
        let raw = '';
        try {
            raw = fs.readFileSync(this.file, 'utf8');
        }
        catch {
            return [];
        }
        const rows = [];
        for (const line of raw.split('\n')) {
            const s = line.trim();
            if (!s)
                continue;
            try {
                rows.push(JSON.parse(s));
            }
            catch {
                /* 坏行跳过，不炸整本 */
            }
        }
        return rows;
    }
    mdPath(day) {
        return path.join(this.dir, `${day}.md`);
    }
    appendMd(entry) {
        if (!this.writeMd)
            return;
        const p = this.mdPath(entry.day);
        const fresh = !fs.existsSync(p);
        const head = fresh ? `# ${entry.day}\n` : '';
        const bits = [];
        bits.push(`\n## ${entry.time}${entry.mood ? ' · ' + entry.mood : ''}\n`);
        if (entry.title)
            bits.push(`**${entry.title}**\n\n`);
        bits.push(entry.text.trim() + '\n');
        if (entry.tags?.length)
            bits.push(`\n\`${entry.tags.join('` `')}\`\n`);
        fs.appendFileSync(p, head + bits.join(''), 'utf8');
    }
    /** 写一条日记 */
    add(entry) {
        const text = String(entry.text ?? '').trim();
        if (!text)
            throw new Error('日记正文是空的');
        if (text.length > this.maxChars)
            throw new Error(`日记太长（${text.length} > ${this.maxChars}）`);
        const now = new Date();
        const t = entry.t ? new Date(entry.t) : now;
        const row = {
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
    recent(n = 10) {
        const all = this.readAll();
        return all.slice(Math.max(0, all.length - n));
    }
    /** 某一天的全部条目 */
    day(day) {
        return this.readAll().filter((r) => r.day === day);
    }
    /** 条数与首条日期（算"认识第几天"用） */
    stats() {
        const all = this.readAll();
        if (!all.length)
            return { count: 0, firstDay: null, firstT: null, lastT: null, days: 0 };
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
    context(n = 3, days = 3) {
        const all = this.readAll();
        if (!all.length)
            return '';
        const keepDays = [...new Set(all.map((r) => r.day))].slice(-days);
        const rows = all.filter((r) => keepDays.includes(r.day)).slice(-n);
        if (!rows.length)
            return '';
        const L = rows.map((r) => {
            const head = `${r.day.slice(5)} ${r.time}${r.mood ? '（' + r.mood + '）' : ''}`;
            const title = r.title ? `「${r.title}」` : '';
            return `· ${head} ${title}\n  ${r.text.replace(/\n/g, '\n  ')}`;
        });
        return '【你自己最近写的日记】\n' + L.join('\n')
            + '\n（这是你写的，别装作不记得；今天的日记还没写的话，找机会写一条）\n';
    }
}
//# sourceMappingURL=diary.js.map