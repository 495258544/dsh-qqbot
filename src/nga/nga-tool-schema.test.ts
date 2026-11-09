/**
 * qq_nga 输出 schema 的完整性测试
 * ─────────────────────────────────────────────────────────────
 * ## 为什么必须有这条（2026-11-09，连挂两次）
 *
 * 工具的 output schema 是 `additionalProperties: false` 的 —— 返回里只要有
 * 一个**没在顶层 properties 声明**的字段，宿主 `dsh-tools` 就会把整个工具结果
 * 判成 `INVALID_TOOL_OUTPUT` 扔掉。
 *
 * 我连着挂了两次，都是同一个毛病：
 *   1. 加 search 时返回了 `keyword`/`scope`，schema 没声明
 *   2. 加版面表时返回了 `forums`/`note`，schema 没声明
 *
 * 而且第二次更隐蔽：我用字符串替换插入字段，锚点 `subject: { type: 'string' },`
 * 在 schema 里出现了**两次**，匹配到了 `topics.items.properties` 里那个 ——
 * 于是 `keyword`/`scope`/`forums`/`note` 全被塞进"每条主题的属性"，
 * 顶层仍然是没声明的。表面上 schema 里"有这些字"，实际校验照样失败。
 *
 * 所以这条测试**不看字段名在不在文本里**，而是真的把 schema 取出来，
 * 逐条比对"代码 return 的顶层字段" ⊆ "schema 顶层 properties"。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerNgaTools } from './tools.ts';

const SRC = readFileSync(
  '/root/Documents/deepseek-harness/default-workspace/dsh-qqbot/src/nga/tools.ts',
  'utf8',
);

/** 取 qq_nga 那一段（到 qq_nga_login 之前） */
function toolBlock(): string {
  const i = SRC.indexOf("name: 'qq_nga',");
  expect(i).toBeGreaterThan(-1);
  const j = SRC.indexOf("name: 'qq_nga_login'", i);
  return SRC.slice(i, j === -1 ? SRC.length : j);
}

/**
 * 真的把工具定义跑出来，读它注册进去的 schema 对象。
 *
 * 为什么不用文本解析：我上一版就是按缩进猜层级，结果 `keyword` 塞进了
 * `topics.items.properties`，文本里"有这些字"但层级是错的 —— 测试通过、线上照样挂。
 * 现在改成**执行注册流程、拿到真实 schema 对象**再比对，这才是校验器看到的那个东西。
 */
interface RegisteredTool {
  name: string;
  output?: { schema?: { properties?: Record<string, unknown> } };
  parameters?: { properties?: Record<string, unknown> };
}

function registeredTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const fakeCtx = {
    get: () => ({
      register: (def: RegisteredTool) => { tools.push(def); },
    }),
  } as unknown as Parameters<typeof registerNgaTools>[0];

  registerNgaTools(fakeCtx, {
    logger: {
      info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined,
    } as unknown as Parameters<typeof registerNgaTools>[1]['logger'],
  });
  return tools;
}

describe('qq_nga output schema', () => {
  it('顶层 properties 声明了所有会返回的字段', () => {
    const tools = registeredTools();
    const nga = tools.find((t) => t.name === 'qq_nga');
    expect(nga, 'qq_nga 没有被注册').toBeDefined();
    const declared = new Set(Object.keys(nga!.output?.schema?.properties ?? {}));
    expect(declared.size, 'schema 里一个属性都没有 —— 提取失败了').toBeGreaterThan(0);

    const mustDeclare = [
      'ok', 'action', 'error',
      'forumName', 'totalPage', 'topics',
      'keyword', 'scope', 'needLogin',
      'forums', 'note',
      'subject', 'floors',
    ];
    const missing = mustDeclare.filter((f) => !declared.has(f));
    expect(missing, `这些字段会被返回但 schema 没声明 → 整个工具结果会被判 INVALID_TOOL_OUTPUT`).toEqual([]);
  });

  it('keyword/scope 不能在 topics.items 里（上一轮塞错层级的那个 bug）', () => {
    const block = toolBlock();
    const topicsAt = block.indexOf('topics: {');
    const topicsEnd = block.indexOf('// ── search', topicsAt);
    expect(topicsAt).toBeGreaterThan(-1);
    const topicsBlock = block.slice(topicsAt, topicsEnd === -1 ? topicsAt + 800 : topicsEnd);
    expect(topicsBlock).not.toContain('keyword:');
    expect(topicsBlock).not.toContain('scope:');
    expect(topicsBlock).not.toContain('forums:');
  });

  it('数组元素的 required 只引用它自己 properties 里有的字段', () => {
    // topics.items 的 required 里有 subject/author/replies/lastAt/tid
    const block = toolBlock();
    const m = block.match(/required: \['tid', 'subject', 'author', 'replies', 'lastAt'\]/);
    expect(m).not.toBeNull();
  });
});

describe('真实返回数据能通过 schema 校验', () => {
  it('三种动作的典型返回都不含未声明字段', async () => {
    const tools = registeredTools();
    const nga = tools.find((t) => t.name === 'qq_nga')!;
    const props = nga.output?.schema?.properties ?? {};
    const declared = new Set(Object.keys(props));

    // 这三种返回是代码里真的会产出的形状（照 execute 里的 return 抄的）
    const samples = [
      { ok: true, action: 'list', forumName: 'x', totalPage: 1, topics: [] },
      { ok: true, action: 'list', forums: [], note: 'y' },                       // 无 fid 时的版面表
      { ok: true, action: 'search', keyword: 'k', scope: { kind: 'site' }, totalPage: 1, topics: [] },
      { ok: true, action: 'read', subject: 's', totalPage: 1, floors: [] },
      { ok: false, action: 'search', error: 'e', needLogin: true },
    ];

    for (const sample of samples) {
      const extra = Object.keys(sample).filter((k) => !declared.has(k));
      expect(extra, `返回 ${JSON.stringify(Object.keys(sample))} 里的 ${extra.join(',')} 未在 schema 声明`).toEqual([]);
    }
  });
});

describe('负数 fid 在工具层也要放过（不只是 client 层）', () => {
  it('tools.ts 的 fid 校验不能用 <= 0（否则负数版面被当成"没给"）', () => {
    const src = readFileSync(
      '/root/Documents/deepseek-harness/default-workspace/dsh-qqbot/src/nga/tools.ts',
      'utf8',
    );
    // 找 qq_nga 的 execute，确认校验条件是 fid === 0 而不是 fid <= 0
    const i = src.indexOf("name: 'qq_nga',");
    const seg = src.slice(i, src.indexOf("name: 'qq_nga_login'", i));
    // 只看**代码行**（排除注释）—— 注释里写 "不能用 fid <= 0" 是正确的说明
    const codeLines = seg.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    const code = codeLines.join('\n');
    expect(code, 'qq_nga 里不该出现 fid <= 0（会把负数版面误判为没给）').not.toContain('fid <= 0');
    expect(code, '应该用 fid === 0 作"没指定"的哨兵').toContain('fid === 0');
  });

  it('search 的 fid 判断也允许负数', () => {
    const src = readFileSync(
      '/root/Documents/deepseek-harness/default-workspace/dsh-qqbot/src/nga/tools.ts',
      'utf8',
    );
    const i = src.indexOf("name: 'qq_nga',");
    const seg = src.slice(i, src.indexOf("name: 'qq_nga_login'", i));
    const code = seg.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(code).not.toContain('fidNum > 0');
    expect(code).toContain('fidNum !== 0');
  });
});
