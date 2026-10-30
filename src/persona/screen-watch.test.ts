/**
 * M7/R7 看屏幕主动搭话 — 单元测试
 * ─────────────────────────────────────────────────────────────
 * 全部用 mock 探针：**不碰真机、不截图、不点屏幕**。
 * 重点覆盖隐私规则的"该拦的必须拦住"——这类规则的回归代价太高，
 * 宁可测多也不测少。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkForegroundApp,
  containsSensitiveText,
  isNotificationShade,
  focusDiverged,
  matchInterests,
  inActiveHours,
  parseDeviceOverview,
  parseWindowFocus,
  parseDumpContent,
  unwrapBridgeResult,
  renderScreenNudge,
  createScreenWatch,
  type ScreenProbe,
  type ScreenNudge,
} from './screen-watch.ts';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-watch-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 一台"健康"的 mock 手机：亮屏、前台是阅读 App、无障碍开着 */
function healthyProbe(overrides: Partial<{
  device: ReturnType<ScreenProbe['deviceOverview']> extends Promise<infer T> ? T : never;
  focus: ReturnType<ScreenProbe['windowFocus']> extends Promise<infer T> ? T : never;
  a11y: boolean | null;
  dump: ReturnType<ScreenProbe['screenText']> extends Promise<infer T> ? T : never;
}> = {}): ScreenProbe & { calls: string[] } {
  const calls: string[] = [];
  const probe = {
    calls,
    async deviceOverview() {
      calls.push('device');
      return 'device' in overrides
        ? overrides.device
        : { screen: 'on' as const, appForeground: true };
    },
    async windowFocus() {
      calls.push('focus');
      return 'focus' in overrides
        ? overrides.focus
        : {
            focusedAppPackage: 'com.qidian.QDReader',
            focusedAppClass: '.ui.activity.QDReaderActivity',
            currentFocusPackage: 'com.qidian.QDReader',
            currentFocusClass: '.ui.activity.QDReaderActivity',
            keyguardShowing: false,
          };
    },
    async accessibilityEnabled() {
      calls.push('a11y');
      return 'a11y' in overrides ? overrides.a11y : true;
    },
    async screenText() {
      calls.push('dump');
      return 'dump' in overrides
        ? overrides.dump
        : { packageName: 'com.qidian.QDReader', text: '第 3 章 咖啡与深夜的代码 / 评论 12', nodeCount: 20, truncated: false };
    },
  };
  return probe;
}

function watch(probe: ScreenProbe, extra: Partial<Parameters<typeof createScreenWatch>[0]> = {}) {
  const delivered: ScreenNudge[] = [];
  const log: string[] = [];
  const handle = createScreenWatch({
    probe,
    deliver: async (n) => {
      delivered.push(n);
      return { ok: true };
    },
    interests: () => [{ topic: '咖啡', weight: 0.6 }, { topic: '游戏', weight: 0.4 }],
    chattiness: () => 1.0,
    allowProactive: () => ({ ok: true }),
    markProactive: () => {},
    statePath: path.join(dir, 'state.json'),
    log: (m) => log.push(m),
    now: () => FIXED_NOW,
    ...extra,
  });
  return { handle, delivered, log };
}

/** 固定时间：2026-10-30 是周五，本地 12:00 —— 落在默认 [9,23) 时段内 */
const FIXED_NOW = new Date(2026, 9, 30, 12, 0, 0).getTime();

// ─────────────────────── 隐私规则：包名/Activity 黑名单 ───────────────────────

describe('隐私 · 包名与 Activity 黑名单（R1/R2/R6）', () => {
  it('支付/金融命中即拦（支付宝/微信/银联/银行）', () => {
    expect(checkForegroundApp('com.eg.android.AlipayGphone', undefined).reason).toBe('payment');
    expect(checkForegroundApp('com.tencent.mm', undefined).reason).toBe('payment');
    expect(checkForegroundApp('com.unionpay', undefined).reason).toBe('payment');
    expect(checkForegroundApp('com.icbc.mobilebank', undefined).reason).toBe('payment');
    expect(checkForegroundApp('cmbchina.app', undefined).reason).toBe('payment');
    expect(checkForegroundApp('com.example.wallet', undefined).reason).toBe('payment');
  });

  it('聊天工具一律不读（QQ/微博/TIM）', () => {
    expect(checkForegroundApp('com.tencent.mobileqq', undefined).reason).toBe('chat');
    expect(checkForegroundApp('com.sina.weibo', undefined).reason).toBe('chat');
    expect(checkForegroundApp('com.tencent.tim', undefined).reason).toBe('chat');
  });

  it('系统界面/桌面不算"在看的内容"', () => {
    expect(checkForegroundApp('com.android.systemui', undefined).reason).toBe('system-ui');
    expect(checkForegroundApp('com.miui.home', undefined).reason).toBe('system-ui');
  });

  it('密码/认证类包名', () => {
    expect(checkForegroundApp('com.example.authenticator', undefined).reason).toBe('auth');
    expect(checkForegroundApp('com.example.passwordmanager', undefined).reason).toBe('auth');
    expect(checkForegroundApp('com.evil.loginapp', undefined).reason).toBe('auth');
  });

  it('Activity 名关键词（支付/密码/确认/解锁…）', () => {
    const r = (cls: string) => checkForegroundApp('com.example.reader', cls);
    expect(r('.ui.PaymentActivity').reason).toBe('activity-keyword');
    expect(r('.ui.PasswordActivity').reason).toBe('activity-keyword');
    expect(r('.ui.TransferActivity').reason).toBe('activity-keyword');
    expect(r('.ui.RedPacketActivity').reason).toBe('activity-keyword');
    expect(r('.ui.UnlockActivity').reason).toBe('activity-keyword');
    expect(r('.ui.SetupWizardActivity').reason).toBe('activity-keyword');
    expect(r('.ui.LoginActivity').reason).toBe('activity-keyword');
    // 正常阅读页不受牵连
    expect(r('.ui.activity.QDReaderActivity').ok).toBe(true);
  });

  it('空包名 = 焦点未知，不猜', () => {
    expect(checkForegroundApp('', undefined).ok).toBe(false);
    expect(checkForegroundApp('  ', undefined).reason).toBe('unknown-focus');
  });

  it('普通 App 放行', () => {
    expect(checkForegroundApp('com.qidian.QDReader', '.ui.activity.QDReaderActivity').ok).toBe(true);
    expect(checkForegroundApp('com.bilibili.app', undefined).ok).toBe(true);
  });
});

// ─────────────────────── 白名单 ───────────────────────

describe('隐私 · 白名单（可配置，但只能收紧不能放宽黑名单）', () => {
  it('空白名单 = 不额外限制（黑名单仍生效）', () => {
    expect(checkForegroundApp('com.qidian.QDReader', undefined, []).ok).toBe(true);
    expect(checkForegroundApp('com.eg.android.AlipayGphone', undefined, []).reason).toBe('payment');
  });

  it('非空白名单只放行名单内的', () => {
    expect(checkForegroundApp('com.qidian.QDReader', undefined, ['com.qidian.QDReader']).ok).toBe(true);
    expect(checkForegroundApp('com.bilibili.app', undefined, ['com.qidian.QDReader']).reason).toBe('not-whitelisted');
  });

  it('白名单支持通配，但**不能**把黑名单放进白名单来放宽', () => {
    expect(checkForegroundApp('com.tencent.mobileqq', undefined, ['com.tencent.*']).reason).toBe('chat');
    expect(checkForegroundApp('com.eg.android.AlipayGphone', undefined, ['com.eg.*']).reason).toBe('payment');
    expect(checkForegroundApp('com.xjs.ehviewer', undefined, ['com.xjs.*']).ok).toBe(true);
  });
});

// ─────────────────────── 通知栏 / 锁屏 / 息屏 ───────────────────────

describe('隐私 · 通知栏盲区（实测踩过的坑）', () => {
  it('mCurrentFocus 含 NotificationShade → 判定为通知栏', () => {
    expect(isNotificationShade({
      currentFocusWindow: 'NotificationShade',
      focusedAppPackage: 'com.qidian.QDReader',
      keyguardShowing: false,
    })).toBe(true);
  });

  it('systemui 出现在任一侧焦点 → 通知栏', () => {
    expect(isNotificationShade({
      currentFocusWindow: 'Window{abc u0 com.android.systemui/NotificationShade}',
      currentFocusPackage: 'com.android.systemui',
      keyguardShowing: false,
    })).toBe(true);
    // 只有 mFocusedApp 是 systemui（下拉时的常见形态）
    expect(isNotificationShade({ focusedAppPackage: 'com.android.systemui', keyguardShowing: false })).toBe(true);
  });

  it('正常前台不会误判成通知栏', () => {
    expect(isNotificationShade({
      currentFocusWindow: 'Window{abc u0 com.qidian.QDReader/...}',
      currentFocusPackage: 'com.qidian.QDReader',
      focusedAppPackage: 'com.qidian.QDReader',
      keyguardShowing: false,
    })).toBe(false);
  });

  it('焦点分叉（当前窗口 ≠ 前台 App）= 有东西盖着 → 跳过', () => {
    expect(focusDiverged({
      focusedAppPackage: 'com.qidian.QDReader',
      currentFocusPackage: 'com.android.systemui',
      keyguardShowing: false,
    })).toBe(true);
    expect(focusDiverged({
      focusedAppPackage: 'com.qidian.QDReader',
      currentFocusPackage: 'com.qidian.QDReader',
      keyguardShowing: false,
    })).toBe(false);
    // 缺一边不作为证据
    expect(focusDiverged({ focusedAppPackage: 'com.qidian.QDReader', keyguardShowing: false })).toBe(false);
  });
});

describe('隐私 · 控件树文字特征（R3）', () => {
  it('敏感词命中', () => {
    for (const t of ['付款', '确认支付', '输入密码', '验证码', '指纹', '面容', '余额', '转账', '收款', '红包', '银行卡', '实名', '身份证']) {
      expect(containsSensitiveText(`屏幕上有 ${t} 字样`)).toBe(true);
    }
  });

  it('正常文字不误伤', () => {
    expect(containsSensitiveText('第 3 章 咖啡与深夜的代码')).toBe(false);
    expect(containsSensitiveText('B站 番剧 更新 第 2 集')).toBe(false);
  });
});

// ─────────────────────── 解析函数 ───────────────────────

describe('解析 · /app/device', () => {
  it('息屏', () => {
    expect(parseDeviceOverview('screen=off\napp_foreground=false')).toEqual({ screen: 'off', appForeground: false });
  });
  it('亮屏 + 前台', () => {
    expect(parseDeviceOverview('battery=98% charging=false\nscreen=on\napp_foreground=true'))
      .toEqual({ screen: 'on', appForeground: true });
  });
  it('拿不到 screen 字段 → null（不猜）', () => {
    expect(parseDeviceOverview('battery=98%')).toBeNull();
  });
  it('桥把结果再编码一层也能解开', () => {
    expect(parseDeviceOverview(unwrapBridgeResult('{"result":"screen=on\\napp_foreground=true"}'))
      ?.appForeground).toBe(true);
  });
});

describe('解析 · dumpsys window', () => {
  const sample = [
    '  mCurrentFocus=Window{e04f44d u0 dsh.android.client/com.deepseekharness.app.ui.WebPreviewActivity}',
    '  mFocusedApp=ActivityRecord{12030201 u0 dsh.android.client/com.deepseekharness.app.ui.WebPreviewActivity t21371}',
    '    KeyguardServiceDelegate',
    '      showing=false',
    '      inputRestricted=false',
  ].join('\n');

  it('取 mFocusedApp 的包名与 Activity（Android 16 没有 mResumedActivity）', () => {
    const f = parseWindowFocus(sample);
    expect(f.focusedAppPackage).toBe('dsh.android.client');
    expect(f.focusedAppClass).toBe('com.deepseekharness.app.ui.WebPreviewActivity');
    expect(f.keyguardShowing).toBe(false);
  });

  it('锁屏 showing=true → keyguardShowing', () => {
    const locked = sample.replace('showing=false', 'showing=true');
    expect(parseWindowFocus(locked).keyguardShowing).toBe(true);
  });

  it('isKeyguardShowing=true 也算锁屏', () => {
    expect(parseWindowFocus(`${sample}\n    isKeyguardShowing=true`).keyguardShowing).toBe(true);
  });

  it('没有焦点行时不编造', () => {
    const f = parseWindowFocus('dumpsys 里什么都没有');
    expect(f.focusedAppPackage).toBeUndefined();
    expect(f.currentFocusWindow).toBeUndefined();
  });
});

describe('解析 · /app/ui/dump', () => {
  it('真实回包形态（kind=dsha-screen-tree-v1）', () => {
    const raw = JSON.stringify({
      ok: true,
      code: 'SCREEN_COMPLETED',
      kind: 'dsha-screen-tree-v1',
      text: '窗口应用: com.xjs.ehviewer\n[1] "91%" 中心=(124,210)\n[2] "3/9" 中心=(600,210)',
      nodes: [{ text: '91%' }, { text: '3/9' }, { description: '目录' }],
      visited: 3,
      target: { packageName: 'com.xjs.ehviewer' },
    });
    const d = parseDumpContent(raw);
    expect(d).not.toBeNull();
    expect(d?.packageName).toBe('com.xjs.ehviewer');
    expect(d?.text).toContain('3/9');
    expect(d?.text).not.toContain('窗口应用'); // 抬头不算内容
    expect(d?.nodeCount).toBe(3);
    expect(d?.truncated).toBe(false);
  });

  it('200 节点上限 → truncated 标记', () => {
    const d = parseDumpContent(JSON.stringify({ ok: true, code: 'SCREEN_COMPLETED', nodes: [], visited: 200 }));
    expect(d?.truncated).toBe(true);
  });

  it('无障碍不可用（ok:false / ACCESSIBILITY_UNAVAILABLE）→ null，不当作空屏', () => {
    expect(parseDumpContent(JSON.stringify({
      ok: false,
      code: 'ACCESSIBILITY_UNAVAILABLE',
      error: 'ACCESSIBILITY_UNAVAILABLE',
    }))).toBeNull();
  });

  it('纯文本兜底', () => {
    expect(parseDumpContent('屏幕上就这几个字')?.text).toBe('屏幕上就这几个字');
  });
});

// ─────────────────────── 兴趣匹配 / 时段 ───────────────────────

describe('兴趣匹配', () => {
  it('命中并按权重降序', () => {
    const hits = matchInterests('今晚又煮了一杯咖啡，顺便打了会儿游戏', [
      { topic: '咖啡', weight: 0.3 },
      { topic: '游戏', weight: 0.8 },
    ]);
    expect(hits.map((h) => h.topic)).toEqual(['游戏', '咖啡']);
  });

  it('大小写不敏感', () => {
    expect(matchInterests('在用 VSCode 写 TypeScript', [{ topic: 'typescript', weight: 0.5 }])).toHaveLength(1);
  });

  it('单字话题不参与匹配（噪声太大）', () => {
    expect(matchInterests('今天喝水喝多了', [{ topic: '水', weight: 0.9 }])).toHaveLength(0);
  });

  it('没命中就是空数组', () => {
    expect(matchInterests('完全无关的新闻', [{ topic: '咖啡', weight: 0.9 }])).toEqual([]);
  });

  it('最多 3 条', () => {
    const hits = matchInterests('咖啡 游戏 猫 音乐', [
      { topic: '咖啡', weight: 0.9 }, { topic: '游戏', weight: 0.8 },
      { topic: '猫', weight: 0.7 }, { topic: '音乐', weight: 0.6 },
    ]);
    expect(hits).toHaveLength(3);
  });
});

describe('观察时段', () => {
  it('默认 [9,23) 不碰半夜', () => {
    expect(inActiveHours(new Date(2026, 9, 30, 12, 0), [9, 23])).toBe(true);
    expect(inActiveHours(new Date(2026, 9, 30, 8, 59), [9, 23])).toBe(false);
    expect(inActiveHours(new Date(2026, 9, 30, 23, 0), [9, 23])).toBe(false);
    expect(inActiveHours(new Date(2026, 9, 30, 2, 0), [9, 23])).toBe(false);
  });

  it('跨零点区间', () => {
    expect(inActiveHours(new Date(2026, 9, 30, 23, 30), [22, 6])).toBe(true);
    expect(inActiveHours(new Date(2026, 9, 30, 3, 0), [22, 6])).toBe(true);
    expect(inActiveHours(new Date(2026, 9, 30, 12, 0), [22, 6])).toBe(false);
  });
});

// ─────────────────────── 整轮流程（mock 探针） ───────────────────────

describe('整轮 · 该跳过的必须跳过（且不继续往下读）', () => {
  it('息屏：连 dumpsys 都不跑，绝不走到 dump/截图', async () => {
    const probe = healthyProbe({ device: { screen: 'off', appForeground: false } });
    const { handle, delivered } = watch(probe);
    const r = await handle.tick(FIXED_NOW);
    expect(r.skipped).toBe('screen-off');
    expect(delivered).toHaveLength(0);
    expect(probe.calls).toEqual(['device']); // 只跑了第 ① 层
  });

  it('App 不在前台 → 跳过', async () => {
    const probe = healthyProbe({ device: { screen: 'on', appForeground: false } });
    const { handle, delivered } = watch(probe);
    expect((await handle.tick(FIXED_NOW)).skipped).toBe('app-not-foreground');
    expect(delivered).toHaveLength(0);
    expect(probe.calls).toEqual(['device']);
  });

  it('锁屏 → 跳过', async () => {
    const probe = healthyProbe({
      focus: {
        focusedAppPackage: 'com.qidian.QDReader',
        currentFocusPackage: 'com.qidian.QDReader',
        keyguardShowing: true,
      },
    });
    const { handle, delivered } = watch(probe);
    expect((await handle.tick(FIXED_NOW)).skipped).toBe('keyguard');
    expect(probe.calls).toEqual(['device', 'focus']);
  });

  it('通知栏 → 跳过，且**不读 nodes/text**（最关键的一条）', async () => {
    const probe = healthyProbe({
      focus: {
        currentFocusWindow: 'NotificationShade',
        currentFocusPackage: 'com.android.systemui',
        focusedAppPackage: 'com.qidian.QDReader',
        keyguardShowing: false,
      },
    });
    const { handle, delivered } = watch(probe, { allowedApps: ['com.qidian.QDReader'] });
    const r = await handle.tick(FIXED_NOW);
    expect(r.skipped).toBe('notification-shade');
    expect(delivered).toHaveLength(0);
    expect(probe.calls).toEqual(['device', 'focus']); // 没走到 a11y / dump
  });

  it('焦点分叉（有窗口盖着）→ 跳过', async () => {
    const probe = healthyProbe({
      focus: {
        focusedAppPackage: 'com.qidian.QDReader',
        currentFocusPackage: 'com.miui.home',
        keyguardShowing: false,
      },
    });
    const { handle, delivered } = watch(probe, { allowedApps: [] });
    expect((await handle.tick(FIXED_NOW)).skipped).toBe('focus-diverged');
    expect(probe.calls).toEqual(['device', 'focus']);
  });

  it('前台是聊天工具 → 跳过，不读内容', async () => {
    const probe = healthyProbe({
      focus: { focusedAppPackage: 'com.tencent.mobileqq', currentFocusPackage: 'com.tencent.mobileqq', keyguardShowing: false },
    });
    const { handle } = watch(probe);
    expect((await handle.tick(FIXED_NOW)).skipped).toBe('chat');
    expect(probe.calls).toEqual(['device', 'focus']);
  });

  it('无障碍服务被 dsha 重启关掉 → 跳过（不假装读到空屏）', async () => {
    const probe = healthyProbe({ a11y: false });
    const { handle } = watch(probe);
    const r = await handle.tick(FIXED_NOW);
    expect(r.skipped).toBe('probe-failed');
    expect(r.error).toBe('accessibility-off');
    expect(probe.calls).toEqual(['device', 'focus', 'a11y']);
  });

  it('控件树里出现付款字样 → 整轮丢弃，内容不投递', async () => {
    const probe = healthyProbe({
      dump: { packageName: 'com.qidian.QDReader', text: '确认支付 ￥18 咖啡', nodeCount: 12, truncated: false },
    });
    const { handle, delivered } = watch(probe);
    expect((await handle.tick(FIXED_NOW)).skipped).toBe('sensitive-text');
    expect(delivered).toHaveLength(0);
  });

  it('dump 报告的窗口换了（systemui 盖上来）→ 丢弃已读内容', async () => {
    const probe = healthyProbe({
      dump: { packageName: 'com.android.systemui', text: '一条通知', nodeCount: 5, truncated: false },
    });
    const { handle, delivered } = watch(probe);
    expect((await handle.tick(FIXED_NOW)).skipped).toBe('notification-shade');
    expect(delivered).toHaveLength(0);
  });

  it('非白名单 App → 跳过', async () => {
    const { handle } = watch(healthyProbe(), { allowedApps: ['com.xjs.ehviewer'] });
    expect((await handle.tick(FIXED_NOW)).skipped).toBe('not-whitelisted');
  });

  it('半夜不看', async () => {
    const probe = healthyProbe();
    const { handle } = watch(probe, { activeHours: [9, 23] });
    expect((await handle.tick(new Date(2026, 9, 31, 3, 0).getTime())).skipped).toBe('quiet-hours');
    expect(probe.calls).toHaveLength(0);
  });

  it('间隔未到不重复探', async () => {
    const probe = healthyProbe();
    const { handle } = watch(probe, { intervalMs: 30 * 60 * 1000 });
    await handle.tick(FIXED_NOW);
    const r2 = await handle.tick(FIXED_NOW + 60 * 1000); // 一分钟后
    expect(r2.skipped).toBe('not-yet');
    expect(probe.calls).toHaveLength(4); // 只有第一轮跑满
  });
});

describe('整轮 · 该搭话的搭话', () => {
  it('兴趣命中 + 高话痨 + 预算允许 → 投递，且内容不含隐私原文整段', async () => {
    const probe = healthyProbe();
    const { handle, delivered } = watch(probe);
    const r = await handle.tick(FIXED_NOW);
    expect(r.ok).toBe(true);
    expect(r.topics).toEqual(['咖啡']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.packageName).toBe('com.qidian.QDReader');
    expect(delivered[0]?.snippet).toContain('咖啡');
    expect(handle.snapshot().nudgedToday).toBe(1);
  });

  it('话痨度 ≤ 0.5 不搭话', async () => {
    const probe = healthyProbe();
    const { handle, delivered } = watch(probe, { chattiness: () => 0.5 });
    expect((await handle.tick(FIXED_NOW)).skipped).toBe('low-chattiness');
    expect(delivered).toHaveLength(0);
  });

  it('预算闸不允许（例如连续没被理）→ 不搭话', async () => {
    const probe = healthyProbe();
    const { handle, delivered } = watch(probe, { allowProactive: () => ({ ok: false, reason: 'cooling' }) });
    const r = await handle.tick(FIXED_NOW);
    expect(r.skipped).toBe('budget:cooling');
    expect(delivered).toHaveLength(0);
  });

  it('兴趣权重低于 0.3 → 不算相关', async () => {
    const probe = healthyProbe();
    const { handle } = watch(probe, { interests: () => [{ topic: '咖啡', weight: 0.2 }] });
    expect((await handle.tick(FIXED_NOW)).skipped).toBe('no-interest');
  });

  it('和兴趣无关的内容不搭话', async () => {
    const probe = healthyProbe({
      dump: { packageName: 'com.qidian.QDReader', text: '天气预报 晴转多云', nodeCount: 8, truncated: false },
    });
    const { handle } = watch(probe);
    expect((await handle.tick(FIXED_NOW)).skipped).toBe('no-interest');
  });

  it('同一画面 10 分钟内不重复搭话', async () => {
    const probe = healthyProbe();
    const { handle, delivered } = watch(probe, { intervalMs: 1000, statePath: undefined });
    await handle.tick(FIXED_NOW);
    const r2 = await handle.tick(FIXED_NOW + 5 * 60 * 1000);
    expect(r2.skipped).toBe('same-content');
    expect(delivered).toHaveLength(1);
  });

  it('投递方跳过（没有存活会话）不计成功', async () => {
    const probe = healthyProbe();
    const { handle } = watch(probe, { deliver: async () => ({ ok: false, reason: 'no-live-session' }) });
    const r = await handle.tick(FIXED_NOW);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('deliver-skip');
    expect(handle.snapshot().nudgedToday).toBe(0);
  });

  it('默认 enabled=false 直接不跑', async () => {
    const probe = healthyProbe();
    const { handle } = watch(probe, { enabled: false });
    expect((await handle.tick(FIXED_NOW)).skipped).toBe('disabled');
    expect(probe.calls).toHaveLength(0);
  });

  it('每天上限', async () => {
    const probe = healthyProbe();
    const { handle, delivered } = watch(probe, { intervalMs: 1000, statePath: undefined, maxNudgesPerDay: 1 });
    await handle.tick(FIXED_NOW);
    // 换内容让 same-content 不拦，但日上限已满
    await handle.tick(FIXED_NOW + 20 * 60 * 1000);
    expect(delivered).toHaveLength(1);
  });
});

describe('搭话文案', () => {
  it('不让她暴露"我在看你的屏幕"', () => {
    const text = renderScreenNudge({
      packageName: 'com.qidian.QDReader',
      topics: [{ topic: '咖啡', weight: 0.6 }],
      snippet: '第 3 章 咖啡与深夜的代码',
    });
    expect(text).toContain('咖啡');
    expect(text).toContain('第 3 章');
    expect(text).toContain('不要');
  });
});

describe('状态持久化 · 重启不补跑', () => {
  it('lastProbeAt 落盘，重启后间隔延续', async () => {
    const probe = healthyProbe();
    const statePath = path.join(dir, 'state.json');
    const first = createScreenWatch({
      probe,
      deliver: async () => ({ ok: true }),
      interests: () => [{ topic: '咖啡', weight: 0.6 }],
      chattiness: () => 1,
      allowProactive: () => ({ ok: true }),
      markProactive: () => {},
      intervalMs: 30 * 60 * 1000,
      statePath,
      now: () => FIXED_NOW,
      log: () => {},
    });
    await first.tick(FIXED_NOW);
    expect(fs.existsSync(statePath)).toBe(true);

    const probe2 = healthyProbe();
    const second = createScreenWatch({
      probe: probe2,
      deliver: async () => ({ ok: true }),
      interests: () => [{ topic: '咖啡', weight: 0.6 }],
      chattiness: () => 1,
      allowProactive: () => ({ ok: true }),
      markProactive: () => {},
      intervalMs: 30 * 60 * 1000,
      statePath,
      now: () => FIXED_NOW,
      log: () => {},
    });
    expect((await second.tick(FIXED_NOW)).skipped).toBe('not-yet');
    expect(probe2.calls).toHaveLength(0);
  });
});

describe('探针失败不抛', () => {
  it('probe 抛异常 → 返回 probe-failed，不炸掉定时器', async () => {
    const probe: ScreenProbe = {
      deviceOverview: vi.fn(async () => {
        throw new Error('bridge down');
      }),
      windowFocus: async () => null,
      accessibilityEnabled: async () => true,
      screenText: async () => null,
    };
    const { handle } = watch(probe);
    const r = await handle.tick(FIXED_NOW);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('probe-failed');
  });
});
