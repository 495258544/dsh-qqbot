/**
 * 真实链路诊断：宿主 web 搜索有没有真的接进 persona。
 *
 * 为什么需要它（不要再用假对象自证）：
 *   - 2026-11-05 这个 bug 之前"修好过"一次，用的是手写假 web 服务，
 *     结果线上跑的是 lib/，永远走 Bing RSS —— 假对象验证的全是空气。
 *   - 所以这里**按生产的组装方式来**：真实 cordis Context + 真实
 *     @deepseek-ai/dsh-web 的 WebRuntime + 真实 dsh-free-search 插件，
 *     然后**复用 bootstrap 同一条软注入代码路径**，再真发一次 query。
 *
 * 模块解析必须和生产一致：从 profile 目录（/root/.dsh/profiles/web）解析，
 * 否则拿到的是另一份 cordis/dsh-web 副本（版本都不同：仓库 4.0.1 vs 宿主 4.0.5），
 * 服务表不在同一个世界里，"接不通"就是假的失败。
 *
 * 判据（任何一条不满足都算没修好）：
 *   ① 软注入回调真的跑了（日志里出现 web-attached）
 *   ② web.search({engine:'auto'}) 返回 ≥1 条
 *   ③ 首条标题不是"手"的字典页（汉典/汉语国学/汉语查/HSK/石碇古籍）
 *
 * 用法：
 *   node scripts/probe-web-wiring.mjs ["查询词"]
 * 输出：stdout JSON + 追加行到 /root/.dsh-qqbot/debug-surf.jsonl
 */
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const PROFILE_DIR = process.env.DSH_PROFILE_DIR || '/root/.dsh/profiles/web';
const QUERY = process.argv[2] || '手冲咖啡 研磨度 C40';

/** 从 profile 目录解析，和生产同一份副本 */
const req = createRequire(`${PROFILE_DIR}/noop.js`);
const load = (name) => import(pathToFileURL(req.resolve(name)).href);

/** 字典页特征（就是这个 bug 的表征） */
const DICT_RE = /(汉典|汉语国学|汉语查|HSK|石碇古籍|新华字典|康熙字典|说文解字)/;

function dbg(event) {
  try {
    appendFileSync(
      '/root/.dsh-qqbot/debug-surf.jsonl',
      `${JSON.stringify({ t: new Date().toISOString(), src: 'probe-web-wiring', ...event })}\n`,
    );
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

/** 最小 logger（cordis 的 logger 服务）；落到 jsonl，stdout 会丢 */
function makeLogger() {
  const toDbg = (level) => (msg) => dbg({ stage: 'log', level, msg: String(msg).slice(0, 300) });
  return {
    info: toDbg('info'),
    warn: toDbg('warn'),
    error: toDbg('error'),
    debug: () => {},
    success: toDbg('info'),
    trace: () => {},
  };
}

async function main() {
  dbg({ stage: 'probe-start', query: QUERY, profile: PROFILE_DIR });

  const { Context } = await load('@deepseek-ai/cordis');
  const { WebRuntime } = await load('@deepseek-ai/dsh-web');
  const freeSearch = await load('dsh-free-search');
  dbg({ stage: 'modules-loaded', freeSearchApply: typeof freeSearch.apply });

  const app = new Context();
  // cordis 的 logger 是服务；用最小替身，省掉 console 插件
  app.provide('logger', makeLogger());

  // ① 真实 web 服务（就是 dsh 里注册 ctx.web 的那个类）
  app.plugin(WebRuntime, { searchProvider: 'ddg', fetchProvider: 'http' });

  // ② 真实 dsh-free-search（生产里挂的就是它）
  //    它自己 inject ['web']，内部还有 ctx.inject(['settings'|'tools'…])：
  //    那些服务这里没有 → 软注入回调不跑，但 provider 注册在 apply 里是同步的。
  app.plugin(
    {
      name: freeSearch.name ?? 'web-search-free',
      apply: freeSearch.apply,
      Config: freeSearch.Config,
      // 必须带上：free-search 自己就是 inject ['web'] 的插件。
      // 漏了它 apply 会抢在 WebRuntime 提供服务之前跑，ctx.web 拿不到 → apply 抛错。
      inject: freeSearch.inject ?? ['web'],
    },
    {
      provider: 'bing',
      bingMarket: 'zh-CN',
      doubaoApiKey: 'qLNrqxrnA9hHUG3umxk8XEG8PDfDXmp0',
    },
  );

  // 等 fiber 稳定（服务激活是异步的）
  await new Promise((r) => setTimeout(r, 3000));

  const web = app.get('web');
  dbg({ stage: 'got-web', type: typeof web, hasSearch: typeof web?.search === 'function' });
  if (!web || typeof web.search !== 'function') {
    console.log(JSON.stringify({ ok: false, why: 'ctx.web 不存在（free-search 没注册上）' }));
    dbg({ stage: 'fail', why: 'no-ctx-web' });
    process.exit(1);
  }

  // ③ 复刻 bootstrap 的软注入：web 就绪后回调一次，把服务交给 PersonaService
  const attached = [];
  app.inject(['web'], (scoped) => {
    const w = scoped.get('web');
    attached.push(w);
    dbg({ stage: 'web-attached', hasWeb: w !== undefined, hasSearch: typeof w?.search === 'function' });
  });
  await new Promise((r) => setTimeout(r, 500));

  // ④ 真发一次搜索 —— 就是 surf.ts 里那个调用形状（engine:'auto' 不能省）
  const started = Date.now();
  const res = await web.search({ query: QUERY, maxResults: 10, engine: 'auto' }, undefined);
  const sources = res?.sources ?? [];
  const first = sources[0] ?? {};
  const dict = DICT_RE.test(String(first.title ?? ''));
  dbg({
    stage: 'search-done',
    sources: sources.length,
    first: String(first.title ?? '').slice(0, 80),
    firstUrl: String(first.url ?? '').slice(0, 100),
    dict,
    ms: Date.now() - started,
  });

  console.log(
    JSON.stringify(
      {
        ok: attached.length > 0 && sources.length > 0 && !dict,
        softInjectRan: attached.length > 0,
        sources: sources.length,
        first: first.title,
        firstUrl: first.url,
        dictPage: dict,
        titles: sources.slice(0, 5).map((s) => s.title),
        ms: Date.now() - started,
      },
      null,
      2,
    ),
  );
  process.exit(sources.length > 0 && !dict ? 0 : 2);
}

main().catch((err) => {
  dbg({ stage: 'crash', error: String(err?.message ?? err).slice(0, 300) });
  console.log(JSON.stringify({ ok: false, why: String(err?.message ?? err).slice(0, 300) }));
  process.exit(1);
});
