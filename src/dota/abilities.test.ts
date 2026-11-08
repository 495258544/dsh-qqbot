import { describe, it, expect } from 'vitest'
import { isNoiseAbility, parseAbilities, parseAbilityUpgrades, describeAbilityMix } from './abilities.ts'
import type { AbilityMeta } from './opendota.ts'

const meta = new Map<string, AbilityMeta>([
  ['nevermore_shadowraze2', { dname: 'Shadowraze', behavior: 'No Target', dmgType: 'Magical' }],
  ['shadow_shaman_voodoo', { dname: 'Hex', behavior: 'Unit Target' }],
  ['shadow_demon_disruption', { dname: 'Disruption', behavior: 'Unit Target' }],
  ['shadow_demon_demonic_purge', { dname: 'Demonic Purge', behavior: 'Unit Target', dmgType: 'Magical' }],
  ['shadow_demon_demonic_cleanse', { dname: 'Demonic Cleanse', behavior: 'Unit Target' }],
])

describe('isNoiseAbility · 哪些不是英雄技能', () => {
  it('天赋、引擎、道具类要剔掉', () => {
    for (const k of [
      'special_bonus_unique_shadow_demon_9',
      'special_bonus_unique_shadow_demon_7',
      'dota_base_ability',
      'item_blink',
      'plus_high_five',
      'generic_hidden',
    ]) {
      expect(isNoiseAbility(k), k).toBe(true)
    }
  })

  it('机制类条目要剔掉（它们不以噪声前缀开头）', () => {
    expect(isNoiseAbility('ability_lamp_use')).toBe(true)
    expect(isNoiseAbility('ability_creep_stun')).toBe(true)
  })

  it('真实技能一个都不能误杀', () => {
    // A杖给的 cleanse 名字里带 demonic，但不是噪声
    for (const k of [
      'nevermore_shadowraze2',
      'shadow_shaman_voodoo',
      'shadow_demon_disruption',
      'shadow_demon_demonic_cleanse',
      'shredder_chakram',
      'lion_impale',
    ]) {
      expect(isNoiseAbility(k), k).toBe(false)
    }
  })
})

describe('parseAbilities · 从 ability_uses 提技能', () => {
  // 2026-11-03 实测的一场真实数据（matchId 9065708025，技能征召）
  const realUses = {
    shadow_demon_disruption: 32,
    shadow_demon_demonic_cleanse: 3,
    nevermore_shadowraze2: 126,
    shadow_shaman_voodoo: 27,
    shadow_demon_demonic_purge: 17,
    ability_lamp_use: 4,
  }

  it('按使用次数降序，噪声被剔掉', () => {
    const got = parseAbilities(realUses, meta)
    expect(got.map((a) => a.name)).toEqual([
      'Shadowraze',        // 126
      'Disruption',        // 32
      'Hex',               // 27
      'Demonic Purge',     // 17
      'Demonic Cleanse',   // 3
    ])
    expect(got.map((a) => a.uses)).toEqual([126, 32, 27, 17, 3])
    expect(got.some((a) => a.key === 'ability_lamp_use')).toBe(false)
  })

  it('带上施法类型和伤害类型（分析要用）', () => {
    const got = parseAbilities(realUses, meta)
    const raze = got.find((a) => a.name === 'Shadowraze')
    expect(raze?.behavior).toBe('No Target')
    expect(raze?.damageType).toBe('Magical')
    const hex = got.find((a) => a.name === 'Hex')
    expect(hex?.behavior).toBe('Unit Target')
    expect(hex?.damageType).toBeUndefined()
  })

  it('meta 里查不到时回退成内部名，不丢技能', () => {
    const got = parseAbilities({ unknown_hero_spell: 5 }, new Map())
    expect(got).toHaveLength(1)
    expect(got[0].name).toBe('unknown_hero_spell')
    expect(got[0].uses).toBe(5)
  })

  it('limit 生效', () => {
    expect(parseAbilities(realUses, meta, 2).map((a) => a.name)).toEqual(['Shadowraze', 'Disruption'])
  })

  it('脏输入不炸', () => {
    expect(parseAbilities(undefined, meta)).toEqual([])
    expect(parseAbilities(null, meta)).toEqual([])
    expect(parseAbilities({ foo: 0, bar: -3, baz: 'x' } as unknown as Record<string, unknown>, meta)).toEqual([])
  })
})

describe('describeAbilityMix · 给个「怎么看」的起点', () => {
  it('选目标/选点的技能多 → 提示控场味重（Point Target 也算指向类）', () => {
    const got = parseAbilities(
      { a1: 10, a2: 9, a3: 8, a4: 7 },
      new Map<string, AbilityMeta>([
        ['a1', { dname: 'X', behavior: 'Unit Target' }],
        ['a2', { dname: 'Y', behavior: 'Point Target' }],
        ['a3', { dname: 'Z', behavior: 'Unit Target' }],
        ['a4', { dname: 'W', behavior: 'Point Target' }],
      ]),
    )
    expect(describeAbilityMix(got)).toContain('选目标/选点')
  })

  it('用得最多的那个会被点出来', () => {
    const got = parseAbilities(
      { a1: 126, a2: 10 },
      new Map<string, AbilityMeta>([['a1', { dname: 'Shadowraze' }]]),
    )
    expect(describeAbilityMix(got)).toContain('Shadowraze')
    expect(describeAbilityMix(got)).toContain('126')
  })

  it('空列表返回空串（不要硬编一坨话）', () => {
    expect(describeAbilityMix([])).toBe('')
  })
})

describe('parseAbilityUpgrades · ability_uses 缺失时的兜底', () => {
  // 2026-11-05 实测：matchId 9075953759（小周 PA，技能征召）局后 12 小时，
  // OpenDota 仍是半解析状态 —— ability_uses / teamfights 都没有，
  // 但 ability_upgrades_arr 一直在。只认 ability_uses 的话这种局整个拿不到技能。
  const ids = new Map<number, string>([
    [5190, 'phantom_assassin_stifling_dagger'],
    [5255, 'dark_seer_vacuum'],
    [5298, 'jakiro_ice_path'],
    [5258, 'dark_seer_wall_of_replica'],
    [559, 'special_bonus_unique_phantom_assassin_7'],
    [491, 'special_bonus_unique_phantom_assassin_5'],
  ])
  const meta = new Map<string, AbilityMeta>([
    ['phantom_assassin_stifling_dagger', { dname: 'Stifling Dagger', behavior: 'Unit Target' }],
    ['dark_seer_vacuum', { dname: 'Vacuum', behavior: 'Point Target' }],
    ['jakiro_ice_path', { dname: 'Ice Path', behavior: 'Point Target', dmgType: 'Magical' }],
    ['dark_seer_wall_of_replica', { dname: 'Wall of Replica', behavior: 'Point Target' }],
  ])
  // 这场的真实加点顺序（4 级窒息之刃 + 4 级真空 + 4 级冰路 + 3 级幻影墙 + 2 个天赋）
  const realUpgrades = [5190,5255,5190,5298,5190,5258,5190,5255,5255,5298,559,5298,5258,5298,5255,491,5258]

  it('能从加点顺序还原技能组合，天赋被剔掉', () => {
    const got = parseAbilityUpgrades(realUpgrades, ids, meta)
    expect(got.map((a) => a.name)).toEqual(['Stifling Dagger', 'Vacuum', 'Ice Path', 'Wall of Replica'])
    // 加点次数：窒息之刃 4 / 真空 4 / 冰路 4 / 幻影墙 3（手数：5190×4、5255×4、5298×4、5258×3）
    expect(got.map((a) => a.uses)).toEqual([4, 4, 4, 3])
    expect(got.some((a) => a.key.startsWith('special_bonus'))).toBe(false)
  })

  it('排序按加点次数，同数按首次出现稳定', () => {
    const got = parseAbilityUpgrades(realUpgrades, ids, meta)
    for (let i = 1; i < got.length; i++) expect(got[i - 1].uses).toBeGreaterThanOrEqual(got[i].uses)
  })

  it('未知 id（表没更新的新技能）跳过不炸', () => {
    const got = parseAbilityUpgrades([99999, 5190], ids, meta)
    expect(got).toHaveLength(1)
    expect(got[0].name).toBe('Stifling Dagger')
  })

  it('脏输入不炸', () => {
    expect(parseAbilityUpgrades(undefined, ids, meta)).toEqual([])
    expect(parseAbilityUpgrades(null, ids, meta)).toEqual([])
    expect(parseAbilityUpgrades([], ids, meta)).toEqual([])
    expect(parseAbilityUpgrades([0, -5, 'x'] as unknown as number[], ids, meta)).toEqual([])
  })

  it('两个解析器口径不同：同样 4 次，一个是用了 4 次、一个是点了 4 级', () => {
    // 这是 basis 字段存在的原因 —— 措辞必须区分「按使用」和「按加点」
    const fromUses = parseAbilities({ dark_seer_vacuum: 4 }, meta)
    const fromUpgrades = parseAbilityUpgrades([5255, 5255, 5255, 5255], ids, meta)
    expect(fromUses[0].name).toBe('Vacuum')
    expect(fromUpgrades[0].name).toBe('Vacuum')
    expect(fromUses[0].uses).toBe(4)
    expect(fromUpgrades[0].uses).toBe(4)
    // 但语义不同 —— service 层用 basis 标注，summary 措辞分别为「技能」/「技能（按加点）」
  })
})

describe('ability_capture · 占领旗帜是引擎技能不是英雄技能', () => {
  // 2026-11-08 实测：9079610365（邪影芳灵局）的 ability_uses 里有
  // ability_capture×2（占领前哨/旗帜，OpenDota 标记 Hidden）——
  // 漏过滤会让她把"占了两次旗"当成一个技能来分析。
  it('精确名单拦下 ability_capture', () => {
    expect(isNoiseAbility('ability_capture')).toBe(true)
  })

  it('真实解析里不再出现', () => {
    const meta = new Map<string, AbilityMeta>([
      ['shadow_shaman_voodoo', { dname: 'Hex', behavior: 'Unit Target' }],
      ['ability_capture', { behavior: 'Unit Target / Channeled / Hidden' }],
    ])
    const got = parseAbilities(
      { shadow_shaman_voodoo: 27, ability_capture: 2 },
      meta,
    )
    expect(got.map((a) => a.name)).toEqual(['Hex'])
  })
})
