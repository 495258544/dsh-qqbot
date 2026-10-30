/**
 * 自主冲浪（M6）— 低峰时段上网搜集她感兴趣的内容
 * ─────────────────────────────────────────────────────────────
 * 分层设计（子代理实测验证）：
 *   Layer 1  Bing RSS（首选，521ms，10 条结构化结果，无反爬/无乱码）
 *            curl -sL "https://cn.bing.com/search?q=<词>&format=rss"
 *   Layer 2  ego-browser 抓正文（要深度见闻时用，冷启2.4s/热复用1.0s）
 *   Layer 3  备用 RSS 源（机核/少数派/B站番剧/知乎日报/HN）
 *
 * 关键设计：冲浪结果**只写摘要**（100字内），不把原始 HTML 塞进上下文。
 * 结果落盘到 self.json 的 findings，主上下文零消耗。
 *
 * 时段（用户确认）：凌晨 3:00–7:00
 *   - 亮屏：可随意玩
 *   - 息屏：只能走 curl / ego-browser（虚拟屏1分钟后也会黑）
 */
import { execFileSync } from 'node:child_process';
/** ego-browser 入口（vendored Linux 版，package.json 无 bin 字段） */
const EGO_BIN = '/root/.dsh/profiles/web/node_modules/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs';
/** root 下必须用的 chrome wrapper（否则 --no-sandbox 缺失会假装 DevTools 超时） */
const EGO_CHROME = '/root/.dsh/profiles/web/node_modules/dsh-ego-browser/bin/ego-chrome-wrapper.sh';
/** 去掉 XML 标签 + 实体转义 */
function stripXml(s) {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Layer 1：Bing 搜索结果 RSS。
 * 注意：中文多词查询用 HTML 接口会返回"单字释义"垃圾，但 RSS 格式不受影响。
 */
export function fetchBingRss(topic, timeoutMs = 15000) {
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(topic)}&format=rss`;
    const xml = execFileSync('curl', ['-sL', '--max-time', String(Math.floor(timeoutMs / 1000)), url], {
        encoding: 'utf8',
        timeout: timeoutMs,
    });
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const block = m[1] ?? '';
        const title = stripXml((block.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '');
        const link = stripXml((block.match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? '');
        const desc = stripXml((block.match(/<description>([\s\S]*?)<\/description>/) ?? [])[1] ?? '');
        if (title)
            items.push({ title, link, description: desc });
    }
    return items;
}
/**
 * Layer 2：用 ego-browser 抓某个 URL 的正文（返回纯文本，截断）。
 * 前置：EGO_LINUX_HEADLESS=1 + EGO_LINUX_CHROME=wrapper，否则必失败。
 */
export function fetchPageText(url, maxChars = 2000, timeoutMs = 120000) {
    const q = JSON.stringify(url);
    const script = `
await taskSpaces.useOrCreate('surf')
await page.goto(${q}, {wait:true})
await page.waitForTimeout(400)
const body = await page.evaluate('document.body.innerText.slice(0, ${Number(maxChars)})')
console.log(JSON.stringify({body}))
`;
    const out = execFileSync('node', [EGO_BIN], {
        input: script,
        env: { ...process.env, EGO_LINUX_HEADLESS: '1', EGO_LINUX_CHROME: EGO_CHROME },
        encoding: 'utf8',
        timeout: timeoutMs,
    });
    try {
        const parsed = JSON.parse(out.trim().split('\n').pop() ?? '{}');
        return (parsed.body ?? '').replace(/\s+/g, ' ').trim();
    }
    catch {
        return '';
    }
}
/** 把一段正文压缩成 ≤100 字摘要（不调模型，纯抽取式，零成本） */
function abstract(text, max = 100) {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= max)
        return clean;
    // 优先在句号/句末标点处截断，读起来更自然
    const cut = clean.slice(0, max);
    const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('.'));
    return lastStop > max * 0.6 ? cut.slice(0, lastStop + 1) : `${cut}…`;
}
/**
 * 冲浪一个话题：Bing RSS 拿结果 → 挑第 1 条抓正文 → 组合成见闻。
 * deep=true 时才跑 ego-browser（更慢但内容更实）。
 */
export function surfTopic(topic, opts = {}) {
    const maxFindings = opts.maxFindings ?? 2;
    try {
        const items = fetchBingRss(topic);
        if (items.length === 0) {
            return { topic, findings: [], layer: 'none', error: 'Bing RSS 无结果' };
        }
        const findings = items.slice(0, maxFindings).map((it) => ({
            title: it.title,
            url: it.link,
            summary: abstract(it.description || it.title),
        }));
        // 深度模式：抓第一条的正文，补一个更实的摘要
        if (opts.deep && findings.length > 0) {
            try {
                const first = findings[0];
                if (first) {
                    const text = fetchPageText(first.url);
                    if (text)
                        first.summary = abstract(text);
                }
            }
            catch {
                /* 抓正文失败不影响已有摘要 */
            }
        }
        return { topic, findings, layer: 'rss' };
    }
    catch (err) {
        return { topic, findings: [], layer: 'none', error: err instanceof Error ? err.message : String(err) };
    }
}
/** 现在是否在冲浪时段（默认凌晨 3:00–7:00） */
export function inSurfWindow(now = new Date(), from = 3, to = 7) {
    const h = now.getHours();
    return from <= to ? h >= from && h < to : h >= from || h < to;
}
/**
 * 跑一轮冲浪：按 self.json 里权重最高的兴趣逐个冲，结果写回 findings。
 * 返回这一轮收集到的内容（供上层决定要不要告知用户）。
 */
export function runSurfRound(self, opts = {}) {
    const maxTopics = opts.maxTopics ?? 2;
    const topics = self.topInterests(maxTopics).filter((i) => i.weight >= 0.3);
    if (topics.length === 0) {
        opts.log?.('surf: 没有足够权重的兴趣，这轮跳过');
        return [];
    }
    const results = [];
    for (const t of topics) {
        const r = surfTopic(t.topic, { deep: opts.deep });
        opts.log?.(`surf: 「${t.topic}」${r.layer} 拿到 ${r.findings.length} 条${r.error ? `（${r.error}）` : ''}`);
        // 写回 findings（只存摘要，不存原始正文）
        for (const f of r.findings) {
            self.addFinding(t.topic, `[${f.title}] ${f.summary}`, f.url);
        }
        results.push(r);
    }
    return results;
}
//# sourceMappingURL=surf.js.map