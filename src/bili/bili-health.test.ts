/**
 * bili 字段自检的测试
 * ─────────────────────────────────────────────────────────────
 * 这组测试防的是**静默失效**：bili 升级改了字段，我们拿到 undefined，
 * 功能悄悄坏掉，日志里什么都没有。
 *
 * 这个仓库已经因为"坏了不响"吃过太多次亏，所以自检的意义不是"能检查"，
 * 而是"该响的时候一定响"。
 */
import { describe, expect, it } from 'vitest';
import { checkBiliHealth, BILI_DEPS, formatHealthIssues } from './bili-health.ts';

/** 造一个按 args 分派的假 run */
const fakeRun = (map: Record<string, unknown>) => (args: string[]) => {
  const key = args.join(' ');
  for (const [k, v] of Object.entries(map)) {
    if (key.startsWith(k)) return v;
  }
  return { ok: true, data: {} };
};

const healthy = () => ({
  'video subtitle': { ok: true, data: { items: [{ from: 0.1, to: 1, content: '你好' }] } },
  'video info': { ok: true, data: { title: 'T', pages: [{ page: 1, title: 'P1', duration: 60 }] } },
  'video summary': { ok: true, data: { summary: '这是总结' } },
  'video danmaku': { ok: true, data: { peaks: [] } },
});

describe('checkBiliHealth · 全部正常', () => {
  it('字段齐全时返回空数组', () => {
    expect(checkBiliHealth({ run: fakeRun(healthy()) })).toEqual([]);
  });

  it('peaks 是空数组**不算错**（很多视频没弹幕）', () => {
    // 实测：10.5 小时的教学合集只有 15 条弹幕且时间轴全 0，peaks 返回 []
    // 这是正常结果，不是字段缺失
    const issues = checkBiliHealth({ run: fakeRun(healthy()) });
    expect(issues.filter((i) => i.what.includes('peaks'))).toEqual([]);
  });
});

describe('checkBiliHealth · 字段变了要响', () => {
  it('字幕缺 from（时间轴）→ missing-field', () => {
    // 这是最关键的一项：没有时间轴，"哪几分钟讲到东西"就退化成"整段倒出来"
    const map = healthy();
    map['video subtitle'] = { ok: true, data: { items: [{ content: '你好' }] } };
    const issues = checkBiliHealth({ run: fakeRun(map) });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reason).toBe('missing-field');
    expect(issues[0]!.what).toContain('时间轴');
  });

  it('字幕 items 变空数组 → missing-field', () => {
    const map = healthy();
    map['video subtitle'] = { ok: true, data: { items: [] } };
    expect(checkBiliHealth({ run: fakeRun(map) })[0]!.reason).toBe('missing-field');
  });

  it('pages 里的 title 改名 → missing-field', () => {
    const map = healthy();
    map['video info'] = { ok: true, data: { title: 'T', pages: [{ page: 1, part: 'P1', duration: 60 }] } };
    const issues = checkBiliHealth({ run: fakeRun(map) });
    expect(issues[0]!.what).toContain('分 P 目录');
  });

  it('summary 变成 null → missing-field', () => {
    const map = healthy();
    map['video summary'] = { ok: true, data: { summary: null } };
    expect(checkBiliHealth({ run: fakeRun(map) })[0]!.reason).toBe('missing-field');
  });
});

describe('checkBiliHealth · 命令层面失败', () => {
  it('ok=false → not-ok，并带上 bili 自己的 message', () => {
    const map = healthy();
    map['video subtitle'] = { ok: false, error: { code: 'not_found', message: '该视频没有字幕' } };
    const issues = checkBiliHealth({ run: fakeRun(map) });
    expect(issues[0]!.reason).toBe('not-ok');
    expect(issues[0]!.detail).toContain('没有字幕');
  });

  it('run 抛异常 → command-failed，**不向上抛**', () => {
    const run = () => { throw new Error('boom'); };
    const issues = checkBiliHealth({ run });
    // 4 项全部失败，但函数本身没抛
    expect(issues).toHaveLength(BILI_DEPS.length);
    expect(issues.every((i) => i.reason === 'command-failed')).toBe(true);
  });

  it('bili 不存在（ENOENT）→ command-failed', () => {
    const run = () => { throw new Error('spawnSync bili ENOENT'); };
    const issues = checkBiliHealth({ run });
    expect(issues.every((i) => i.reason === 'command-failed')).toBe(true);
  });

  it('超时 → timeout 而不是 command-failed', () => {
    const run = () => { throw new Error('ETIMEDOUT'); };
    const issues = checkBiliHealth({ run });
    expect(issues.every((i) => i.reason === 'timeout')).toBe(true);
  });

  it('返回非对象 → command-failed', () => {
    for (const bad of [null, 'str', 42]) {
      const issues = checkBiliHealth({ run: () => bad });
      expect(issues.every((i) => i.reason === 'command-failed')).toBe(true);
    }
  });
});

describe('checkBiliHealth · 项与项互不影响', () => {
  it('一项炸了，其它项照常检查', () => {
    const map = healthy();
    map['video info'] = { ok: false, error: { message: '挂了' } };
    const issues = checkBiliHealth({ run: fakeRun(map) });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.what).toContain('分 P 目录');
  });

  it('每项都会被检查一次（不多不少）', () => {
    const seen: string[] = [];
    checkBiliHealth({
      run: (args) => { seen.push(args.join(' ')); return { ok: true, data: {} }; },
    });
    expect(seen).toHaveLength(BILI_DEPS.length);
  });
});

describe('formatHealthIssues', () => {
  it('没有问题时不输出（不打无意义的日志）', () => {
    expect(formatHealthIssues([])).toBe('');
  });

  it('有问题时一行说清楚哪项、为什么', () => {
    const s = formatHealthIssues([
      { what: '字幕时间轴', args: [], reason: 'missing-field', detail: '字段不存在' },
    ]);
    expect(s).toContain('字幕时间轴');
    expect(s).toContain('missing-field');
  });
});
