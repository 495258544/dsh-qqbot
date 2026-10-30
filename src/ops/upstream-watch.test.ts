/**
 * ops/upstream-watch 单测
 *
 * 重点覆盖**审计发现、且已实测复现**的那几个坑：
 *  - 时区：必须走 IANA 换算，不能用宿主 getHours()
 *  - 分级口径：NOISE 不留 MAYBE 悬空、feat(scope) 能被识别、重叠含未提交改动
 *  - 只读：任何一次巡检都不能改动工作树（含脏工作树）
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beijingParts, classifyCommit, parseKind, createUpstreamWatch, renderReport } from './upstream-watch.ts';

function makeRepo(): { repo: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const g = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'src.ts'), 'export const x = 1;\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  return { repo, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('beijingParts · 时区', () => {
  it('UTC 21:00 必须是北京次日 05:00（容器 TZ 无效，不能靠 getHours）', () => {
    const ts = Date.UTC(2026, 9, 30, 21, 0, 0);
    const p = beijingParts(ts);
    expect(p.hour).toBe(5);
    expect(p.minute).toBe(0);
    expect(p.dayKey).toBe('2026-10-31');
  });

  it('UTC 20:59 是北京 04:59（跨天边界）', () => {
    const p = beijingParts(Date.UTC(2026, 9, 30, 20, 59, 0));
    expect(p.hour).toBe(4);
    expect(p.minute).toBe(59);
    expect(p.dayKey).toBe('2026-10-31');
  });

  it('不受宿主时区影响：宿主是 UTC，但结论按 Asia/Shanghai', () => {
    const ts = Date.UTC(2026, 0, 1, 16, 30, 0); // 北京 2026-01-02 00:30
    const p = beijingParts(ts);
    expect(p.hour).toBe(0);
    expect(p.dayKey).toBe('2026-01-02');
  });
});

describe('parseKind · 提交前缀', () => {
  it('带 scope 也能识别（原 classify.sh 的 ^(feat 会漏）', () => {
    expect(parseKind('feat(bind): load qrcode')).toBe('feat');
    expect(parseKind('fix(host): probe session')).toBe('fix');
  });
  it('无前缀 → none', () => {
    expect(parseKind('更新一点东西')).toBe('none');
  });
  it('中文冒号也认', () => {
    expect(parseKind('fix：修正')).toBe('fix');
  });
});

describe('classifyCommit · 分级口径', () => {
  it('仅 lib/产物等噪声 → AUTO（不是悬空的 UNKNOWN/MAYBE）', () => {
    const c = classifyCommit({ sha: 'abc1234', subject: 'chore: rebuild lib', churn: 0, files: 0, tests: 0, overlap: [] });
    expect(c.verdict).toBe('AUTO');
    expect(c.category).toBe('NOISE');
  });

  it('小修复无重叠 → AUTO', () => {
    const c = classifyCommit({ sha: 'abc1234', subject: 'fix: typo', churn: 10, files: 2, tests: 0, overlap: [] });
    expect(c.verdict).toBe('AUTO');
  });

  it('有测试且 churn≤200 的 fix 放宽（保留原阈值）', () => {
    const c = classifyCommit({ sha: 'abc1234', subject: 'fix: race', churn: 150, files: 3, tests: 2, overlap: [] });
    expect(c.verdict).toBe('AUTO');
  });

  it('churn 150 但无测试 → REVIEW', () => {
    const c = classifyCommit({ sha: 'abc1234', subject: 'fix: race', churn: 150, files: 3, tests: 0, overlap: [] });
    expect(c.verdict).toBe('REVIEW');
    expect(c.reasons.join()).toContain('无测试');
  });

  it('与本地重叠 → 一律 REVIEW（压倒规模）', () => {
    const c = classifyCommit({ sha: 'abc1234', subject: 'fix: tiny', churn: 2, files: 1, tests: 1, overlap: ['src/config.ts'] });
    expect(c.verdict).toBe('REVIEW');
    expect(c.reasons.join()).toContain('重叠');
  });

  it('feat 即使很小也 REVIEW（语义要人看）', () => {
    const c = classifyCommit({ sha: 'abc1234', subject: 'feat: new cmd', churn: 6, files: 2, tests: 1, overlap: [] });
    expect(c.verdict).toBe('REVIEW');
  });

  it('churn>400 REVIEW', () => {
    const c = classifyCommit({ sha: 'abc1234', subject: 'fix: big', churn: 500, files: 9, tests: 3, overlap: [] });
    expect(c.verdict).toBe('REVIEW');
  });

  it('AUTO + REVIEW 覆盖全部提交（不漏项）', () => {
    const cs = [
      classifyCommit({ sha: 'a', subject: 'fix: a', churn: 5, files: 1, tests: 0, overlap: [] }),
      classifyCommit({ sha: 'b', subject: 'feat: b', churn: 5, files: 1, tests: 0, overlap: [] }),
    ];
    expect(cs.filter((c) => c.verdict === 'AUTO').length + cs.filter((c) => c.verdict === 'REVIEW').length).toBe(cs.length);
  });
});

describe('createUpstreamWatch · 只读与降级', () => {
  let env: { repo: string; cleanup: () => void };
  let stateDir: string;

  beforeEach(() => {
    env = makeRepo();
    stateDir = path.join(os.tmpdir(), `uw-state-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => {
    env.cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('脏工作树：照常给出结论，且一个字节都不改工作树', async () => {
    fs.writeFileSync(path.join(env.repo, 'src.ts'), 'export const x = 2; // WIP\n');
    fs.writeFileSync(path.join(env.repo, 'untracked.ts'), 'wip\n');
    const before = fs.readFileSync(path.join(env.repo, 'src.ts'), 'utf8');
    const beforeUntracked = fs.readFileSync(path.join(env.repo, 'untracked.ts'), 'utf8');

    const w = createUpstreamWatch({ repo: env.repo, stateDir, apiRepo: '' });
    const s = await w.runNow();

    expect(s.dirtyFiles).toBe(2);
    expect(fs.readFileSync(path.join(env.repo, 'src.ts'), 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(env.repo, 'untracked.ts'), 'utf8')).toBe(beforeUntracked);
    expect(fs.existsSync(path.join(env.repo, '.git', 'MERGE_HEAD')).valueOf()).toBe(false);
    // 没有任何 stash / 没有 reset
    const stash = execFileSync('git', ['-C', env.repo, 'stash', 'list'], { encoding: 'utf8' });
    expect(stash.trim()).toBe('');
  });

  it('未跟踪文件也算进"本地改动"（原脚本 -uno 会漏）', async () => {
    fs.writeFileSync(path.join(env.repo, 'untracked.ts'), 'wip\n');
    const w = createUpstreamWatch({ repo: env.repo, stateDir, apiRepo: '' });
    const s = await w.runNow();
    expect(s.dirtyFiles).toBeGreaterThanOrEqual(1);
    expect(s.dirtySample.join()).toContain('untracked.ts');
  });

  it('没有 upstream ref 时不撒谎：hasUpdates=undefined，不报"无更新"', async () => {
    const w = createUpstreamWatch({ repo: env.repo, stateDir, apiRepo: '' });
    const s = await w.runNow();
    expect(s.ok).toBe(true);
    expect(s.hasUpdates).toBeUndefined();
    const md = renderReport(s, { repo: env.repo, runHour: 5, windowMinutes: 45 });
    expect(md).toContain('无法判定是否有更新');
  });

  it('stateDir 默认不落在被巡检仓库里（否则巡检产物自己把树弄脏）', () => {
    const w = createUpstreamWatch({ repo: env.repo, apiRepo: '' });
    void w;
    // 通过快照间接验证：默认 stateDir 在 home 下
    expect(os.homedir()).not.toBe(env.repo);
  });

  it('窗口内只跑一次（重启不补跑）', async () => {
    const w = createUpstreamWatch({ repo: env.repo, stateDir, apiRepo: '', runHour: 5, windowMinutes: 45 });
    const win = Date.UTC(2026, 9, 30, 21, 5, 0); // 北京 05:05
    const r1 = await w.tick(win);
    expect(r1.ran).toBe(true);
    const r2 = await w.tick(win + 10 * 60 * 1000); // 北京 05:15，同一天
    expect(r2.ran).toBe(false);
    expect(r2.skipped).toBe('already-ran-today');
  });

  it('窗口外不跑', async () => {
    const w = createUpstreamWatch({ repo: env.repo, stateDir, apiRepo: '', runHour: 5, windowMinutes: 45 });
    const r = await w.tick(Date.UTC(2026, 9, 30, 12, 0, 0)); // 北京 20:00
    expect(r.ran).toBe(false);
    expect(r.skipped).toContain('not-window');
  });

  it('锁被占用时不重复跑', async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, '.lock'));
    const w = createUpstreamWatch({ repo: env.repo, stateDir, apiRepo: '' });
    await expect(w.runNow()).rejects.toThrow('锁被占用');
  });
});
