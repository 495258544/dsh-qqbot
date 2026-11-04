/**
 * 客户端测试：信封解析 / 限流语义 / 节流窗口 / 正文与评论提取
 *
 * 这里的 fetch 是替身，但**响应形状逐字来自线上真实抓包**，
 * 包括那些坑：status 放在 body 里、HTTP 永远 200、show_captcha 不带 msg。
 */
import { describe, expect, it, vi } from 'vitest';
import { XhhClient, XhhError } from './client.ts';
import type { Logger } from '../types.ts';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as unknown as Logger;

/** 造一个只在测试里用的 fetch 替身：按 URL 路径返回预设 body */
function stubFetch(bodies: Record<string, unknown>, opts: { onCall?: () => void } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    opts.onCall?.();
    for (const [key, body] of Object.entries(bodies)) {
      if (url.includes(key)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ status: 'ok', result: {} }), { status: 200 });
  }) as unknown as typeof fetch;
}

/** 线上真实搜索信封（截取 2 条 link + 1 条噪声） */
const SEARCH_BODY = {
  status: 'ok',
  msg: '',
  result: {
    items: [
      {
        type: 'link',
        info: {
          linkid: 195308152,
          title: '原来影之刃零的零是<em>0</em>元购啊',
          description: '就是画质有点绷不住',
          link_award_num: 56,
          comment_num: 48,
          create_at: 1793254976,
          share_url: 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&h_src=YXBwX3NoYXJl&link_id=2a3772c3058e',
          topics: [{ topic_id: 442871, name: '影之刃零' }],
          imgs: ['https://imgheybox1.max-c.com/bbs/2026/11/03/a.webp'],
          user: { username: '小高不姓高' },
        },
      },
      // 噪声条目：真实响应里必然混着这些
      { type: 'filter_tag', info: { name: '全部' } },
      {
        type: 'link',
        info: {
          linkid: 195450408,
          title: '这角色好看[heygirl_敲开心]',
          description: '',
          link_award_num: 1210,
          comment_num: 315,
          create_at: 1793200000,
          share_url: 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=aad4725e7687',
          topics: [],
          imgs: [],
          user: { username: 'kuma' },
        },
      },
      { type: 'space', info: { name: '某空间' } },
    ],
  },
};

/** 线上真实正文信封（含 text/img 混排 + 一条带图评论） */
const TREE_BODY = {
  status: 'ok',
  result: {
    link: {
      title: '原神画质',
      text: JSON.stringify([
        { type: 'text', text: '就是画质有点绷不住' },
        { type: 'img', url: 'https://imgheybox1.max-c.com/bbs/2026/10/29/d.webp' },
      ]),
      user: { username: '楼主' },
    },
    comments: [
      {
        comment: [
          {
            commentid: 987029636,
            text: 'dlss质量',
            link_award_num: 3,
            imgs: [{ url: 'https://imgheybox1.max-c.com/bbs/2026/10/29/e.jpeg', thumb: 'same', width: 4096, height: 2304 }],
            user: { username: '26477349号' },
          },
          // 纯图无字评论（表情包场景正是这类）
          {
            commentid: 2,
            text: '',
            imgs: [{ url: 'https://imgheybox1.max-c.com/bbs/2026/10/29/f.webp' }],
            user: { username: '图党' },
          },
          // 纯空节点应被丢掉
          { commentid: 3, text: '', imgs: [] },
        ],
      },
    ],
  },
};

describe('搜索', () => {
  it('解析真实信封：剥 <em>、拼话题、取分享哈希、跳过噪声条目', async () => {
    const c = new XhhClient({ logger: noopLogger, fetchImpl: stubFetch({ 'general/search': SEARCH_BODY }) });
    const posts = await c.search('影之刃零', 5);
    expect(posts).toHaveLength(2); // filter_tag / space 被跳过
    expect(posts[0]!.title).toBe('原来影之刃零的零是0元购啊'); // <em> 已剥
    expect(posts[0]!.hash).toBe('2a3772c3058e');
    expect(posts[0]!.topic).toBe('影之刃零');
    expect(posts[0]!.award).toBe(56);
    expect(posts[0]!.author).toBe('小高不姓高');
    expect(posts[0]!.coverUrl).toContain('max-c.com');
    // 第二条没有 topics / 没有封面，也不能炸
    expect(posts[1]!.topic).toBe('');
    expect(posts[1]!.coverUrl).toBeUndefined();
  });

  /**
   * limit 的真实语义：**条目总数**，不是帖子数。
   * 实测 limit=10 → 3 条 link，limit=30 → 10 条 link（约 1/3）。
   * 所以客户端必须按 3 倍去要，否则"我要 10 条"会静默变成 3 条。
   * 这条测试钉的就是"别把 limit 直接透传"。
   */
  it('要 N 条帖子 → 向服务端要 3N 条目（限 30）', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push(new URL(url).searchParams.get('limit') ?? '');
      return new Response(JSON.stringify(SEARCH_BODY), { status: 200 });
    }) as unknown as typeof fetch;

    const c = new XhhClient({ logger: noopLogger, fetchImpl });
    await c.search('x', 10);
    expect(seen[0]).toBe('30'); // min(30, 10*3)
    seen.length = 0;
    const c2 = new XhhClient({ logger: noopLogger, fetchImpl, throttleMaxCalls: 99 });
    await c2.search('y', 1);
    expect(seen[0]).toBe('3'); // 1*3
  });

  it('空搜索词直接拒，不浪费一次请求', async () => {
    const onCall = vi.fn();
    const c = new XhhClient({ logger: noopLogger, fetchImpl: stubFetch({}, { onCall }) });
    await expect(c.search('  ')).rejects.toThrow(/空/);
    expect(onCall).not.toHaveBeenCalled();
  });
});

describe('平台语义（HTTP 200 但 body 里失败）', () => {
  /**
   * 线上实测：被限流时 HTTP 仍是 200，body 是
   * `{"msg":"","result":{},"status":"show_captcha"}`。
   * 只看 resp.ok 的实现会把它当成功、返回空列表 —— 那她就永远"搜不到东西"，
   * 而且完全不知道为什么。
   */
  it('show_captcha → captcha 错误并进入静默', async () => {
    const c = new XhhClient({
      logger: noopLogger,
      fetchImpl: stubFetch({ 'general/search': { msg: '', result: {}, status: 'show_captcha' } }),
    });
    await expect(c.search('x')).rejects.toBeInstanceOf(XhhError);
    // 静默已生效：再搜直接被拒，且不再发请求
    await expect(c.search('x')).rejects.toThrow(/等约 20 分钟/);
    expect(c.mutedRemainingMs()).toBeGreaterThan(0);
  });

  it('status!=ok 的其他状态 → 带平台 msg 的结构错误', async () => {
    const c = new XhhClient({
      logger: noopLogger,
      fetchImpl: stubFetch({ 'general/search': { status: 'failed', msg: 'hkey 不能为空' } }),
    });
    await expect(c.search('x')).rejects.toThrow(/hkey 不能为空/);
  });

  it('返回非 JSON → shape 错误（接口改了要能看出来）', async () => {
    const fetchImpl = (async () => new Response('<html>not found</html>', { status: 200 })) as unknown as typeof fetch;
    const c = new XhhClient({ logger: noopLogger, fetchImpl });
    await expect(c.search('x')).rejects.toThrow(/不是 JSON/);
  });

  it('HTTP 非 200 → http 错误', async () => {
    const fetchImpl = (async () => new Response('', { status: 502 })) as unknown as typeof fetch;
    const c = new XhhClient({ logger: noopLogger, fetchImpl });
    await expect(c.search('x')).rejects.toThrow(/HTTP 502/);
  });
});

describe('节流窗口', () => {
  /**
   * 这条对应一个实测出来的关键事实：
   * 单独守"搜索间隔"没用 —— 实测 search 和 link/tree **会同时**被弹验证码，
   * 说明限流是"同一签名短时间内的请求总量"。所以 search 与 readPost 必须共用一个池。
   */
  it('搜索与读帖共用一个额度（读帖也吃搜索的额度）', async () => {
    let calls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      calls += 1;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = url.includes('link/tree') ? TREE_BODY : SEARCH_BODY;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const now = 1793770716000;
    const c = new XhhClient({ logger: noopLogger, fetchImpl, now: () => now, throttleMaxCalls: 2 });
    await c.search('a');           // 第 1 次
    await c.readPost('ba9b72b0316e'); // 第 2 次
    await expect(c.search('b')).rejects.toThrow(/请求太密/); // 第 3 次被挡，且没发出请求
    expect(calls).toBe(2);
  });

  it('窗口滑出后自动恢复', async () => {
    let clock = 1793770716000;
    const fetchImpl = stubFetch({ 'general/search': SEARCH_BODY });
    const c = new XhhClient({ logger: noopLogger, fetchImpl, now: () => clock, throttleMaxCalls: 1, throttleWindowMs: 60_000 });
    await c.search('a');
    await expect(c.search('b')).rejects.toThrow(/请求太密/);
    clock += 61_000;
    await expect(c.search('c')).resolves.toBeDefined();
  });
});

describe('读帖', () => {
  it('正文 text/img 混排 + 评论图 + 纯图评论保留 + 空节点丢弃', async () => {
    const c = new XhhClient({ logger: noopLogger, fetchImpl: stubFetch({ 'link/tree': TREE_BODY }) });
    const d = await c.readPost('ba9b72b0316e', 10);
    expect(d.title).toBe('原神画质');
    expect(d.author).toBe('楼主');
    expect(d.paragraphs).toEqual([
      { type: 'text', text: '就是画质有点绷不住' },
      { type: 'img', url: 'https://imgheybox1.max-c.com/bbs/2026/10/29/d.webp' },
    ]);
    expect(d.images).toHaveLength(1);
    // 3 个节点里挑出 2 个有内容的（纯图那条要保留，空节点丢掉）
    expect(d.comments).toHaveLength(2);
    expect(d.comments[0]).toMatchObject({ text: 'dlss质量', author: '26477349号', award: 3 });
    expect(d.comments[0]!.images).toHaveLength(1);
    expect(d.comments[1]).toMatchObject({ text: '', author: '图党' });
    expect(d.comments[1]!.images[0]).toContain('max-c.com');
  });

  it('读帖也受静默约束（被拦过就别再打）', async () => {
    const fetchImpl = stubFetch({ 'general/search': { status: 'show_captcha', result: {}, msg: '' } });
    const c = new XhhClient({ logger: noopLogger, fetchImpl });
    await expect(c.search('x')).rejects.toThrow(/人机验证/);
    await expect(c.readPost('abc')).rejects.toThrow(/等约/);
  });
});

describe('热搜与推荐流', () => {
  it('热搜分组解析（含空 head_text 归为「热搜」）', async () => {
    const c = new XhhClient({
      logger: noopLogger,
      fetchImpl: stubFetch({
        'welcome_page': {
          status: 'ok',
          result: {
            Lists: [
              { head_text: '', items: [{ text: '影之刃零' }, { text: '黑神话悟空' }] },
              { head_text: '热门游戏', items: [{ text: '原神', right_tag: { text: '热门' } }] },
            ],
          },
        },
      }),
    });
    const groups = await c.hot();
    expect(groups).toHaveLength(2);
    expect(groups[0]!.title).toBe('热搜'); // 空 head_text 兜底
    expect(groups[0]!.items).toHaveLength(2);
    expect(groups[1]!.items[0]).toEqual({ text: '原神', tag: '热门' });
  });

  it('推荐流解析（links 数组，字段比搜索少）', async () => {
    const c = new XhhClient({
      logger: noopLogger,
      fetchImpl: stubFetch({
        'bbs/app/feeds': {
          status: 'ok',
          result: {
            links: [
              {
                linkid: 195958556,
                title: '玩了几天影之刃的感受',
                link_award_num: 384,
                comment_num: 631,
                share_url: 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=3a5372c3c9f9',
                topics: [{ name: '影之刃零' }],
                user: { username: '失眠哥布林' },
              },
            ],
          },
        },
      }),
    });
    const posts = await c.feeds(5);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.hash).toBe('3a5372c3c9f9');
    expect(posts[0]!.author).toBe('失眠哥布林');
  });
});
