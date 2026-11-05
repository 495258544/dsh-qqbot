/**
 * 接线回归测试 —— 2026-11-05「手冲 → 字典页」的真根因。
 *
 * ## 这个 bug 为什么必须用真 cordis 测，不能用假对象
 *
 * 前一轮"修复"就是用手写假 web 服务"验证通过"的，可线上照旧走 Bing RSS：
 *   - 假对象测的是 `searchViaWeb(web, ...)` 那一层，它本来就是对的；
 *   - 真正错的是**上一层的接线** —— `(ctx as Record<string,unknown>).web` 在
 *     cordis 里会抛（服务没声明在 inject），外面套 try/catch 吞成 undefined。
 * 假对象绕开了整个 ctx 访问守卫，所以它永远发现不了这个错。
 *
 * 关键细节：**必须在插件 fiber 内测**。根 ctx 没有 fiber runtime，守卫会走
 * 宽松分支（`if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false)`），
 * 那里摸 ctx.web 是不抛的 —— 而 bootstrap 的 ctx 恰恰是插件 fiber 的 ctx，
 * 在生产里抛就是抛在这一层。用根 ctx 测等于又把 bug 测没了。
 *
 * 这里用**真 cordis Context + 真 cordis Service**（服务经 provide 注册进 ctx，
 * 走和宿主一样的反射/守卫路径）。不用 `@deepseek-ai/dsh-web` 的 WebRuntime：
 * 仓库依赖里没有它，而宿主那份跑在另一份 cordis（4.0.5 vs 仓库 4.0.1），
 * 服务表不在同一个世界里，"接不通"是假失败。真搜索链路（真 WebRuntime +
 * 真 dsh-free-search 真发 query）由 `scripts/probe-web-wiring.mjs` 验证。
 */
import { describe, it, expect } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import { bindPersonaWeb } from './web-wiring.ts';
import type { WebSearchLike } from './surf.ts';

const silentLogger = (): unknown => {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop, success: noop, trace: noop };
};

/** 真 cordis 服务：注册进 ctx 时走与宿主 web 相同的反射/守卫路径 */
class FakeWebService extends Service {
  calls: Array<{ query: string; maxResults?: number; engine?: string }> = [];
  constructor(ctx: Context) {
    super(ctx, 'web');
  }
  async search(request: { query: string; maxResults?: number; engine?: string }) {
    this.calls.push(request);
    return { sources: [{ url: 'https://x.com/a', title: '手冲参数对照表', snippet: '粉水比1:15' }] };
  }
}

/** 一个空壳插件，用来拿到"插件 fiber 内的 ctx"（与 bootstrap 的处境相同） */
function makeApp(opts: { withWeb?: boolean } = {}): Context {
  const root = new Context();
  root.provide('logger', silentLogger());
  if (opts.withWeb) root.plugin(FakeWebService);
  return root;
}

/** 等 cordis 的服务激活（plugin 加载是异步的） */
async function settle(ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('bindPersonaWeb · 真实 cordis 接线', () => {
  it('web 服务缺席：不抛、不卡，一次都不 attach（CLI 兜底路径）', async () => {
    const root = makeApp({ withWeb: false });
    const calls: Array<WebSearchLike | undefined> = [];
    let thrown: unknown;
    // 用 ctx.plugin 进到插件 fiber 内跑 —— bootstrap 就在这个上下文里
    root.plugin({
      name: 'probe-no-web',
      apply: (ctx: Context) => {
        try {
          bindPersonaWeb(ctx, (w) => calls.push(w));
        } catch (err) {
          thrown = err;
        }
      },
    });
    await settle(200);
    expect(thrown).toBeUndefined();
    // 软注入语义：依赖未就绪时回调不跑，所以不会误报"已接入"。
    // persona 构造时的 undefined 保持有效 → surf 继续走 Bing RSS 兜底。
    expect(calls).toHaveLength(0);
  });

  it('web 服务就绪：回调真的跑，attach 拿到带 search 的真服务对象', async () => {
    const root = makeApp({ withWeb: true });
    const calls: Array<WebSearchLike | undefined> = [];
    root.plugin({
      name: 'probe-with-web',
      apply: (ctx: Context) => {
        bindPersonaWeb(ctx, (w) => calls.push(w));
      },
    });
    await settle(400);
    expect(calls.length).toBeGreaterThan(0);
    const got = calls.at(-1);
    expect(got).toBeDefined();
    expect(typeof got!.search).toBe('function');
  });

  it('钉住根因本身：插件 fiber 内不声明 inject 就摸 ctx.web 会抛', async () => {
    // 这条就是 2026-11-05 的真凶：原来的代码在 fiber ctx 上读 .web，抛了被 catch 吞掉。
    // 如果哪天 cordis 放开守卫，这条会红 —— 提醒重新审接线，而不是退回 ctx.web。
    const root = makeApp({ withWeb: true });
    let thrown: unknown;
    root.plugin({
      name: 'probe-raw-access',
      apply: (ctx: Context) => {
        try {
          (ctx as unknown as Record<string, unknown>).web;
        } catch (err) {
          thrown = err;
        }
      },
    });
    await settle(400);
    expect(thrown).toBeDefined();
    expect(String((thrown as Error)?.message ?? thrown)).toMatch(/without inject/);
  });

  it('ctx 形状不兼容（没有 inject）→ 静默跳过，不炸启动', () => {
    const bare = { get: () => undefined } as unknown as Context;
    expect(() => bindPersonaWeb(bare, () => {})).not.toThrow();
  });
});

describe('PersonaService.attachWeb · 运行时回填', () => {
  it('attach 前 hasWeb=false，attach 后 true，卸载后回到 false', async () => {
    const { PersonaService } = await import('./service.ts');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-web-'));
    const baseCfg = {
      enabled: true,
      dataDir: '',
      roleCardPath: '',
      roleMaxChars: 12000,
      wakeEnabled: false,
      names: [],
      keywords: [],
      ownerOpenids: [],
      groupProbability: 0,
      humanizeEnabled: true,
      msPerChar: 110,
      burstMax: 2,
      gapMinMs: 700,
      gapMaxMs: 2600,
      ownLifeEnabled: false,
      ownLifeIntervalMs: 9000000,
      ownLifeMaxPerDay: 6,
      maxProactivePerDay: 2,
      proactiveMinGapMs: 7200000,
    };
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const svc = new PersonaService({ config: baseCfg, dataDir: dir, logger });
    expect(svc.hasWeb()).toBe(false);
    svc.attachWeb({ search: async () => ({ sources: [] }) });
    expect(svc.hasWeb()).toBe(true);
    svc.attachWeb(undefined);
    expect(svc.hasWeb()).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
