/**
 * persona · 装配器
 * ─────────────────────────────────────────────────────────────
 * 把移植自 ai-companion-kit 的五个模块（Role/Memory/Waker/Humanizer/Diary）
 * 与 own-life 静默唤醒装配成一个服务，暴露给：
 *   - session-manager：system-prompt/assemble 注入（人格 + 记忆 + 日记）
 *   - inbound：Waker 判定 + 对话流水记账
 *   - outbound：Humanizer 拟人化发送 + 回复记账
 *   - bootstrap：工具注册（qq_write_diary / qq_read_diary / qq_memory_append）
 *                + own-life 定时静默唤醒 + 主动消息预算/冷退避
 */
import path from 'node:path';
import { Memory } from './memory.ts';
import { Diary } from './diary.ts';
import { Role } from './role.ts';
import { Waker } from './wake.ts';
import { Humanizer } from './humanize.ts';
import { createOwnLife, type OwnLifeHandle, type OwnLifeDeliverResult } from './own-life.ts';
import type { PersonaConfig } from '../config.ts';
import type { Logger } from '../types.ts';

export interface PersonaBudgetPeer {
  lastProactiveAt: number;
  unansweredStreak: number;
  mutedUntil: number;
  /** 本轮主动推送是否已记过"未响应"（防重复计） */
  staleCounted?: boolean;
}

/**
 * 主动消息预算 + 冷启动退避（DESIGN §4）。
 * streak≥2 冷却 3 天，≥3 冷却 14 天，≥5 永久静默该 peer。
 */
export class ProactiveBudget {
  private peers = new Map<string, PersonaBudgetPeer>();
  private daily = new Map<string, number>();
  private dayKey = '';

  constructor(
    private readonly maxPerPeerPerDay: number,
    private readonly minGapMs: number,
    private readonly logger: Logger,
  ) {}

  private day(): string {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  private peer(id: string): PersonaBudgetPeer {
    let p = this.peers.get(id);
    if (!p) {
      p = { lastProactiveAt: 0, unansweredStreak: 0, mutedUntil: 0 };
      this.peers.set(id, p);
    }
    return p;
  }

  /** 是否允许对该 peer 主动推送 */
  allow(peerId: string): { ok: boolean; reason?: string } {
    const today = this.day();
    if (today !== this.dayKey) {
      this.daily.clear();
      this.dayKey = today;
    }
    const p = this.peer(peerId);
    const now = Date.now();
    if (p.mutedUntil === -1) return { ok: false, reason: 'muted-forever' };
    if (now < p.mutedUntil) return { ok: false, reason: 'cooling' };
    if ((this.daily.get(peerId) ?? 0) >= this.maxPerPeerPerDay) return { ok: false, reason: 'daily-cap' };
    if (now - p.lastProactiveAt < this.minGapMs) return { ok: false, reason: 'too-soon' };
    return { ok: true };
  }

  /** 记一次主动推送 */
  recordProactive(peerId: string): void {
    const p = this.peer(peerId);
    p.lastProactiveAt = Date.now();
    p.staleCounted = false;
    this.daily.set(peerId, (this.daily.get(peerId) ?? 0) + 1);
  }

  /** 主动推送后对方无响应（own-life 决定发消息但对方没回） */
  markUnanswered(peerId: string): void {
    const p = this.peer(peerId);
    p.unansweredStreak += 1;
    const now = Date.now();
    if (p.unansweredStreak >= 5) {
      p.mutedUntil = -1;
      this.logger.info(`persona: budget peer ${peerId} muted forever (streak=${p.unansweredStreak})`);
    } else if (p.unansweredStreak >= 3) {
      p.mutedUntil = now + 14 * 24 * 3600_000;
    } else if (p.unansweredStreak >= 2) {
      p.mutedUntil = now + 3 * 24 * 3600_000;
    }
  }

  /** 对方主动说话 → 清零（这是社交意义上"理你了"） */
  markReplied(peerId: string): void {
    const p = this.peer(peerId);
    // 只有"在我方最后一次主动推送之后来的消息"才算理你了（防 observe 交替重计）
    if (p.lastProactiveAt === 0 || Date.now() >= p.lastProactiveAt) p.staleCounted = false;
    if (p.unansweredStreak > 0) {
      p.unansweredStreak = 0;
      p.mutedUntil = 0;
    }
  }

  /**
   * 观察 peer 的最近活跃时间：若晚于我方最后一次主动推送，
   * 视为"理你了"清零；否则在下次投递前记一次未响应。
   * （inbound 直接调 markReplied；本方法供 own-life 投递前结算用）
   */
  observe(peerId: string, lastActivityAt: number): void {
    const p = this.peer(peerId);
    if (p.lastProactiveAt === 0) return;
    if (lastActivityAt > p.lastProactiveAt) this.markReplied(peerId);
    else if (!p.staleCounted) {
      p.staleCounted = true;
      this.markUnanswered(peerId);
    }
  }

  /** 定期清理（审查 m9）：清掉从未主动推送过的纯占位空壳。
   *  正在冷退避、永久静默、以及近期主动过的 peer 保留（语义不能丢）。 */
  prune(staleMs = 30 * 24 * 3600_000): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, p] of this.peers) {
      const active = p.lastProactiveAt > 0 && now - p.lastProactiveAt < staleMs;
      const inCooldown = p.mutedUntil !== 0; // >0 冷却中，-1 永久静默
      if (!active && !inCooldown && p.unansweredStreak === 0) {
        this.peers.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

export interface PersonaDeps {
  config: PersonaConfig;
  /** persona 数据根目录（bootstrap 解析默认 ~/.dsh-qqbot/persona） */
  dataDir: string;
  logger: Logger;
}

export class PersonaService {
  public readonly memory: Memory;
  public readonly diary: Diary;
  public readonly role: Role | undefined;
  public readonly waker: Waker | undefined;
  public readonly humanizer: Humanizer;
  public readonly budget: ProactiveBudget;
  public ownLife: OwnLifeHandle | undefined;
  /** 轮内记账暂存（sessionId → 用户/回复文本），turn/end 配对写流水后清除。
   *  刻意不挂 SessionRecord：deliverables 等既有路径对 record 做深比较 */
  private readonly turnLedger = new Map<string, { user?: string; reply: string; who?: string }>();
  private readonly pruneTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: PersonaDeps) {
    const { config, dataDir, logger } = deps;
    this.memory = new Memory({ dir: path.join(dataDir, 'memory') });
    this.diary = new Diary(path.join(dataDir, 'diary'));
    if (config.roleCardPath) {
      this.role = new Role({ cardPath: config.roleCardPath, maxChars: config.roleMaxChars });
      const l = this.role.lint();
      if (!l.ok) logger.warn(`persona: 角色卡体检: ${l.warn.join(' | ')}`);
      else logger.info('persona: 角色卡体检通过');
    }
    if (config.wakeEnabled) {
      this.waker = new Waker({
        names: config.names,
        keywords: config.keywords,
        ownerIds: config.ownerOpenids,
        probability: config.groupProbability,
      });
    }
    this.humanizer = new Humanizer({
      enabled: config.humanizeEnabled,
      msPerChar: config.msPerChar,
      burstMax: config.burstMax,
      gapRange: config.gapMinMs && config.gapMaxMs ? [config.gapMinMs, config.gapMaxMs] : undefined,
    });
    this.budget = new ProactiveBudget(config.maxProactivePerDay, config.proactiveMinGapMs, logger);
    // 周期清理 Waker/Budget 的过期会话状态（审查 m9）——每 6h 一次
    this.pruneTimer = setInterval(() => this.pruneStale(), 6 * 3600_000);
    if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref();
  }


  /** 清掉长期无活跃的会话配置/预算占位（waker + budget） */
  private pruneStale(): void {
    const SW = 30 * 24 * 3600_000;
    const a = this.waker?.prune(SW) ?? 0;
    const b = this.budget.prune(SW);
    if (a || b) this.deps.logger.info(`persona: prune 清理 waker=${a} budget=${b}`);
  }

  /** 该 peer 的注入 section（人格 + 该人的账 + 日记连续性）；空数组 = 不注入 */
  buildSections(personKey: string | undefined): Array<{ name: string; order: number; text: string }> {
    const out: Array<{ name: string; order: number; text: string }> = [];
    if (this.role) {
      const text = this.role.renderSection();
      if (text) out.push({ name: 'qqbot:persona-role', order: 60, text });
    }
    if (personKey) {
      const ledger = this.memory.renderPerson(personKey);
      if (ledger) out.push({ name: 'qqbot:persona-memory', order: 62, text: ledger });
    }
    const diaryCtx = this.diary.context(3);
    if (diaryCtx) out.push({ name: 'qqbot:persona-diary', order: 64, text: diaryCtx });
    return out;
  }

  /** P6：时间感上下文——"几点了 / 周几 / 距上次聊了多久"，给人格现实锚点。
   *  距上次由调用方传入 lastActivityAt（ms）；缺省则不拼该句。 */
  static timeSection(now: Date = new Date(), lastActivityAt?: number): { name: string; order: number; text: string } | undefined {
    const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    let mindist = '';
    if (lastActivityAt) {
      const mins = Math.max(0, Math.round((now.getTime() - lastActivityAt) / 60000));
      if (mins >= 1) mindist = ` · 距上次聊了约 ${mins >= 60 ? `${Math.floor(mins / 60)}小时${mins % 60 ? `${mins % 60}分` : ''}` : `${mins}分`}`;
    }
    return {
      name: 'qqbot:persona-clock',
      order: 63,
      text: `[当前时间 ${hhmm} · 星期${week}${mindist}]`,
    };
  }

  /** 启动 own-life 静默唤醒（deliver 由 bootstrap 注入：向 owner 存活会话 followup 一条静默消息） */
  startOwnLife(deliver: (text: string) => Promise<OwnLifeDeliverResult>): void {
    if (!this.deps.config.ownLifeEnabled) return;
    this.ownLife = createOwnLife({
      deliver,
      statePath: path.join(this.deps.dataDir, 'state', 'own-life.json'),
      intervalMs: this.deps.config.ownLifeIntervalMs,
      maxPerDay: this.deps.config.ownLifeMaxPerDay,
      log: (m) => this.deps.logger.info(`persona: own-life ${m}`),
    });
    this.ownLife.start();
  }

  stop(): void {
    this.ownLife?.stop();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  /** inbound：本轮用户消息与其发言人（空串也记，覆盖上一轮残留） */
  noteUserTurn(sessionId: string, text: string, who?: string): void {
    const cur = this.turnLedger.get(sessionId) ?? { reply: '' };
    this.turnLedger.set(sessionId, { ...cur, user: text, who });
  }

  /** outbound：累积本轮已发送回复（截断 300 字，与 memory.logTurn 对齐） */
  noteReplyChunk(sessionId: string, text: string): void {
    const cur = this.turnLedger.get(sessionId) ?? { reply: '' };
    this.turnLedger.set(sessionId, { user: cur.user, who: cur.who, reply: (cur.reply + ' ' + text).slice(0, 300) });
  }

  /** outbound turn/end：配对写入跨场合流水并清暂存。
   *  who 优先取本轮实际发言人（群会话 record.senderId 是会话创建者，会记错人） */
  flushTurn(sessionId: string, where: string, fallbackWho: string): void {
    const entry = this.turnLedger.get(sessionId);
    this.turnLedger.delete(sessionId);
    if (!entry) return;
    const user = (entry.user ?? '').trim();
    const reply = entry.reply.trim();
    if (user || reply) this.memory.logTurn({ where, who: entry.who ?? fallbackWho, text: user, reply });
  }
}
