/**
 * NGA 客户端测试
 * ─────────────────────────────────────────────────────────────
 * fixture 全部取自 **2026-11-08 真实回包**（curl 打 app_api 抓下来的原文，
 * 只删了用不到的字段）。理由：这个模块的整个价值就是"NGA 的回包到底长什么样"，
 * 用手写的理想 JSON 测，等于给自己发合格证 —— 这正是 §16.2 记的那个失败模式。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  NgaClient,
  NgaError,
  bbcodeToText,
  decodeGbk,
  formatNgaTime,
  loadCredentials,
  defaultNgaDir,
  parseNgaJson,
  decodeByCharset,
} from './nga.ts';
import {
  genQrSession,
  pollQrSession,
  renderQrPng,
  parseScriptVarStore,
  saveCredentials,
  clearCredentials,
  ngaStatus,
} from './nga-capture.ts';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 真实回包：版面主题列表（fid=7 艾泽拉斯议事厅，截 3 条） */
const REAL_SUBJECT_LIST = {
  code: 0,
  msg: '操作成功',
  totalPage: 107601,
  currentPage: 1,
  perPage: 35,
  forumname: '艾泽拉斯议事厅 - Hall of Azeroth',
  fid: 7,
  result: {
    data: [
      {
        tid: 40674382, fid: 7, author: 'NoirFlame', authorid: 61363705,
        subject: '[公告一则]本版面仅供讨论正式服内容.(11/7无限服相关内容更新)',
        postdate: 1719409227, lastpost: 1719409227, lastposter: 'NoirFlame', replies: 0, type: 5120,
      },
      {
        tid: 47878890, fid: 7, author: 'ChaosZT', authorid: 20805982,
        subject: '精 准 控 分',
        postdate: 1794143408, lastpost: 1794144394, lastposter: '浮的生', replies: 7, type: 8192,
      },
      {
        tid: 47878748, fid: 7, author: '卡加斯拳皇', authorid: 37608949,
        subject: '还有什么套装幻化可以有效遮掩各种族的缺点',
        postdate: 1794141746, lastpost: 1794144374, lastposter: '看乐子的人', replies: 1, type: 0,
      },
    ],
  },
};

/** 真实回包：帖子楼层（tid=47878885，含 BBCode 与嵌套 author 对象） */
const REAL_POST_LIST = {
  code: 0,
  msg: '操作成功',
  totalPage: 1,
  currentPage: 1,
  perPage: 20,
  tsubject: '',
  forum_name: '艾泽拉斯议事厅',
  result: [
    {
      pid: 0, fid: 7, tid: 47878885, lou: 0, postdate: '2026-11-08 21:09',
      subject: '',
      content: '正式服就像无情的打本机器。而无限就像一股清流，猎人打枪要子弹，宠物要喂养，很有代入感，这才是正统猎人。正式服宠物都没有，假猎人',
      author: { uid: 62850600, username: 'UID:62850600', nickname: null, member: '学徒' },
      comments: [],
    },
    {
      pid: 0, fid: 7, tid: 47878885, lou: 1, postdate: '2026-11-08 21:11',
      subject: '',
      content: '饭还是拼的香。',
      author: { uid: 41786089, username: 'UID:41786089', nickname: null, member: '学徒' },
      comments: [
        { author: '某人', content: '[b]同意[/b]' },
      ],
    },
    {
      // 这一条是真实回包里最容易崩的：author 是个**字符串**而不是对象
      pid: 0, fid: 7, tid: 47878885, lou: 2, postdate: '2026-11-08 21:12',
      subject: '',
      content: '[quote]饭还是拼的香。[/quote]一个礼拜以后你自己来回一下贴，[url=https://bbs.nga.cn/read.php?tid=1]点这里[/url][img]./mon_201708/29/-3zj1sQ2h-jgvhK3Su-u.png[/img]',
      author: '匿名用户',
      comments: [],
    },
  ],
};

describe('bbcodeToText', () => {
  it('剥掉 NGA 的表格/随机块/样式标签（真实正文里它们占大头）', () => {
    const raw = '[randomblock][table][tr][td19][align=center][img]./mon_201708/29/-3zj1sQ2h-jgvhK3Su-u.png[/img][/align][/td][/tr][/table][/randomblock]正文在这里';
    // 图片现在保留可点开的地址（不是只留 [图]）—— 她能判断要不要问"这图是什么"
    const out = bbcodeToText(raw);
    expect(out).toContain('[图: https://img.nga.cn/attachments/mon_201708/29/-3zj1sQ2h-jgvhK3Su-u.png]');
    expect(out).toContain('正文在这里');
  });

  it('链接保留「文字 (url)」，裸 url 只留一次', () => {
    expect(bbcodeToText('[url=https://bbs.nga.cn/x]点这里[/url]')).toBe('点这里 (https://bbs.nga.cn/x)');
    expect(bbcodeToText('[url]https://bbs.nga.cn/y[/url]')).toBe('https://bbs.nga.cn/y');
  });

  it('引用保留成 > 前缀（谁在回谁是关键线索）', () => {
    expect(bbcodeToText('[quote]饭还是拼的香。[/quote]那当然')).toBe('> 饭还是拼的香。\n那当然');
  });

  it('表情丢掉、图片保留可点地址', () => {
    const out = bbcodeToText('好[s:aj]的[img]./mon/a.png[/img]');
    expect(out).toBe('好的[图: https://img.nga.cn/attachments/mon/a.png]');
  });

  it('残留开标签（[td19] [size=120%]）也能剥干净', () => {
    expect(bbcodeToText('[size=120%][color=royalblue]字[/color][/size][td19][b]加粗[/b]')).toBe('字加粗');
  });

  it('连续空行压成一个，行尾空格去掉', () => {
    expect(bbcodeToText('a   \n\n\n\n b')).toBe('a\n\nb');
  });

  it('空输入不炸', () => {
    expect(bbcodeToText('')).toBe('');
    expect(bbcodeToText(undefined as unknown as string)).toBe('');
  });
});

describe('decodeGbk', () => {
  it('解 GBK 中文（NGA 页面全是 GBK，按 UTF-8 解会乱码）', () => {
    // "艾泽拉斯" 的 GBK 字节
    // "艾泽拉斯" 的 GBK 字节（Python: '艾泽拉斯'.encode('gbk')）
    const bytes = new Uint8Array([0xb0, 0xac, 0xd4, 0xf3, 0xc0, 0xad, 0xcb, 0xb9]);
    expect(decodeGbk(bytes.buffer)).toBe('艾泽拉斯');
  });
});

describe('formatNgaTime', () => {
  it('unix 秒按北京时间显示 MM-DD HH:mm（不依赖容器 TZ）', () => {
    // 1794143408 → 2026-11-08 21:10 北京时间
    expect(formatNgaTime(1794143408)).toBe('11-08 21:10');
  });

  it('0 或缺失返回空串', () => {
    expect(formatNgaTime(0)).toBe('');
    expect(formatNgaTime(undefined as unknown as number)).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────
// 客户端
// ────────────────────────────────────────────────────────────────

/** 造一个假 fetch：按 path 分派，记录调用 */
function makeFetch(routes: Record<string, unknown>, opts: { guestToken?: string } = {}) {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method, headers, body: String(init?.body ?? '') });

    const guestMatch = url.match(/guest_token=([^&]*)/);
    const hasGuest = Boolean(guestMatch);
    const token = guestMatch?.[1];

    // 没带 guest_token 且配了"要求 token" → 先回 46 给 token
    if (opts.guestToken && !hasGuest && /app_api\.php/.test(url)) {
      return jsonResponse({ code: 46, msg: '游客不能直接访问', result: [], guest_token: opts.guestToken });
    }
    // 带了**错的** token 也回 46（真实服务端行为）
    if (opts.guestToken && hasGuest && token !== opts.guestToken) {
      return jsonResponse({ code: 46, msg: '游客不能直接访问', result: [], guest_token: opts.guestToken });
    }

    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return jsonResponse({ code: 404, msg: 'not mocked' }, 404);
    return jsonResponse(routes[key]);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeClient(fetchImpl: typeof fetch, extra: ConstructorParameters<typeof NgaClient>[0] = {}) {
  return new NgaClient({ fetchImpl, sleep: async () => {}, now: () => 0, ...extra });
}

describe('NgaClient · 游客 token 自动获取', () => {
  it('第一次被 46 挡 → 自动带 guest_token 重打（不带任何 cookie 也能成）', async () => {
    const { impl, calls } = makeFetch(
      { 'app_api.php?__lib=subject': REAL_SUBJECT_LIST },
      { guestToken: 'guest06af078522768a' },
    );
    const client = makeClient(impl);
    const list = await client.listTopics(7, 1);

    expect(list.topics).toHaveLength(3);
    expect(list.forumName).toBe('艾泽拉斯议事厅 - Hall of Azeroth');
    expect(list.totalPage).toBe(107601);
    // 第一次没 token，第二次带上了
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).not.toContain('guest_token');
    expect(calls[1]!.url).toContain('guest_token=guest06af078522768a');
  });

  it('**必须**带 X-User-Agent —— 不带的话真实服务端直接 code=46', async () => {
    const { impl, calls } = makeFetch({ 'app_api.php': REAL_POST_LIST });
    const client = makeClient(impl);
    await client.readThread(47878885, 1);
    expect(calls[0]!.headers?.['X-User-Agent']).toBe('NGA_skull/7.3.1(iPhone17,1;iOS17.0)');
    expect(calls[0]!.headers?.['User-Agent']).toContain('Chrome');
  });

  it('回包连错两次都 46 → 抛 guest-denied，不是静默返回空', async () => {
    const { impl } = makeFetch({ 'app_api.php': { code: 46, msg: '游客不能直接访问', result: [] } });
    const client = makeClient(impl);
    await expect(client.listTopics(7)).rejects.toBeInstanceOf(NgaError);
  });
});

describe('NgaClient · readThread', () => {
  it('真实回包：嵌套 author 对象与字符串 author 都要正确取名字', async () => {
    const { impl } = makeFetch({ 'app_api.php': REAL_POST_LIST });
    const client = makeClient(impl);
    const thread = await client.readThread(47878885, 1);

    expect(thread.floors).toHaveLength(3);
    // 对象形态：username 是 'UID:62850600'
    expect(thread.floors[0]!.author).toBe('UID:62850600');
    // 字符串形态（真实回包里确实有）
    expect(thread.floors[2]!.author).toBe('匿名用户');
    expect(thread.forumName).toBe('艾泽拉斯议事厅');
  });

  it('正文里的 BBCode 被转成纯文本', async () => {
    const { impl } = makeFetch({ 'app_api.php': REAL_POST_LIST });
    const client = makeClient(impl);
    const thread = await client.readThread(47878885, 1);
    const last = thread.floors[2]!;
    expect(last.content).toContain('> 饭还是拼的香。');
    expect(last.content).toContain('点这里 (https://bbs.nga.cn/read.php?tid=1)');
    expect(last.content).not.toContain('[img]');
    expect(last.content).toContain('[图:');   // 保留可点开的地址
  });

  it('maxFloors 截断生效（防一次把 50 楼全塞进上下文）', async () => {
    const { impl } = makeFetch({ 'app_api.php': REAL_POST_LIST });
    const client = makeClient(impl);
    const thread = await client.readThread(47878885, 1, 2);
    expect(thread.floors).toHaveLength(2);
  });

  it('楼中楼只留 3 条', async () => {
    const many = { ...REAL_POST_LIST, result: [{ ...REAL_POST_LIST.result[1]!, comments: Array.from({ length: 8 }, (_, i) => ({ author: `a${i}`, content: `c${i}` })) }] };
    const { impl } = makeFetch({ 'app_api.php': many });
    const client = makeClient(impl);
    const thread = await client.readThread(47878885, 1);
    expect(thread.floors[0]!.comments).toHaveLength(3);
  });
});

describe('NgaClient · 错误分类', () => {
  it('HTTP 500 → server', async () => {
    const impl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const client = makeClient(impl);
    await expect(client.readThread(1)).rejects.toMatchObject({ kind: 'server' });
  });

  it('回包不是 JSON → bad-response（而不是 TypeError 冒到上层）', async () => {
    const impl = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    const client = makeClient(impl);
    await expect(client.readThread(1)).rejects.toMatchObject({ kind: 'bad-response' });
  });

  it('code=56 → not-found（版面不存在/无权限）', async () => {
    const { impl } = makeFetch({ 'app_api.php': { code: 56, msg: '无权限', result: [] } });
    const client = makeClient(impl);
    await expect(client.listTopics(178)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('超时 → timeout（fetch 抛 AbortError）', async () => {
    const impl = (async () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }) as unknown as typeof fetch;
    const client = makeClient(impl);
    await expect(client.readThread(1)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('非法参数在发请求前就挡掉', async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    const client = makeClient(impl);
    await expect(client.readThread(-1)).rejects.toMatchObject({ kind: 'bad-request' });
    await expect(client.listTopics(0)).rejects.toMatchObject({ kind: 'bad-request' });
    expect(impl).not.toHaveBeenCalled();
  });
});

describe('NgaClient · 登录态与限速', () => {
  it('有凭证时带上 Cookie 头', async () => {
    const { impl, calls } = makeFetch({ 'app_api.php': REAL_POST_LIST });
    const client = makeClient(impl, { credentials: { uid: '12345678', cid: 'abcdef' } });
    await client.readThread(47878885, 1);
    expect(calls[0]!.headers?.Cookie).toBe('ngaPassportUid=12345678; ngaPassportCid=abcdef');
    expect(client.authenticated).toBe(true);
  });

  it('无凭证 = 游客态，authenticated 为 false 且不带 Cookie', async () => {
    const { impl, calls } = makeFetch({ 'app_api.php': REAL_POST_LIST });
    const client = makeClient(impl);
    await client.readThread(47878885, 1);
    expect(client.authenticated).toBe(false);
    expect(calls[0]!.headers?.Cookie).toBeUndefined();
  });

  it('串行化 + 最小间隔：并发两请求不会同时打出', async () => {
    let clock = 0;
    const started: number[] = [];
    const { impl } = makeFetch({ 'app_api.php': REAL_POST_LIST });
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      started.push(clock);
      clock += 100;
      return (impl as unknown as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
    }) as unknown as typeof fetch;
    const client = new NgaClient({
      fetchImpl: wrapped,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      minIntervalMs: 330,
    });
    await Promise.all([client.readThread(1), client.readThread(2)]);
    // 第二个请求的起点必须比第一个晚至少 330ms
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(330);
  });
});

// ────────────────────────────────────────────────────────────────
// 凭证
// ────────────────────────────────────────────────────────────────

describe('凭证文件', () => {
  it('不存在 → undefined（游客态，不算错误）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nga-cred-'));
    try {
      expect(loadCredentials(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('存了再读，形状对得上', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nga-cred-'));
    try {
      saveCredentials({ uid: '12345678', cid: 'abcdefg' }, dir);
      const got = loadCredentials(dir);
      expect(got).toEqual({ uid: '12345678', cid: 'abcdefg' });
      // 只写这两个字段（不写整串 cookie）
      const raw = JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')) as Record<string, unknown>;
      expect(Object.keys(raw).sort()).toEqual(['cid', 'savedAt', 'uid']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件损坏 → undefined（不抛，回到游客态照常能用）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nga-cred-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'credentials.json'), '{坏的', 'utf8');
      expect(loadCredentials(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缺 cid 的凭证不认（半个凭证等于没有）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nga-cred-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ uid: '12345678' }), 'utf8');
      expect(loadCredentials(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clear 删掉文件；不存在的删不报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nga-cred-'));
    try {
      saveCredentials({ uid: '1', cid: '2' }, dir);
      expect(clearCredentials(dir)).toBe(true);
      expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
      expect(clearCredentials(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ngaStatus 报出路径与登录态（游客态 authenticated=false）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nga-cred-'));
    try {
      const s = ngaStatus(dir);
      expect(s.authenticated).toBe(false);
      expect(s.path).toContain('credentials.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});





// ────────────────────────────────────────────────────────────────
// NGA 搜索（参数名对齐官方客户端 TopicListModel.getUrl）
// ────────────────────────────────────────────────────────────────

/** 真实回包：thread.php?key=结算&content=1&lite=js（截 2 条，GBK 解码后） */
const REAL_SEARCH = {
  data: {
    __T: {
      0: {
        tid: 47879910, fid: 818, author: '于绯华盛放时', authorid: 63921333,
        subject: '书接上回 珍珠卡池关闭前浅谈一下绯英最终配队各种问题以及绯爻真虚的加金顺序',
        type: 8192, postdate: 1794155508, lastpost: 1794161109, replies: 15,
      },
      1: {
        tid: 47879720, fid: 853, author: 'eleven2020', authorid: 62150958,
        subject: '[搜打撤氵]下版本要加入竞拍之王玩法了',
        type: 0, postdate: 1794152990, lastpost: 1794158252, replies: 3,
      },
    },
    __T__ROWS: 34,
    __ROWS: 110046,
  },
};

describe('NgaClient.searchTopics', () => {
  it('全站搜索：不传 fid → scope=site，解析 __T 字典', async () => {
    // lite=js 回的是"赋值给 JS 变量"的包装 + GBK，这里用 getText 路径模拟
    const { impl, calls } = makeTextFetch(JSON.stringify(REAL_SEARCH));
    const client = makeClient(impl);
    const r = await client.searchTopics('结算', {});

    expect(r.scope).toEqual({ kind: 'site' });
    expect(r.topics).toHaveLength(2);
    expect(r.topics[0]!.tid).toBe(47879910);
    expect(r.topics[0]!.replies).toBe(15);
    // 34 条 / 每页 35 → 1 页
    expect(r.totalPage).toBe(1);
    // 关键：参数名必须是 key，且带 content=1 与 lite=js
    expect(calls[0]!.url).toContain('key=');
    expect(calls[0]!.url).not.toContain('q=');
    expect(calls[0]!.url).toContain('content=1');
    expect(calls[0]!.url).toContain('lite=js');
    expect(calls[0]!.url).not.toContain('fid=');
  });

  it('版面搜索：传 fid → scope=forum 且 URL 带 fid', async () => {
    const { impl, calls } = makeTextFetch(JSON.stringify(REAL_SEARCH));
    const client = makeClient(impl);
    const r = await client.searchTopics('手机', { fid: 436 });
    expect(r.scope).toEqual({ kind: 'forum', fid: 436 });
    expect(calls[0]!.url).toContain('fid=436');
  });

  it('只搜标题：withContent=false 时不带 content=1', async () => {
    const { impl, calls } = makeTextFetch(JSON.stringify(REAL_SEARCH));
    const client = makeClient(impl);
    await client.searchTopics('结算', { withContent: false });
    expect(calls[0]!.url).not.toContain('content=1');
  });

  it('搜回复：searchPost=true 带 searchpost=1', async () => {
    const { impl, calls } = makeTextFetch(JSON.stringify(REAL_SEARCH));
    const client = makeClient(impl);
    await client.searchTopics('某某', { searchPost: true });
    expect(calls[0]!.url).toContain('searchpost=1');
  });

  it('空关键词在发请求前就被挡掉', async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    const client = makeClient(impl);
    await expect(client.searchTopics('   ')).rejects.toMatchObject({ kind: 'bad-request' });
    expect(impl).not.toHaveBeenCalled();
  });

  it('回包不是 JSON → bad-response（而不是 TypeError 冒到上层）', async () => {
    const { impl } = makeTextFetch('<html>不是 json</html>');
    const client = makeClient(impl);
    await expect(client.searchTopics('x')).rejects.toMatchObject({ kind: 'bad-response' });
  });
});

/** 造一个返回**文本**的假 fetch（search 走 getText 路径，不是 post/JSON 路径） */
function makeTextFetch(text: string) {
  const calls: Array<{ url: string; method?: string }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    // search 走 GET + GBK 文本；用 gb18030 编码器保证 decodeGbk 能解回中文
    return new Response(new TextEncoder().encode(text), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// ────────────────────────────────────────────────────────────────
// NGA 扫码登录（纯 HTTP，不依赖浏览器）
// ────────────────────────────────────────────────────────────────

/** 真实回包：qrlogin_gen */
const REAL_GEN = 'window.script_muti_get_var_store={"data":{"0":"d9dab3ee03f1e3f03662ecf37dcf81fb,6afa38fae3526dd80c60f238adbc1af5"},"time":1794160605}';
/** 真实回包：还没扫码 */
const REAL_PENDING = 'window.script_muti_get_var_store={"error":{"0":"未找到登录许可"},"time":1794160627}';
/** 真实回包：扫了并确认 */
const REAL_SUCCESS = 'window.script_muti_get_var_store={"data":{"0":"登录成功","1":60023764,"2":"X8n28rq67o1v1rnl7pln1i517kghiv4mivqmtcnr","3":{"uid":60023764,"username":"Matthew.J","avatar":"","token":"X8n28rq67o1v1rnl7pln1i517kghiv4mivqmtcnr","bound_mobile":1,"login_type":3}},"time":1794160703}';

describe('parseScriptVarStore', () => {
  it('从 window.script_muti_get_var_store=... 抠出 JSON', () => {
    const v = parseScriptVarStore(REAL_GEN) as { data: { '0': string } };
    expect(v.data['0']).toContain(',');
  });
  it('纯 JSON 也能解（有些端点不包装）', () => {
    expect(parseScriptVarStore('{"a":1}')).toEqual({ a: 1 });
  });
  it('解析失败要抛，不要静默返回空对象', () => {
    expect(() => parseScriptVarStore('<html>')).toThrow();
  });
});

describe('genQrSession', () => {
  it('解析出 qrkey/hiddenkey 并拼出正确的二维码内容', async () => {
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(new TextEncoder().encode(REAL_GEN), { status: 200 });
    }) as unknown as typeof fetch;

    const s = await genQrSession({ fetchImpl: impl, now: () => 123 });
    expect(s.qrkey).toBe('d9dab3ee03f1e3f03662ecf37dcf81fb');
    expect(s.hiddenkey).toBe('6afa38fae3526dd80c60f238adbc1af5');
    expect(s.issuedAt).toBe(123);
    // 二维码内容必须是 NGA 自己的回调地址（与它的 JS 一字不差）
    expect(s.content).toBe(
      'https://bbs.nga.cn/nuke.php?__lib=login&__act=qrlogin_ui&qrkey=d9dab3ee03f1e3f03662ecf37dcf81fb',
    );
    // 申请时必须带 app_id=5004（缺了服务端不给 data）
    expect(calls[0]).toContain('__act=qrlogin_gen');
    expect(calls[0]).toContain('app_id=5004');
  });

  it('回包没有 qrkey → 抛错并带上原始回包，便于排查', async () => {
    const impl = (async () => new Response(new TextEncoder().encode('{"data":{}}'), { status: 200 })) as unknown as typeof fetch;
    await expect(genQrSession({ fetchImpl: impl })).rejects.toThrow(/qrkey/);
  });
});

describe('pollQrSession', () => {
  const session = { qrkey: 'k1', hiddenkey: 'h1', content: 'c', issuedAt: 0 };

  it('还没扫 → pending（这是"再等等"，不是错误）', async () => {
    const impl = (async () => new Response(new TextEncoder().encode(REAL_PENDING), { status: 200 })) as unknown as typeof fetch;
    const r = await pollQrSession(session, { fetchImpl: impl });
    expect(r.status).toBe('pending');
    expect(r.message).toContain('还没扫');
  });

  it('扫了并确认 → success，且取出 uid/token/username', async () => {
    const impl = (async () => new Response(new TextEncoder().encode(REAL_SUCCESS), { status: 200 })) as unknown as typeof fetch;
    const r = await pollQrSession(session, { fetchImpl: impl });
    expect(r.status).toBe('success');
    expect(r.credentials).toEqual({ uid: '60023764', cid: 'X8n28rq67o1v1rnl7pln1i517kghiv4mivqmtcnr' });
    expect(r.username).toBe('Matthew.J');
  });

  it('其它错误（key 过期）→ expired，不能当 pending 一直轮询', async () => {
    const impl = (async () => new Response(new TextEncoder().encode('{"error":{"0":"登录许可已失效"}}'), { status: 200 })) as unknown as typeof fetch;
    const r = await pollQrSession(session, { fetchImpl: impl });
    expect(r.status).toBe('expired');
  });

  it('成功回包里缺 uid/token → 仍是 pending（半个凭证不能用）', async () => {
    const impl = (async () => new Response(new TextEncoder().encode('{"data":{"0":"登录成功","3":{}}}'), { status: 200 })) as unknown as typeof fetch;
    const r = await pollQrSession(session, { fetchImpl: impl });
    expect(r.status).toBe('pending');
  });
});

describe('renderQrPng', () => {
  it('渲染出 data:image/png;base64 的 data URL', async () => {
    const url = await renderQrPng('https://example.com/x', 200);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(url.length).toBeGreaterThan(1000);
  });
});

describe('decodeGbk 编码嗅探（踩过：UTF-8 回包被当 GBK 解 → 静默误判）', () => {
  it('真正的 GBK 字节按 GBK 解', () => {
    // "艾泽拉斯" 的 GBK 字节
    const gbk = new Uint8Array([0xb0, 0xac, 0xd4, 0xf3, 0xc0, 0xad, 0xcb, 0xb9]);
    expect(decodeGbk(gbk.buffer)).toBe('艾泽拉斯');
  });

  it('UTF-8 字节也能正确解（不会被硬当 GBK 解成乱码）', () => {
    // 这是真实踩到的坑：测试替身用 TextEncoder 编 UTF-8，
    // 而 decodeGbk 硬解 GBK，中文变"鏈壘鍒扮櫥褰曡鍙"→ 文案匹配失败 → 误判过期
    const utf8 = new TextEncoder().encode('{"error":{"0":"未找到登录许可"}}');
    expect(decodeGbk(utf8)).toContain('未找到登录许可');
  });

  it('纯 ASCII 不解错', () => {
    expect(decodeGbk(new TextEncoder().encode('{"a":1}')).trim()).toBe('{"a":1}');
  });
});

// ────────────────────────────────────────────────────────────────
// 负数 fid（她第一次调 list 踩到的两个真实 bug）
// ────────────────────────────────────────────────────────────────

describe('fid 允许负数（NGA 大量版面 fid 是负的）', () => {
  it('负数 fid 能正常列版面（曾错误复用 assertPositiveInt 全被拒）', async () => {
    // 实测：厨艺美食 -608808、小窗视界 -8725919、程序员版 -202020 都是负的。
    // 我最初图省事复用了 tid 的 assertPositiveInt，这些版一个都打不开，
    // 报"fid 必须是正整数"—— 拿 tid 的规则套 fid，是类型搞错了。
    const { impl } = makeFetch({ 'app_api.php': REAL_SUBJECT_LIST });
    const client = makeClient(impl);
    const r = await client.listTopics(-608808, 1);
    expect(r.topics.length).toBeGreaterThan(0);
  });

  it('搜索也接受负数 fid（版面内搜）', async () => {
    const { impl } = makeTextFetch(JSON.stringify(REAL_SEARCH));
    const client = makeClient(impl);
    const r = await client.searchTopics('红烧', { fid: -608808 });
    expect(r.scope).toEqual({ kind: 'forum', fid: -608808 });
  });

  it('fid=0 仍然拒绝（0 表示没指定版面）', async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    const client = makeClient(impl);
    await expect(client.listTopics(0)).rejects.toMatchObject({ kind: 'bad-request' });
    expect(impl).not.toHaveBeenCalled();
  });

  it('tid 仍然必须是正整数（帖子 id 没有负数）', async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    const client = makeClient(impl);
    await expect(client.readThread(-1)).rejects.toMatchObject({ kind: 'bad-request' });
  });
});

describe('parseNgaJson 容错（抄自 dsh-nga-sidebar 的踩坑文档 2.2）', () => {
  it('正常 JSON 直接过（零成本路径）', () => {
    expect(parseNgaJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('正文里含字面制表符也能解析', () => {
    // 别人实测：alterinfo 字段含原始 \t → JSON.parse 报错。
    // 我们这两条路径现在没触发，但它是"某些帖子才触发"的随机性，先手做掉。
    const withTab = '{"content":"a\tb"}';
    expect(() => JSON.parse(withTab)).toThrow();
    expect(parseNgaJson(withTab)).toEqual({ content: 'a\uE009b' });
  });

  it('真的坏 JSON 仍然抛错（不静默吞掉）', () => {
    expect(() => parseNgaJson('<html>')).toThrow();
  });
});

describe('decodeByCharset（不同接口 charset 不统一，别猜）', () => {
  it('UTF-8 接口按 UTF-8 解（app_api.php）', () => {
    const buf = new TextEncoder().encode('{"subject":"艾泽拉斯"}');
    expect(decodeByCharset(buf.buffer, 'text/json; charset=UTF-8')).toContain('艾泽拉斯');
  });

  it('GBK 接口按 GBK 解（nuke.php）', () => {
    // "艾泽拉斯" 的 GBK 字节
    const gbk = new Uint8Array([0xb0, 0xac, 0xd4, 0xf3, 0xc0, 0xad, 0xcb, 0xb9]);
    expect(decodeByCharset(gbk.buffer, 'text/javascript; charset=GBK')).toBe('艾泽拉斯');
  });

  it('gb2312 也当 gb18030 解（超集）', () => {
    const gbk = new Uint8Array([0xb0, 0xac, 0xd4, 0xf3]);
    expect(decodeByCharset(gbk.buffer, 'charset=gb2312')).toBe('艾泽');
  });

  it('没有 charset → 退回嗅觉解码（别崩）', () => {
    const gbk = new Uint8Array([0xb0, 0xac, 0xd4, 0xf3]);
    expect(decodeByCharset(gbk.buffer, null)).toBe('艾泽');
  });

  it('**关键**：UTF-8 接口不能再被硬当 GBK 解（这就是之前误判"二维码过期"的根因）', () => {
    const buf = new TextEncoder().encode('{"error":"未找到登录许可"}');
    expect(decodeByCharset(buf.buffer, 'text/plain; charset=UTF-8')).toContain('未找到登录许可');
  });
});

describe('服务端 charset 会**说谎**（thread.php?lite=js 实测）', () => {
  /** "想想也真是" 的 GBK 字节（真实搜索回包里的中文） */
  const GBK_BYTES = new Uint8Array([0xcf, 0xeb, 0xcf, 0xeb, 0xd2, 0xb2, 0xd5, 0xe6, 0xca, 0xc7]);

  it('header 说是 UTF-8 但内容是 GBK → 必须按 GBK 解出来', () => {
    // 实测：thread.php?lite=js 回 content-type: text/html; charset=UTF-8，
    // 但字节解出来全是 乱码。盲信 header 就会得到 "����Ҳ������"。
    const got = decodeByCharset(GBK_BYTES.buffer, 'text/html; charset=UTF-8');
    expect(got).toBe('想想也真是');   // 「想想也真是」的 GBK 字节，解出来不该有替换符
    expect(got).not.toContain('\uFFFD');
  });

  it('header 说是 GBK 且内容真是 GBK → 正常解', () => {
    expect(decodeByCharset(GBK_BYTES.buffer, 'text/javascript; charset=GBK')).not.toContain('\uFFFD');
  });

  it('header 说是 UTF-8 且内容真是 UTF-8 → 正常解（别反过来把对的解坏）', () => {
    const buf = new TextEncoder().encode('{"subject":"艾泽拉斯"}');
    expect(decodeByCharset(buf.buffer, 'text/json; charset=UTF-8')).toContain('艾泽拉斯');
  });

  it('没有 header → 两个都试，取干净的那个', () => {
    expect(decodeByCharset(GBK_BYTES.buffer, null)).toBe('想想也真是');
  });
});

// ────────────────────────────────────────────────────────────────
// NGA 方言补强（对照 dsh-nga-fish 的 bbcode.js + 实测 101 层楼）
// ────────────────────────────────────────────────────────────────

describe('引用块的真实格式（实测 31 次，比想象中脏）', () => {
  const REAL_QUOTE =
    '[quote][pid=887251660,47873940,1]Reply[/pid] <b>Post by [uid=5528287]大部分网友[/uid] '
    + '(2026-11-08 10:23):</b><br/><br/>你醒了？现在都有大肥鱼皮套直播了。[/quote]'
    + '大肥鱼直播我也是最近突然刷到很多';

  it('抠出作者与时间，去掉 Reply/Post by 英文噪音', () => {
    const out = bbcodeToText(REAL_QUOTE, 'https://img.nga.cn/attachments/');
    expect(out).toContain('大部分网友');
    expect(out).toContain('2026-11-08 10:23');
    expect(out).toContain('你醒了？');
    // 这些是剥标签后的残留噪音，必须清掉
    expect(out).not.toContain('Reply');
    expect(out).not.toContain('Post by');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('pid=');
  });

  it('引用后必须换行（不然和被引正文粘成一句，语义会错）', () => {
    const out = bbcodeToText(REAL_QUOTE);
    const lines = out.split('\n');
    expect(lines[0]!.startsWith('> ')).toBe(true);
    expect(lines[1]).toContain('大肥鱼直播');
  });

  it('纯 [quote]文字[/quote] 也能处理', () => {
    expect(bbcodeToText('[quote]饭还是拼的香。[/quote]那当然')).toBe('> 饭还是拼的香。\n那当然');
  });
});

describe('其它方言', () => {
  it('字面 \\u0026 转义要还原（否则链接是坏的）', () => {
    expect(bbcodeToText('[url=https://a.com/x?a=1\\u0026b=2]点这里[/url]')).toContain('&b=2');
  });

  it('骰子保留结果（[dice]）', () => {
    expect(bbcodeToText('[dice]d100=63[/dice]')).toContain('骰子');
    expect(bbcodeToText('[dice]d100=63[/dice]')).toContain('63');
  });

  it('折叠块保留内容（干货常在折叠里）', () => {
    const out = bbcodeToText('[collapse]展开后的正文[/collapse]');
    expect(out).toContain('折叠');
    expect(out).toContain('展开后的正文');
  });

  it('medium.jpg 缩略图后缀去掉', () => {
    const out = bbcodeToText('[img]https://img.nga.cn/a.jpg.medium.jpg[/img]');
    expect(out).toContain('a.jpg');
    expect(out).not.toContain('medium.jpg');
  });
});

describe('图片 URL 补全（坑 3.4）', () => {
  it('相对路径用服务端给的 attachPrefix', () => {
    expect(bbcodeToText('[img]./mon_2017/x.jpg[/img]', 'https://img.nga.cn/attachments/'))
      .toContain('https://img.nga.cn/attachments/mon_2017/x.jpg');
  });

  it('已给前缀时补成完整 URL（实测 NGA 有时直接给全 URL）', () => {
    const out = bbcodeToText('[img]./mon/x.jpg[/img]');
    expect(out).toContain('https://img.nga.cn/attachments/mon/x.jpg');
  });

  it('绝对 URL 原样保留', () => {
    expect(bbcodeToText('[img]https://x.com/a.jpg[/img]')).toContain('https://x.com/a.jpg');
  });

  it('空图片退回 [图]', () => {
    expect(bbcodeToText('[img][/img]')).toBe('[图]');
  });
});

describe('搜索结果过滤占位帖（NGA 实测坑）', () => {
  it('「帖子发布或回复时间超过限制」这类占位条目要滤掉', async () => {
    // 实测搜「手冲咖啡」：29 条里大半是这个占位标题，点进去打不开。
    // 不滤掉的话她看到的搜索结果一半是废条目 —— 比"没搜到"更糟。
    const withPlaceholder = JSON.stringify({
      data: {
        __T: {
          0: { tid: 1, subject: '帖子发布或回复时间超过限制', author: 'a', replies: 0 },
          1: { tid: 2, subject: '真正的手冲咖啡讨论', author: 'b', replies: 12 },
          2: { tid: 3, subject: '帖子已被删除', author: '', replies: 0 },
          3: { tid: 4, subject: '   ', author: 'c', replies: 1 },
        },
        __T__ROWS: 4,
      },
    });
    const { impl } = makeTextFetch(withPlaceholder);
    const client = makeClient(impl);
    const r = await client.searchTopics('手冲咖啡', {});
    expect(r.topics).toHaveLength(1);
    expect(r.topics[0]!.subject).toBe('真正的手冲咖啡讨论');
  });
});
