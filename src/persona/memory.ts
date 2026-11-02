/**
 * 记忆账本 · 按「人」存，而不是按「会话」存
 * ─────────────────────────────────────────────────────────────
 * 移植自 ai-companion-kit（MIT）packages/companion/src/memory.js，
 * 作者 pinganbbOvO。逻辑保持一致，改为 TS 严格模式。
 *
 * 大多数聊天机器人把记忆按会话存：私聊一份、群聊一份、不同群各一份。
 * 结果就是同一个人换了地方，AI 就"不认识"他了。
 * 这里所有记忆都挂在人身上（官方 API 用 user openid 当 key）。
 */
import fs from 'node:fs';
import { clockInTz } from './clock.ts';
import {
  type Importance,
  freshness,
  rankScore,
  inferImportance,
  isStableFact,
} from './memory-decay.ts';
import path from 'node:path';

/**
 * 每条记忆的衰减状态（M27，借鉴 dsh-fish-memory）。
 *
 * 存在独立的 `decay` 里，**不塞进 traits/facts/topics 数组本身**——
 * 那些是纯字符串数组，改结构会破坏现有数据和工具。
 * key 是那条记忆的原文，value 是它的状态。
 */
export interface DecayMap {
  [text: string]: {
    /** 时间锚（毫秒）。被强化时重置 */
    a: number;
    /** 重要度 0 / 0.5 / 1 */
    i: Importance;
    /** 初始鲜活度 */
    a0: number;
    /** 是否长期事实（不过期） */
    st?: 1;
  };
}

export interface PersonLedger {
  name: string;
  traits: string[];
  facts: string[];
  topics: string[];
  pending: string[];
  interactions: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** 衰减状态（M27）。老数据没有这个字段，读到时自动补 */
  decay?: DecayMap;
}

export interface TurnRecord {
  t: number;
  where: string;
  who: string;
  text: string;
  reply: string;
}

export interface RememberInput {
  trait?: string;
  fact?: string;
  topic?: string;
  pending?: string;
  name?: string;
}

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** key 形态守卫：QQ openid 为 [\w-]+ 且必不为原型污染保留键 */
function safeKey(id: string): string {
  const key = String(id);
  if (RESERVED_KEYS.has(key) || !/^[\w.-]+$/.test(key)) {
    throw new Error(`memory: 非法 person key: ${key.slice(0, 40)}`);
  }
  return key;
}

export class Memory {
  private readonly peopleFile: string;
  private readonly turnsFile: string;
  private readonly maxTopics: number;
  private readonly maxTurns: number;
  /** turns.jsonl 当前行数缓存（避免每次 logTurn 全文件扫描，审查 m8） */
  private turnLineHint = -1;

  constructor({ dir, maxTopics = 20, maxTurns = 400 }: { dir: string; maxTopics?: number; maxTurns?: number }) {
    this.peopleFile = path.join(dir, 'people.json');
    this.turnsFile = path.join(dir, 'turns.jsonl');
    this.maxTopics = maxTopics;
    this.maxTurns = maxTurns;
    fs.mkdirSync(dir, { recursive: true });
  }

  // ── 底层读写 ────────────────────────────────────────────────
  private readAll(): Record<string, PersonLedger> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.peopleFile, 'utf8')) as Record<string, PersonLedger>;
      // 审查 B1：断开原型链，防 "__proto__"/"constructor" 键写穿全局 Object.prototype
      Object.setPrototypeOf(parsed, null);
      return parsed;
    } catch {
      return {};
    }
  }

  private writeAll(j: Record<string, PersonLedger>): void {
    fs.writeFileSync(this.peopleFile, JSON.stringify(j, null, 2), 'utf8');
  }

  private static blank(name: string): PersonLedger {
    return {
      name,
      traits: [], facts: [], topics: [], pending: [],
      interactions: 0,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
  }

  /** 取某个人的账（不存在就建） */
  person(id: string, { name }: { name?: string } = {}): PersonLedger {
    const all = this.readAll();
    const key = safeKey(id);
    if (!all[key]) {
      all[key] = Memory.blank(name ?? key);
      this.writeAll(all);
    }
    const p = all[key] as PersonLedger;
    // 补字段（老数据兼容）
    for (const k of ['traits', 'facts', 'topics', 'pending'] as const) {
      if (!Array.isArray(p[k])) p[k] = [];
    }
    if (name && p.name !== name) {
      p.name = name;
      this.writeAll(all);
    }
    return p;
  }

  /** 往某人账上写一条 */
  remember(id: string, { trait, fact, topic, pending, name }: RememberInput = {}): PersonLedger {
    const all = this.readAll();
    const key = safeKey(id);
    if (!all[key]) all[key] = Memory.blank(name ?? key);
    const p = all[key] as PersonLedger;
    for (const k of ['traits', 'facts', 'topics', 'pending'] as const) {
      if (!Array.isArray(p[k])) p[k] = [];
    }
    if (name) p.name = String(name).slice(0, 40);

    const put = (arr: string[], v: string | undefined): void => {
      const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!s) return;
      const i = arr.indexOf(s);
      if (i >= 0) arr.splice(i, 1);      // 提过的挪到最新
      arr.push(s);
    };

    if (trait) put(p.traits, trait);
    if (fact) put(p.facts, fact);
    if (topic) put(p.topics, topic);
    if (pending) put(p.pending, pending);

    // ── M27：给每条记忆写上衰减状态 ──
    // 没有这一步，衰减就是死代码（和源码里 emotion 字段的毛病一样）。
    // 重要度由**规则**判定（不是模型），稳定事实（工作/住址/家人/宠物/喜好/约定）
    // 会拿到 importance=1 → 有效半衰期 90 天，且标记为不过期。
    const now = Date.now();
    const note = (text: string | undefined): void => {
      if (!text) return;
      const imp = inferImportance(text);
      const prev = p.decay?.[text];
      p.decay ??= {};
      p.decay[text] = prev
        // 已经记过 → 强化（A' = A + 0.2(1−A)，锚点重置到现在）
        ? {
            a: now,
            a0: Math.min(1, freshness({ activation0: prev.a0, anchor: prev.a, importance: prev.i, stable: prev.st === 1 }, now) + 0.2),
            i: Math.max(prev.i, imp) as Importance,
            ...(isStableFact(text) ? { st: 1 as const } : {}),
          }
        : {
            a: now,
            a0: 1,
            i: imp,
            ...(isStableFact(text) ? { st: 1 as const } : {}),
          };
    };
    note(trait);
    note(fact);
    note(topic);
    note(pending);

    while (p.topics.length > this.maxTopics) p.topics.shift();
    while (p.traits.length > 40) p.traits.shift();
    while (p.facts.length > 60) p.facts.shift();
    while (p.pending.length > 12) p.pending.shift();

    p.lastSeenAt = Date.now();
    p.interactions = (Number(p.interactions) || 0) + 1;
    this.writeAll(all);
    return p;
  }

  /** 记一次互动（不加内容，只涨计数） */
  touch(id: string, { name }: { name?: string } = {}): void {
    const all = this.readAll();
    const key = safeKey(id);
    if (!all[key]) {
      this.remember(key, { name });
      return;
    }
    const p = all[key] as PersonLedger;
    p.lastSeenAt = Date.now();
    p.interactions = (Number(p.interactions) || 0) + 1;
    if (name) p.name = String(name).slice(0, 40);
    this.writeAll(all);
  }

  // ── 共享对话流 ──────────────────────────────────────────────
  /** 记一轮对话。where 用来说明发生在哪（'c2c' / 'group:xxx'） */
  logTurn({ where, who, text, reply }: { where: string; who: string; text: string; reply: string }): void {
    const rec: TurnRecord = {
      t: Date.now(),
      where: String(where ?? ''),
      who: String(who ?? '').slice(0, 30),
      text: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      reply: String(reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    };
    if (!rec.text && !rec.reply) return;
    try {
      const line = JSON.stringify(rec);
      fs.appendFileSync(this.turnsFile, line + '\n', 'utf8');
      this.turnLineHint += 1;
      // 超过上限才裁剪（平时只 append，不整文件重读）
      if (this.turnLineHint > this.maxTurns) {
        const lines = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n');
        const keep = lines.slice(-this.maxTurns);
        fs.writeFileSync(this.turnsFile, keep.join('\n') + '\n', 'utf8');
        this.turnLineHint = keep.length;
      }
    } catch {
      /* 写失败不影响主流程 */
    }
  }

  /** 取最近 n 轮（可按来源过滤） */
  recentTurns(n = 20, { excludeWhere, sinceMs }: { excludeWhere?: string; sinceMs?: number } = {}): TurnRecord[] {
    let rows: TurnRecord[] = [];
    try {
      rows = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n')
        .map((l) => {
          try {
            return JSON.parse(l) as TurnRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is TurnRecord => r !== null);
    } catch {
      return [];
    }
    if (sinceMs) rows = rows.filter((r) => Date.now() - r.t < sinceMs);
    if (excludeWhere) rows = rows.filter((r) => !String(r.where ?? '').startsWith(excludeWhere));
    return rows.slice(-n);
  }

  // ── 给提示词用 ──────────────────────────────────────────────
  /** 把某人的账渲染成一段可注入的文字 */
  renderPerson(id: string): string {
    let key: string;
    try {
      key = safeKey(id);
    } catch {
      return '';
    }
    const p = this.readAll()[key];
    if (!p) return '';
    const L: string[] = [];

    // M27：按「鲜活度 × 重要度」排序，而不是简单的 slice(-12) 取最近 12 条。
    // 原因：一条"他养了只橘猫"（稳定事实）和一条"他今天说好累"（随口一提）
    // 分量完全不同，但先进先出会把它们一视同仁，重要的被闲聊挤掉。
    const pick = (arr: string[], limit: number, base: number): string[] =>
      this.rankByDecay(p, arr, limit, base);

    if (p.traits?.length) L.push('你了解他：' + pick(p.traits ?? [], 12, 1).join('；'));
    if (p.facts?.length) L.push('他告诉过你：' + pick(p.facts ?? [], 12, 0.8).join('；'));
    if (p.topics?.length) L.push('你们聊过：' + pick(p.topics ?? [], 8, 0.5).join('；'));
    if (p.pending?.length) L.push('⚠️ 你心里还记着没说出口的事：' + p.pending.slice(-4).join('；'));
    if (p.interactions) L.push('你们互动过 ' + p.interactions + ' 次');
    if (!L.length) return '';
    return '【关于 ' + (p.name || id) + '（' + id + '）的一本账】\n' + L.join('\n') + '\n';
  }

  /**
   * 按「鲜活度 × 重要度」排序取前 N 条（M27）。
   *
   * 没有 decay 记录的老数据按"刚记录的、重要度中等"处理，
   * 这样升级后老记忆不会突然全部消失。
   */
  private rankByDecay(p: PersonLedger, arr: string[], limit: number, baseEvidence: number): string[] {
    if (arr.length <= limit) return arr;
    const now = Date.now();
    const scored = arr.map((text, idx) => {
      const d = p.decay?.[text];
      const st = d
        ? { activation0: d.a0, anchor: d.a, importance: d.i, stable: d.st === 1 }
        : { activation0: 1, anchor: p.lastSeenAt || now, importance: 0.5 as Importance, stable: false };
      // 数组越靠后越新 → 给一点点"新近"加分，避免完全打平
      const recencyBump = idx / Math.max(1, arr.length);
      return {
        text,
        score: rankScore(baseEvidence * (1 + recencyBump * 0.1), st, now),
      };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.text);
  }

  /** 把最近对话渲染成一段可注入的文字 */
  renderRecent(n = 20, opts: { excludeWhere?: string; sinceMs?: number } = {}): string {
    const rows = this.recentTurns(n, opts);
    if (!rows.length) return '';
    const lines = rows.map((r) => {
      // 时间戳必须按北京时区渲染。
      // 踩过的坑（2026-11-02）：toLocaleTimeString 走容器本地时区（UTC），
      // 于是注入给她看的"你昨天 20:00 说过…"实际是北京次日 04:00 ——
      // 这不只是显示问题，它**污染她自己的时间认知**（她会以为自己在深夜聊天）。
      const when = clockInTz(new Date(r.t));
      const place = r.where.startsWith('group') ? '群里' : '私聊';
      const parts: string[] = [];
      if (r.text) parts.push(`${r.who}（${place}）：${r.text}`);
      if (r.reply) parts.push(`你：${r.reply}`);
      return `  ${when}  ` + parts.join('\n        ');
    });
    return '【最近的真实对话（跨场合合在一起）】\n' + lines.join('\n')
      + '\n（这些是真说过的，别装作不知道，也别生硬复述）\n';
  }

  /** 导出（调试/备份用） */
  dump(): { people: Record<string, PersonLedger>; turns: TurnRecord[] } {
    return { people: this.readAll(), turns: this.recentTurns(1e9) };
  }
}
