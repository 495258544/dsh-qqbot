/**
 * 工具报错不泄露 · 回归测试
 * ─────────────────────────────────────────────────────────────
 * 真实事故（2026-11-01）：
 *   小羽试图调用不存在的 wait_agent，私聊里直接冒出
 *     ❌ 工具 `wait_agent` 执行失败
 *     `ToolNotFoundError: UNKNOWN_TOOL`
 *
 * 两个问题叠在一起：
 *   ① 她调用了自己根本没有的工具（能力边界不清）
 *   ② 技术报错原样发给用户（比不说更糟）
 *
 * 这里锁住 ②：工具不存在时静默丢弃，其他失败也只给人话。
 */
import { describe, expect, it } from 'vitest';
import { formatToolResult } from '../transport/tool-presenter.ts';

describe('工具报错 · 不把技术细节泄露给用户', () => {
  it('UNKNOWN_TOOL（工具不存在）→ 完全不展示', () => {
    const out = formatToolResult(
      'wait_agent', '{}',
      { error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } } as never,
      undefined, undefined,
    );
    expect(out).toBeNull();
  });

  it('其他错误 → 只给人话，不带错误码', () => {
    const out = formatToolResult(
      'qq_browse', '{}',
      { error: { name: 'NetworkError', code: 'ETIMEDOUT' } } as never,
      undefined, undefined,
    );
    expect(out).toBeTruthy();
    expect(out).not.toContain('ETIMEDOUT');
    expect(out).not.toContain('NetworkError');
    expect(out).toContain('没成功');
  });
});

describe('工具报错 · 通用 NOT_FOUND 不能被当成"工具不存在"', () => {
  // 2026-11-03：原来的正则是 /UNKNOWN_TOOL|NOT_FOUND|ToolNotFound|not found/i，
  // 把 COMMAND_NOT_FOUND / FILE_NOT_FOUND / `bash: not found` / ENOENT 全判成
  // "工具没注册" → return null → 消息凭空消失，用户连一句"没成功"都收不到。
  it('COMMAND_NOT_FOUND / FILE_NOT_FOUND / ENOENT 都要给一句人话', () => {
    for (const code of ['COMMAND_NOT_FOUND', 'FILE_NOT_FOUND', 'ENOENT', 'bash: not found']) {
      const out = formatToolResult(
        'qq_bili_check',
        '{}',
        { error: { name: 'CommandError', code } } as never,
        undefined,
        undefined,
      );
      expect(out, `${code} 不该被静默丢弃`).not.toBeNull();
      expect(out).toContain('没成功');
    }
  });

  it('真正的"工具不存在"仍然静默（这条不能被上面的放宽破坏）', () => {
    for (const code of ['UNKNOWN_TOOL', 'ToolNotFound']) {
      const out = formatToolResult(
        'wait_agent',
        '{}',
        { error: { name: 'ToolNotFoundError', code } } as never,
        undefined,
        undefined,
      );
      expect(out, `${code} 应该仍然静默`).toBeNull();
    }
  });
});
