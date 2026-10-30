/**
 * persona 工具注册 — 让 agent 自己写日记 / 记关于人的账
 * ─────────────────────────────────────────────────────────────
 * 对应 ai-companion 的 qq_write_diary / qq_read_diary / qq_memory_append。
 * 注册形态对齐 media/send-file-tool.ts：tools 服务缺失时优雅降级。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { PersonaService } from './service.ts';
import type { Logger } from '../types.ts';
import type { DshAgent } from '../session/types.ts';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

export function registerPersonaTools(
  ctx: Context,
  persona: PersonaService,
  findByAgent: (agent: unknown) => { senderId: string; scope: string; peerId: string } | undefined,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，persona 工具未注册');
    return;
  }

  tools.register({
    name: 'qq_write_diary',
    description: '写一条你自己的日记（关于你这一天，不是关于对方的事——那用 qq_memory_append）。'
      + '第一人称、口语、短句，1~4 句。不要总结升华，不要"今天真是充实的一天"。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '日记正文' },
        mood: { type: 'string', description: '心情（一两个词，如"踏实"/"有点闷"）' },
        title: { type: 'string', description: '可选：一句话标题' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { day: { type: 'string' }, time: { type: 'string' } },
        required: ['day', 'time'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { day: string; time: string };
        return [{ type: 'text', text: `已写日记 ${v.day} ${v.time}` }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { text, mood, title, tags } = args as { text: string; mood?: string; title?: string; tags?: string[] };
      const row = persona.diary.add({ text, mood, title, tags });
      logger.info(`persona: 日记一条 ${row.day} ${row.time}`);
      return { day: row.day, time: row.time };
    },
  });

  tools.register({
    name: 'qq_read_diary',
    description: '翻你自己的日记。不传参数返回最近 5 条；传 day（YYYY-MM-DD）返回那天全部。',
    parameters: {
      type: 'object',
      properties: {
        n: { type: 'number', description: '最近几条（默认 5，上限 20）' },
        day: { type: 'string', description: '某天 YYYY-MM-DD' },
      },
      additionalProperties: false,
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { n, day } = args as { n?: number; day?: string };
      const rows = day ? persona.diary.day(day) : persona.diary.recent(Math.min(n ?? 5, 20));
      return {
        count: rows.length,
        entries: rows.map((r) => ({
          day: r.day, time: r.time, mood: r.mood, title: r.title, text: r.text,
        })),
        stats: persona.diary.stats(),
      };
    },
  });

  tools.register({
    name: 'qq_memory_append',
    description: '往某个人的账上记一笔。trait=他的习惯性格，fact=他告诉过你的事实，'
      + 'topic=聊过的话题，pending=你想说但还没说的话（会过期，别攒太多）。'
      + '想起来什么就顺手记，别在聊天里宣布"我记下了"。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['trait', 'fact', 'topic', 'pending'], description: '记哪一栏' },
        content: { type: 'string', description: '内容（一句话，≤160字）' },
        person: {
          type: 'string',
          description: '对象 openid；省略 = 当前说话的人。群聊里想记某个群友就传他的 openid。',
        },
        name: { type: 'string', description: '顺手更新对方昵称（可选）' },
      },
      required: ['kind', 'content'],
      additionalProperties: false,
    },
    async execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown>> {
      const { kind, content, person, name } = args as {
        kind: 'trait' | 'fact' | 'topic' | 'pending'; content: string; person?: string; name?: string;
      };
      let key = person;
      if (!key) {
        const record = exec.agent !== undefined ? findByAgent(exec.agent as DshAgent) : undefined;
        if (!record) throw new Error('qq_memory_append: 无法确定当前对话对象，请显式传 person');
        key = record.senderId;
      }
      persona.memory.remember(key, { [kind]: content, name });
      return { ok: true };
    },
  });

  logger.info('im-qqbot: persona 工具已注册（qq_write_diary / qq_read_diary / qq_memory_append）');
}
