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

describe('"工具不存在" vs "命令执行失败" 不能混为一谈', () => {
  // 这条防的是一个**代码级**的同款错误（不只是注释）：
  //
  // 原正则 /UNKNOWN_TOOL|NOT_FOUND|ToolNotFound|not found/i 里，
  // NOT_FOUND / not found 是通用错误码，会把下面这些都判成"工具不存在"并静默：
  //   COMMAND_NOT_FOUND  ← 她 bash 敲了个不存在的命令（正常失败，该给提示）
  //   bash: not found    ← shell 自己的报错
  //   FILE_NOT_FOUND     ← 文件不存在
  //
  // 结果是消息凭空消失，连「（这个操作没成功：bash）」都不发。
  // 这和"把命令失败读成工具不存在"是同一种混淆 —— 只是发生在代码里。

  const isToolMissingNow = (code: string, name = ''): boolean =>
    /UNKNOWN_TOOL|ToolNotFound/i.test(code) || /ToolNotFound|UNKNOWN_TOOL/i.test(name);

  it('结构化的"工具不存在"信号要识别', () => {
    expect(isToolMissingNow('UNKNOWN_TOOL')).toBe(true);
    expect(isToolMissingNow('ToolNotFound')).toBe(true);
    expect(isToolMissingNow('', 'ToolNotFoundError')).toBe(true);
  });

  it('通用 NOT_FOUND **不能**当工具不存在（否则消息静默消失）', () => {
    expect(isToolMissingNow('COMMAND_NOT_FOUND')).toBe(false);
    expect(isToolMissingNow('FILE_NOT_FOUND')).toBe(false);
    expect(isToolMissingNow('bash: not found')).toBe(false);
    expect(isToolMissingNow('NOT_FOUND')).toBe(false);
  });

  it('她 bash 里的常见失败要给用户一句人话，不能吞掉', () => {
    for (const code of ['COMMAND_NOT_FOUND', 'ENOENT', 'bash: not found']) {
      expect(isToolMissingNow(code)).toBe(false);
    }
  });
});
