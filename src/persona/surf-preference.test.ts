/**
 * 她的冲浪姿态偏好（M-surf-pref，2026-11-06）
 * ─────────────────────────────────────────────────────────────
 * 设计边界：冲浪的机制（时段/频率/引擎/质量闸/提示骨架）归代码，她改不了；
 * 她能调的是**姿态** —— 这次想留意什么方向、结果希望怎么被自己记住。
 * 这与 qq_mark_interest 同一性质：自主性长在内容上，不长在机制上。
 *
 * 提示组装 = 固定骨架 + 偏好段（有才出现，无 = 行为与从前完全一致）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfProfileService } from './self.ts';

function tmpSelf(): { self: SelfProfileService; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-pref-'));
  return { self: new SelfProfileService(dir, () => {}), dir };
}

/** 与 notifySurfResults 相同的组装逻辑（骨架 + 偏好段） */
function buildPrompt(pref: { focus?: string; digestAs?: string } | undefined): string {
  const lines: string[] = ['[内部·你刚自己上网看的东西，不用复述本提示]'];
  if (pref !== undefined) {
    const bits: string[] = [];
    if (pref.focus) bits.push(`你之前留过话，这次想留意：${pref.focus}`);
    if (pref.digestAs) bits.push(`你希望把结果记成：${pref.digestAs}`);
    if (bits.length > 0) lines.push(`[你自己的冲浪姿态 —— ${bits.join('；')}]`);
  }
  lines.push('关于「手冲咖啡」：', '- 某篇教程：粉水比 1:15');
  return lines.join('\n');
}

describe('冲浪姿态偏好', () => {
  it('默认无偏好 → 提示与从前完全一致（不出现偏好段）', () => {
    const { self, dir } = tmpSelf();
    try {
      expect(self.surfPreference()).toBeUndefined();
      const prompt = buildPrompt(self.surfPreference());
      expect(prompt).not.toContain('冲浪姿态');
      expect(prompt).toContain('粉水比'); // 结果照常
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('设置 focus → 偏好段出现在提示开头，内容带"你之前留过话"的措辞', () => {
    const { self, dir } = tmpSelf();
    try {
      self.setSurfPreference({ focus: '最近的 C40 实战帖' });
      const prompt = buildPrompt(self.surfPreference());
      expect(prompt).toContain('[你自己的冲浪姿态 —— 你之前留过话，这次想留意：最近的 C40 实战帖]');
      // 骨架仍在（安全边界是代码定的）
      expect(prompt).toContain('不用复述本提示');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('清空（空串）→ 整个偏好回到 undefined，不留 {"focus":""} 空壳', () => {
    const { self, dir } = tmpSelf();
    try {
      self.setSurfPreference({ focus: 'C40' });
      self.setSurfPreference({ focus: '' });
      expect(self.surfPreference()).toBeUndefined();
      expect(buildPrompt(self.surfPreference())).not.toContain('冲浪姿态');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('digestAs=null 是显式清除该项；undefined 是不动', () => {
    const { self, dir } = tmpSelf();
    try {
      self.setSurfPreference({ focus: 'C40', digestAs: '一句反应加出处' });
      // undefined → digestAs 保留
      self.setSurfPreference({ focus: '注水手法' });
      expect(self.surfPreference()?.digestAs).toBe('一句反应加出处');
      // null → 清除
      self.setSurfPreference({ focus: '注水手法', digestAs: null });
      expect(self.surfPreference()?.digestAs).toBeUndefined();
      expect(self.surfPreference()?.focus).toBe('注水手法');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('超长输入被截断到 200 字（防一条便条写成长文）', () => {
    const { self, dir } = tmpSelf();
    try {
      const long = '测'.repeat(500);
      self.setSurfPreference({ focus: long });
      expect(self.surfPreference()?.focus?.length).toBe(200);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('持久化：重新加载后偏好还在（写进 self.json）', () => {
    const { self, dir } = tmpSelf();
    let reloaded: SelfProfileService;
    try {
      self.setSurfPreference({ focus: 'C40 实战' });
      reloaded = new SelfProfileService(dir, () => {});
    } finally {
      // dir 在断言后再删
    }
    try {
      expect(reloaded.surfPreference()?.focus).toBe('C40 实战');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
