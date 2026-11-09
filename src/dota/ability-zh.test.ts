import { describe, it, expect } from 'vitest'
import { abilityZh, formatAbilityName } from './ability-zh.ts'
import { parseAbilities, parseAbilityUpgrades, abilityLabel } from './abilities.ts'
import type { AbilityMeta } from './opendota.ts'

describe('abilityZh · 技能官方中文名', () => {
  it('God\'s Strength 必须是「神之力量」，不是「众神之力」', () => {
    expect(abilityZh("God's Strength")).toBe('神之力量')
    // 这是本次要修的回归点：绝不能再让模型自由译出复数所有格
    expect(abilityZh("God's Strength")).not.toBe('众神之力')
  })

  it('归一化大小写 / 弯引号 / 多余空白', () => {
    expect(abilityZh('  GOD’S  STRENGTH  ')).toBe('神之力量')
  })

  it('常见的几个也要对上', () => {
    expect(abilityZh('Bloodlust')).toBe('嗜血术')
    expect(abilityZh('Ignite')).toBe('引燃')
    expect(abilityZh('Shadowraze')).toBe('毁灭阴影（影压）')
  })

  it('没收录的一律返回 undefined（保留英文原名，不硬译）', () => {
    expect(abilityZh('Some Brand New Skill')).toBeUndefined()
    expect(abilityZh('')).toBeUndefined()
  })
})

describe('formatAbilityName · 旧记录也能补中文', () => {
  it('有 nameZh 直接用；没有就回查对照表', () => {
    expect(formatAbilityName("God's Strength", '神之力量')).toBe("神之力量（God's Strength）")
    expect(formatAbilityName("God's Strength")).toBe("神之力量（God's Strength）")
  })

  it('没收录的保持英文原名，不硬译、不加空括号', () => {
    expect(formatAbilityName('Some Brand New Skill')).toBe('Some Brand New Skill')
    expect(formatAbilityName('Rot', '')).toBe('腐烂（Rot）')
  })
})

describe('解析结果带中文名 + 统一展示格式', () => {
  const meta = new Map<string, AbilityMeta>([
    ['sven_gods_strength', { dname: "God's Strength", behavior: 'No Target' }],
    ['ogre_magi_bloodlust', { dname: 'Bloodlust', behavior: 'Unit Target' }],
    ['some_new_skill', { dname: 'Some Brand New Skill' }],
  ])

  it('parseAbilities：收录的给中文，未收录的只给英文', () => {
    const out = parseAbilities(
      { sven_gods_strength: 9, ogre_magi_bloodlust: 64, some_new_skill: 3 },
      meta,
    )
    const byKey = Object.fromEntries(out.map((a) => [a.key, a]))
    expect(byKey['sven_gods_strength'].nameZh).toBe('神之力量')
    expect(abilityLabel(byKey['sven_gods_strength'])).toBe("神之力量（God's Strength）")
    expect(byKey['some_new_skill'].nameZh).toBeUndefined()
    expect(abilityLabel(byKey['some_new_skill'])).toBe('Some Brand New Skill')
  })

  it('parseAbilityUpgrades（半解析兜底）也要带中文名', () => {
    const ids = new Map<number, string>([[5010, 'sven_gods_strength']])
    const out = parseAbilityUpgrades([5010, 5010, 5010], ids, meta)
    expect(out).toHaveLength(1)
    expect(out[0].nameZh).toBe('神之力量')
    expect(abilityLabel(out[0])).toBe("神之力量（God's Strength）")
  })
})
