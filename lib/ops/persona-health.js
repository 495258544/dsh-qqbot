/**
 * 小羽运行状态自检（运维用）
 * ─────────────────────────────────────────────────────────────
 * 一眼看清：她的自主功能到底跑没跑、跑成什么样。
 *
 * 用法：node lib/ops/persona-health.js
 */
import fs from 'node:fs';
import path from 'node:path';
const APP_ID = process.env.QQBOT_APP_ID || '1906131500';
const BASE = `/root/.dsh-qqbot/persona/app-${APP_ID}`;
function exists(p) {
    try {
        return fs.existsSync(p);
    }
    catch {
        return false;
    }
}
function readJson(p) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}
function ago(ms) {
    if (!ms)
        return '从未';
    const diff = Date.now() - ms;
    const m = Math.floor(diff / 60000);
    if (m < 60)
        return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24)
        return `${h} 小时前`;
    return `${Math.floor(h / 24)} 天前`;
}
function main() {
    console.log('════════ 小羽 · 运行状态自检 ════════\n');
    // ── 数据文件 ──
    console.log('【数据文件】');
    const files = [
        ['self.json（自我画像）', path.join(BASE, 'self.json')],
        ['self-note.json（自我叙述）', path.join(BASE, 'self-note.json')],
        ['voice.json（口癖）', path.join(BASE, 'voice.json')],
        ['diary/（日记目录）', path.join(BASE, 'diary')],
        ['state/own-life.json（自由时间）', path.join(BASE, 'state', 'own-life.json')],
    ];
    for (const [label, p] of files) {
        const ok = exists(p);
        let extra = '';
        if (ok && label.includes('日记')) {
            const n = fs.readdirSync(p).length;
            extra = ` · ${n} 个文件`;
        }
        console.log(`  ${ok ? '✅' : '❌'} ${label}${extra}`);
    }
    // ── 日记内容 ──
    const diaryDir = path.join(BASE, 'diary');
    if (exists(diaryDir)) {
        const entries = fs.readdirSync(diaryDir).filter((f) => f.endsWith('.md')).sort();
        console.log(`\n【日记】${entries.length === 0 ? '❌ 一篇都没写' : `✅ ${entries.length} 天`}`);
        for (const e of entries.slice(-3)) {
            console.log(`  · ${e}`);
        }
    }
    // ── 自我叙述 ──
    const sn = readJson(path.join(BASE, 'self-note.json'));
    console.log(`\n【自我叙述 selfNote】`);
    if (!sn || !sn.current || sn.current.length === 0) {
        console.log('  ❌ 还没写过');
    }
    else {
        console.log(`  ✅ ${sn.current.length} 条（归档 ${sn.archived?.length ?? 0} 条）`);
        for (const n of sn.current.slice(-2))
            console.log(`    "${n.text.slice(0, 40)}"`);
    }
    // ── 口癖 ──
    const vf = readJson(path.join(BASE, 'voice.json'));
    console.log(`\n【口癖 voice】`);
    if (!vf || !vf.habits || vf.habits.length === 0) {
        console.log(`  ❌ 还没形成（正样本 ${vf?.caughtSamples?.length ?? 0} 条）`);
    }
    else {
        const active = vf.habits.filter((h) => h.state === 'active');
        console.log(`  ✅ 共 ${vf.habits.length} 条，其中生效 ${active.length} 条`);
        for (const h of active.slice(0, 3))
            console.log(`    "${h.style}"（${h.count}次）`);
    }
    // ── 自由时间 ──
    const ol = readJson(path.join(BASE, 'state', 'own-life.json'));
    console.log(`\n【自由时间 own-life】`);
    if (!ol) {
        console.log('  ❌ 未启动过（无状态文件）');
    }
    else {
        console.log(`  ✅ 最近触发：${ago(ol.lastFiredAt)}（今天 ${ol.firedToday ?? 0} 次）`);
    }
    // ── 兴趣与冲浪 ──
    const self = readJson(path.join(BASE, 'self.json'));
    if (self) {
        console.log(`\n【兴趣】`);
        for (const i of self.interests ?? []) {
            const s = i.strength ?? i.weight ?? 0;
            const flag = i.frozen ? ' [冻结]' : '';
            console.log(`  ${i.topic}: ${s.toFixed(2)} (${i.kind ?? 'current'})${flag}`);
        }
        console.log(`\n【冲浪】最近一次：${ago(self.lastSurfAt)}`);
        if (self.names && self.names.length > 0) {
            console.log(`\n【称呼】${self.names.map((n) => `${n.name}${n.accepted ? '(已接受)' : '(未接受)'}`).join('、')}`);
        }
        console.log(`\n【话痨度】${self.engagement?.chattiness ?? 1}`);
        console.log(`【需求】${self.wishes?.length ?? 0} 条`);
    }
    // ── 上游检查 ──
    const uw = readJson('/root/.dsh-qqbot/ops/upstream-watch/state.json');
    console.log(`\n【上游巡检】`);
    if (!uw) {
        console.log('  ❌ 未运行过');
    }
    else {
        console.log(`  ✅ 最近：${ago(uw.lastRunAt)}（落后 ${uw.lastBehind ?? '?'} 个提交）`);
    }
    console.log('\n════════ 完 ════════');
}
main();
//# sourceMappingURL=persona-health.js.map