/**
 * 设置面板扩展路由（2026-11-06）
 * ─────────────────────────────────────────────────────────────
 * GET /models  —— ModelResolver.listModels 的桥（下拉菜单数据源）
 * GET /presets —— agentPresets 列表
 * GET /status  —— 只读运行状态快照
 * GET/POST /persona-runtime —— runtime.json 四件套（白名单只收四个键）
 *
 * 共同点：能力未注入时返回 503（面板显示"不可用"，不阻塞其它区块）。
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerBindRoutes, type WebRoute, type WebServerLike } from './bind-routes.ts';

class FakeServer implements WebServerLike {
  readonly routes = new Map<string, WebRoute>();
  register(route: WebRoute): () => void {
    this.routes.set(route.path, route);
    return () => { this.routes.delete(route.path); };
  }
}

function makeReq(method: string, body?: unknown): IncomingMessage {
  if (body === undefined) return { method, headers: {} } as unknown as IncomingMessage;
  // POST：readJsonBody 用 for-await 读流，这里给一个可迭代的 body
  const chunks = [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next: async () => i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined } };
    },
  } as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; json: () => Promise<{ status: number; body: unknown }> } {
  let status = 0;
  let raw = '';
  let done = false;
  const res = {
    writeHead(code: number, _h?: unknown) { status = code; },
    end(chunk?: unknown) { raw += String(chunk ?? ''); done = true; },
  } as unknown as ServerResponse;
  return {
    res,
    // handler 是 fire-and-forget（void 包装，返回 undefined），
    // 要等 res.end 被调（响应写完）再读，而不是 await handler 的返回值。
    json: async () => {
      for (let i = 0; i < 50 && !done; i++) await new Promise((r) => setTimeout(r, 10));
      return { status, body: JSON.parse(raw || '{}') as unknown };
    },
  };
}

describe('设置面板扩展路由', () => {
  it('未注入 listModels 时 /models 返回 503', async () => {
    const server = new FakeServer();
    registerBindRoutes(server, null, console as never, {});
    const { res, json } = makeRes();
    await server.routes.get('/qqbot/im-qqbot/models')!.handler(makeReq('GET'), res);
    const { status, body } = await json();
    expect(status).toBe(503);
    expect((body as { error: string }).error).toContain('不可用');
  });

  it('listModels 正常返回模型数组', async () => {
    const server = new FakeServer();
    registerBindRoutes(server, null, console as never, {
      listModels: async () => [
        { provider: 'our-free-model', id: 'deepseek-v4.1-flash-free' },
        { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'V4 Flash' },
      ],
    });
    const { res, json } = makeRes();
    await server.routes.get('/qqbot/im-qqbot/models')!.handler(makeReq('GET'), res);
    const { status, body } = await json();
    expect(status).toBe(200);
    const models = (body as { models: Array<{ provider: string; id: string }> }).models;
    expect(models.length).toBe(2);
    expect(models[0]!.provider).toBe('our-free-model');
  });

  it('listModels 抛错时返回 502 带原因（下拉退化为手输，面板不死）', async () => {
    const server = new FakeServer();
    registerBindRoutes(server, null, console as never, {
      listModels: async () => { throw new Error('ctx.llm 缺席'); },
    });
    const { res, json } = makeRes();
    await server.routes.get('/qqbot/im-qqbot/models')!.handler(makeReq('GET'), res);
    const { status, body } = await json();
    expect(status).toBe(502);
    expect((body as { error: string }).error).toContain('ctx.llm 缺席');
  });

  it('/presets 未注入时 503；注入时返回列表', async () => {
    const server = new FakeServer();
    registerBindRoutes(server, null, console as never, {});
    const { res, json } = makeRes();
    await server.routes.get('/qqbot/im-qqbot/presets')!.handler(makeReq('GET'), res);
    expect((await json()).status).toBe(503);

    const server2 = new FakeServer();
    registerBindRoutes(server2, null, console as never, {
      listPresets: () => [{ id: 'standard', name: '标准' }],
    });
    const { res: r2, json: j2 } = makeRes();
    await server2.routes.get('/qqbot/im-qqbot/presets')!.handler(makeReq('GET'), r2);
    const out = await j2();
    expect(out.status).toBe(200);
    expect((out.body as { presets: Array<{ id: string }> }).presets[0]!.id).toBe('standard');
  });

  it('/status 未注入 503；注入返回快照', async () => {
    const server = new FakeServer();
    registerBindRoutes(server, null, console as never, {});
    const { res, json } = makeRes();
    await server.routes.get('/qqbot/im-qqbot/status')!.handler(makeReq('GET'), res);
    expect((await json()).status).toBe(503);

    const server2 = new FakeServer();
    registerBindRoutes(server2, null, console as never, {
      runtimeStatus: () => ({ qqConnected: true, activeSessions: 3 }),
    });
    const { res: r2, json: j2 } = makeRes();
    await server2.routes.get('/qqbot/im-qqbot/status')!.handler(makeReq('GET'), r2);
    const out = await j2();
    expect(out.status).toBe(200);
    expect((out.body as { status: { activeSessions: number } }).status.activeSessions).toBe(3);
  });

  it('/persona-runtime POST 只收四个白名单键，其余丢弃', async () => {
    const written: Array<Record<string, unknown>> = [];
    const server = new FakeServer();
    registerBindRoutes(server, null, console as never, {
      writePersonaRuntime: (patch) => { written.push(patch); return { ok: true }; },
      readPersonaRuntime: () => ({ names: [] }),
    });
    const { res, json } = makeRes();
    await server.routes.get('/qqbot/im-qqbot/persona-runtime')!.handler(
      makeReq('POST', { names: ['小鲸鱼'], evil: 'x' }),
      res,
    );
    const out = await json();
    expect(out.status).toBe(200);
    expect(written[0]).toEqual({ names: ['小鲸鱼'] });
  });

  it('/persona-runtime 空补丁返回 400', async () => {
    const server = new FakeServer();
    registerBindRoutes(server, null, console as never, {
      writePersonaRuntime: () => ({ ok: true }),
    });
    const { res, json } = makeRes();
    await server.routes.get('/qqbot/im-qqbot/persona-runtime')!.handler(
      makeReq('POST', { evil: 'x' }),
      res,
    );
    const out = await json();
    expect(out.status).toBe(400);
  });
});
