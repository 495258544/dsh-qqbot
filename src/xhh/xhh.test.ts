/**
 * 纯函数测试：签名 / 归一 / 富文本解析 / URL 白名单
 *
 * 这些测试的输入全部来自**线上真实响应**（2026-11-05 实测抓到的字段形状），
 * 不是为了让测试好写过而简化过的形状 —— 这个仓库吃过"测试喂的输入和生产不一样，
 * 测试就是在给自己发合格证"的亏（见 DESIGN-PERSONA.md §16.5）。
 */
import { describe, expect, it } from 'vitest';
import { hkeyOf, signatureOf } from './sign.ts';
import { hashFromShareUrl, normalizePostRef, parseRichText, webUrlOf, XhhError } from './client.ts';
import { isAllowedImageUrl, filterAllowedImageUrls } from './images.ts';

describe('签名（sign.ts）', () => {
  /**
   * 这条是硬校验值，不是"跑一遍看结果"。
   *
   * 同一个 (path, timestamp, nonce) 在三个独立实现里都必须得到 `7X3XY98`：
   *   - fbbDirge/dsh-xiaoheihe 的 lib/index.js（JS，MIT）
   *   - AaronZ345/xiaoheihe-cli 的 signing.py（Python，MIT）
   *   - 本文件 hkeyOf
   * 两边实跑比对过。如果这里变了，说明签名算法被"优化"坏了 ——
   * 而坏掉的签名服务端只会回 `show_captcha`，从错误信息看不出是签名问题。
   */
  it('与另外两个独立实现逐字节一致（7X3XY98）', () => {
    const path = '/bbs/app/api/general/search/v1';
    // 注意：hkeyOf 收的是 timestamp+1（协议要求），这里直接给 ts+1
    expect(hkeyOf(path, 1793770716 + 1, 'ACCD976013CCAA640234E0D1E0F73C92')).toBe('7X3XY98');
  });

  it('路径归一：头尾斜杠、重复斜杠都不影响结果', () => {
    const ts = 1793770717;
    const nonce = 'ACCD976013CCAA640234E0D1E0F73C92';
    expect(hkeyOf('/bbs/app/api/general/search/v1', ts, nonce))
      .toBe(hkeyOf('bbs/app/api/general/search/v1/', ts, nonce));
    expect(hkeyOf('//bbs//app//api//general//search//v1', ts, nonce))
      .toBe(hkeyOf('/bbs/app/api/general/search/v1', ts, nonce));
  });

  it('hkey 形如 字母+两位校验（长度固定 7）', () => {
    const sig = signatureOf('/bbs/app/feeds', 1793770716000, 'fixed');
    expect(sig.hkey).toMatch(/^[A-Z0-9]{5}\d{2}$/);
    expect(sig._time).toBe(1793770716);
    expect(sig.nonce).toMatch(/^[0-9A-F]{32}$/);
  });

  it('nonce 不同 → hkey 不同（保证不是常量）', () => {
    const a = signatureOf('/bbs/app/feeds', 1793770716000, 'a');
    const b = signatureOf('/bbs/app/feeds', 1793770716000, 'b');
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.hkey).not.toBe(b.hkey);
  });
});

describe('share_url → 分享哈希', () => {
  it('从真实 share_url 里取哈希', () => {
    // 线上实测原样
    const url = 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&h_src=YXBwX3NoYXJl&link_id=ba9b72b0316e';
    expect(hashFromShareUrl(url)).toBe('ba9b72b0316e');
  });

  it('没有 link_id 返回 undefined（不抛）', () => {
    expect(hashFromShareUrl('https://example.com/x?a=1')).toBeUndefined();
    expect(hashFromShareUrl(undefined)).toBeUndefined();
    expect(hashFromShareUrl('')).toBeUndefined();
  });
});

describe('webUrlOf（API 被封时的浏览器出路）', () => {
  /**
   * 为什么这个函数单独存在并单独测：
   * 实测 API 的 link/tree 被小黑盒按 HTTP/TLS 指纹风控，而真实浏览器打开
   * 同一个帖子完全不受影响（同一时刻 API=show_captcha、浏览器连读 6 篇 0 验证，
   * 同一个端点、浏览器也没带登录 Cookie）。
   * 所以"被拦了去浏览器读"是**唯一可行的替代路径**，这个 URL 必须拼对。
   */
  it('分享哈希 → 网页版帖子地址', () => {
    expect(webUrlOf('4e4372c114cb')).toBe('https://www.xiaoheihe.cn/app/bbs/link/4e4372c114cb');
  });
});

describe('被风控时的提示（关键：必须给出具体地址）', () => {
  /**
   * 这条测的是**可用性**，不是字符串美观。
   * 早先的提示里只给了模板 `.../link/<ref>`，她还得自己把 ref 拼进去 ——
   * 多一步就可能拼错或干脆放弃去浏览器，那就等于把唯一可行的替代路径浪费掉。
   * 所以钉住：提示里必须出现这一篇的**完整可点地址**。
   */
  it('captcha 错误文本包含这一篇的真实地址，而不是占位符', async () => {
    const { registerXhhTools } = await import('./tools.ts');
    const { XhhClient } = await import('./client.ts');
    // 关键：用注入的 fetch 替身把它**固定**在"一定返回 show_captcha"的状态。
    // 早期版本这里是真发网络请求的 —— 那会让测试结果随（实测很不稳定的）平台风控漂移，
    // 属于"测试给自己发合格证"那一类，不能留。
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ msg: '', result: {}, status: 'show_captcha' }), { status: 200 })) as unknown as typeof fetch;
    const client = new XhhClient({ logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never, fetchImpl });

    const tools: { name: string; execute: (a: unknown) => Promise<unknown>; output: { render: (a: unknown, v: unknown) => { text: string }[] } }[] = [];
    const ctx = { get: (k: string) => (k === 'tools' ? { register: (d: unknown) => tools.push(d as never) } : undefined) };
    const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
    registerXhhTools(ctx as never, client, {} as never, logger as never);

    const readTool = tools.find((t) => t.name === 'qq_xhh_read')!;
    const res = await readTool.execute({ ref: '3f1572c4aabe' });
    const text = readTool.output.render({}, res)[0]!.text;

    // 必须能直接点进去，不能是模板占位符
    expect(text).toContain('https://www.xiaoheihe.cn/app/bbs/link/3f1572c4aabe');
    expect(text).not.toContain('<ref>');
    expect(text).toContain('ego_navigate');
    // 也必须明确劝阻重试（实测重试会把封禁拉长）
    expect(text).toContain('别在接口上重试');
  });
});

describe('normalizePostRef', () => {
  it('纯哈希原样通过', () => {
    expect(normalizePostRef('ba9b72b0316e')).toBe('ba9b72b0316e');
  });

  it('整条 share_url → 哈希', () => {
    expect(normalizePostRef('https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=2a3772c3058e'))
      .toBe('2a3772c3058e');
  });

  /**
   * 这是最容易被误用的一条：网页版链接里是**数字 ID**，而数字 ID 读正文会被
   * 弹人机验证（实测 `/bbs/app/link/tree?link_id=194674321` → `show_captcha`）。
   * 所以必须在这里就拦住，并明确告诉模型"你给的是数字 ID，要用哈希"，
   * 而不是让它拿数字 ID 打过去换一个验证码、再连累整个模块静默 20 分钟。
   */
  it('网页版数字 ID 链接 → 明确报错并指路', () => {
    expect(() => normalizePostRef('https://www.xiaoheihe.cn/app/bbs/link/195802469'))
      .toThrow(XhhError);
    try {
      normalizePostRef('https://www.xiaoheihe.cn/app/bbs/link/195802469');
    } catch (err) {
      const e = err as XhhError;
      expect(e.kind).toBe('shape');
      expect(e.message).toContain('195802469');
      expect(e.message).toContain('qq_xhh_search');
    }
  });

  it('空串报错而不是拿去请求', () => {
    expect(() => normalizePostRef('   ')).toThrow(/空/);
  });
});

describe('parseRichText（正文富文本）', () => {
  /** 线上实测的正文结构：text 段 + img 段混排 */
  it('解析真实形状：text/img 混排', () => {
    const raw = JSON.stringify([
      { text: '就是画质有点绷不住', type: 'text' },
      { height: '1450.0', type: 'img', url: 'https://imgheybox1.max-c.com/bbs/2026/10/29/x/thumb.webp', width: '669.0' },
      { text: '第二段', type: 'text' },
    ]);
    const out = parseRichText(raw);
    expect(out).toEqual([
      { type: 'text', text: '就是画质有点绷不住' },
      { type: 'img', url: 'https://imgheybox1.max-c.com/bbs/2026/10/29/x/thumb.webp' },
      { type: 'text', text: '第二段' },
    ]);
  });

  /**
   * 线上实测：有的帖子 img.url 是**发帖人手机本地路径**
   * `/storage/emulated/0/DCIM/Camera/IMG_20261029_110447.jpg`。
   * 这种图我们永远拿不到，必须在这里丢掉 ——
   * 否则会当成图片地址传下去，下载必定失败，还会误导模型"这里有图可以收"。
   */
  it('手机本地路径的图丢掉（线上真实出现过）', () => {
    const raw = JSON.stringify([
      { type: 'img', url: '/storage/emulated/0/DCIM/Camera/IMG_20261029_110447.jpg' },
      { type: 'img', url: 'https://imgheybox1.max-c.com/bbs/ok.webp' },
    ]);
    const out = parseRichText(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toContain('max-c.com');
  });

  it('老帖是纯字符串正文 → 当成一段文本', () => {
    expect(parseRichText('纯文本正文')).toEqual([{ type: 'text', text: '纯文本正文' }]);
  });

  it('空/怪结构不抛异常', () => {
    expect(parseRichText(undefined)).toEqual([]);
    expect(parseRichText('')).toEqual([]);
    expect(parseRichText('{"a":1}')).toEqual([]);
    expect(parseRichText('[null, 1, "x"]')).toEqual([]);
  });

  it('空文本段被过滤（不留空白段）', () => {
    const raw = JSON.stringify([{ type: 'text', text: '   ' }, { type: 'text', text: '有内容' }]);
    expect(parseRichText(raw)).toEqual([{ type: 'text', text: '有内容' }]);
  });
});

describe('图片地址白名单', () => {
  it('小黑盒图床放行', () => {
    expect(isAllowedImageUrl('https://imgheybox1.max-c.com/bbs/2026/x.webp')).toBe(true);
    expect(isAllowedImageUrl('https://cdn.max-c.com/x.jpg')).toBe(true);
    expect(isAllowedImageUrl('https://xiaoheihe.cn/x.png')).toBe(true);
  });

  /**
   * 这条是安全底线，不是洁癖。
   * 帖子正文里的 img url 是**发帖人可控**内容 —— 谁都能在帖子里填自己的地址。
   * 不设白名单，她逛一次小黑盒就等于被使唤着做了任意 URL 下载（内网探测/打点）。
   */
  it('外部域名一律拒绝（正文里的 img url 是用户可控的）', () => {
    expect(isAllowedImageUrl('https://evil.com/x.jpg')).toBe(false);
    expect(isAllowedImageUrl('http://imgheybox1.max-c.com/x.webp')).toBe(false); // 非 https
    // 后缀混淆不能过
    expect(isAllowedImageUrl('https://max-c.com.evil.com/x.jpg')).toBe(false);
    expect(isAllowedImageUrl('https://evilmax-c.com/x.jpg')).toBe(false);
    expect(isAllowedImageUrl('not-a-url')).toBe(false);
  });

  it('批量预筛分桶', () => {
    const r = filterAllowedImageUrls([
      'https://imgheybox1.max-c.com/a.webp',
      'https://evil.com/b.jpg',
      '/storage/emulated/0/DCIM/c.jpg',
    ]);
    expect(r.ok).toHaveLength(1);
    expect(r.rejected).toHaveLength(2);
  });
});
