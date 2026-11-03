import { describe, it, expect } from 'vitest'
import { isNoiseAbility, parseAbilities, describeAbilityMix } from './abilities.ts'
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
  it('指向性技能多 → 提示带控', () => {
    const got = parseAbilities(
      { a1: 10, a2: 9, a3: 8 },
      new Map<string, AbilityMeta>([
        ['a1', { dname: 'X', behavior: 'Unit Target' }],
        ['a2', { dname: 'Y', behavior: 'Unit Target' }],
        ['a3', { dname: 'Z', behavior: 'Unit Target' }],
      ]),
    )
    expect(describeAbilityMix(got)).toContain('指向性')
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
