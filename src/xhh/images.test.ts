/**
 * 图片入库测试
 *
 * 用临时库根 + 真实字节，不用 mock 文件系统：
 * 这里要验的恰恰是"文件真的落哪儿了、索引真的指向什么"，
 * 用替身会把这两件事一起验掉。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../types.ts';
import { fetchIntoStickerLibrary, isAllowedImageUrl, XHH_STICKER_DIR } from './images.ts';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as unknown as Logger;

const roots: string[] = [];
function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xhh-img-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

/** 最小合法 PNG（1×1），真字节，能过 magic bytes */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 造 fetch 替身：返回给定字节 / 状态 / 长度头 */
function stubImage(bytes: Buffer, init: { status?: number; contentLength?: number } = {}): typeof fetch {
  return (async () => {
    const headers: Record<string, string> = { 'content-type': 'image/png' };
    if (init.contentLength !== undefined) headers['content-length'] = String(init.contentLength);
    return new Response(bytes, { status: init.status ?? 200, headers });
  }) as unknown as typeof fetch;
}

describe('图片入库', () => {
  it('成功入库：落进 _小黑盒 子目录、索引指向真实文件、不是临时文件', async () => {
    const root = makeRoot();
    const url = 'https://imgheybox1.max-c.com/bbs/2026/11/03/some.png';
    const r = await fetchIntoStickerLibrary(
      url,
      root,
      { timing: ['C1'], desc: '一张梗图' },
      noopLogger,
      { fetchImpl: stubImage(PNG_1X1) },
    );

    expect(r.ok).toBe(true);
    expect(r.ext).toBe('.png'); // 按字节判定，不看 URL 后缀
    expect(r.path).toBeTruthy();
    expect(existsSync(r.path!)).toBe(true);
    expect(r.path!.includes(XHH_STICKER_DIR)).toBe(true);
    // 这条钉住之前那个真 bug：临时文件若建在库根内，adoptIntoLibrary
    // 会认为"已在库内"直接返回，索引就会指向 tmp 路径 → 重启后死链
    expect(r.path!.includes('.tmp')).toBe(false);
    expect(r.path!.startsWith(root)).toBe(true);

    // 索引确实写进去了，且指向同一个路径
    const idx = JSON.parse(readFileSync(join(root, '_index.json'), 'utf8')) as {
      stickers: { path: string; use?: string[]; desc?: string }[];
      count: number;
    };
    const hit = idx.stickers.find((s) => s.path === r.path);
    expect(hit).toBeDefined();
    expect(hit!.use).toEqual(['C1']);
    expect(hit!.desc).toBe('一张梗图');
  });

  /**
   * 去重靠内容 MD5 + 路径前缀判断。
   * 同一张图在两个帖子里出现非常常见，库里只能留一份，索引也只能一条。
   */
  it('内容相同的图重复收 → 库里只有一份，索引不重复', async () => {
    const root = makeRoot();
    const meta = { timing: ['C1'], desc: '同一张图' };
    const a = await fetchIntoStickerLibrary('https://imgheybox1.max-c.com/a.png', root, meta, noopLogger, {
      fetchImpl: stubImage(PNG_1X1),
    });
    const b = await fetchIntoStickerLibrary('https://imgheybox1.max-c.com/b.png', root, meta, noopLogger, {
      fetchImpl: stubImage(PNG_1X1),
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // adoptIntoLibrary 按 MD5 命名，同内容 → 同路径
    expect(b.path).toBe(a.path);

    const idx = JSON.parse(readFileSync(join(root, '_index.json'), 'utf8')) as {
      stickers: { path: string }[];
    };
    expect(idx.stickers.filter((s) => s.path === a.path)).toHaveLength(1);
  });

  it('不是图片（HTML 伪装）→ not-an-image，不落盘', async () => {
    const root = makeRoot();
    const r = await fetchIntoStickerLibrary(
      'https://imgheybox1.max-c.com/x.png',
      root,
      { timing: ['C1'], desc: 'x' },
      noopLogger,
      { fetchImpl: stubImage(Buffer.from('<html>404 page</html>')) },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-an-image');
    expect(existsSync(join(root, '_index.json'))).toBe(false);
  });

  it('超过上限 → too-large（先看 content-length，省一次完整下载）', async () => {
    const root = makeRoot();
    const r = await fetchIntoStickerLibrary(
      'https://imgheybox1.max-c.com/big.png',
      root,
      { timing: ['C1'], desc: 'x' },
      noopLogger,
      { fetchImpl: stubImage(PNG_1X1, { contentLength: 10 * 1024 * 1024 }), maxBytes: 1024 * 1024 },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too-large');
  });

  /**
   * 这条不是洁癖，是安全底线：
   * 帖子正文的 img url 是发帖人可控的，谁都能填自己的地址。
   * 白名单在 images.ts 里守，工具层也提前筛。两层都要有。
   */
  it('非白名单域名 → host-not-allowed，且一次请求都不发', async () => {
    const root = makeRoot();
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return new Response(PNG_1X1, { status: 200 });
    }) as unknown as typeof fetch;

    const r = await fetchIntoStickerLibrary('https://evil.com/x.png', root, { timing: ['C1'], desc: 'x' }, noopLogger, {
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('host-not-allowed');
    expect(called).toBe(0);
  });

  it('http（非 https）→ not-https', async () => {
    const root = makeRoot();
    const r = await fetchIntoStickerLibrary('http://imgheybox1.max-c.com/x.png', root, { timing: ['C1'], desc: 'x' }, noopLogger, {
      fetchImpl: stubImage(PNG_1X1),
    });
    expect(r.reason).toBe('not-https');
  });

  it('下载失败/超时 → download-failed，不抛异常', async () => {
    const root = makeRoot();
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await fetchIntoStickerLibrary('https://imgheybox1.max-c.com/x.png', root, { timing: ['C1'], desc: 'x' }, noopLogger, {
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('download-failed');
    expect(r.detail).toContain('network down');
  });

  it('HTTP 404 → download-failed（带状态码）', async () => {
    const root = makeRoot();
    const r = await fetchIntoStickerLibrary('https://imgheybox1.max-c.com/x.png', root, { timing: ['C1'], desc: 'x' }, noopLogger, {
      fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    });
    expect(r.reason).toBe('download-failed');
    expect(r.detail).toContain('404');
  });

  it('白名单判定直接命中真实 CDN 域名', () => {
    expect(isAllowedImageUrl('https://imgheybox1.max-c.com/bbs/2026/11/03/x.webp')).toBe(true);
  });

  /**
   * webp 是线上最常见的图片格式（`.../thumb.jpeg?...&format/webp` 后缀是 jpeg，
   * 实际字节是 webp）。只看后缀的实现会把它当 jpg 存，然后在发送工具那边解不出来。
   */
  it('后缀是 jpeg 但字节是 webp → 按真实格式存成 .webp', async () => {
    const root = makeRoot();
    // 最小 webp 头：RIFF....WEBP
    const webp = Buffer.from('52494646100000005745425056503820', 'hex');
    const r = await fetchIntoStickerLibrary(
      'https://imgheybox1.max-c.com/bbs/thumb.jpeg',
      root,
      { timing: ['C1'], desc: 'webp' },
      noopLogger,
      { fetchImpl: stubImage(webp) },
    );
    expect(r.ok).toBe(true);
    expect(r.ext).toBe('.webp');
  });
});
