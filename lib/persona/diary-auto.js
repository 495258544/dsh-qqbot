/**
 * 日记硬触发（M23）
 * ─────────────────────────────────────────────────────────────
 * 真实失效（2026-11-01 实测）：
 *   diary/ 目录 **0 个文件** —— 她跑了两个多月，一次日记都没写过。
 *
 * 根因（小黑盒那篇文章的说法完全对上我们的实测）：
 *   **指望模型自觉调 qq_write_diary ≈ 不写。** 群聊场景实测 0 次。
 *   因为闲聊时模型永远优先"接话"，不会优先"记账"。
 *
 * 修法：系统硬触发 —— 当天聊过就写一条，不问她要不要写。
 *
 * 关键取舍：**不编造**。
 * 日记内容只从当天真实对话里取材（turns.jsonl），不看没有的事。
 * 宁可写得平淡，也不要写"我今天学到了很多"这种废话，或写没发生过的事。
 */
import fs from 'node:fs';
/** 从当天对话里提炼可写进日记的素材 */
/** 判断是不是裸 openid（QQ 的 openid 是 32 位十六进制） */
function looksLikeOpenid(v) {
    return /^[A-Fa-f0-9]{20,}$/.test(v);
}
export function pickDiaryMaterial(turns) {
    const people = new Set();
    const topics = new Set();
    const TOPIC_HINT = /(游戏|新番|动画|电影|音乐|咖啡|奶茶|读书|小说|考研|上班|加班|学校|公司|旅行|出差|健身|跑步|猫|狗|吃饭|睡觉|下雨|天气|演唱会|比赛)/;
    for (const t of turns) {
        // 日记里不能出现裸 openid（她不可能管人叫 2DA749E82EB6...）：
        // who 有时是 openid（QQ 没给昵称时回落而来），这种就不往日记里放
        if (t.who && !looksLikeOpenid(t.who))
            people.add(t.who);
        const hit = `${t.text} ${t.reply}`.match(TOPIC_HINT);
        if (hit?.[0])
            topics.add(hit[0]);
    }
    return { people: [...people], topics: [...topics], lineCount: turns.length };
}
/**
 * 生成一条**朴素、基于事实**的日记正文。
 *
 * 不调用 LLM：额外调用有成本，且容易写出空话。
 * 只把"今天跟谁聊了、聊到什么"如实说出来 —— 这已经像真人了。
 */
export function composeDiaryText(m) {
    const { people, topics, lineCount } = m;
    if (lineCount === 0)
        return '';
    const parts = [];
    if (people.length > 0) {
        const who = people.slice(0, 3).join('、');
        parts.push(`今天跟${who}聊了几句。`);
    }
    else {
        // 只知道 openid、不知道昵称时，用泛称，不要糊一串 id 上去
        parts.push('今天跟人聊了几句。');
    }
    if (topics.length > 0) {
        const tt = topics.slice(0, 3).join('、');
        parts.push(`说到${tt}。`);
    }
    if (lineCount >= 20) {
        parts.push('话有点多，脑子有点满。');
    }
    else if (lineCount <= 3) {
        parts.push('没聊多少，安静的一天。');
    }
    return parts.join('') || '';
}
/** 读某天（本地时区）的 turns */
export function readTurnsOfDay(turnsFile, day) {
    if (!fs.existsSync(turnsFile))
        return [];
    const out = [];
    // 按日期前缀粗筛：t 是毫秒时间戳，这里用时间范围比较
    const [y, m, d] = day.split('-').map(Number);
    const start = new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
    const end = start + 24 * 3600_000;
    try {
        const lines = fs.readFileSync(turnsFile, 'utf8').split('\n');
        for (const line of lines) {
            if (!line.trim())
                continue;
            try {
                const rec = JSON.parse(line);
                if (typeof rec.t === 'number' && rec.t >= start && rec.t < end)
                    out.push(rec);
            }
            catch {
                /* 坏行跳过 */
            }
        }
    }
    catch {
        /* 读不了就当空 */
    }
    return out;
}
/**
 * 是否该写日记：当天有对话，且当天还没写过。
 * @param alreadyWrittenToday 由调用方从 diary 目录判断
 */
export function shouldWriteDiary(lineCount, alreadyWrittenToday) {
    return lineCount > 0 && !alreadyWrittenToday;
}
//# sourceMappingURL=diary-auto.js.map