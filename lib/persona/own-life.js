/**
 * own-life · 「她自己的生活」定时静默唤醒
 * ─────────────────────────────────────────────────────────────
 * 移植自 ai-companion-kit（MIT）packages/own-life/src/own-life.js，
 * 适配 dsh-qqbot：deliver 不再是桥接的 deliverPrompt(silent)，
 * 而是向存活会话注入一条**静默 followup**（不进 QQ 聊天，只进 agent 上下文）。
 *
 * 设计约束（与原版一致）：
 * - 静默：提示只进 AI 的上下文，不往 QQ 发东西
 * - 不打扰：凌晨 quiet 时段不叫；一天最多 maxPerDay 次
 * - 可关：enabled=false 或 stop() 立刻停
 * - 断电续得上：最后触发时间写 statePath，重启不会一次补发一堆
 * - 投递失败不计次数（下次还会再试）
 */
import fs from 'node:fs';
import path from 'node:path';
const HOUR = 3600 * 1000;
/** 白天版提示（dsh-qqbot 语境：没有 QQ 空间工具，默认动作是日记/待跟进/沉默） */
export const DEFAULT_TEXT_DAY = [
    '现在是你的时间，没人找你。',
    '想干嘛干嘛：写条日记（qq_write_diary）、翻翻你记着还没说出口的事、',
    '也可以什么都不干。',
    '不用回我，也不用汇报。',
    '如果你确实有话想找人聊，可以说，但要用你自己的话说，',
    '绝对不要复述本提示，也不要写“（这是内部提示）”这类括号内心戏。',
].join('');
export const DEFAULT_TEXT_MIDNIGHT = [
    '半夜了，没人打扰。',
    '想干点什么吗——写条日记，也可以就坐着什么都不干。',
    '这段时间里别主动找人发消息，他们多半睡了。',
    '就算要说话，也是你自己的想法，不是把这几句提示说给别人听。',
].join('');
function hhmm(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function createOwnLife(opts) {
    const { deliver, statePath, intervalMs = 2.5 * HOUR, quiet = [3, 8], midnightAt = '23:30', maxPerDay = 6, enabled = true, textDay = DEFAULT_TEXT_DAY, textMidnight = DEFAULT_TEXT_MIDNIGHT, log = (m) => console.log('[own-life]', m), } = opts;
    if (typeof deliver !== 'function')
        throw new Error('own-life: 缺 deliver');
    const state = { lastFiredAt: 0, lastDay: '', firedToday: 0, lastMidnightDay: '' };
    if (statePath) {
        try {
            const raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
            if (raw && typeof raw === 'object')
                Object.assign(state, raw);
        }
        catch {
            /* 第一次跑，没文件是正常的 */
        }
    }
    function save() {
        if (!statePath)
            return;
        try {
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
        }
        catch (e) {
            log(`状态写不进去（忽略）: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    function inQuiet(now) {
        const h = new Date(now).getHours();
        const [from, to] = quiet;
        return from <= to ? (h >= from && h < to) : (h >= from || h < to);
    }
    function pastMidnightSlot(now) {
        const [mh, mm] = String(midnightAt).split(':').map(Number);
        const d = new Date(now);
        const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), mh ?? 23, mm ?? 30, 0, 0).getTime();
        return now >= slot;
    }
    let timer = null;
    let busy = false;
    async function fire(kind, nowTs = Date.now()) {
        if (busy)
            return { ok: false, skipped: 'busy' };
        busy = true;
        const now = Number(nowTs) || Date.now();
        const text = kind === 'midnight' ? textMidnight : textDay;
        try {
            const res = await deliver(text);
            const skip = res === false || (res && typeof res === 'object' && res.ok === false);
            if (skip) {
                // 业务跳过：非失败、不计次，但推进 lastFiredAt 使下次尝试顺延到间隔末尾
                state.lastFiredAt = now;
                state.lastDay = dayKey(now);
                save();
                const reason = res && typeof res === 'object' ? (res.reason ?? '') : '';
                log(`跳过（${kind}）${hhmm(now)} ${reason}`);
                return { ok: false, kind, at: now, skipped: 'deliver-skip' };
            }
            state.lastFiredAt = now;
            state.firedToday += 1;
            state.lastDay = dayKey(now);
            if (kind === 'midnight')
                state.lastMidnightDay = dayKey(now);
            save();
            log(`已投递（${kind}）${hhmm(now)} · 今天第 ${state.firedToday} 次`);
            return { ok: true, kind, at: now };
        }
        catch (e) {
            log(`投递失败: ${e instanceof Error ? e.message : String(e)}`);
            return { ok: false, kind, at: now, error: e instanceof Error ? e.message : String(e) };
        }
        finally {
            busy = false;
        }
    }
    async function tick(nowTs = Date.now()) {
        if (!enabled)
            return { ok: false, skipped: 'disabled' };
        if (inQuiet(nowTs))
            return { ok: false, skipped: 'quiet' };
        const today = dayKey(nowTs);
        if (state.lastDay !== today) {
            state.lastDay = today;
            state.firedToday = 0;
        }
        if (state.firedToday >= maxPerDay)
            return { ok: false, skipped: 'daily-cap' };
        if (pastMidnightSlot(nowTs) && state.lastMidnightDay !== today) {
            return fire('midnight', nowTs);
        }
        if (nowTs - Number(state.lastFiredAt || 0) >= intervalMs) {
            return fire('day', nowTs);
        }
        return { ok: false, skipped: 'not-yet' };
    }
    function start() {
        if (timer)
            return;
        timer = setInterval(() => {
            void tick().catch(() => { });
        }, 60 * 1000);
        timer.unref?.();
        log(`已武装 · 每 ${(intervalMs / HOUR).toFixed(1)}h 一次 · 安静时段 ${quiet[0]}:00–${quiet[1]}:00 · 半夜 ${midnightAt} · 每天最多 ${maxPerDay} 次`);
        // 启动后 90 秒先看一眼（别和开机时的会话创建抢）
        setTimeout(() => {
            void tick().catch(() => { });
        }, 90 * 1000).unref?.();
    }
    function stop() {
        if (timer)
            clearInterval(timer);
        timer = null;
        log('已停止');
    }
    return {
        start,
        stop,
        tick,
        fireNow: () => fire('day'),
        snapshot: () => ({ ...state, enabled, intervalMs }),
    };
}
//# sourceMappingURL=own-life.js.map