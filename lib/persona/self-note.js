/**
 * selfNote（M16）— L4 层：她自己写自己的成长叙述
 * ─────────────────────────────────────────────────────────────
 * 来源（heybox-digest.md，《目前全网 QQ 大肥鱼的最优方案》）：
 *   L0 原文库 / L1 会话摘要 / L2 长期权重链 / L3 产物索引 / **L4 selfNote**
 *   前四层都在记录"用户"，**L4 是记录她自己**。
 *
 * 关键设计（照原帖）：
 *   - 她**不定期**对自己写叙述
 *   - 叙述**有字数上限**（不能无限膨胀）
 *   - 新叙述出现 → **旧叙述归档**（不是删除）
 *   - 目的："不希望她每次醒来都看着臃肿的过去"，
 *          "重新开一个新对话也不会觉得陌生"
 *
 * 与 diary.ts 的区别：
 *   diary   = 她的一天（事件流水，按日期组织，可以天天写）
 *   selfNote = 她的**自我认知**（"我是个什么样的人""我最近变了什么"），
 *              低频、精简、有上限，只保留最近若干条 + 归档旧版
 */
import fs from 'node:fs';
import path from 'node:path';
/** 最多保留几条"当前"叙述 */
const MAX_CURRENT = 3;
/** 当前叙述总字数上限（原帖强调"有上限"） */
const MAX_CHARS = 600;
/** 单条叙述上限 */
const MAX_ONE = 240;
/** 归档区上限（防无限增长） */
const MAX_ARCHIVED = 20;
/** 默认空结构 */
function empty() {
    return { version: 1, current: [], archived: [] };
}
/**
 * selfNote 服务：读写 self-note.json。
 */
export class SelfNoteService {
    log;
    data;
    file;
    constructor(dataDir, log) {
        this.log = log;
        this.file = path.join(dataDir, 'self-note.json');
        this.data = this.load();
    }
    load() {
        try {
            if (!fs.existsSync(this.file))
                return empty();
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            return {
                version: 1,
                current: Array.isArray(raw.current) ? raw.current : [],
                archived: Array.isArray(raw.archived) ? raw.archived : [],
                updatedAt: raw.updatedAt,
            };
        }
        catch {
            return empty();
        }
    }
    save() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            this.data.updatedAt = new Date().toISOString();
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
            fs.renameSync(tmp, this.file);
        }
        catch (err) {
            this.log?.(`selfNote: 写入失败 ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    snapshot() {
        return this.data;
    }
    /**
     * 写一条新的自我叙述。
     * 超出字数/条数上限时，**最旧的一条被归档**（不删除，可追溯）。
     * 返回实际有没有写入（太短/太长的拒绝）。
     */
    write(text, trigger = 'free-time') {
        const t = text.trim().replace(/\s+/g, ' ');
        if (t.length < 8 || t.length > MAX_ONE) {
            this.log?.(`selfNote: 长度不合适(${t.length})，拒绝`);
            return false;
        }
        // 重复内容不写（避免车轱辘话）
        if (this.data.current.some((n) => n.text === t)) {
            this.log?.('selfNote: 与已有叙述重复，跳过');
            return false;
        }
        this.data.current.push({ text: t, at: Date.now(), trigger });
        // 超出条数 → 归档最旧的
        while (this.data.current.length > MAX_CURRENT) {
            const old = this.data.current.shift();
            if (old)
                this.archive(old);
        }
        // 超出总字数 → 继续归档最旧的，直到不超
        let total = this.data.current.reduce((a, n) => a + n.text.length, 0);
        while (total > MAX_CHARS && this.data.current.length > 1) {
            const old = this.data.current.shift();
            if (old) {
                this.archive(old);
                total -= old.text.length;
            }
        }
        this.save();
        this.log?.(`selfNote: 写入一条（当前 ${this.data.current.length} 条/${total} 字）`);
        return true;
    }
    /** 归档：旧叙述进归档区，超过归档上限则丢弃最旧的 */
    archive(note) {
        this.data.archived.push(note);
        while (this.data.archived.length > MAX_ARCHIVED)
            this.data.archived.shift();
    }
    /**
     * 生成注入 prompt 的文本（只放 current，archive 不进上下文 ——
     * 呼应"上下文里只留检索路径，不塞记忆正文"的圈子共识）。
     */
    renderSection() {
        if (this.data.current.length === 0)
            return '';
        const lines = this.data.current.map((n) => `- ${n.text}`);
        return [
            '【你对自己的认识（这些是你自己写下的，会随时间更新）】',
            ...lines,
        ].join('\n');
    }
    /** 当前叙述条数/字数（供体检） */
    stats() {
        return {
            count: this.data.current.length,
            chars: this.data.current.reduce((a, n) => a + n.text.length, 0),
            archived: this.data.archived.length,
        };
    }
}
//# sourceMappingURL=self-note.js.map