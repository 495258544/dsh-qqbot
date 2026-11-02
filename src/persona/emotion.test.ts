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
    // 不断言具体数值（半衰期是设计参数，会随"心情该不该跨天"这类语义判断调整），
    // 只断言"分 24 步和一步到位一致" —— 这才是这条测试真正要防的东西。
    expect(stepped.valence).toBeCloseTo(once.valence, 6);
  });
});

describe('回归方向是基线，不是 0', () => {
  it('valence 从 +0.8 明显回落到基线', () => {
    // 防的是"衰减到 0"的实现：valence 的基线本来就是 0，所以这里同时
    // 验证它没有停在 +0.8 的高位（没有回归）也没有变成负值。
    // 72h = 3 个 valence 半衰期 → 剩 1/8 左右。断言"明显回落"而不是"归零"：
    // 指数回归是渐进的，永远不会精确等于基线。
    const after = regress(st({ valence: 0.8 }), T0 + 72 * HOUR);

    expect(after.valence).toBeLessThan(0.15);
    expect(after.valence).toBeGreaterThan(0);
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
  it('同样经过 6 小时，arousal 退得最快、valence 最慢', () => {
    // 防的是三个量用同一个半衰期。设计意图（M31 实测调过）：
    //   激动 4h  —— 气头过了就过了
    //   精力 12h —— 累了要睡，睡醒才恢复
    //   心情 24h —— 必须扛得过一夜睡眠，否则"情绪"退化成"当场抖动"
    //
    // 只断言**相对快慢**，不钉具体数值：半衰期是设计参数，
    // 会随着"心情该不该跨天"这类语义判断调整（已经调过一次）。
    const start = st({ valence: 0.5, arousal: 0.9, energy: 0.2 });
    const after = regress(start, T0 + 6 * HOUR);

    const v = remainedFraction(after.valence, start.valence, 0);
    const a = remainedFraction(after.arousal, start.arousal, 0.3);
    const e = remainedFraction(after.energy, start.energy, 0.7);

    expect(a).toBeLessThan(v);      // 激动退得比心情快
    expect(v).toBeGreaterThan(0.5); // 6h 只过了 1/4 个心情半衰期，还留得住
    // 精力从低于基线往回升（0.2 → 0.7），所以它"剩下"的比例会 >1，不做比较
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

    // 不钉具体数值（半衰期会随语义判断调整），断言"确实按真实停摆时间回归了"：
    // 激动（4h 半衰）应该几乎回到基线，心情（24h）只掉一点，精力（12h）掉一半。
    expect(state.arousal).toBeLessThan(0.4);          // 0.9 → 接近基线 0.3
    expect(state.valence).toBeGreaterThan(0.5);        // 0.8 → 只掉一点
    expect(state.valence).toBeLessThan(0.8);           // 但确实降了
    expect(state.energy).toBeGreaterThan(0.3);         // 0.2 → 回升了一些
    expect(state.energy).toBeLessThan(0.6);            // 但没到基线 0.7
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

describe('跨天连续性 · 心情必须扛得过一夜睡眠', () => {
  // 这条防的是我第一版参数的错误：valence 半衰期定成 6h，
  // 模拟 7 天真实节奏时发现睡一觉（8h）只剩 40%，
  // 第二天永远从基线开始 —— "情绪"退化成"每场对话内的抖动"。
  //
  // 人的心情是跨天的：昨天被夸了，今天起来还是有点轻快。

  const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-night-'));
    return new EmotionService(dir);
  };

  it('开心之后睡 8 小时，还剩大半（不是归零）', () => {
    const svc = mk();
    for (let i = 0; i < 3; i++) svc.onReplied();
    const before = svc.current().valence;
    expect(before).toBeGreaterThan(0.2);

    const after = svc.current(Date.now() + 8 * 3600_000).valence;
    // 初版 6h 会掉到 40%，正确参数应保持六成以上
    expect(after).toBeGreaterThan(before * 0.6);
  });

  it('激动退得比心情快（气头过了，但心情还在）', () => {
    const svc = mk();
    svc.onReplied();
    const st0 = svc.current();
    const st4 = svc.current(Date.now() + 4 * 3600_000);
    const vKeep = st4.valence / Math.max(1e-9, st0.valence);
    const aKeep = (st4.arousal - 0.3) / Math.max(1e-9, st0.arousal - 0.3);
    expect(aKeep).toBeLessThan(vKeep);
  });

  it('连着两天好心情，第二天起点明显高于零', () => {
    const svc = mk();
    for (let i = 0; i < 4; i++) svc.onReplied();
    // 睡一夜
    const d2 = svc.current(Date.now() + 9 * 3600_000).valence;
    expect(d2).toBeGreaterThan(0.15);
  });
});

describe('写入点必须真的被调用（防"接上又被改掉"）', () => {
  // 这三条防的是一个真实发生的退化：
  // onIgnored 曾经接在 ProactiveBudget.markUnanswered 里，
  // 后来因为那个类没有 emotion 字段被删掉，**忘了在 service 侧补回**
  // 导致"最重要的负向写入点"静默消失，情绪只剩正向源
  // → 长期贴在上限 → 正好是 feiyu-mood 的"永远开心 = 没有心情"。
  //
  // 靠代码审查抓不住这类问题：删一行编译一样过，测试一样绿。

  const mkSvc = async (dir: string) => {
    const { PersonaService } = await import('./service.ts');
    return new PersonaService({
      config: {
        enabled: true, dataDir: dir, roleCardPath: '', roleMaxChars: 12000,
        wakeEnabled: true, names: [], keywords: [], ownerOpenids: [], groupProbability: 0,
        humanizeEnabled: true, msPerChar: 110, burstMax: 2, gapMinMs: 700, gapMaxMs: 2600,
        ownLifeEnabled: false, ownLifeIntervalMs: 9000000, ownLifeMaxPerDay: 6,
        maxProactivePerDay: 2, proactiveMinGapMs: 7200000,
      } as never,
      dataDir: dir,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    });
  };

  it('主动说话没人理 → valence 下降（onIgnored 真的被调）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-wire-'));
    const svc = await mkSvc(dir);
    // 先制造一次"主动推送"
    svc.budget.recordProactive('u1');
    const before = svc.emotion.current().valence;

    // 对方没有回应（lastActivityAt 早于 lastProactiveAt）
    svc.observePeer('u1', Date.now() - 60_000);

    expect(svc.emotion.current().valence).toBeLessThan(before);
  });

  it('主动说话后对方回了 → 不扣，反而算被接住', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-wire2-'));
    const svc = await mkSvc(dir);
    svc.budget.recordProactive('u1');
    const before = svc.emotion.current().valence;

    // 对方在推送之后说话了
    svc.observePeer('u1', Date.now() + 60_000);

    expect(svc.emotion.current().valence).toBeGreaterThanOrEqual(before);
  });

  it('从没主动过 → 不碰情绪（不能白扣）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-wire3-'));
    const svc = await mkSvc(dir);
    const before = svc.emotion.current().valence;
    svc.observePeer('nobody', Date.now());
    expect(svc.emotion.current().valence).toBeCloseTo(before, 6);
  });

  it('隔了 6 小时以上再说话 → 精力回升（onRest 真的被调）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-rest-'));
    const svc = await mkSvc(dir);
    // 先把精力压低
    for (let i = 0; i < 4; i++) svc.emotion.onNightChat(2);

    // 第一次轮次：lastTurnAt 是 0，不触发 onRest
    svc.noteUserTurn('s0', '先来一句', 'u1');
    svc.noteReplyChunk('s0', '在');
    svc.flushTurn('s0', 'c2c:u1', 'u1');

    // M35：基线必须取**第一次 flush 之后**的值。
    // 原因：第一轮本身还会触发别的 energy 写入点（实测 0.38 → 0.30），
    // 拿 flush 前的值当基线，就把"那 0.08"误算成 onRest 没生效。
    const low = svc.emotion.current().energy;

    // 手动把"上次对话时间"推到 7 小时前，模拟睡了一觉。
    // M35 修正：`lastTurnAt` 现在**同时落盘**（state/last-turn.json），
    // 只改内存字段会被下一轮的 loadLastTurnAt() 覆盖 —— 必须写文件。
    fs.mkdirSync(path.dirname((svc as unknown as { lastTurnFile: string }).lastTurnFile), { recursive: true });
    fs.writeFileSync(
      (svc as unknown as { lastTurnFile: string }).lastTurnFile,
      JSON.stringify({ at: Date.now() - 7 * 3600_000 }),
      'utf8',
    );
    (svc as unknown as { lastTurnAt: number }).lastTurnAt = Date.now() - 7 * 3600_000;

    svc.noteUserTurn('s1', '早', 'u1');
    svc.noteReplyChunk('s1', '早呀');
    svc.flushTurn('s1', 'c2c:u1', 'u1');

    expect(svc.emotion.current().energy).toBeGreaterThan(low);
  });
});

describe('M33 · 生产链路上 onIgnored 必须真的扣分', () => {
  // 复核 8a94319 时发现：调用点在、测试绿，但**生产路径上条件恒假**。
  // bootstrap 原先把 `record.lastActivity` 传给 observePeer，而
  // ensureForProactive 新建会话时刚写过 `lastActivity = Date.now()`，
  // 于是 `lastActivityAt > lastProactiveAt` 恒真 → onIgnored 永不执行，
  // 连带 unansweredStreak 永不增长（ProactiveBudget 整套退避一起失效）。
  //
  // 修法：bootstrap 在 ensureForProactive **之前**取活跃时间，
  // 会话已被回收就用 0 表示"这轮肯定没理"。

  const mkSvc2 = async (dir: string) => {
    const { PersonaService } = await import('./service.ts');
    return new PersonaService({
      config: {
        enabled: true, dataDir: dir, roleCardPath: '', roleMaxChars: 12000,
        wakeEnabled: true, names: [], keywords: [], ownerOpenids: [], groupProbability: 0,
        humanizeEnabled: true, msPerChar: 110, burstMax: 2, gapMinMs: 700, gapMaxMs: 2600,
        ownLifeEnabled: false, ownLifeIntervalMs: 9000000, ownLifeMaxPerDay: 6,
        maxProactivePerDay: 2, proactiveMinGapMs: 7200000,
      } as never,
      dataDir: dir,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    });
  };

  it('会话已被回收（活跃时间=0）→ 确实扣分，且 streak 增长', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-m33-'));
    const svc = await mkSvc2(dir);
    svc.budget.recordProactive('owner');
    const p = svc.budget.peerSnapshot('owner')!;
    p.lastProactiveAt = Date.now() - 4 * 3600_000; // 4 小时前推送过

    const before = svc.emotion.current().valence;
    svc.observePeer('owner', 0); // 修复后 bootstrap 传的就是这个
    expect(svc.emotion.current().valence).toBeLessThan(before);
    expect(svc.budget.peerSnapshot('owner')!.unansweredStreak).toBeGreaterThan(0);
  });

  it('连续没理 → 退避机制逐级生效（曾因同一 bug 整体失效）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-m33b-'));
    const svc = await mkSvc2(dir);
    svc.budget.recordProactive('owner');
    const seen: number[] = [];
    for (let i = 1; i <= 5; i++) {
      svc.observePeer('owner', 0);
      const p = svc.budget.peerSnapshot('owner')!;
      seen.push(p.unansweredStreak);
      svc.budget.recordProactive('owner');
      p.lastProactiveAt = Date.now() - 4 * 3600_000;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    // streak>=5 → 永久静默
    expect(svc.budget.peerSnapshot('owner')!.mutedUntil).toBe(-1);
  });

  it('会话还活着且对方确实回过 → 不扣分', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-m33c-'));
    const svc = await mkSvc2(dir);
    svc.budget.recordProactive('owner');
    const p = svc.budget.peerSnapshot('owner')!;
    const before = svc.emotion.current().valence;
    // 活跃时间晚于推送时刻 = 对方理过她
    svc.observePeer('owner', p.lastProactiveAt + 60_000);
    expect(svc.emotion.current().valence).toBeGreaterThanOrEqual(before);
    expect(p.unansweredStreak).toBe(0);
  });
});

describe('M33 · lastTurnAt 必须落盘（onRest 的唯一正向来源）', () => {
  // 原实现是纯内存字段，进程重启归零 → "睡了一觉"的时间维度整个丢失。
  // 而 onRest 是 energy 的唯一正向来源，压在易失字段上等于"重启越频繁她越累"。

  it('重启后仍能判断"中间睡了一觉"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-lastturn-'));
    const mk = async () => {
      const { PersonaService } = await import('./service.ts');
      return new PersonaService({
        config: {
          enabled: true, dataDir: dir, roleCardPath: '', roleMaxChars: 12000,
          wakeEnabled: false, names: [], keywords: [], ownerOpenids: [], groupProbability: 0,
          humanizeEnabled: true, msPerChar: 110, burstMax: 2, gapMinMs: 700, gapMaxMs: 2600,
          ownLifeEnabled: false, ownLifeIntervalMs: 9000000, ownLifeMaxPerDay: 6,
          maxProactivePerDay: 2, proactiveMinGapMs: 7200000,
        } as never,
        dataDir: dir,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      });
    };
    // 进程 A：聊一轮，落盘
    const a = await mk();
    a.noteUserTurn('s', '早', 'u1');
    a.noteReplyChunk('s', '早呀');
    a.flushTurn('s', 'c2c:u1', 'u1');
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'last-turn.json'), 'utf8')) as { at: number };
    expect(persisted.at).toBeGreaterThan(0);

    // 模拟 7 小时后重启
    fs.writeFileSync(path.join(dir, 'state', 'last-turn.json'), JSON.stringify({ at: Date.now() - 7 * 3600_000 }));
    const b = await mk();
    for (let i = 0; i < 6; i++) b.emotion.onNightChat(2);
    const low = b.emotion.current().energy;

    b.noteUserTurn('s2', '早', 'u1');
    b.noteReplyChunk('s2', '早呀');
    b.flushTurn('s2', 'c2c:u1', 'u1');
    expect(b.emotion.current().energy).toBeGreaterThan(low);
  });
});

describe('M34 · 正向事件日上限与边际递减（解决"永远贴顶"）', () => {
  it('过了当日软上限后，单次增量显著变小', () => {
    const svc = new EmotionService(`/tmp/emo-cap-${Math.random().toString(36).slice(2)}`);
    // 前 8 次全额
    const first: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = svc.current().valence;
      svc.onAddressed();
      first.push(svc.current().valence - before);
    }
    // 第 9 次开始递减（1/10）
    const before = svc.current().valence;
    svc.onAddressed();
    const after = svc.current().valence - before;
    expect(after).toBeLessThan(first[0]! * 0.2);
  });

  it('daily 计数器会跨 regress / applyDeltas 存活（实测发现过这个 bug）', () => {
    const svc = new EmotionService(`/tmp/emo-daily-${Math.random().toString(36).slice(2)}`);
    svc.onAddressed();
    expect(svc.current().daily?.addressed).toBe(1);
    svc.onReplied();
    expect(svc.current().daily?.addressed).toBe(1);
    expect(svc.current().daily?.replied).toBe(1);
    // 再 bump 一次情绪（走 applyDeltas），计数器仍要在
    svc.onIgnored();
    expect(svc.current().daily?.addressed).toBe(1);
  });

  it('模拟 130 轮密集聊天，valence 不再贴顶', () => {
    // 稳态分析：每 30min +0.06、24h 半衰期 → 原稳态 4.19，远超上限 1.0。
    // 加日上限(1/10)后应落在 0.4 左右。
    let st = { valence: 0, arousal: 0.3, energy: 0.7, at: Date.now() };
    const t0 = Date.now(), H = 1800000;
    const vals: number[] = [];
    for (let i = 0; i < 130; i++) {
      const now = t0 + i * H;
      st = regress(st, now);
      st = applyDeltas(st, { valence: i < 8 ? 0.06 : 0.006 }, now);
      vals.push(st.valence);
    }
    const median = [...vals].sort((a, b) => a - b)[65]!;
    expect(median).toBeLessThan(0.7);
    expect(vals.filter((v) => v > 0.85).length / vals.length).toBeLessThan(0.05);
  });
});
