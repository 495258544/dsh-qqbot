/**
 * Dota2 工具注册 — 让 agent 在群里接游戏话题
 * ─────────────────────────────────────────────────────────────
 * 注册三个工具，按"问题粒度"分工：
 *   qq_dota_recent    —— 最近几局打得咋样（概览）
 *   qq_dota_match     —— 具体一局的细节，**顺便触发 OpenDota 解析并存技能记录**
 *   qq_dota_abilities —— 翻本地已存的技能记录（隔几天再问"那局拿了啥"）
 *
 * 第三个是纯本地、不联网的：OpenDota 的 match 详情是一次性快照，
 * 不存下来就查不了旧账；而"存"只在单场解析时发生，两个工具职责不能混。
 *
 * 身份：account_id / SteamID64 由调用方给，**不做**"这个 QQ 对应哪个号"的判断 ——
 * 那是上层绑定表的事，这个模块只认账号。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Logger } from '../types.ts';
import { steamIdToAccountId } from './opendota.ts';
import { heroIdByName } from './heroes.ts';
import { formatAbilityRecordHits, type AbilityRecordHit, type AbilityRecordQuery } from './ability-records.ts';
import { formatAbilityName } from './ability-zh.ts';
import type { DotaService, MatchDetailForm } from './service.ts';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

/**
 * 工具注册的可选接线。
 *
 * 2026-11-16 新增 `annotateMatchDetail`：单场解析还要知道「队里谁是群友」，
 * 但绑定表（steam.bindings）属于接线层，dota/ 不能反向依赖它 ——
 * 所以由 gateway/bootstrap 传进来一个"给 form 补群友标记"的函数
 * （内部就是 service.ts 的 annotateBoundPlayers + 一张 accountId→alias 的 map）。
 * 不给就退回默认：全员算路人，也绝不抛错。
 */
export interface DotaToolsOptions {
  annotateMatchDetail?: (form: MatchDetailForm) => MatchDetailForm;
}

const TOOL_NAME = 'qq_dota_recent';

export function registerDotaTools(
  ctx: Context,
  service: DotaService,
  logger: Logger,
  options?: DotaToolsOptions,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，Dota2 工具未注册');
    return;
  }

  const { defaultLimit, maxLimit } = service.limits;

  tools.register({
    name: TOOL_NAME,
    description:
      '查某个人的 Dota2 最近战绩（输赢、KDA、用的英雄、时长），用于群里聊游戏时接话或调侃。'
      + '**查之前先调 qq_steam_lookup 拿到这个人的 SteamID64，再填进 steam_id**：'
      + '别凭名字猜 account_id，也别把一个人的号套到别人身上；'
      + '被问"能查谁的战绩"就用 qq_steam_lookup 的 all 把已绑定的人列出来。'
      + '数据来自 OpenDota 的公开数据：对方在 Dota2 设置里关掉了「公开比赛数据」时会查不到，'
      + '这种情况要如实说"查不到"，不要说成对方没打过。'
      + 'account_id 和 steam_id 至少给一个，都给了以 account_id 为准。',
    parameters: {
      type: 'object',
      properties: {
        account_id: {
          type: 'integer',
          description: 'Dota2 的 32 位 account_id（OpenDota 用的那个），如 70388657',
        },
        steam_id: {
          type: 'string',
          description: 'SteamID64（17 位数字，如 76561198030654385），工具内部会换算成 account_id',
        },
        limit: {
          type: 'integer',
          description: `查最近几局，默认 ${defaultLimit}，最多 ${maxLimit}（OpenDota 一次最多返回 20 条）`,
        },
        hero: {
          type: 'string',
          description: '只看某个英雄的局：填英雄名都行 —— 官方名（伐木机）、英文名（Timbersaw）、'
            + '群里常见的叫法（timber / 锯子 / 剑圣 / 白牛 / AM / SF）。'
            + '给了这个参数时 limit 默认拉满（20 局），因为只查几局很可能没玩这个英雄。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          accountId: { type: 'integer' },
          displayName: { type: 'string' },
          rankText: { type: 'string' },
          summary: { type: 'string' },
          stats: {
            type: 'object',
            properties: {
              wins: { type: 'integer' },
              losses: { type: 'integer' },
              winRate: { type: 'integer' },
              avgKda: { type: 'number' },
              streak: { type: 'integer' },
            },
            additionalProperties: false,
          },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                matchId: { type: 'integer' },
                heroId: { type: 'integer' },
                heroName: { type: 'string' },
                win: { type: 'boolean' },
                kills: { type: 'integer' },
                deaths: { type: 'integer' },
                assists: { type: 'integer' },
                kdaRatio: { type: 'number' },
                durationSec: { type: 'integer' },
                durationText: { type: 'string' },
                startedAt: { type: 'string' },
                startedAtText: { type: 'string' },
                gameMode: { type: 'integer' },
                gameModeText: { type: 'string' },
                lobbyType: { type: 'integer' },
                lobbyTypeText: { type: 'string' },
                isRanked: { type: 'boolean' },
              },
              required: ['matchId', 'heroName', 'win', 'kills', 'deaths', 'assists', 'kdaRatio'],
              additionalProperties: false,
            },
          },
          note: { type: 'string' },
        },
        required: ['ok', 'summary', 'matches'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { summary?: string };
        return [{ type: 'text', text: v.summary ?? '没有战绩可展示' }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { account_id, steam_id, limit, hero } = args as {
        account_id?: number;
        steam_id?: string;
        limit?: number;
        hero?: string;
      };

      const accountId = resolveAccountId(account_id, steam_id);

      // 英雄筛选：群友说的往往是黑话（timber / 剑圣 / 白牛 / SF），先翻译成 ID。
      // 认不出来就如实说 —— 猜一个最像的比不认更糟，她会照着错英雄编一整段分析。
      let heroId: number | undefined;
      if (hero !== undefined && String(hero).trim() !== '') {
        const q = String(hero).trim();
        heroId = heroIdByName(q);
        if (heroId === undefined) {
          return {
            ok: false,
            error: `没认出英雄「${q}」。可以用官方名（伐木机）、英文名（Timbersaw）或常见叫法（timber / 锯子 / 白牛）。`,
          };
        }
      }

      // 按英雄筛时默认拉满（20 局）：只查最近 5 局的话，很可能这几局里根本没玩这个英雄
      const finalLimit = heroId !== undefined && limit === undefined ? maxLimit : limit;
      const form = await service.recentForm(accountId, finalLimit, heroId);

      logger.info(
        `dota: 工具查询 ${accountId} → ${form.matches.length} 局（${form.wins}W/${form.losses}L）`
        + (hero !== undefined ? ` 筛=${String(hero)}` : ''),
      );

      return {
        ok: true,
        accountId: form.accountId,
        displayName: form.displayName,
        ...(form.rankText !== null ? { rankText: form.rankText } : {}),
        summary: form.summaryText,
        stats: {
          wins: form.wins,
          losses: form.losses,
          winRate: form.winRate,
          avgKda: form.avgKda,
          streak: form.streak,
        },
        matches: form.matches.map((m) => ({
          matchId: m.matchId,
          heroId: m.heroId,
          heroName: m.heroName,
          win: m.win,
          kills: m.kills,
          deaths: m.deaths,
          assists: m.assists,
          kdaRatio: m.kdaRatio,
          durationSec: m.durationSec,
          durationText: m.durationText,
          startedAt: m.startedAt,
          startedAtText: m.startedAtText,
          gameMode: m.gameMode,
          gameModeText: m.gameModeText,
          lobbyType: m.lobbyType,
          lobbyTypeText: m.lobbyTypeText,
          isRanked: m.isRanked,
        })),
        ...(form.note !== undefined ? { note: form.note } : {}),
      };
    },
  });

  // ── qq_dota_match：单场详细解析 ─────────────────────────────
  tools.register({
    name: 'qq_dota_match',
    description:
      '解析一场具体的 Dota2 对局（比 qq_dota_recent 细得多）：经济/输出/正反补、队内排名、对位对比、'
      + '首血/肉山/推塔、经济曲线、团战参与、双方阵容、出装。'
      + '给了 match_id 就查那场；只给 account 不给 match_id 时，自动取该账号最近一场。'
      + 'account 仍然是必需的（要定位这局里的哪个人）。数据来自 OpenDota 公开数据；'
      + '对方关掉「公开比赛数据」时查不到，要如实说查不到。'
      + '**装备已经给了官方简体中文名（itemsZh），直接照抄，不要自己翻译**：'
      + '自行翻译专有名词必然出错（Maelstrom 是「漩涡」，不是「狂战斧」；狂战斧是 Battle Fury）。'
      + '**队友里谁是群友、谁是路人看 teamPlayers**：isBound=true 的是群里绑过 Steam 的人'
      + '（alias 是群里怎么叫的），isBound=false 的是路人；别把群友说成路人，'
      + '也别把群友的操作/功劳安到路人头上。'
      // 2026-11-16 加。群里的原话：「我看他从来没有综合分析过能收集的数据吧，
      // 不都是抓一两条就开始评么」。根因不是数据拿不到，是模型只会挑最好念的那两个数字。
      // 所以这里把「必须先逐项对照」写成硬约束，而不是又多给几个字段。
      + '**回答前必须先看 factSheet**：lines 每行是一个维度（经济/输出/补刀/视野/团战/'
      + '目标/死亡/出装/分路）+ 一句纯数据 + verdict（plus=明显占优，minus=明显不行，'
      + 'flat=无异常或无数据）；findings 是挂了 evidence（lines 下标）的结论候选。'
      + '**每条点评至少引用 2 个不同维度的 fact 并说出数字**，只提 KDA 或只有一个数字的'
      + '回答算不合格。minus 是这局真问题、plus 是可夸的，flat 别硬编故事。'
      + 'fact 里写「未解析/未知/缺对比数据」的是**没读到**，不许说成打得差；'
      + '分路未知就说未知。结论要能指回 factSheet 某一行，'
      + '不许自己发明因果（「补刀少所以输了」这种数据里没有的因果链一句都不许写）。',
    parameters: {
      type: 'object',
      properties: {
        match_id: {
          type: 'integer',
          description: '对局 ID（qq_dota_recent 返回的 matchId）；省略则取该账号最近一场',
        },
        account_id: {
          type: 'integer',
          description: 'Dota2 的 32 位 account_id（OpenDota 用的那个）',
        },
        steam_id: {
          type: 'string',
          description: 'SteamID64（17 位数字），工具内部换算成 account_id',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          matchId: { type: 'integer' },
          summary: { type: 'string' },
          heroName: { type: 'string' },
          win: { type: 'boolean' },
          kills: { type: 'integer' },
          deaths: { type: 'integer' },
          assists: { type: 'integer' },
          kdaRatio: { type: 'number' },
          gpm: { type: 'integer' },
          xpm: { type: 'integer' },
          lastHits: { type: 'integer' },
          denies: { type: 'integer' },
          heroDamage: { type: 'integer' },
          towerDamage: { type: 'integer' },
          heroHealing: { type: 'integer' },
          netWorth: { type: 'integer' },
          level: { type: 'integer' },
          items: { type: 'array', items: { type: 'string' } },
          // 装备官方中文名（与 items 等长、一一对应；未收录的位置放英文原名）
          itemsZh: { type: 'array', items: { type: 'string' } },
          teamRank: {
            type: 'object',
            properties: {
              netWorth: { type: 'integer' },
              heroDamage: { type: 'integer' },
              teamSize: { type: 'integer' },
            },
            additionalProperties: false,
          },
          laneOpponent: {
            type: 'object',
            properties: {
              heroName: { type: 'string' },
              gpmDiff: { type: 'integer' },
              damageDiff: { type: 'integer' },
            },
            additionalProperties: false,
          },
          objectives: {
            type: 'object',
            properties: {
              firstBlood: { type: 'string' },
              roshanRadiant: { type: 'integer' },
              roshanDire: { type: 'integer' },
              towersRadiant: { type: 'integer' },
              towersDire: { type: 'integer' },
            },
            additionalProperties: false,
          },
          goldSwing: {
            type: 'object',
            properties: {
              maxLead: { type: 'integer' },
              maxDeficit: { type: 'integer' },
              leadMinute: { type: 'integer' },
              deficitMinute: { type: 'integer' },
            },
            additionalProperties: false,
          },
          teamfights: {
            type: 'object',
            properties: {
              count: { type: 'integer' },
              participated: { type: 'integer' },
            },
            additionalProperties: false,
          },
          lineup: {
            type: 'object',
            properties: {
              radiant: { type: 'array', items: { type: 'string' } },
              dire: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
          // 本人这一队五个人：谁是群友（isBound + alias）、谁是路人
          teamPlayers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                accountId: { type: 'integer' },
                heroName: { type: 'string' },
                isRadiant: { type: 'boolean' },
                isBound: { type: 'boolean' },
                alias: { type: 'string' },
              },
              required: ['heroName', 'isRadiant', 'isBound'],
              additionalProperties: false,
            },
          },
          notes: { type: 'array', items: { type: 'string' } },
          // 事实清单（2026-11-16）：逐项对照表 + 挂了 lines 下标的结论候选。
          // 上面那些散字段是一个维度的原始数字，这张表是「横着比过的结论」，
          // 模型用它才可能做到「综合分析」，否则永远只会挑 KDA 说。
          factSheet: {
            type: 'object',
            properties: {
              lines: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    dim: { type: 'string' },
                    fact: { type: 'string' },
                    verdict: { type: 'string' },
                  },
                  required: ['dim', 'fact', 'verdict'],
                  additionalProperties: false,
                },
              },
              findings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                    evidence: { type: 'array', items: { type: 'integer' } },
                  },
                  required: ['text', 'evidence'],
                  additionalProperties: false,
                },
              },
            },
            required: ['lines', 'findings'],
            additionalProperties: false,
          },
          // 技能组合：技能征召（OMG）局里这是分析的核心，不是装饰
          abilities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                uses: { type: 'integer' },
                behavior: { type: 'string' },
                damageType: { type: 'string' },
              },
              required: ['name', 'uses'],
              additionalProperties: false,
            },
          },
          abilityMix: { type: 'string' },
        },
        required: ['ok', 'matchId', 'summary'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { summary?: string };
        return [{ type: 'text', text: v.summary ?? '没有可展示的解析' }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { match_id, account_id, steam_id } = args as {
        match_id?: number;
        account_id?: number;
        steam_id?: string;
      };

      const accountId = resolveAccountId(account_id, steam_id, 'qq_dota_match');

      // 没给对局 ID 就取该账号最近一场（recentForm 已带缓存，不会多打一次）
      let matchId: number;
      if (match_id !== undefined && match_id !== null) {
        const n = Number(match_id);
        if (!Number.isSafeInteger(n) || n <= 0) {
          throw new Error(`qq_dota_match: match_id 必须是正整数，收到 ${String(match_id)}`);
        }
        matchId = n;
      } else {
        const recent = await service.recentForm(accountId, 1);
        const first = recent.matches[0];
        if (first === undefined) {
          throw new Error('qq_dota_match: 这个账号最近没有比赛，取不到「最近一场」');
        }
        matchId = first.matchId;
      }

      // 单场解析完先补「谁是群友」（2026-11-16）：不补的话模型只看到五个英雄名，
      // 会把一起开黑的群友当路人点评，还把功劳安到路人头上。
      const raw = await service.matchDetail(matchId, accountId);
      const form = options?.annotateMatchDetail !== undefined ? options.annotateMatchDetail(raw) : raw;
      logger.info(`dota: 单场解析 ${matchId} → ${form.player.heroName}`);

      const p = form.player;
      const ob = form.objectives;
      return {
        ok: true,
        matchId: form.matchId,
        summary: form.summaryText,
        heroName: p.heroName,
        win: p.win,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        kdaRatio: p.kdaRatio,
        gpm: p.gpm,
        xpm: p.xpm,
        lastHits: p.lastHits,
        denies: p.denies,
        heroDamage: p.heroDamage,
        towerDamage: p.towerDamage,
        heroHealing: p.heroHealing,
        netWorth: p.netWorth,
        level: p.level,
        items: p.items,
        // 官方简体中文名，让模型照抄 —— 自己翻译装备名翻过车（Maelstrom→「狂战斧」）
        ...(p.itemsZh !== undefined ? { itemsZh: p.itemsZh } : {}),
        teamRank: form.teamRank,
        ...(form.laneOpponent !== null ? { laneOpponent: form.laneOpponent } : {}),
        objectives: {
          firstBlood: ob.firstBlood ?? 'unknown',
          roshanRadiant: ob.roshan.radiant,
          roshanDire: ob.roshan.dire,
          towersRadiant: ob.towers.radiant,
          towersDire: ob.towers.dire,
        },
        ...(form.goldSwing !== null ? { goldSwing: form.goldSwing } : {}),
        ...(form.teamfights !== null ? { teamfights: form.teamfights } : {}),
        lineup: form.lineup,
        // 本人这一队谁是群友/路人（isBound + alias）。别把群友当路人点评。
        // accountId 可能为 null（匿名玩家），而 output schema 里它是 integer ——
        // 仓库惯例是工具输出里绝不出现 null（见 firstBlood ?? 'unknown'），
        // 所以匿名的那个干脆不带这个字段；heroName/isBound/isRadiant 足够说明是谁。
        teamPlayers: form.teamPlayers.map((p) => ({
          ...(p.accountId !== null ? { accountId: p.accountId } : {}),
          heroName: p.heroName,
          isRadiant: p.isRadiant,
          isBound: p.isBound,
          ...(p.alias !== undefined && p.alias !== '' ? { alias: p.alias } : {}),
        })),
        notes: form.notes,
        // 事实清单：逐项对照表（维度/纯数据/三态）+ findings（挂 lines 下标）。
        // 这是让模型「综合全量数据再说」的那份东西，不是装饰 —— 提示词里已经
        // 硬性要求每条点评至少引用 2 个不同维度（2026-11-16）。
        factSheet: form.factSheet,
        // 技能组合（内部 key 不上报，schema 里也没有它）
        ...(p.abilities !== undefined && p.abilities.length > 0
          ? {
            abilities: p.abilities.map((a) => ({
              name: a.name,
              uses: a.uses,
              ...(a.behavior !== undefined ? { behavior: a.behavior } : {}),
              ...(a.damageType !== undefined ? { damageType: a.damageType } : {}),
            })),
          }
          : {}),
        ...(p.abilityMix !== undefined && p.abilityMix !== '' ? { abilityMix: p.abilityMix } : {}),
      };
    },
  });

  // ── qq_dota_abilities：翻本地技能记录（纯本地、不联网） ──────
  tools.register({
    name: 'qq_dota_abilities',
    description:
      '翻本地保存的 OMG（技能征召）技能记录：某人某局拿了哪几个技能、这套组合是赢是输、'
      + '次数是按使用还是按加点。用于隔几天再问"小周那局 PA 到底拿了什么技能""他老爱拿什么技能"这类旧账。'
      + '记录是每次用 qq_dota_match 解析单场时自动存的；本工具只读本地存档，不联网、不触发 OpenDota 解析。'
      + '给 match_id 查指定场次，或给 account_id / steam_id（可再配 hero）查最近符合条件的记录；'
      + '都不给就列最近几场。查不到就如实说"本地还没有这场的技能记录"，'
      + '可以提示先用 qq_dota_match 解析那一场（解析时会自动存一份）；'
      + '绝不要凭英雄的默认技能编（技能征召里英雄不一定有招牌技能）。',
    parameters: {
      type: 'object',
      properties: {
        match_id: {
          type: 'integer',
          description: '只翻这一场（qq_dota_recent 返回的 matchId）',
        },
        account_id: {
          type: 'integer',
          description: '只看这个 Dota2 账号（32 位 account_id）；不给就列所有记录里的人',
        },
        steam_id: {
          type: 'string',
          description: 'SteamID64（17 位数字），工具内部换算成 account_id；account_id 优先',
        },
        hero: {
          type: 'string',
          description: '只看某个英雄：官方名（幻影刺客）、英文名（Phantom Assassin）、'
            + '群里叫法（PA / 剑圣 / 白牛 / SF）都行',
        },
        limit: {
          type: 'integer',
          description: `最多列几场，默认 ${defaultLimit}，最多 ${maxLimit}（按记录时间，新的在前）`,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          summary: { type: 'string' },
          count: { type: 'integer' },
          records: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                matchId: { type: 'integer' },
                at: { type: 'string' },
                gameMode: { type: 'integer' },
                basis: { type: 'string' },
                players: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      accountId: { type: 'integer' },
                      heroName: { type: 'string' },
                      win: { type: 'boolean' },
                      basis: { type: 'string' },
                      mix: { type: 'string' },
                      abilities: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string' },
                            uses: { type: 'integer' },
                            behavior: { type: 'string' },
                            damageType: { type: 'string' },
                          },
                          required: ['name', 'uses'],
                          additionalProperties: false,
                        },
                      },
                    },
                    required: ['accountId', 'heroName', 'win', 'basis', 'abilities'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['matchId', 'at', 'gameMode', 'players'],
              additionalProperties: false,
            },
          },
          note: { type: 'string' },
        },
        required: ['ok', 'summary', 'count', 'records'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { summary?: string };
        return [{ type: 'text', text: v.summary ?? '没有可展示的技能记录' }];
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { match_id, account_id, steam_id, hero, limit } = args as {
        match_id?: number;
        account_id?: number;
        steam_id?: string;
        hero?: string;
        limit?: number;
      };

      // 所有条件都是可选的：不给就是"翻最近几场"。
      // 但**给了非法值必须报错**，不能悄悄当成没给 —— 否则会拿别人的记录答问题。
      let matchId: number | undefined;
      if (match_id !== undefined && match_id !== null) {
        const n = Number(match_id);
        if (!Number.isSafeInteger(n) || n <= 0) {
          return errorResult(`qq_dota_abilities: match_id 必须是正整数，收到 ${String(match_id)}`);
        }
        matchId = n;
      }

      const accountId = resolveOptionalAccountId(account_id, steam_id);

      let heroId: number | undefined;
      if (hero !== undefined && String(hero).trim() !== '') {
        const q = String(hero).trim();
        heroId = heroIdByName(q);
        if (heroId === undefined) {
          return errorResult(
            `没认出英雄「${q}」。可以用官方名（幻影刺客）、英文名（Phantom Assassin）或常见叫法（PA / 白牛 / SF）。`,
          );
        }
      }

      const wanted = limit === undefined ? defaultLimit : Number(limit);
      const finalLimit = Number.isFinite(wanted)
        ? Math.min(maxLimit, Math.max(1, Math.floor(wanted)))
        : defaultLimit;

      const query: AbilityRecordQuery = {
        ...(matchId !== undefined ? { matchId } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
        ...(heroId !== undefined ? { heroId } : {}),
        limit: finalLimit,
      };
      const hits = service.abilityRecords.query(query);
      const { summary, note } = formatAbilityRecordHits(hits);

      logger.info(
        `dota: 技能记录查询${matchId !== undefined ? ` #${matchId}` : ''}`
        + `${accountId !== undefined ? ` 账号=${accountId}` : ''}`
        + `${hero !== undefined ? ` 英雄=${String(hero)}` : ''} → ${hits.length} 场`,
      );

      return {
        ok: hits.length > 0,
        summary,
        count: hits.length,
        records: hits.map(toRecord),
        note,
      };
    },
  });

  logger.info(`im-qqbot: Dota2 工具已注册（${TOOL_NAME} / qq_dota_match / qq_dota_abilities）`);
}

/**
 * 参数非法时也要带齐 output schema 的 required 字段，并且把原因写进 summary ——
 * render 只吐 summary，光给 error 的话模型可能根本看不到为什么没查到。
 */
function errorResult(error: string): Record<string, unknown> {
  return { ok: false, error, summary: error, count: 0, records: [] };
}

/** 技能记录 → 工具输出。技能名统一成 `中文（English）`，旧记录也能补上中文。 */
function toRecord(hit: AbilityRecordHit): Record<string, unknown> {
  return {
    matchId: hit.matchId,
    at: new Date(hit.at).toISOString(),
    gameMode: hit.gameMode,
    ...(hit.basis !== undefined ? { basis: hit.basis } : {}),
    players: hit.players.map((p) => ({
      accountId: p.accountId,
      heroName: p.heroName,
      win: p.win,
      basis: p.basis ?? hit.basis ?? 'uses',
      abilities: p.abilities.map((a) => ({
        name: formatAbilityName(a.name, a.nameZh),
        uses: a.uses,
        ...(a.behavior !== undefined ? { behavior: a.behavior } : {}),
        ...(a.damageType !== undefined ? { damageType: a.damageType } : {}),
      })),
      ...(p.mix !== undefined && p.mix !== '' ? { mix: p.mix } : {}),
    })),
  };
}

/**
 * account_id 优先于 steam_id。
 * 注意：account_id 给了但非法时**不**回落到 steam_id —— 静默换一个账号查，
 * 比直接报错更危险（群里会把 A 的战绩当 B 的说出来）。
 */
function resolveAccountId(accountId: unknown, steamId: unknown, toolName = 'qq_dota_recent'): number {
  if (accountId !== undefined && accountId !== null) {
    const n = Number(accountId);
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error(`${toolName}: account_id 必须是正整数，收到 ${String(accountId)}`);
    }
    return n;
  }

  if (typeof steamId === 'string' && steamId.trim() !== '') {
    const converted = steamIdToAccountId(steamId);
    if (converted === null) {
      throw new Error(
        `${toolName}: ${steamId.trim()} 不是合法的 SteamID64（需要 17 位数字，且属于个人账号）`,
      );
    }
    return converted;
  }

  throw new Error(`${toolName}: 需要 account_id 或 steam_id 其中一个（account_id 优先）`);
}

/**
 * 同上，但账号是**可选**的（qq_dota_abilities 允许不带条件列最近记录）。
 * 语义差异：这里"两个都没给"返回 undefined 是合法的；"给了但非法"仍然报错，
 * 不能静默忽略，否则模型以为按某人筛了、实际拿的是所有人的记录。
 */
function resolveOptionalAccountId(accountId: unknown, steamId: unknown): number | undefined {
  const toolName = 'qq_dota_abilities';
  if (accountId !== undefined && accountId !== null) {
    const n = Number(accountId);
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error(`${toolName}: account_id 必须是正整数，收到 ${String(accountId)}`);
    }
    return n;
  }
  if (typeof steamId === 'string' && steamId.trim() !== '') {
    const converted = steamIdToAccountId(steamId);
    if (converted === null) {
      throw new Error(`${toolName}: ${steamId.trim()} 不是合法的 SteamID64（需要 17 位数字）`);
    }
    return converted;
  }
  return undefined;
}
