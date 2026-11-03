import { describe, it, expect } from 'vitest'
import { heroIdByName, heroName, heroNameEn, unresolvedAliases } from './heroes.ts'
import { HERO_ALIASES } from './hero-aliases.ts'

describe('别名表 · 自检', () => {
  it('每条别名的官方中文名都能对上（写错一个字就会静默失效）', () => {
    // 这是最关键的一条：别名表的 value 是中文名，靠它反查 ID。
    // 打错一个字（「冥魂大帝」写成「冥魂帝王」）不会报错，只会让那条别名
    // 永远查不到 —— 所以必须显式校验。
    expect(unresolvedAliases()).toEqual([])
  })

  it('别名表不为空，且键都做过小写归一化', () => {
    const keys = Object.keys(HERO_ALIASES)
    expect(keys.length).toBeGreaterThan(80)
    const bad = keys.filter((k) => k !== k.toLowerCase())
    expect(bad, `这些别名含大写，查表前虽会 lowercase，但写的时候统一更好: ${bad.join(',')}`).toEqual([])
  })
})

describe('heroIdByName · 官方名与英文名', () => {
  it('官方中文名能反查', () => {
    expect(heroIdByName('敌法师')).toBe(1)
    expect(heroIdByName('影魔')).toBe(11)
    expect(heroIdByName('伐木机')).toBe(98)
  })

  it('英文名能反查，且大小写/连字符/空格都不影响', () => {
    for (const n of ['Anti-Mage', 'anti mage', 'ANTIMAGE', 'antimage']) {
      expect(heroIdByName(n), n).toBe(1)
    }
    expect(heroIdByName('Timbersaw')).toBe(98)
    expect(heroIdByName('Queen of Pain')).toBe(39)
  })

  it('反查出来的 ID 能再查回名字（往返一致）', () => {
    for (const name of ['斧王', '帕吉', '冥魂大帝', '齐天大圣']) {
      const id = heroIdByName(name)
      expect(id, name).toBeDefined()
      expect(heroName(id as number)).toBe(name)
    }
  })
})

describe('heroIdByName · 群里的黑话', () => {
  it('官方名和俗称完全不同的那几个（最常见的困惑点）', () => {
    // 官方「主宰」，群里一律叫剑圣
    expect(heroIdByName('剑圣')).toBe(heroIdByName('主宰'))
    // 官方「冥魂大帝」，群里叫骷髅王
    expect(heroIdByName('骷髅王')).toBe(heroIdByName('冥魂大帝'))
    // 官方「帕吉」，群里叫屠夫
    expect(heroIdByName('屠夫')).toBe(heroIdByName('帕吉'))
    // 官方「雷泽」，群里叫电棍
    expect(heroIdByName('电棍')).toBe(heroIdByName('雷泽'))
    // 官方「卓尔游侠」，群里叫小黑
    expect(heroIdByName('小黑')).toBe(heroIdByName('卓尔游侠'))
    // 官方「自然先知」，群里叫先知
    expect(heroIdByName('先知')).toBe(heroIdByName('自然先知'))
  })

  it('英文缩写能认（AM / SF / LC / TA / SB / WD）', () => {
    expect(heroIdByName('AM')).toBe(heroIdByName('敌法师'))
    expect(heroIdByName('SF')).toBe(heroIdByName('影魔'))
    expect(heroIdByName('LC')).toBe(heroIdByName('军团指挥官'))
    expect(heroIdByName('TA')).toBe(heroIdByName('圣堂刺客'))
    expect(heroIdByName('SB')).toBe(heroIdByName('裂魂人'))
    expect(heroIdByName('WD')).toBe(heroIdByName('巫医'))
  })

  it('中文简称能认（伐木 / 白牛 / 小鱼 / 大娜迦 / 蓝胖）', () => {
    expect(heroIdByName('伐木')).toBe(heroIdByName('伐木机'))
    expect(heroIdByName('白牛')).toBe(heroIdByName('裂魂人'))
    expect(heroIdByName('小鱼')).toBe(heroIdByName('斯拉克'))
    expect(heroIdByName('大娜迦')).toBe(heroIdByName('美杜莎'))
    expect(heroIdByName('小娜迦')).toBe(heroIdByName('娜迦海妖'))
    expect(heroIdByName('蓝胖')).toBe(heroIdByName('食人魔魔法师'))
  })

  it('三只猫要分得清（蓝猫/火猫/土猫/紫猫是四个不同英雄）', () => {
    const 蓝 = heroIdByName('蓝猫')
    const 火 = heroIdByName('火猫')
    const 土 = heroIdByName('土猫')
    const 紫 = heroIdByName('紫猫')
    for (const [n, v] of [['蓝猫', 蓝], ['火猫', 火], ['土猫', 土], ['紫猫', 紫]] as const) {
      expect(v, n).toBeDefined()
    }
    expect(new Set([蓝, 火, 土, 紫]).size).toBe(4)
    expect(heroName(蓝 as number)).toBe('风暴之灵')
    expect(heroName(火 as number)).toBe('灰烬之灵')
    expect(heroName(土 as number)).toBe('大地之灵')
    expect(heroName(紫 as number)).toBe('虚无之灵')
  })
})

describe('heroIdByName · 认不出来时不要猜', () => {
  it('无关字符串返回 undefined（不能糊一个最像的）', () => {
    for (const n of ['', '   ', '不存在的英雄', 'timberr', '12345']) {
      expect(heroIdByName(n), JSON.stringify(n)).toBeUndefined()
    }
  })

  it('单个字不误伤（比如「牛」不该命中撼地者）', () => {
    expect(heroIdByName('牛')).toBeUndefined()
  })
})
