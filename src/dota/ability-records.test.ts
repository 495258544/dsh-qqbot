/**
 * 技能记录：落盘合并、查询筛选、给模型看的摘要
 * ─────────────────────────────────────────────────────────────
 * 不联网。落盘测试用 os.tmpdir() 下自建的临时目录，跑完删掉。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AbilityRecordStore,
  selectAbilityRecords,
  formatAbilityRecordHits,
  type AbilityRecord,
  type AbilityRecordPlayer,
} from './ability-records.ts';
import { heroIdByName } from './heroes.ts';

const dirs: string[] = [];

function tmpStore(): AbilityRecordStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ability-records-'));
  dirs.push(dir);
  return new AbilityRecordStore(dir);
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function player(o: Partial<AbilityRecordPlayer> & Pick<AbilityRecordPlayer, 'accountId'>): AbilityRecordPlayer {
  return {
    heroName: '幻影刺客',
    win: true,
    abilities: [{ name: "God's Strength", uses: 9 }],
    ...o,
  };
}

function rec(matchId: number, at: number, players: AbilityRecordPlayer[]): AbilityRecord {
  return { matchId, at, gameMode: 18, basis: 'uses', players };
}

describe('AbilityRecordStore.put · 同场多人不互相覆盖', () => {
  it('三个人先后解析同一场，三个人都要留着', () => {
    const store = tmpStore();
    store.put(rec(9079610365, 1000, [player({ accountId: 101, heroName: '邪影芳灵' })]));
    store.put(rec(9079610365, 2000, [player({ accountId: 202, heroName: '帕吉' })]));
    store.put(rec(9079610365, 3000, [player({ accountId: 303, heroName: '工程师' })]));

    const saved = store.get(9079610365);
    expect(saved?.players.map((p) => p.accountId).sort()).toEqual([101, 202, 303]);
    expect(saved?.at).toBe(3000);
    expect(store.size()).toBe(1);
  });

  it('同一个人重新解析（半解析 → 完整解析）覆盖自己，不动别人', () => {
    const store = tmpStore();
    store.put({ ...rec(9079610365, 1000, [player({ accountId: 101, basis: 'levels' })]), basis: 'levels' });
    store.put(rec(9079610365, 2000, [player({ accountId: 202 })]));
    store.put(rec(9079610365, 3000, [player({ accountId: 101, basis: 'uses', abilities: [{ name: 'Bloodlust', uses: 64 }] })]));

    const saved = store.get(9079610365);
    expect(saved?.players).toHaveLength(2);
    const me = saved?.players.find((p) => p.accountId === 101);
    expect(me?.basis).toBe('uses');
    expect(me?.abilities[0]?.name).toBe('Bloodlust');
    expect(saved?.players.find((p) => p.accountId === 202)?.heroName).toBe('幻影刺客');
  });

  it('坏文件按空处理，不让战绩查询挂掉', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ability-records-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'ability-records.json'), '{ broken', 'utf8');
    const store = new AbilityRecordStore(dir);
    expect(store.size()).toBe(0);
    expect(store.query()).toEqual([]);
  });
});

describe('selectAbilityRecords · 筛选', () => {
  const matches: Record<string, AbilityRecord> = {
    '1': rec(1, 1000, [player({ accountId: 101, heroName: '幻影刺客' }), player({ accountId: 202, heroName: '邪影芳灵' })]),
    '2': rec(2, 3000, [player({ accountId: 101, heroName: '帕吉', win: false })]),
    '3': rec(3, 2000, [player({ accountId: 303, heroName: '幻影刺客' })]),
  };

  it('默认按记录时间倒序、最多 5 场', () => {
    expect(selectAbilityRecords(matches).map((h) => h.matchId)).toEqual([2, 3, 1]);
  });

  it('limit 生效，且最多 20 场', () => {
    expect(selectAbilityRecords(matches, { limit: 1 }).map((h) => h.matchId)).toEqual([2]);
    expect(selectAbilityRecords(matches, { limit: 999 })).toHaveLength(3);
    expect(selectAbilityRecords(matches, { limit: 0 })).toHaveLength(1);
  });

  it('按 matchId 精确查', () => {
    expect(selectAbilityRecords(matches, { matchId: 1 }).map((h) => h.matchId)).toEqual([1]);
    expect(selectAbilityRecords(matches, { matchId: 999 })).toEqual([]);
  });

  it('按账号筛，只留那个人的条目', () => {
    const hits = selectAbilityRecords(matches, { accountId: 101 });
    expect(hits.map((h) => h.matchId)).toEqual([2, 1]);
    expect(hits[1]?.players.map((p) => p.accountId)).toEqual([101]);
  });

  it('英雄黑话归一化：PA 能匹配记录里的「幻影刺客」', () => {
    const pa = heroIdByName('PA');
    expect(pa).toBe(44);
    const hits = selectAbilityRecords(matches, { heroId: pa });
    expect(hits.map((h) => h.matchId)).toEqual([3, 1]);
    expect(hits[1]?.players).toHaveLength(1);
    expect(hits[1]?.players[0]?.accountId).toBe(101);
  });

  it('账号 + 英雄同时给，取交集；没交集的场不返回', () => {
    const hits = selectAbilityRecords(matches, { accountId: 202, heroId: heroIdByName('PA') });
    expect(hits).toEqual([]);
  });

  it('旧记录里的噪声技能与英文 mix 在查询时清洗掉（bce819b 之前存的脏数据）', () => {
    const dirty: Record<string, AbilityRecord> = {
      '9079610365': {
        matchId: 9079610365,
        at: 4000,
        gameMode: 18,
        basis: 'uses',
        players: [{
          accountId: 203546336,
          heroName: '邪影芳灵',
          win: true,
          abilities: [
            { name: 'Bloodlust', uses: 64, behavior: 'Unit Target / Autocast' },
            { name: 'Ignite', uses: 24, behavior: 'Unit Target / AOE', damageType: 'Magical' },
            { name: "God's Strength", uses: 9, behavior: 'No Target' },
            { name: 'ability_capture', uses: 2, behavior: 'Unit Target / Channeled / Hidden' },
          ],
          mix: '3 个选目标/选点的技能；用得最多的是 Bloodlust（64 次）',
        }],
      },
    };
    const hits = selectAbilityRecords(dirty, { matchId: 9079610365 });
    expect(hits).toHaveLength(1);
    const p = hits[0]?.players[0];
    expect(p?.abilities.map((a) => a.name)).toEqual(['Bloodlust', 'Ignite', "God's Strength"]);
    expect(p?.mix).toContain('嗜血术（Bloodlust）');
    expect(p?.mix).not.toContain('3 个选目标');

    const { summary } = formatAbilityRecordHits(hits);
    expect(summary).not.toContain('ability_capture');
    expect(summary).toContain("神之力量（God's Strength）");
  });

  it('整条记录全是噪声技能时不返回，避免她凭英雄默认技能脑补', () => {
    const dirty: Record<string, AbilityRecord> = {
      '1': rec(1, 1000, [player({ accountId: 101, abilities: [{ name: 'ability_capture', uses: 2 }] })]),
    };
    expect(selectAbilityRecords(dirty)).toEqual([]);
  });
});

describe('formatAbilityRecordHits · 给模型看的文本', () => {
  it('空结果：明确说没有记录 + 告诉她怎么补，不许编', () => {
    const { summary, note } = formatAbilityRecordHits([]);
    expect(summary).toContain('本地还没有符合条件的技能记录');
    expect(summary).toContain('qq_dota_match');
    expect(note).toContain('不要凭英雄的招牌技能脑补');
  });

  it('旧记录没有 nameZh 也能补上官方中文名（God\'s Strength ≠ 众神之力）', () => {
    const { summary } = formatAbilityRecordHits([
      { matchId: 7, at: Date.now(), gameMode: 18, players: [player({ accountId: 101 })] },
    ]);
    expect(summary).toContain("神之力量（God's Strength）×9");
    expect(summary).not.toContain('众神之力');
    expect(summary).toContain('技能征召');
    expect(summary).toContain('账号 101');
  });

  it('按加点的口径单独标注，note 里禁止说成使用次数', () => {
    const { summary, note } = formatAbilityRecordHits([
      {
        matchId: 8,
        at: Date.now(),
        gameMode: 18,
        basis: 'levels',
        players: [player({ accountId: 202, heroName: '帕吉', abilities: [{ name: 'Rot', uses: 4 }] })],
      },
    ]);
    expect(summary).toContain('技能（按加点）');
    expect(note).toContain('不是使用次数');
    expect(note).toContain('不要自行翻译');
  });
});
