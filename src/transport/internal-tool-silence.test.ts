/**
 * 内部工具错误静默 · 回归测试（2026-11-02 实测事故）
 * ─────────────────────────────────────────────────────────────
 * 小羽调 bash 失败，QQ 里出现「（这个操作没成功：bash）」——
 * 用户看到莫名其妙的技术噪音。
 *
 * 内部工具（bash/read/write/grep…）是"她干活的手段"，不是"要对用户说的话"，
 * 失败不该上台面。
 */
import { describe, expect, it } from 'vitest';
import { formatToolResult } from './tool-presenter.ts';

const fail = (name: string) => formatToolResult(
  name, '{}',
  { error: { name: 'ExecError', code: 'EPERM' } } as never,
  undefined, undefined,
);

describe('内部工具失败 → 静默', () => {
  it('bash 失败不展示（这就是事故里的那句）', () => {
    expect(fail('bash')).toBeNull();
  });

  it('其他内部工具同样静默', () => {
    for (const t of ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'terminal_open']) {
      expect(fail(t), t).toBeNull();
    }
  });

  it('工具不存在也静默（UNKNOWN_TOOL 老问题）', () => {
    const out = formatToolResult('wait_agent', '{}',
      { error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } } as never, undefined, undefined);
    expect(out).toBeNull();
  });

  it('面向用户的自有工具失败仍给一句人话', () => {
    const out = fail('qq_browse');
    expect(out).toBeTruthy();
    expect(out).toContain('没成功');
    expect(out).not.toContain('EPERM');
  });
});

describe('anchor · 不汇报内部过程', () => {
  it('anchor 里明确禁止讲排查过程', async () => {
    const { POST_HISTORY_ANCHOR } = await import('../persona/role.ts');
    expect(POST_HISTORY_ANCHOR).toContain('查资料、跑命令、翻文件的过程不要讲给对方听');
    expect(POST_HISTORY_ANCHOR).toContain('对方只要结论');
  });

  it('anchor 要求先试再用，不要先列清单', async () => {
    const { POST_HISTORY_ANCHOR } = await import('../persona/role.ts');
    expect(POST_HISTORY_ANCHOR).toContain('先试着用');
  });
});
