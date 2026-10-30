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
import path from 'node:path';

export interface PersonLedger {
  name: string;
  traits: string[];
  facts: string[];
  topics: string[];
  pending: string[];
  interactions: number;
  firstSeenAt: number;
  lastSeenAt: number;
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
      fs.appendFileSync(this.turnsFile, JSON.stringify(rec) + '\n', 'utf8');
      const lines = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n');
      if (lines.length > this.maxTurns) {
        fs.writeFileSync(this.turnsFile, lines.slice(-this.maxTurns).join('\n') + '\n', 'utf8');
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
    if (p.traits?.length) L.push('你了解他：' + p.traits.slice(-12).join('；'));
    if (p.facts?.length) L.push('他告诉过你：' + p.facts.slice(-12).join('；'));
    if (p.topics?.length) L.push('你们聊过：' + p.topics.slice(-8).join('；'));
    if (p.pending?.length) L.push('⚠️ 你心里还记着没说出口的事：' + p.pending.slice(-4).join('；'));
    if (p.interactions) L.push('你们互动过 ' + p.interactions + ' 次');
    if (!L.length) return '';
    return '【关于 ' + (p.name || id) + '（' + id + '）的一本账】\n' + L.join('\n') + '\n';
  }

  /** 把最近对话渲染成一段可注入的文字 */
  renderRecent(n = 20, opts: { excludeWhere?: string; sinceMs?: number } = {}): string {
    const rows = this.recentTurns(n, opts);
    if (!rows.length) return '';
    const lines = rows.map((r) => {
      const when = new Date(r.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
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
