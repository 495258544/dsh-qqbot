import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceService, independentOccurrenceCount } from './voice.ts';

let dir: string;
let v: VoiceService;

const HOUR = 3600_000;
/** 判定「不同场合」的最小间隔（与 voice.ts 的 EVIDENCE_GAP_MS 对齐） */
const GAP = 4 * HOUR;
/**
 * 造样本时用的实际间隔：**明显大于** GAP。
 *
 * 不留余量的话，`Date.now() - i * GAP` 这种写法只要多取一次 Date.now()，
 * 相邻两条就只差 3h59m59.9xx，刚好掉进同一个桶 —— 测试会因为几毫秒而假失败。
 */
const SPREAD = 5 * HOUR;

beforeEach(() => {
  dir = path.join(os.tmpdir(), `voice-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  v = new VoiceService(dir);
});

/**
 * 把已录到的正样本在时间上摊开（每条错开 SPREAD），模拟"不同场合都这么说"。
 *
 * M40：抽取判据从「跨会话」换成「跨时间桶」之后，样本的 `at` 也参与判定。
 * 测试里 recordUtterance/judgeIncoming 是在同一毫秒内跑完的 ——
 * 那在时间维度上等于「同一场对话里连说几句」，本来就**不该**算独立证据。
 * 所以要模拟"另一场对话"，必须把时间显式挪开。
 *
 * 基准时间只取一次：每条各自取 Date.now() 会积累几毫秒误差，
 * 正好落在桶边界上时行为不可预测。
 */
function spreadAway(service: VoiceService, base = Date.now()): void {
  const all = service.snapshot().caughtSamples;
  all.forEach((s, i) => {
    // 保持时间先后与样本顺序一致：最后一条最新（=base），往前每条退 SPREAD
    s.at = base - (all.length - 1 - i) * SPREAD;
  });
}

describe('VoiceService · 采集', () => {
  it('记录合适的发言，过滤图片占位和过短内容', () => {
    expect(v.recordUtterance('t1', 'group:g', '说实话这游戏还行')).toBe(true);
    expect(v.recordUtterance('t2', 'group:g', '嗯')).toBe(false); // 太短
    expect(v.recordUtterance('t3', 'group:g', '[图片]')).toBe(false); // 占位
    expect(v.snapshot().pending.length).toBe(1);
  });

  it('判定"被接住"：哈哈/确实/问号 都算', () => {
    v.recordUtterance('t1', 'group:g', '说实话这游戏还行');
    const caught1 = v.judgeIncoming('group:g', '哈哈哈确实');
    expect(caught1.length).toBe(1);
    expect(v.caughtSampleCount()).toBe(1);

    v.recordUtterance('t2', 'group:g', '要不先睡吧');
    v.judgeIncoming('group:g', '？');
    expect(v.caughtSampleCount()).toBe(2);
  });

  it('被嫌的发言不记为负样本、也不进正样本', () => {
    v.recordUtterance('t1', 'group:g', '这话我说了算');
    v.judgeIncoming('group:g', '太吵了闭嘴');
    expect(v.caughtSampleCount()).toBe(0);
    expect(v.snapshot().pending.filter((p) => p.turnId === 't1')).toHaveLength(0);
  });

  it('平淡回应保留在待判定队列（可能下一句才接住）', () => {
    v.recordUtterance('t1', 'group:g', '今天有点累');
    v.judgeIncoming('group:g', '嗯我在忙');
    expect(v.snapshot().pending.some((p) => p.turnId === 't1')).toBe(true);
  });

  it('跨会话的发言不被误判', () => {
    v.recordUtterance('t1', 'c2c:a', '说实话不想动');
    v.judgeIncoming('group:b', '哈哈哈');
    expect(v.caughtSampleCount()).toBe(0);
    expect(v.snapshot().pending.length).toBe(1);
  });
});

describe('VoiceService · 抽取与护栏', () => {
  /**
   * 造样本。
   *
   * M39 之后所有类别都要求「不同场合」出现过；M40 起「不同场合」按**时间桶**
   * 衡量（同一词组出现在相隔 ≥4 小时的两个时间桶里），不再按 session key 数。
   * 所以这里既轮流用两个 key（覆盖跨会话这条老路径），也把样本按小时错开 ——
   * 两条路任意一条成立都算独立证据，样本才不会被时间维度判成"同一场对话"。
   */
  function seedSamples(service: VoiceService, lines: string[]): void {
    for (const [i, l] of lines.entries()) {
      const k = i % 2 === 0 ? 'group:g' : 'group:g2';
      service.recordUtterance(`t${i}`, k, l);
      service.judgeIncoming(k, '哈哈确实');
    }
    spreadAway(service);
  }

  it('样本不足不抽取（<4 条）', () => {
    seedSamples(v, ['说实话还行', '这个吧']);
    expect(v.extractCandidates().length).toBe(0);
  });

  it('抽取重复出现的句式特征', () => {
    seedSamples(v, ['说实话挺好', '说实话有点难', '先这样吧', '不聊了吧']);
    const c = v.extractCandidates();
    expect(c.length).toBeGreaterThan(0);
    expect(c.some((h) => h.style === '说实话')).toBe(true);
  });

  it('子串去重："说实" 不重复出现', () => {
    seedSamples(v, ['说实话挺好', '说实话有点难', '先这样吧', '不聊了吧']);
    const c = v.extractCandidates();
    const styles = c.map((h) => h.style);
    // "说实" 是 "说实话" 的子串，应被去掉
    expect(styles).not.toContain('说实');
  });

  it('冲突词被过滤（不学"哇/太棒了"这类破坏人设的话）', () => {
    seedSamples(v, ['哇这太棒了', '哇真的绝', '哇哈哈', '太棒了吧']);
    const c = v.extractCandidates();
    expect(c.every((h) => !h.style.includes('哇') && !h.style.includes('太棒'))).toBe(true);
  });
});

describe('VoiceService · 确认门槛与注入', () => {
  // M40：轮次级独立性由 turnId 保证，场合独立性由时间桶保证（见 voice.ts）
  function seed(service: VoiceService, n: number, line: string): void {
    for (let i = 0; i < n; i++) {
      const k = i % 2 === 0 ? 'group:g' : 'group:g2';
      service.recordUtterance(`t${i}`, k, line);
      service.judgeIncoming(k, '哈哈确实');
    }
    spreadAway(service);
  }

  it('未过门槛不注入', () => {
    seed(v, 4, '说实话挺好');
    v.extractCandidates();
    expect(v.renderSection()).toBe(''); // 候选不注入
  });

  it('满足门槛后转正并注入', () => {
    seed(v, 4, '说实话挺好');
    v.extractCandidates();
    const promoted = v.promoteHabits();
    expect(promoted).toBeGreaterThan(0);
    const sec = v.renderSection();
    expect(sec).toContain('说话习惯');
    expect(sec).toContain('说实话');
    expect(sec).toContain('不强求');
  });

  it('她可以表态拒绝某条口癖', () => {
    seed(v, 4, '说实话挺好');
    v.extractCandidates();
    const habits = v.snapshot().habits;
    expect(habits.length).toBeGreaterThan(0);
    const target = habits[0];
    expect(v.decideHabit(target.id, false)).toBe(true);
    expect(v.activeHabits()).toHaveLength(0);
  });

  it('长期不用会退役', () => {
    seed(v, 4, '说实话挺好');
    v.extractCandidates();
    v.promoteHabits();
    const before = v.activeHabits().length;
    const future = Date.now() + 100 * 24 * 3600 * 1000;
    const retired = v.retireStale(future);
    expect(retired).toBe(before);
    expect(v.activeHabits()).toHaveLength(0);
  });
});

describe('VoiceService · 持久化', () => {
  it('落盘后重新加载保持一致', () => {
    v.recordUtterance('t1', 'group:g', '说实话这游戏还行');
    v.judgeIncoming('group:g', '哈哈确实');
    v.save();
    const v2 = new VoiceService(dir);
    expect(v2.caughtSampleCount()).toBe(1);
  });
});

describe('口癖管线 · 从样本到生效（M32 修的死链）', () => {
  // 这条链原来只做了第一步：judgeIncoming 攒正样本，
  // 而 extractCandidates / promoteHabits 零调用。
  // 结果：样本攒到 60 条被丢，habits 永远空，
  // 而 persona-health 还在报"有正样本"—— 谎报健康。
  //
  // 测试必须走 service.judgeVoice 走完整链路，
  // 不能只测 extractCandidates 算得对 —— 那样把调用点删了测试还是绿的。

  it('反复被接住后，会真的长出生效的口癖', async () => {
    const { PersonaService } = await import('./service.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-pipe-'));
    const svc = new PersonaService({
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

    // 走完整真实路径：她说一句 → 记录 → 对方笑着接住 → service 判定
    // （不能直接往 caughtSamples 里灌，那样测不到 recordUtterance/judgeIncoming）
    //
    // M40：把样本在时间上摊开，模拟"不同场合都这么说"。
    // 全部压在同一个瞬间会被时间桶判据正确识别为"同一场对话里连说几句"。
    // 注意必须**边加边摊**：judgeVoice 每轮内部就会调 extractCandidates，
    // 只在循环结束后摊开的话，抽取早就按"同一瞬间"跑完了。
    const base = Date.now();
    for (let i = 0; i < 6; i++) {
      const k = i % 2 === 0 ? 'group:g' : 'group:g2';
      svc.voice.recordUtterance(`t${i}`, k, '说实话这事挺离谱的吧');
      svc.judgeVoice(k, '哈哈哈确实');
      spreadAway(svc.voice, base);
    }

    const habits = svc.voice.activeHabits();
    expect(habits.length).toBeGreaterThan(0);
  });

  it('样本不够时不会硬造口癖', () => {
    const v2 = new VoiceService(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-few-')));
    v2.judgeIncoming('group:g', '哈哈哈');
    expect(v2.extractCandidates()).toEqual([]);
  });
});

describe('markUsed · 使用计数必须真的在涨（M32）', () => {
  // 防的是 markUsed 零调用：lastSaidAt 永远 undefined，
  // retireStale 按一个从没被写过的时间判定退役，count 也永远不涨。

  it('说出口癖后会计数，并刷新 lastSaidAt', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-used-'));
    const svc = new VoiceService(dir2);
    // 造一条生效口癖（M40：把样本在时间上拉开，模拟跨场合重复）
    for (let i = 0; i < 6; i++) {
      const k = i % 2 === 0 ? 'group:g' : 'group:g2';
      svc.recordUtterance(`t${i}`, k, '说实话这事挺离谱的吧');
      svc.judgeIncoming(k, '哈哈哈确实');
    }
    spreadAway(svc);
    svc.extractCandidates();
    svc.promoteHabits();
    const h = svc.activeHabits()[0];
    expect(h).toBeDefined();

    const before = h!.count;
    svc.markUsed(h!.id);
    const after = svc.activeHabits().find((x) => x.id === h!.id)!;
    expect(after.count).toBe(before + 1);
    expect(after.lastSaidAt).toBeGreaterThan(0);
  });
});

describe('M33 · 口癖产出的表达性（线上 48 条样本的真实教训）', () => {
  // 复核 8a94319 时，用线上 voice.json 实跑，抽出并 100% 转正的是：
  //   「的。」「多。」「完了。」「一样。」「行,」
  // 这些会原样注入 system prompt：「当"想收尾时"时，可以用"的。"来表达。」
  //
  // 根因不是"没接线"，是**抽取粒度**：字符 n-gram 没有词边界，标点尾巴天然高频。
  // 同时 promoteHabits 的判据被 consider() 写死（count:n 且 evidence 恒定 2 条），
  // 任何候选一产生就转正 —— 门槛等于没设。

  // M40：样本按 4 小时错开 —— 这些用例要验证的是「抽取粒度/表达性」，
  // 得先让它们真的有资格进抽取（否则时间桶判据会把它们全拦在门外，
  // 测试就退化成"什么都没抽到所以断言成立"）。
  function seed(service: VoiceService, lines: string[], key = 'group:g'): void {
    for (const [i, l] of lines.entries()) {
      service.recordUtterance(`t${i}`, key, l);
      service.judgeIncoming(key, '哈哈确实');
    }
    spreadAway(service);
  }

  it('标点尾巴不算口癖（"的。""完了。""行,"都不该出现）', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-m33-'));
    const svc = new VoiceService(dir2);
    // 构造一批"以标点结尾"的样本，模拟线上那 48 条的形态
    seed(svc, ['逛了会儿，翻出点东西。', '好，逛得挺实在。', '成，这句翻篇了。', '那下回喊你吃饭就行。']);
    const c = svc.extractCandidates();
    for (const h of c) {
      // 去掉尾部标点后必须还有 >=2 个汉字，且以汉字开头
      const core = h.style.replace(/[，。！？、,.!?~…：:；;"'）)】\]》」]+$/, '');
      expect(core.length, `候选「${h.style}」去掉标点后太短`).toBeGreaterThanOrEqual(2);
      expect(/^[\u4e00-\u9fa5]/.test(core), `候选「${h.style}」不以汉字开头`).toBe(true);
    }
  });

  it('只有一个样本的不转正（门槛必须真的拦得住）', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-m33b-'));
    const svc = new VoiceService(dir2);
    // 同一句话只出现在 1 条样本里 → 不该转正
    seed(svc, ['随便说句别的吧', '今天天气还行呢', '这个我也不太懂', '总之先这样吧']);
    svc.extractCandidates();
    const promoted = svc.promoteHabits();
    const active = svc.activeHabits();
    // 任何转正的都必须有 >=3 次真实出现（PROMOTE_MIN_COUNT）
    for (const h of active) expect(h.count).toBeGreaterThanOrEqual(3);
    expect(promoted).toBe(active.length);
  });

  it('真口癖仍然能转正（护栏不能把功能一起拦死）', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-m33c-'));
    const svc = new VoiceService(dir2);
    // "说实话" 在 4 个不同会话的 4 句话里都出现 → 这是真的说话习惯
    // M40：会话维度已不再是判据，但只要这 4 条发生在不同时间桶里，
    // 它就同样是"不同场合都这么说"。这里两条独立性都保留（4 个 key + 4 小时错开）。
    const lines = ['说实话这事挺离谱吧', '说实话我也这么想', '说实话不太行', '说实话有点难'];
    for (const [i, l] of lines.entries()) {
      svc.recordUtterance(`s${i}#${i}`, `group:g${i}`, l);
      svc.judgeIncoming(`group:g${i}`, '哈哈确实');
    }
    spreadAway(svc);
    svc.extractCandidates();
    expect(svc.promoteHabits()).toBeGreaterThan(0);
    const styles = svc.activeHabits().map((h) => h.style);
    expect(styles).toContain('说实话');
    expect(svc.renderSection()).toContain('说实话');
  });
});

describe('PENDING_TTL · 口癖样本必须有足够存活时间（M36）', () => {
  it('她说的话在 30 分钟后仍可被判定（原来 5 分钟就丢）', async () => {
    // 实测：线上 48 条样本、最新停在 11-02 12:07，40 小时没有新样本，
    // 但期间有 10 轮对话。根因是 TTL=5min，而真实对话间隔平均 12.1 分钟。
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'voice-ttl-'));
    const { VoiceService } = await import('./voice.ts');
    const v = new VoiceService(dir);

    expect(v.recordUtterance('t1', 'k1', '翻了下那个系列，看它还更不更新。')).toBe(true);
    // 模拟 30 分钟过去
    const pending = (v as unknown as { data: { pending: Array<{ at: number }> } }).data.pending;
    pending[0]!.at = Date.now() - 30 * 60_000;

    // 30 分钟后仍应能判定（不该被 TTL 丢掉）
    const caught = v.judgeIncoming('k1', '确实是这样');
    expect(caught.length).toBe(1);
  });
});

describe('M40 · 「不同场合」判据：时间桶而不是会话数', () => {
  // 线上实测（2026-11-12）：60 条正样本里 55 条同一个 session key
  // （用户跟她基本只有一个长期私聊会话），于是「≥2 个不同 key」这条判据
  // 恒为 false —— 「是我自己」「你这」两个候选 count 卡在 2，永远转不了正。
  // 这里直接按真实形态构造：**全部样本同一个 session key**。

  /** 同一个 key 下造样本；times 与 lines 一一对应（毫秒时间戳） */
  function seedSameKey(service: VoiceService, lines: string[], times: number[]): void {
    const base = 1_700_000_000_000;
    for (const [i, l] of lines.entries()) {
      service.recordUtterance(`t${i}`, 'session-same', l);
      service.judgeIncoming('session-same', '哈哈确实');
      const s = service.snapshot().caughtSamples[i];
      if (s) s.at = base + (times[i] ?? 0);
    }
  }

  it('同一会话里、相隔 5 小时的两条 → 算独立证据，能抽成候选', () => {
    const svc = new VoiceService(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-m40a-')));
    // 满足 extractCandidates 的 <4 条保护，同时让"说实话"出现两次
    seedSameKey(
      svc,
      ['说实话这事挺离谱吧', '今天倒是挺安静的', '说实话我也懒得动', '那就先这样了吧'],
      [0, 1 * HOUR, 5 * HOUR, 6 * HOUR],
    );
    const c = svc.extractCandidates();
    const styles = c.map((h) => h.style);
    expect(styles).toContain('说实话');
  });

  it('同一会话里、相隔 1 分钟的两条 → 不算独立证据，抽不成候选', () => {
    const svc = new VoiceService(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-m40b-')));
    seedSameKey(
      svc,
      ['说实话这事挺离谱吧', '今天倒是挺安静的', '说实话我也懒得动', '那就先这样了吧'],
      [0, 1 * HOUR, 1 * HOUR + 60_000, 6 * HOUR],
    );
    const c = svc.extractCandidates();
    // 「说实话」只在同一场对话里连着说了两次 —— 不是跨场合的说话习惯
    expect(c.map((h) => h.style)).not.toContain('说实话');
  });

  it('相隔 5 小时的三条能让候选真的转正（端到端，不再是死锁）', () => {
    const svc = new VoiceService(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-m40c-')));
    // PROMOTE_MIN_COUNT=3：需要真含该词的 3 条样本；同时总样本 >=4 才进抽取
    const times = [0, 5 * HOUR, 10 * HOUR, 15 * HOUR];
    seedSameKey(
      svc,
      ['说实话这事挺离谱吧', '说实话我也这么想', '说实话不太行', '那今天就先这样了吧'],
      times,
    );
    svc.extractCandidates();
    expect(svc.promoteHabits()).toBeGreaterThan(0);
    expect(svc.activeHabits().map((h) => h.style)).toContain('说实话');
  });

  it('independentOccurrenceCount：时间桶切分语义', () => {
    const t = 1_700_000_000_000;
    expect(independentOccurrenceCount([])).toBe(0);
    expect(independentOccurrenceCount([t])).toBe(1);
    // 一样本内相隔 1 分钟 → 同一桶
    expect(independentOccurrenceCount([t, t + 60_000])).toBe(1);
    // 相隔 5 小时 → 两个桶
    expect(independentOccurrenceCount([t, t + 5 * HOUR])).toBe(2);
    // 输入顺序无关
    expect(independentOccurrenceCount([t + 5 * HOUR, t])).toBe(2);
    // 防链式吞并：每 3.9 小时出现一次、共 4 次、跨度 11.7 小时。
    // 「离上一条 >=4h」的写法会一路串下去 → 1 个桶（明明跨了半天的独立场合被判成同一场）。
    // 锚定桶起点后必然断开：0 → (3.9 同桶) → 7.8 起新桶 → (11.7 同桶) = 2 个桶。
    const chain = [0, 3.9, 7.8, 11.7].map((h) => t + h * HOUR);
    expect(independentOccurrenceCount(chain)).toBe(2);
  });

  it('按北京日期分桶会漏判的线上真实案例：跨日期边界但实际隔了 21 小时', () => {
    // 线上「是我自己」的两次出现：
    //   UTC 2026-10-31 17:02 = 北京 11-01 01:02
    //   UTC 2026-11-01 14:09 = 北京 11-01 22:09
    // 同为北京 11-01（按日期分桶只有 1 个桶），但实际相隔 21 小时 ——
    // 这是两场完全不同的对话，必须算独立证据。这就是选间隔分桶的理由。
    const a = 1_793_466_120_000;
    const b = 1_793_542_140_000;
    expect(independentOccurrenceCount([a, b])).toBe(2);
  });
});

describe('M41 · 表达性护栏（时间桶放宽后碎片漏进）', () => {
  // M40 把「不同场合」的判据从「跨会话」换成「时间桶」，死锁解除了
  //（真实口癖「是我自己」这类终于能进）。但旧判据在「顺带」承担挡碎片的职责，
  // 换维度后那个副作用消失了 —— 这不是 M40 改错了，是要把挡碎片显式做好。
  //
  // 线上实测（2026-11-12，voice.json 60 条样本）M40 之后新漏进并 100% 转正的是
  // 「今天」「不一样。」。下面的用例逐条钉住它们，同时钉住「不许误伤真口癖」。

  const SPREAD = 5 * HOUR;
  /** 与 voice.ts 的 PUNCT_ANY_RE 同源的判据（测试本地声明，避免导出实现细节） */
  const PUNCT_ANY = /[，。！？、；：,.!?;:…~"'（）()【】\[\]「」『』《》\s]/;

  function seed(service: VoiceService, lines: string[]): void {
    for (const [i, l] of lines.entries()) {
      const k = i % 2 === 0 ? 'group:g' : 'group:g2';
      service.recordUtterance(`t${i}`, k, l);
      service.judgeIncoming(k, '哈哈确实');
    }
    spreadAway(service);
  }

  function fresh(lines: string[]): VoiceService {
    const svc = new VoiceService(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-m41-')));
    seed(svc, lines);
    return svc;
  }

  it('「今天」被 COMMON 挡住（高频时间词不是口癖）', () => {
    // 它是完整词，不是碎片 —— 问题在于换谁说这句话都会有「今天」，
    // 它不构成"她这个人的说话习惯"。这类词只能靠枚举挡。
    const svc = fresh(['今天看了个讲研磨度的', '今天下午翻了几页书', '我觉得还行吧', '那就算了呗']);
    const styles = svc.extractCandidates().map((h) => h.style);
    expect(styles).not.toContain('今天');
  });

  it('「不一样。」被句中标点挡住（那个句号是小句的，不是句尾的）', () => {
    // 线上原句：「有句话一直停在脑子里，讲的是…在不在意的人那儿分量不一样。别的没干。」
    // 这里的「。」结束的是**小句**。旧 isExpressive 只剥**尾部**标点，
    // 「不一样。」→「不一样」看着无害就放过了。
    const svc = fresh([
      '有点近，但不全一样。别的没干',
      '两个结果不一样。就这样吧',
      '我觉得还行吧',
      '那就算了呗',
    ]);
    const styles = svc.extractCandidates().map((h) => h.style);
    expect(styles).not.toContain('不一样。');
    // 任何候选都不许以标点结尾
    for (const s of styles) expect(/[。！？，、；：]$/.test(s), `候选「${s}」以标点结尾`).toBe(false);
  });

  it('「字典页。」不再原样进候选（句尾标点先剥掉，再谈边界）', () => {
    // 线上原句：「搜出来的都是字典页和导航页，正经内容没有。」
    const svc = fresh([
      '搜出来是字典页。正经内容没有',
      '查出来是字典页。没别的',
      '我觉得还行吧',
      '那就算了呗',
    ]);
    const styles = svc.extractCandidates().map((h) => h.style);
    expect(styles).not.toContain('字典页。');
    expect(styles).not.toContain('字典页');
  });

  it('句尾 2 字候选在长句里被拒（词边界校验）', () => {
    // 「…还挺累」的「挺累」是半个词。2 字特异性太低，
    // 长句里除非前一字是结构助词，否则不认。
    //
    // 选例说明：必须让「挺累」**没有更长的候选把它包住** ——
    // 否则它会被子串去重顺带干掉，这条测试就变成假绿
    //（换成「…很累了」时，「累了」会被「真的很累」吃掉，
    //  即使拆掉 tailBoundaryOk 也照样通过，测不出东西）。
    const svc = fresh(['今天上班还挺累', '这几天干活是挺累', '我觉得还行吧', '那就算了呗']);
    const styles = svc.extractCandidates().map((h) => h.style);
    expect(styles).not.toContain('挺累');
    expect(styles).not.toContain('是挺累');
  });

  it('跨小句的切片含标点 → 一律拒（不只是句号尾巴）', () => {
    // 线上「不一样。」的实质：那个「。」结束的是**小句**。
    // 这里用「不一样。别」把它钉死 —— 这是 mid 类 5 字切片，
    // 长度足以通过长度判据、既不以虚词开头也不以虚词结尾，
    // 唯一能挡它的就是「词内部含标点」。
    //
    // 选例说明：必须让它**不被别的判据顺手挡住**，否则拆掉标点护栏测试仍是绿的。
    //（用「不一样。别的没干」时，「。别的没干」会因以「。」开头/结尾被 isExpressive 拒，
    //  这条测试就测不到标点护栏本身。）
    const svc = fresh(['分数不一样。别的不说', '结果不一样。别的算了', '我觉得还行吧', '那就算了呗']);
    const styles = svc.extractCandidates().map((h) => h.style);
    for (const s of styles) {
      expect(PUNCT_ANY.test(s), `候选「${s}」内部含标点，不该通过`).toBe(false);
    }
    expect(styles).not.toContain('不一样。别');
  });

  it('常用词在这些样本里半句重复，也不会因为高频就当成口癖', () => {
    // 「是我自己」在线上是**真候选**（M40 保住的那个），
    // 这里刻意构造它出现在 4/4 条里 —— 密度极高，但它是 mid 类：
    // mid 没有位置锚点，高频即常用词，密度兜底会拦（阈值 0.5）。
    // 这条测的是"密度判据确实在 mid 上生效"，不是"是我自己永远该被拒"。
    const svc = fresh([
      '另一行是我自己的话',
      '这些都算是我自己的东西',
      '说来是我自己选的',
      '剩下的是我自己的份',
    ]);
    const styles = svc.extractCandidates().map((h) => h.style);
    expect(styles).not.toContain('是我自己');
  });

  // ───────── 以下两条是「防误伤」，比上面任何一条都重要 ─────────
  // M34 注释里点名「说实话」是真实口癖的正面例子。
  // 收紧护栏时最危险的失败不是"漏挡"，是"把功能一起拦死"。

  it('「说实话」跨时间桶仍能抽成候选并转正（不许误伤）', () => {
    const svc = fresh([
      '说实话这事挺离谱吧',
      '说实话我也这么想',
      '说实话不太行',
      '那今天就先这样了吧',
    ]);
    const c = svc.extractCandidates();
    expect(c.map((h) => h.style)).toContain('说实话');
    expect(svc.promoteHabits()).toBeGreaterThan(0);
    expect(svc.activeHabits().map((h) => h.style)).toContain('说实话');
  });

  it('「说真的」「其实吧」这类以虚词收尾的真口癖也不许误伤', () => {
    // 它们确实以「的」「吧」结尾，本能会被"虚词收尾"判据当碎片拒掉，
    // 但它们是汉语里一个封闭小类（话语标记），见 voice.ts 的 DISCOURSE_MARKERS。
    const cases: Array<[string, string[]]> = [
      ['说真的', ['说真的这游戏还行', '说真的我没想到', '说真的有点离谱', '那下回再说吧']],
      ['其实吧', ['其实吧我也不确定', '其实吧这没啥', '其实吧挺一般的', '那就算了呗']],
    ];
    for (const [marker, lines] of cases) {
      const svc = fresh(lines);
      const styles = svc.extractCandidates().map((h) => h.style);
      expect(styles, `「${marker}」被误伤了`).toContain(marker);
    }
  });

  it('垃圾片段被剔除后，它不许顺带把合法候选一起带走（护栏顺序）', () => {
    // 回归：dedup（子串去重）原来跑在硬性过滤**之前**，
    // 于是更长的垃圾片段先把合法短候选判成子串丢掉，自己再被过滤 —— 双双消失。
    // 实测过的形态：「说实话这事」(mid,6字) 包含「说实话」(start,3字)，
    // 若 mid 那条随后被密度拒，start 这条也已经被误杀，产出空集。
    // 现在顺序是「先剔垃圾 → 再在存活者之间做子串去重」，两者互不牵连。
    const svc = fresh([
      '说实话这事挺离谱的吧',
      '说实话这事挺离谱的吧',
      '说实话这事挺离谱的吧',
      '说实话这事挺离谱的吧',
    ]);
    const styles = svc.extractCandidates().map((h) => h.style);
    expect(styles).toContain('说实话');
  });
});
