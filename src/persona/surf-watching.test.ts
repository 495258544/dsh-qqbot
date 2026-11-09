/**
 * 冲浪产物落进 watching（2026-11-06）
 * ─────────────────────────────────────────────────────────────
 * ## 要解决的问题
 *
 * `findings`（冲浪搜到的情报）**只写不读** —— 全仓搜过，除了写入没有任何消费端，
 * `buildSections()` 注入的是 watching 而不是 findings。
 * 于是冲浪搜到的东西除了那一次投递就消失了，既不成"情报"也不成"经历"，
 * 她自己的日子留不下来。
 *
 * 而实测她的冲浪回复是**开头读后感、后面滑成总结**：
 *   「一条是澎湃上的《花式咖啡、小甜水的快乐》，作者说自己从前是纯苦咖啡的
 *     死硬派——光这一句我就想读下去。」      ← 读后感
 *   「最后那篇顺带给了个选豆的原则：新手选中烘阿拉比卡，酸甜平衡，
 *     坚果巧克力调性最友好…」                ← 纯总结，无态度
 *
 * 缺的是「她自己的反应留得下来」。所以：冲浪看过的东西要落进 watching，
 * 让她下次记得自己看过；感受由她自己补（qq_note_watched），
 * **系统不替她写感受** —— 替她写就又变成总结她了。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfProfileService } from './self.ts';

function tmpSelf(): { self: SelfProfileService; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-watch-'));
  return { self: new SelfProfileService(dir, () => {}), dir };
}

const FINDINGS = [
  {
    title: '司令官C40磨豆机刻度怎么调？手冲、摩卡壶、法压壶粗细刻度一次看懂',
    url: 'https://www.makecoffee.cn/archives133286',
    summary: '原厂建议手冲 22–32 格',
  },
  {
    title: '手冲咖啡进阶指南:从研磨到注水',
    url: 'https://blog.csdn.net/x/article/details/1',
    summary: '粉水比 1:15',
  },
];

describe('冲浪产物 → watching', () => {
  it('落进 watching 后，renderWatching 能注入「今天看的《…》」', () => {
    const { self, dir } = tmpSelf();
    try {
      for (const f of FINDINGS) {
        self.addWatching({ title: f.title, ref: f.url, done: true });
      }
      const sec = self.renderWatching(4);
      expect(sec).toContain('你最近看过的东西');
      expect(sec).toContain('司令官C40磨豆机刻度怎么调');
      expect(sec).toContain('手冲咖啡进阶指南');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('她补一句感受后，注入变成「当时记了一句：…」——这才是读后感', () => {
    const { self, dir } = tmpSelf();
    try {
      for (const f of FINDINGS) {
        self.addWatching({ title: f.title, ref: f.url, done: true });
      }
      // 她自己调用 qq_note_watched 补感受
      self.addWatching({
        title: FINDINGS[0]!.title,
        ref: FINDINGS[0]!.url,
        note: '原来手冲要 22-32 格，我一直以为 16 格就够',
      });
      const sec = self.renderWatching(4);
      expect(sec).toContain('当时记了一句：');
      expect(sec).toContain('我一直以为 16 格就够');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('系统不替她写感受：只有标题，没有「当时记了一句」', () => {
    const { self, dir } = tmpSelf();
    try {
      for (const f of FINDINGS) {
        self.addWatching({ title: f.title, ref: f.url, done: true });
      }
      expect(self.renderWatching(4)).not.toContain('当时记了一句');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同一 URL 重复冲浪不会堆重复条目（ref 去重）', () => {
    const { self, dir } = tmpSelf();
    try {
      for (let i = 0; i < 3; i++) {
        for (const f of FINDINGS) {
          self.addWatching({ title: f.title, ref: f.url, done: true });
        }
      }
      const sec = self.renderWatching(10);
      const occurrences = sec.split('司令官C40磨豆机刻度怎么调').length - 1;
      expect(occurrences).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('补感受不会把标题冲掉（addWatching 的原有语义）', () => {
    const { self, dir } = tmpSelf();
    try {
      self.addWatching({ title: '某篇文章', ref: 'u1' });
      self.addWatching({ title: '某篇文章', ref: 'u1', note: '我的一句话' });
      const sec = self.renderWatching(4);
      expect(sec).toContain('某篇文章');
      expect(sec).toContain('我的一句话');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
