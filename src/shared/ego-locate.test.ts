/**
 * ego 可选依赖定位测试
 * ─────────────────────────────────────────────────────────────
 * 这个模块存在的理由就是「别再硬编码部署路径」。所以测试的核心是**降级行为**：
 * 找不到时必须返回 undefined，调用方能据此优雅关掉功能，而不是抛 ENOENT。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { locateEgo, egoUnavailableHint, resetEgoCache } from './ego-locate.ts';

describe('locateEgo', () => {
  it('本机 profile 里装了 dsh-ego-browser → 解析出真实存在的两个文件', () => {
    resetEgoCache();
    const ego = locateEgo({ fresh: true });
    if (ego === undefined) {
      // 这台机器没装 ego 也是合法状态（可选依赖），但那就跳过这条断言
      expect(egoUnavailableHint()).toContain('可选');
      return;
    }
    expect(ego.bin).toMatch(/ego-browser\.mjs$/);
    expect(ego.chrome).toMatch(/ego-chrome-wrapper\.sh$/);
    expect(ego.root).toContain('dsh-ego-browser');
  });

  it('指定一个没有 node_modules 的 profile → undefined（不抛）', () => {
    resetEgoCache();
    const dir = mkdtempSync(join(tmpdir(), 'ego-locate-'));
    try {
      expect(locateEgo({ profileDir: dir, fresh: true })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('包目录在但缺 runtime 文件 → undefined（半个安装等于没装）', () => {
    resetEgoCache();
    const dir = mkdtempSync(join(tmpdir(), 'ego-locate-'));
    try {
      const pkg = join(dir, 'node_modules', 'dsh-ego-browser');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-ego-browser', version: '0.9.7' }), 'utf8');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake-profile' }), 'utf8');
      expect(locateEgo({ profileDir: dir, fresh: true })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('包装好的情形能解析（模拟真实布局）', () => {
    resetEgoCache();
    const dir = mkdtempSync(join(tmpdir(), 'ego-locate-'));
    try {
      const pkg = join(dir, 'node_modules', 'dsh-ego-browser');
      mkdirSync(join(pkg, 'runtime', 'ego-linux', 'bin'), { recursive: true });
      mkdirSync(join(pkg, 'bin'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-ego-browser' }), 'utf8');
      writeFileSync(join(pkg, 'runtime', 'ego-linux', 'bin', 'ego-browser.mjs'), '// stub', 'utf8');
      writeFileSync(join(pkg, 'bin', 'ego-chrome-wrapper.sh'), '#!/bin/sh', 'utf8');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake-profile' }), 'utf8');

      const ego = locateEgo({ profileDir: dir, fresh: true });
      expect(ego).toBeDefined();
      expect(ego!.bin).toContain('ego-browser.mjs');
      expect(ego!.chrome).toContain('ego-chrome-wrapper.sh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缓存生效：第二次不传 fresh 时复用同一个结果', () => {
    resetEgoCache();
    const a = locateEgo({ fresh: true });
    const b = locateEgo();
    expect(b).toEqual(a);
  });
});

describe('egoUnavailableHint', () => {
  it('说明是可选依赖，并讲清「不装也不影响主体功能」', () => {
    const hint = egoUnavailableHint();
    expect(hint).toContain('可选');
    expect(hint).toMatch(/聊天|日记|记忆|B 站/);
    expect(hint).toContain('dsh-ego-browser');
  });
});
