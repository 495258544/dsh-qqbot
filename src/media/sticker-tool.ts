/**
 * 表情包工具 — 让小羽按「使用时机」从本地表情库挑图
 * ─────────────────────────────────────────────────────────────
 * 设计原则：按"我什么时候想发这张图"分类，不是按画风/来源分类。
 *   - 表情库在设备 /sdcard/表情包/，配 _index.json 索引（v2，按使用时机）
 *   - 本工具只检索候选并返回路径，真正发图仍走 qqbot_send_file（单一发送实现）
 *   - 无特别情绪时优先鲸鱼娘（DSH鲸鱼娘_ 前缀，priority 10）
 *
 * 使用时机（TAXONOMY）：
 *   A 情绪强化  A1喜 A2怒 A3哀 A4惊 A5羞 A6得意
 *   B 社交回应  B1夸人 B2吐槽 B3安慰 B4疑问 B5感谢 B6道歉
 *   C 气氛经营  C1搞笑 C2卖萌 C3日常 C4节日
 *   D 御用默认  D1鲸鱼娘
 *
 * 索引 /sdcard/表情包/_index.json 结构：
 *   { "version":2, "stickers":[
 *       { "path":"...", "use":["A1"], "emo":["开心"], "desc":"...",
 *         "text":"图上的字", "scene":"二次元", "priority":0 } ] }
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';

/** 工具名 */
export const STICKER_TOOL_NAME = 'qq_pick_sticker';

/** 索引文件固定位置（相对表情库根） */
const INDEX_FILE = '_index.json';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

/** 一条表情记录 */
interface StickerEntry {
  path: string;
  use?: string[];
  emo?: string[];
  desc?: string;
  text?: string;
  scene?: string;
  priority?: number;
}

/** 索引整体 */
interface StickerIndex {
  version: number;
  updatedAt?: string;
  stickers: StickerEntry[];
}

/** 工具入参 */
interface PickStickerArgs {
  timing?: string;
  emotion?: string;
  scene?: string;
  keyword?: string;
  count?: number;
}

/** 表情库根目录兜底 */
const DEFAULT_ROOT = '/sdcard/表情包';

/** 读取索引；不存在或解析失败返回 null */
function loadIndex(root: string): StickerIndex | null {
  const p = `${root}/${INDEX_FILE}`;
  try {
    if (!existsSync(p)) return null;
    const idx = JSON.parse(readFileSync(p, 'utf8')) as StickerIndex;
    if (!idx || !Array.isArray(idx.stickers)) return null;
    return idx;
  } catch {
    return null;
  }
}

/** 把入参规范成可比较的搜索词集合 */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** 单条是否命中若干搜索词（use / emo / desc / text 任一包含即算） */
function matches(entry: StickerEntry, words: string[]): boolean {
  if (words.length === 0) return true;
  const hay = [
    ...(entry.use ?? []),
    ...(entry.emo ?? []),
    entry.desc ?? '',
    entry.text ?? '',
    entry.scene ?? '',
  ].join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** 挑选候选：鲸鱼娘软优先 + 随机打散 */
function pickFromIndex(idx: StickerIndex, args: PickStickerArgs): StickerEntry[] {
  const count = Math.max(1, Math.min(8, Number(args.count ?? 3)));
  const timing = String(args.timing ?? '').trim();
  const emotion = String(args.emotion ?? '').trim();
  const scene = String(args.scene ?? '').trim();
  const keyword = String(args.keyword ?? '').trim();

  let pool = idx.stickers.slice();

  // 1) 使用时机（A1/A2/B1... 或中文"开心""夸人"）
  if (timing) {
    const t = norm(timing);
    pool = pool.filter((s) => {
      const uses = (s.use ?? []).map(norm);
      return uses.some((u) => u === t || u.includes(t) || t.includes(u));
    });
  }
  // 2) 情绪词
  if (emotion) {
    const words = emotion.split(/[\s,，/]+/).map(norm).filter(Boolean);
    pool = pool.filter((s) => matches(s, words));
  }
  // 3) 场景目录
  if (scene) {
    const sc = norm(scene);
    pool = pool.filter((s) => norm(s.scene ?? '').includes(sc) || norm(s.path).includes(sc));
  }
  // 4) 关键词
  if (keyword) {
    const k = norm(keyword);
    pool = pool.filter((s) => `${s.desc ?? ''} ${s.text ?? ''} ${s.path}`.toLowerCase().includes(k));
  }

  // 放宽：无命中时退回全库模糊找（避免空手）
  if (pool.length === 0 && (timing || emotion || keyword)) {
    const k = norm(timing || emotion || keyword);
    pool = idx.stickers.filter((s) =>
      `${s.use?.join(' ') ?? ''} ${s.emo?.join(' ') ?? ''} ${s.desc ?? ''} ${s.text ?? ''} ${s.path}`
        .toLowerCase().includes(k));
  }

  // 排序：priority 高优先（鲸鱼娘=10），同级随机
  pool.sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pa !== pb) return pb - pa;
    return Math.random() - 0.5;
  });

  // 去重：同一张图可能以不同文件名存了多份（微博带 _后缀 的重复导出）。
  // 用「文件名主干去掉尾缀 _xxxxxx」作为指纹，避免一次返回两张一样的图。
  const seen = new Set<string>();
  const out: StickerEntry[] = [];
  for (const s of pool) {
    const base = (s.path.split('/').pop() ?? '').replace(/\.\w+$/, '').replace(/_[0-9a-f]{4,}$/i, '');
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(s);
    if (out.length >= count) break;
  }
  return out;
}

/** 注册 qq_pick_sticker（tools 服务缺失时优雅降级） */
export function registerStickerTool(
  ctx: Context,
  config: ImQQBotConfig,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qq_pick_sticker 工具未注册');
    return;
  }

  const extraRoots = (config.sendFile?.extraRoots ?? []).map(String);
  const root = extraRoots.find((r) => r.includes('表情包')) ?? DEFAULT_ROOT;

  tools.register({
    name: STICKER_TOOL_NAME,
    description:
      '从本地表情库按「使用时机」挑合适的表情图，返回本地绝对路径；'
      + '拿到路径后必须用 qqbot_send_file 发送才会真正出现在聊天里。\n'
      + '使用时机（timing）可选：\n'
      + '  A1开心 A2生气 A3难过 A4震惊 A5害羞 A6得意\n'
      + '  B1夸人 B2吐槽 B3安慰 B4疑问 B5感谢 B6道歉\n'
      + '  C1搞笑 C2卖萌 C3日常 C4节日\n'
      + '  D1鲸鱼娘（无特别情绪时的默认，会优先命中）\n'
      + '也可以用中文：开心/夸奖/生气/无语/难过/震惊/害羞/得意/安慰/疑问/搞笑/卖萌/日常/节日。\n'
      + '聊天里想用表情强化情绪、回应对方、或活跃气氛时用它。',
    parameters: {
      type: 'object',
      properties: {
        timing: {
          type: 'string',
          description: '使用时机：A1/A2/A3/A4/A5/A6 或 B1..B6 或 C1..C4 或 D1；也可以直接写中文（开心/生气/难过/震惊/害羞/得意/夸人/吐槽/安慰/疑问/感谢/道歉/搞笑/卖萌/日常/节日）。',
        },
        emotion: {
          type: 'string',
          description: '具体情绪词，可用空格或逗号分隔多个，如"开心 喜悦"、"无语 嫌弃"。',
        },
        scene: {
          type: 'string',
          description: '可选：限定来源目录，如"二次元"、"搞笑沙雕"、"萌宠动物"、"吐槽怼人"、"DSH鲸鱼娘"。',
        },
        keyword: {
          type: 'string',
          description: '可选：按描述/图上文字检索，如"猫"、"哈哈"、"狗头"。',
        },
        count: {
          type: 'integer',
          description: '候选数量，默认 3，范围 1-8。多给几个候选方便你挑。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer', description: '命中的候选数量' },
          candidates: {
            type: 'array',
            description: '候选表情（路径 + 描述 + 使用时机 + 情绪）',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                desc: { type: 'string' },
                text: { type: 'string' },
                use: { type: 'array', items: { type: 'string' } },
                emo: { type: 'array', items: { type: 'string' } },
                scene: { type: 'string' },
              },
              required: ['path'],
              additionalProperties: false,
            },
          },
        },
        required: ['total', 'candidates'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as {
          total: number;
          candidates: { path: string; desc?: string; text?: string; use?: string[] }[];
        };
        if (v.total === 0) {
          return [{ type: 'text', text: '没有找到匹配的表情。' }];
        }
        const lines = v.candidates.map((c, i) => {
          const tags = c.use?.length ? `[${c.use.join(',')}]` : '';
          const t = c.text ? ` "${c.text}"` : '';
          return `${i + 1}. ${c.path}${tags}${c.desc ? ` ${c.desc}` : ''}${t}`;
        });
        return [{ type: 'text', text: `找到 ${v.total} 个候选表情：\n${lines.join('\n')}` }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = (args ?? {}) as PickStickerArgs;
      const idx = loadIndex(root);
      if (!idx) {
        logger.warn(`im-qqbot: 表情索引缺失 ${root}/${INDEX_FILE}，qq_pick_sticker 无可用数据`);
        return { total: 0, candidates: [] };
      }
      const picked = pickFromIndex(idx, a);
      logger.debug(
        `im-qqbot: qq_pick_sticker timing=${a.timing ?? '-'} emo=${a.emotion ?? '-'} 命中 ${picked.length}`,
      );
      return {
        total: picked.length,
        candidates: picked.map((s) => ({
          path: s.path,
          desc: s.desc ?? '',
          text: s.text ?? '',
          use: s.use ?? [],
          emo: s.emo ?? [],
          scene: s.scene ?? '',
        })),
      };
    },
  });
}

/** 归档工具名 */
export const ARCHIVE_TOOL_NAME = 'qq_archive_sticker';

/** 表情库根（供两个工具共用） */
const LIB_ROOT = '/sdcard/表情包';

/** 把一条记录写进索引（读-改-写，按 path 去重） */
function upsertIndex(entry: StickerEntry, logger: Logger): boolean {
  const p = `${LIB_ROOT}/${INDEX_FILE}`;
  try {
    let idx: StickerIndex;
    if (existsSync(p)) {
      idx = JSON.parse(readFileSync(p, 'utf8')) as StickerIndex;
      if (!Array.isArray(idx.stickers)) idx = { version: 2, stickers: [] };
    } else {
      idx = { version: 2, stickers: [] };
    }
    const i = idx.stickers.findIndex((s) => s.path === entry.path);
    if (i >= 0) idx.stickers[i] = { ...idx.stickers[i], ...entry };
    else idx.stickers.push(entry);
    idx.version = 2;
    idx.updatedAt = new Date().toISOString();
    writeFileSync(p, JSON.stringify({ ...idx, count: idx.stickers.length }, null, 1));
    return true;
  } catch (err) {
    logger.warn(`im-qqbot: 写表情索引失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * 注册 qq_archive_sticker —— 让小羽在聊天中看到合适的图就当场打标入库，
 * 避免事后二次大规模扫描（节省资源）。
 */
export function registerArchiveTool(ctx: Context, logger: Logger): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qq_archive_sticker 工具未注册');
    return;
  }

  tools.register({
    name: ARCHIVE_TOOL_NAME,
    description:
      '把一张图收进表情库并打上使用时机标签（看到群里/私聊里合适的梗图、表情包时用）。'
      + '只需给路径 + 使用时机 + 简短描述，之后就能被 qq_pick_sticker 检索到。'
      + '不合适的图（截图/证件/风景照/二维码）不要收。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片的本地绝对路径（如刚收到的附件路径）' },
        timing: {
          type: 'array',
          items: { type: 'string' },
          description: '使用时机标签，如 ["A1"]（开心）["B2"]（吐槽）["C1"]（搞笑）。可多个。',
        },
        emotion: {
          type: 'array',
          items: { type: 'string' },
          description: '具体情绪词，如 ["开心","喜悦"]。可多个。',
        },
        desc: { type: 'string', description: '一句话描述画面内容' },
        text: { type: 'string', description: '图上的文字（没有可省略）' },
      },
      required: ['path', 'timing', 'desc'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          total: { type: 'integer', description: '入库后索引总数' },
        },
        required: ['ok', 'total'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { ok: boolean; total: number };
        return [{ type: 'text', text: v.ok ? `已收入表情库（共 ${v.total} 张）` : '入库失败' }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const a = args as {
        path: string;
        timing: string[];
        emotion?: string[];
        desc: string;
        text?: string;
      };
      if (!existsSync(a.path)) {
        throw new Error(`qq_archive_sticker: 文件不存在 ${a.path}`);
      }
      const entry: StickerEntry = {
        path: a.path,
        use: a.timing ?? [],
        emo: a.emotion ?? [],
        desc: a.desc,
        text: a.text ?? '',
        scene: '_群聊收集',
        priority: 0,
      };
      const ok = upsertIndex(entry, logger);
      const idx = loadIndex(LIB_ROOT);
      logger.info(`im-qqbot: 表情入库 ${a.path} use=${(a.timing ?? []).join(',')}`);
      return { ok, total: idx?.stickers.length ?? 0 };
    },
  });
}
