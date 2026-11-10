import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceService } from './voice.ts';

let dir: string;
let v: VoiceService;

beforeEach(() => {
  dir = path.join(os.tmpdir(), `voice-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  v = new VoiceService(dir);
});

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
   * M39 之后**所有类别都要求跨会话**（同一个会话里重复不算说话习惯），
   * 所以这里轮流用两个 key —— 否则抽不出任何候选。
   * 真实线上同理：53 条样本只来自 2 个会话时，抽出来的全是中文常用词的巧合重复。
   */
  function seedSamples(service: VoiceService, lines: string[]): void {
    for (const [i, l] of lines.entries()) {
      const k = i % 2 === 0 ? 'group:g' : 'group:g2';
      service.recordUtterance(`t${i}`, k, l);
      service.judgeIncoming(k, '哈哈确实');
    }
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
  // M39：同样要跨会话（两个 key 轮流）
  function seed(service: VoiceService, n: number, line: string): void {
    for (let i = 0; i < n; i++) {
      const k = i % 2 === 0 ? 'group:g' : 'group:g2';
      service.recordUtterance(`t${i}`, k, line);
      service.judgeIncoming(k, '哈哈确实');
    }
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
    // M39：轮流两个会话，否则跨会话判据过不了（同一场里重复不算说话习惯）
    for (let i = 0; i < 6; i++) {
      const k = i % 2 === 0 ? 'group:g' : 'group:g2';
      svc.voice.recordUtterance(`t${i}`, k, '说实话这事挺离谱的吧');
      svc.judgeVoice(k, '哈哈哈确实');
    }

    const habits = svc.voice.activeHabits();
    expect(habits.length).toBeGreaterThan(0);
  }, 20_000);

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
    // 造一条生效口癖（M39：必须跨会话，两个 key 轮流）
    for (let i = 0; i < 6; i++) {
      const k = i % 2 === 0 ? 'group:g' : 'group:g2';
      svc.recordUtterance(`t${i}`, k, '说实话这事挺离谱的吧');
      svc.judgeIncoming(k, '哈哈哈确实');
    }
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

  function seed(service: VoiceService, lines: string[], key = 'group:g'): void {
    for (const [i, l] of lines.entries()) {
      service.recordUtterance(`t${i}`, key, l);
      service.judgeIncoming(key, '哈哈确实');
    }
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
    const lines = ['说实话这事挺离谱吧', '说实话我也这么想', '说实话不太行', '说实话有点难'];
    for (const [i, l] of lines.entries()) {
      svc.recordUtterance(`s${i}#${i}`, `group:g${i}`, l);
      svc.judgeIncoming(`group:g${i}`, '哈哈确实');
    }
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

