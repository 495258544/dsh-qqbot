/**
 * 表情库一致性校验（M10）
 * ─────────────────────────────────────────────────────────────
 * 确立的规则：
 *   1. `_index.json` 是**唯一权威**（分类只看清单，不看目录名）
 *   2. 目录只是物理容器，不承担分类语义
 *   3. 定期自检，保证两边对得上
 *
 * 检查项：
 *   - 失效索引：索引里的 path 在磁盘上不存在
 *   - 孤儿文件：磁盘上的图未进索引（待分类）
 *   - 重复图：内容相同但存了多份（按 MD5）
 *   - 索引结构错误：缺字段、use 代码不合法
 *
 * 用法：
 *   node lib/ops/sticker-verify.js                 # 报告（只读）
 *   node lib/ops/sticker-verify.js --json          # 输出 JSON
 *   node lib/ops/sticker-verify.js --fix-index     # 清理失效索引项（安全，仅删索引不改文件）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { platformDefaultRoot } from "../media/sticker-tool.js";
/**
 * 表情库根。
 * 上游写死 /sdcard/表情包（安卓），桌面端不存在该路径。
 * 这里改为：--root 参数 > QQBOT_STICKER_ROOT 环境变量 > 平台默认（桌面端 ~/stickers）。
 */
function libRoot() {
    const i = process.argv.indexOf('--root');
    const fromArgv = i >= 0 ? (process.argv[i + 1] ?? '') : '';
    const fromEnv = process.env.QQBOT_STICKER_ROOT ?? '';
    return (fromArgv || fromEnv || platformDefaultRoot()).replace(/[\\/]+$/, '');
}
/** 索引文件 */
const INDEX_FILE = '_index.json';
/** 合法的使用时机代码 */
const VALID_USE = new Set([
    'A1', 'A2', 'A3', 'A4', 'A5', 'A6',
    'B1', 'B2', 'B3', 'B4', 'B5', 'B6',
    'C1', 'C2', 'C3', 'C4',
    'D1',
]);
/** 图片扩展名 */
const IMG_RE = /\.(jpg|jpeg|png|gif|webp)$/i;
/** 递归扫描目录下的图片（跳过隐藏文件/下划线开头的元数据） */
function scanImages(dir, out = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const e of entries) {
        if (e.name.startsWith('.'))
            continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            // _ 开头的目录（如 _群聊收集）也扫，但 _ 开头的普通文件是元数据不扫
            scanImages(p, out);
        }
        else if (IMG_RE.test(e.name) && !e.name.startsWith('_')) {
            out.push(p);
        }
    }
    return out;
}
/** 计算文件 MD5（读失败返回空串） */
function md5(file) {
    try {
        return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
    }
    catch {
        return '';
    }
}
/** 读索引 */
function loadIndex() {
    const p = path.join(libRoot(), INDEX_FILE);
    if (!fs.existsSync(p))
        return [];
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(raw.stickers) ? raw.stickers : [];
    }
    catch {
        return [];
    }
}
/**
 * 执行校验（只读）。
 * @param checkDuplicates 是否计算 MD5 查重（大库较慢，默认开）
 */
export function verifyStickerLibrary(checkDuplicates = true) {
    const stickers = loadIndex();
    const diskFiles = scanImages(libRoot());
    const indexedSet = new Set(stickers.map((s) => s.path));
    // 1. 失效索引
    const staleEntries = stickers
        .filter((s) => !fs.existsSync(s.path))
        .map((s) => ({ path: s.path, desc: s.desc }));
    // 2. 孤儿文件（磁盘有、索引无）
    const orphans = diskFiles.filter((f) => !indexedSet.has(f));
    // 3. 结构问题
    const structuralIssues = [];
    for (const s of stickers) {
        if (!s.path)
            structuralIssues.push({ path: '(空)', issue: '缺少 path 字段' });
        if (!Array.isArray(s.use) || s.use.length === 0) {
            structuralIssues.push({ path: s.path, issue: '缺少 use 分类' });
        }
        else {
            const bad = s.use.filter((u) => !VALID_USE.has(u));
            if (bad.length > 0) {
                structuralIssues.push({ path: s.path, issue: `非法 use 代码: ${bad.join(',')}` });
            }
        }
        if (!s.desc)
            structuralIssues.push({ path: s.path, issue: '缺少 desc 描述' });
    }
    // 4. 重复图（同 MD5）
    const duplicates = [];
    if (checkDuplicates) {
        const byMd5 = new Map();
        for (const f of diskFiles) {
            // 只对已入库的查重（孤儿本来就待处理）
            if (!indexedSet.has(f))
                continue;
            const h = md5(f);
            if (!h)
                continue;
            const arr = byMd5.get(h);
            if (arr)
                arr.push(f);
            else
                byMd5.set(h, [f]);
        }
        for (const [h, paths] of byMd5) {
            if (paths.length > 1)
                duplicates.push({ md5: h, paths });
        }
    }
    const consistent = staleEntries.length === 0 &&
        structuralIssues.length === 0 &&
        duplicates.length === 0;
    return {
        indexCount: stickers.length,
        diskCount: diskFiles.length,
        staleEntries,
        orphans,
        duplicates,
        structuralIssues,
        consistent,
    };
}
/** 清理索引里指向不存在文件的条目（**只改索引，不动文件**） */
export function fixStaleIndex() {
    const p = path.join(libRoot(), INDEX_FILE);
    if (!fs.existsSync(p))
        return { removed: 0, remaining: 0 };
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const stickers = raw.stickers ?? [];
    const kept = stickers.filter((s) => fs.existsSync(s.path));
    const removed = stickers.length - kept.length;
    if (removed > 0) {
        const next = { ...raw, stickers: kept, count: kept.length, updatedAt: new Date().toISOString() };
        fs.writeFileSync(`${p}.tmp`, JSON.stringify(next, null, 1), 'utf8');
        fs.renameSync(`${p}.tmp`, p);
    }
    return { removed, remaining: kept.length };
}
/** 把报告格式化成人类可读文本 */
export function renderReport(r) {
    const lines = [];
    lines.push('# 表情库一致性校验报告');
    lines.push('');
    lines.push(`- 索引条数: **${r.indexCount}**`);
    lines.push(`- 磁盘图片: **${r.diskCount}**`);
    lines.push(`- 未入库(待分类): **${r.orphans.length}**`);
    lines.push(`- 一致: **${r.consistent ? '✅ 是' : '❌ 否'}**`);
    lines.push('');
    if (r.staleEntries.length > 0) {
        lines.push(`## 失效索引 (${r.staleEntries.length})`);
        lines.push('索引指向的文件已不存在：');
        for (const s of r.staleEntries.slice(0, 10))
            lines.push(`- \`${s.path}\`${s.desc ? ` — ${s.desc}` : ''}`);
        if (r.staleEntries.length > 10)
            lines.push(`- …还有 ${r.staleEntries.length - 10} 条`);
        lines.push('');
    }
    if (r.structuralIssues.length > 0) {
        lines.push(`## 结构问题 (${r.structuralIssues.length})`);
        for (const s of r.structuralIssues.slice(0, 10))
            lines.push(`- \`${s.path}\` — ${s.issue}`);
        if (r.structuralIssues.length > 10)
            lines.push(`- …还有 ${r.structuralIssues.length - 10} 条`);
        lines.push('');
    }
    if (r.duplicates.length > 0) {
        lines.push(`## 重复图 (${r.duplicates.length} 组)`);
        for (const d of r.duplicates.slice(0, 5)) {
            lines.push(`- md5 \`${d.md5.slice(0, 8)}…\` ${d.paths.length} 份:`);
            for (const p of d.paths)
                lines.push(`  - \`${p}\``);
        }
        if (r.duplicates.length > 5)
            lines.push(`- …还有 ${r.duplicates.length - 5} 组`);
        lines.push('');
    }
    if (r.orphans.length > 0) {
        lines.push(`## 未入库文件 (${r.orphans.length})`);
        lines.push('这些图在磁盘上但没进索引（可用 qq_archive_sticker 收进库）：');
        for (const p of r.orphans.slice(0, 8))
            lines.push(`- \`${p}\``);
        if (r.orphans.length > 8)
            lines.push(`- …还有 ${r.orphans.length - 8} 个`);
        lines.push('');
    }
    return lines.join('\n');
}
// ── CLI 入口 ──
const isMain = process.argv[1] && process.argv[1].endsWith('sticker-verify.js');
if (isMain) {
    const mode = process.argv.includes('--json')
        ? 'json'
        : process.argv.includes('--fix-index')
            ? 'fix'
            : 'text';
    if (mode === 'fix') {
        const r = fixStaleIndex();
        console.log(`清理完成：移除 ${r.removed} 条失效索引，剩余 ${r.remaining} 条`);
    }
    else {
        const r = verifyStickerLibrary(!process.argv.includes('--no-dup'));
        if (mode === 'json')
            console.log(JSON.stringify(r, null, 1));
        else
            console.log(renderReport(r));
    }
}
//# sourceMappingURL=sticker-verify.js.map