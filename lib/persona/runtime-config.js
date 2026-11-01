/**
 * persona 运行时配置（改完即时生效，不用重启）
 * ─────────────────────────────────────────────────────────────
 * 为什么要这一层：profile 的 `cordis.patch.yml` 是宿主**启动时**读的，改一行就得重启 DSH。
 * 但「她叫什么」「群里都有谁」「哪些词该接」这类东西变的频率很高——
 * 每次加个群友名字都要重启一次，太难受。
 *
 * 所以这些放数据目录，靠 mtime 热重读：
 *   <personaDataDir>/runtime.json
 *   {
 *     "names": ["小深"],           // 追加到 profile 的 names
 *     "keywords": ["打刀"],         // 追加到 profile 的 keywords
 *     "otherNames": ["刘宗锴"]      // 追加到"别人名字"表（判断这句在叫谁）
 *   }
 *
 * 语义一律是**追加**，不是替换：profile 里那份是基线，这里只往上加。
 * 这样两边都不用惦记对方，也不会因为漏写一个名字把配置整体搞坏。
 */
import fs from 'node:fs';
/** 只保留非空字符串，去重，保持原顺序 */
function sanitizeList(input) {
    if (!Array.isArray(input))
        return [];
    const out = [];
    for (const item of input) {
        const s = typeof item === 'string' ? item.trim() : '';
        if (s !== '' && !out.includes(s))
            out.push(s);
    }
    return out;
}
export class RuntimeConfig {
    file;
    log;
    value = {};
    mtimeAt;
    loaded = false;
    constructor(file, log = () => { }) {
        this.file = file;
        this.log = log;
    }
    statMtime() {
        try {
            return fs.statSync(this.file).mtimeMs;
        }
        catch {
            return undefined;
        }
    }
    /** 热读：mtime 变了才重新解析；文件不存在 = 全空 */
    get() {
        const mtime = this.statMtime();
        if (this.loaded) {
            if (mtime === this.mtimeAt)
                return this.value;
            // 文件被删 → 回到空配置，别抱着旧值
            if (mtime === undefined) {
                this.value = {};
                this.mtimeAt = undefined;
                return this.value;
            }
        }
        this.loaded = true;
        this.mtimeAt = mtime;
        if (mtime === undefined) {
            this.value = {};
            return this.value;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.value = {
                names: sanitizeList(parsed.names),
                keywords: sanitizeList(parsed.keywords),
                otherNames: sanitizeList(parsed.otherNames),
            };
        }
        catch (err) {
            // 写坏了不该让她直接变哑巴：降级为空，用 profile 的基线继续跑
            this.log(`persona: runtime.json 解析失败，本次按空配置处理（${err instanceof Error ? err.message : String(err)}）`);
            this.value = {};
        }
        return this.value;
    }
    names() {
        return this.get().names ?? [];
    }
    keywords() {
        return this.get().keywords ?? [];
    }
    otherNames() {
        return this.get().otherNames ?? [];
    }
    /** 落盘（给工具用：把新名字/关键词写进去，下一轮就生效） */
    update(patch) {
        const current = { ...this.get(), ...patch };
        const payload = {
            names: sanitizeList(current.names),
            keywords: sanitizeList(current.keywords),
            otherNames: sanitizeList(current.otherNames),
        };
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tmp, this.file);
        this.loaded = true;
        this.mtimeAt = this.statMtime();
        this.value = payload;
        return payload;
    }
    get path() {
        return this.file;
    }
}
//# sourceMappingURL=runtime-config.js.map