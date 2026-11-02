/**
 * 情绪模块的行为契约测试。
 *
 * 这里只钉"对外可见的行为"：回归按真实时间、方向是基线、单次增量有上限、
 * 闸门系数在基线等于没影响、持久化坏档能回落。
 * 每条用例的注释写的是它防的那个真实失效方式，不是"在测哪个函数"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EmotionService,
  applyDeltas,
  burstLimit,
  describeEmotion,
  regress,
  speakWillingness,
  typingSpeedFactor,
} from './emotion.ts';
import type { EmotionState } from './emotion.ts';

const HOUR = 3600_000;

/** 固定基准时刻：不依赖系统时钟，也不引入 fake timer。 */
const T0 = 1_700_000_000_000;

/** 造一个状态，默认就是基线。 */
function st(partial: Partial<EmotionState> = {}): EmotionState {
  return { valence: 0, arousal: 0.3, energy: 0.7, at: T0, ...partial };
}

/** 经过一段时间后"还剩多少偏离"，用来比较三个量的回归速度。 */
function remainedFraction(now: number, from: number, baseline: number): number {
  const start = Math.abs(from - baseline);
  return start === 0 ? 0 : Math.abs(now - baseline) / start;
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('回归按真实经过时间，而不是按调用次数', () => {
  it('6 小时 + 6 小时两次调用，和一次 12 小时结果相同', () => {
    // 防的是"每次调用乘一次固定系数"：那样 6h+6h 会比一次 12h 多衰减一轮，
    // 调用频率一变衰减速度就变（decayInterests 早期踩过的坑）。
    const start = st({ valence: 0.8, arousal: 0.9, energy: 0.2 });
    const once = regress(start, T0 + 12 * HOUR);
    const twice = regress(regress(start, T0 + 6 * HOUR), T0 + 12 * HOUR);

    expect(twice.valence).toBeCloseTo(once.valence, 6);
    expect(twice.arousal).toBeCloseTo(once.arousal, 6);
    expect(twice.energy).toBeCloseTo(once.energy, 6);
    expect(Math.abs(twice.valence - once.valence)).toBeLessThan(1e-6);
    expect(Math.abs(twice.arousal - once.arousal)).toBeLessThan(1e-6);
    expect(Math.abs(twice.energy - once.energy)).toBeLessThan(1e-6);
  });

  it('24 次半小时调用，和一次 12 小时结果相同', () => {
    // 上面那条的极端形式：把 12 小时切成 24 段。
    // 如果衰减按"调用一次乘 0.5"实现，这里会掉到几乎 0，而不是 1/4。
    const start = st({ valence: 0.8, arousal: 0.9, energy: 0.2 });
    let stepped = start;
    for (let i = 1; i <= 24; i++) {
      stepped = regress(stepped, T0 + i * 0.5 * HOUR);
    }
    const once = regress(start, T0 + 12 * HOUR);

    expect(stepped.valence).toBeCloseTo(once.valence, 6);
    expect(stepped.arousal).toBeCloseTo(once.arousal, 6);
    expect(stepped.energy).toBeCloseTo(once.energy, 6);
    expect(stepped.valence).toBeCloseTo(0.2, 6); // 6h 半衰期，12h 后剩 1/4
  });
});

describe('回归方向是基线，不是 0', () => {
  it('valence 从 +0.8 回到 0 附近', () => {
    // 防的是"衰减到 0"的实现：valence 的基线本来就是 0，所以这里同时
    // 验证它没有停在 +0.8 的高位（没有回归）也没有变成负值。
    const after = regress(st({ valence: 0.8 }), T0 + 72 * HOUR);

    expect(after.valence).toBeLessThan(1e-3);
    expect(after.valence).toBeGreaterThan(-1e-3);
  });

  it('arousal 从 0.9 回到 0.3，而不是 0', () => {
    // 防的是把"平静"实现成"没有精神"：0.3 是基线，掉到 0 会让
    // burstLimit / typingSpeedFactor 永久停在低唤醒那一档。
    const after = regress(st({ arousal: 0.9 }), T0 + 48 * HOUR);

    expect(after.arousal).toBeCloseTo(0.3, 3);
    expect(after.arousal).toBeGreaterThan(0.25);
  });

  it('本来就是基线的量，过多久都不动', () => {
    const after = regress(st(), T0 + 500 * HOUR);

    expect(after.valence).toBe(0);
    expect(after.arousal).toBeCloseTo(0.3, 10);
    expect(after.energy).toBeCloseTo(0.7, 10);
  });
});

describe('三个量的半衰期不同', () => {
  it('同样经过 6 小时，arousal 退得最快、energy 最慢', () => {
    // 防的是三个量用同一个半衰期：激动（2h）应该比心情（6h）退得快，
    // 精力（12h）应该比心情恢复得慢，否则"气头过了"和"睡一觉"分不出来。
    const start = st({ valence: 0.5, arousal: 0.9, energy: 0.2 });
    const after = regress(start, T0 + 6 * HOUR);

    const v = remainedFraction(after.valence, start.valence, 0);
    const a = remainedFraction(after.arousal, start.arousal, 0.3);
    const e = remainedFraction(after.energy, start.energy, 0.7);

    expect(v).toBeCloseTo(2 ** -1, 6); // 6h / 6h = 1 个半衰
    expect(a).toBeCloseTo(2 ** -3, 6); // 6h / 2h = 3 个半衰
    expect(e).toBeCloseTo(2 ** -0.5, 6); // 6h / 12h = 0.5 个半衰
    expect(a).toBeLessThan(v);
    expect(v).toBeLessThan(e);
  });
});

describe('单次事件增量有上限', () => {
  it('一次 valence:+5 只加 0.25，不会把心情直接打满', () => {
    // 防的是一次事件（或一次模型输出）把情绪推到边界，
    // 之后几个小时都"永远开心"——那就是 feiyu-mood 的死法。
    const after = applyDeltas(st(), { valence: 5, arousal: 5, energy: -5 }, T0);

    expect(after.valence).toBeCloseTo(0.25, 10);
    expect(after.arousal).toBeCloseTo(0.55, 10);
    expect(after.energy).toBeCloseTo(0.45, 10);
    expect(after.valence).toBeLessThan(1);
  });

  it('负向增量同样封顶在 -0.25', () => {
    // 防的是一次"被嫌吵"就把 valence 打到 -1，再叠加负向事件时无从体现。
    const after = applyDeltas(st(), { valence: -5, arousal: -5, energy: -5 }, T0);

    expect(after.valence).toBeCloseTo(-0.25, 10);
    expect(after.arousal).toBeCloseTo(0.05, 10);
    expect(after.energy).toBeCloseTo(0.45, 10);
  });
});

describe('所有值被夹在合法区间', () => {
  it('极端初值经过回归后仍在 [-1,1] / [0,1]', () => {
    // 防的是坏档或手写 state 把值带出定义域，之后闸门系数算出负数，
    // 乘到概率/延迟上直接产生非法请求或 0 延迟。
    const wild = regress(st({ valence: 99, arousal: 99, energy: -99 }), T0 + HOUR);

    expect(wild.valence).toBeLessThanOrEqual(1);
    expect(wild.valence).toBeGreaterThanOrEqual(-1);
    expect(wild.arousal).toBeLessThanOrEqual(1);
    expect(wild.arousal).toBeGreaterThanOrEqual(0);
    expect(wild.energy).toBeLessThanOrEqual(1);
    expect(wild.energy).toBeGreaterThanOrEqual(0);
    expect(wild.valence).toBe(1);
    expect(wild.arousal).toBe(1);
    expect(wild.energy).toBe(0);
  });

  it('连续施加最大增量，上下边界都不会被突破', () => {
    // 防的是"clamp 只加了一次"：连续正向/负向事件叠加后仍必须停在边界内。
    let up = st();
    let down = st();
    for (let i = 0; i < 20; i++) {
      up = applyDeltas(up, { valence: 1, arousal: 1, energy: 1 }, T0 + i);
      down = applyDeltas(down, { valence: -1, arousal: -1, energy: -1 }, T0 + i);
    }

    for (const s of [up, down]) {
      expect(s.valence).toBeGreaterThanOrEqual(-1);
      expect(s.valence).toBeLessThanOrEqual(1);
      expect(s.arousal).toBeGreaterThanOrEqual(0);
      expect(s.arousal).toBeLessThanOrEqual(1);
      expect(s.energy).toBeGreaterThanOrEqual(0);
      expect(s.energy).toBeLessThanOrEqual(1);
    }
    expect(up.valence).toBe(1);
    expect(up.arousal).toBe(1);
    expect(up.energy).toBe(1);
    expect(down.valence).toBe(-1);
    expect(down.arousal).toBe(0);
    expect(down.energy).toBe(0);
  });
});

describe('闸门系数在基线附近等于没接情绪', () => {
  it('valence=0 时 speakWillingness 正好是 1.0', () => {
    // 设计意图：情绪系统整个挂掉或状态全在基线时，
    // 主动开口概率必须和接入情绪之前完全一致，不能凭空乘一个系数。
    expect(speakWillingness(st())).toBe(1);
    expect(speakWillingness(st({ valence: 0 }))).toBe(1);
  });

  it('energy=0.7 时 typingSpeedFactor ≈ 1.0（±0.05）', () => {
    // 防的是公式常数写错（比如 1.35 写成 1.5）导致基线一上来打字就慢三成。
    const factor = typingSpeedFactor(st());

    expect(Math.abs(factor - 1)).toBeLessThanOrEqual(0.05);
    expect(factor).toBeCloseTo(1, 10);
  });

  it('speakWillingness 被夹在 [0.6,1.4]', () => {
    // 防的是"心情差 ×0.4"叠上其它惩罚后把人变成哑巴。
    for (const v of [-99, -2, -1, -0.5, 0, 0.5, 1, 2, 99]) {
      const factor = speakWillingness(st({ valence: v }));
      expect(factor).toBeGreaterThanOrEqual(0.6);
      expect(factor).toBeLessThanOrEqual(1.4);
    }
    expect(speakWillingness(st({ valence: 1 }))).toBeCloseTo(1.4, 10);
    expect(speakWillingness(st({ valence: -1 }))).toBeCloseTo(0.6, 10);
  });

  it('typingSpeedFactor 被夹在 [0.8,1.4]', () => {
    // 防的是困到 energy=0 时延迟被放大到不可用，或者越界值算出负延迟。
    for (const e of [-99, -1, 0, 0.35, 0.7, 1, 2, 99]) {
      const factor = typingSpeedFactor(st({ energy: e }));
      expect(factor).toBeGreaterThanOrEqual(0.8);
      expect(factor).toBeLessThanOrEqual(1.4);
    }
    expect(typingSpeedFactor(st({ energy: 0 }))).toBeCloseTo(1.35, 10);
    expect(typingSpeedFactor(st({ energy: 1 }))).toBeCloseTo(0.85, 10);
    // 合法区间内下界 0.8 其实撞不到（energy=1 时是 0.85）；
    // 这里传越界值只是为了证明 clamp 本身生效，而不是证明正常输入会撞下界。
    expect(typingSpeedFactor(st({ energy: 10 }))).toBeCloseTo(0.8, 10);
  });
});

describe('burstLimit 控制分几条发', () => {
  it('不激动时只发一条，基线及以上发两条', () => {
    // 防的是阈值写反或写死 2：情绪很低落时还连发两条，观感完全不对。
    expect(burstLimit(st({ arousal: 0 }))).toBe(1);
    expect(burstLimit(st({ arousal: 0.29 }))).toBe(1);
    expect(burstLimit(st({ arousal: 0.3 }))).toBe(2);
    expect(burstLimit(st({ arousal: 0.9 }))).toBe(2);
  });

  it('返回值只可能是 1 或 2（同 msgId 被动回复额度有限）', () => {
    // 防的是返回 0 条（消息消失）或超过 API 额度（400 错误）。
    for (const arousal of [0, 0.1, 0.2, 0.29, 0.3, 0.5, 0.79, 0.9, 1]) {
      expect([1, 2]).toContain(burstLimit(st({ arousal })));
    }
    expect(burstLimit(st({ arousal: 1 }), 1)).toBe(1); // cap 收紧时不超过 cap
  });
});

describe('EmotionService 的持久化', () => {
  it('没有存档文件时从基线开始，也不会凭空创建文件', () => {
    // 防的是首次启动读出 NaN / undefined，或者构造服务就产生副作用写盘。
    const dir = tempDir();
    const service = new EmotionService(dir);
    const state = service.current(Date.now());

    expect(state.valence).toBe(0);
    expect(state.arousal).toBeCloseTo(0.3, 10);
    expect(state.energy).toBeCloseTo(0.7, 10);
    expect(fs.existsSync(path.join(dir, 'state', 'emotion.json'))).toBe(false);
  });

  it('bump 之后重建实例能读回（首次写盘不受 60 秒防抖影响）', () => {
    // 防的是"防抖把第一次写盘也吞了"：lastSaveAt 初值是 0，
    // 第一次 save 必须落盘，否则重启后这次情绪变化直接丢失。
    const dir = tempDir();
    const now = Date.now();
    const first = new EmotionService(dir);
    first.bump({ valence: 0.2, arousal: 0.2 }, now);

    const file = path.join(dir, 'state', 'emotion.json');
    expect(fs.existsSync(file)).toBe(true);

    const second = new EmotionService(dir);
    const state = second.current(Date.now());
    expect(state.valence).toBeCloseTo(0.2, 3);
    expect(state.arousal).toBeCloseTo(0.5, 3);
  });

  it('60 秒防抖：一分钟内第二次 bump 只改内存、不重写文件', () => {
    // 先读了源码：save() 里 `now - lastSaveAt < 60_000` 直接 return。
    // 所以这里不硬等 60 秒，而是分别断言"文件没变"和"内存值变了"——
    // 防的是有人把防抖误改成"直接丢弃这次 bump"。
    const dir = tempDir();
    const now = Date.now();
    const service = new EmotionService(dir);
    const file = path.join(dir, 'state', 'emotion.json');

    service.bump({ valence: 0.1 }, now);
    const afterFirst = JSON.parse(fs.readFileSync(file, 'utf8')) as { valence: number };

    service.bump({ valence: 0.2 }, now + 1000);
    const afterSecond = JSON.parse(fs.readFileSync(file, 'utf8')) as { valence: number };

    expect(afterFirst.valence).toBeCloseTo(0.1, 10);
    expect(afterSecond.valence).toBeCloseTo(afterFirst.valence, 10);
    expect(service.current(now + 1000).valence).toBeCloseTo(0.3, 3);
  });

  it('存档是非法 JSON 时回落到基线，不抛异常', () => {
    // 防的是一个写坏的 state/emotion.json 导致机器人整个起不来。
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'emotion.json'), '{ 这不是合法 JSON', 'utf8');

    let service: EmotionService | undefined;
    expect(() => {
      service = new EmotionService(dir);
    }).not.toThrow();

    const state = service!.current(Date.now());
    expect(state.valence).toBe(0);
    expect(state.arousal).toBeCloseTo(0.3, 10);
    expect(state.energy).toBeCloseTo(0.7, 10);
  });

  it('存档字段类型坏掉时不会把 NaN 传下去', () => {
    // 防的是 JSON 合法但字段是字符串/null：一旦 NaN 逃到闸门系数里，
    // 乘出来的概率和延迟也是 NaN，发消息的请求会直接失败。
    // 注意 `Number(x) || 0` 的写法会把字符串/null 变成 0，而不是基线
    // 0.3/0.7 —— 值仍是合法区间内的数，所以这里只钉"不产生 NaN"。
    // 源码疑似有 bug：这类坏档会静默落到 0（arousal/energy 的基线其实是
    // 0.3/0.7），建议改成 Number.isFinite 校验后回落到 BASELINE。
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state', 'emotion.json'),
      JSON.stringify({ valence: 'abc', arousal: null, energy: Number.NaN, at: 'oops' }),
      'utf8',
    );

    const service = new EmotionService(dir);
    const state = service.current(Date.now());

    expect(Number.isFinite(state.valence)).toBe(true);
    expect(Number.isFinite(state.arousal)).toBe(true);
    expect(Number.isFinite(state.energy)).toBe(true);
    expect(Number.isFinite(state.at)).toBe(true);
    expect(state.arousal).toBeGreaterThanOrEqual(0);
    expect(state.arousal).toBeLessThanOrEqual(1);
    expect(state.energy).toBeGreaterThanOrEqual(0);
    expect(state.energy).toBeLessThanOrEqual(1);
  });

  it('读档时按停摆期间的真实时间回归，而不是原样返回', () => {
    // 防的是进程停了 12 小时后一启动还带着 12 小时前的激动，
    // 相当于"睡一觉回来心情没平"。
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state', 'emotion.json'),
      JSON.stringify({
        valence: 0.8,
        arousal: 0.9,
        energy: 0.2,
        at: Date.now() - 12 * HOUR,
      }),
      'utf8',
    );

    const service = new EmotionService(dir);
    const state = service.current(Date.now());

    // 6h 半衰，12h = 2 个半衰 → 剩 1/4 偏离：0.2
    expect(state.valence).toBeCloseTo(0.2, 6);
    // 2h 半衰，12h = 6 个半衰 → 剩 1/64：0.3 + 0.6/64 = 0.309375
    expect(state.arousal).toBeCloseTo(0.3 + 0.6 * 2 ** -6, 6);
    // 12h 半衰，12h = 1 个半衰 → 剩 1/2 偏离：0.45
    expect(state.energy).toBeCloseTo(0.45, 6);
  });
});

describe('describeEmotion 的一句话概括', () => {
  it('永远返回非空字符串', () => {
    // 防的是边界值下拼出空串（日志里什么都看不到）或直接抛异常。
    for (const valence of [-1, -0.5, 0, 0.5, 1]) {
      const line = describeEmotion(st({ valence }));
      expect(typeof line).toBe('string');
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it('三档心情能区分', () => {
    // 防的是阈值写错导致"开心"和"失落"渲染成同一句，日志里没法排查。
    const good = describeEmotion(st({ valence: 0.8 }));
    const flat = describeEmotion(st({ valence: 0 }));
    const bad = describeEmotion(st({ valence: -0.8 }));

    expect(good).toContain('心情不错');
    expect(flat).toContain('没什么波澜');
    expect(bad).toContain('有点蔫');
    expect(new Set([good, flat, bad]).size).toBe(3);
  });

  it('精力档位也能区分', () => {
    // 防的是能量阈值用反（"有点累"出现在满血时）。
    expect(describeEmotion(st({ energy: 0.1 }))).toContain('有点累');
    expect(describeEmotion(st({ energy: 0.5 }))).toContain('精神一般');
    expect(describeEmotion(st({ energy: 0.9 }))).toContain('精神很好');
  });
});

describe('load() · 坏字段必须各自回落各自基线（不是统一变 0）', () => {
  // 原实现 `Number(x ?? base) || 0` 把坏值统一抹成 0。
  // 后果不是"数据不准"，而是**行为被钉死**：
  //   arousal=0 → burstLimit 恒返回 1（永远只发一条）
  //   energy=0  → typingSpeedFactor 恒 1.35（永远"很累"）
  // 而且没有任何日志能看出来 —— 这是最糟的那种 bug。

  it('合法 JSON + 坏字段 → 回到基线，而不是 0', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-load-'));
    const file = path.join(dir, 'state', 'emotion.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 注意：不能用 JSON.stringify 造坏档 —— 它会把 NaN/undefined **丢掉**，
    // 结果写出来的是"缺字段"，测不到"字段存在但值是坏的"。这里直接写原文。
    fs.writeFileSync(file, '{"valence":"abc","arousal":"oops","energy":{},"at":"x"}', 'utf8');

    const svc = new EmotionService(dir);
    const st = svc.current();
    expect(Number.isFinite(st.valence)).toBe(true);
    // 关键：arousal/energy 回到 0.3/0.7，不是 0
    expect(st.arousal).toBeGreaterThan(0.2);
    expect(st.energy).toBeGreaterThan(0.6);
  });

  it('坏档不会让闸门被钉死在"很累/只发一条"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-load2-'));
    const file = path.join(dir, 'state', 'emotion.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"valence":null,"arousal":"NaN","energy":[]}', 'utf8');

    const st = new EmotionService(dir).current();
    expect(typingSpeedFactor(st)).toBeLessThan(1.2);
    expect([1, 2]).toContain(burstLimit(st));
  });
});
