/**
 * 绑定的别名规则：
 *   alias 里第一个是群里的称呼，后面可以跟真名（"小周、周星宇"）。
 *   - 念出来只用第一个（primaryName）
 *   - 匹配时两个都能命中（find 用 includes）
 *
 * 用户原话：平时称呼用群名，真名只要在他们聊天时知道是在叫谁就好。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BindingStore, primaryName } from './bindings.ts'

const log = { info: () => {}, warn: () => {} }

describe('primaryName · 只取群里的称呼', () => {
  it('多叫法时取第一个', () => {
    expect(primaryName('小周、周星宇')).toBe('小周')
    expect(primaryName('江铭鑫、铭鑫')).toBe('江铭鑫')
  })

  it('支持逗号和斜杠分隔', () => {
    expect(primaryName('芋头,王运琦')).toBe('芋头')
    expect(primaryName('芋头/王运琦')).toBe('芋头')
    expect(primaryName('芋头，王运琦')).toBe('芋头')
  })

  it('单个名字原样返回；空值返回空串', () => {
    expect(primaryName('芋头')).toBe('芋头')
    expect(primaryName(undefined)).toBe('')
    expect(primaryName('')).toBe('')
    expect(primaryName('  ')).toBe('')
  })
})

describe('BindingStore · 真名与群名都能匹配', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-realname-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('按群名和按真名都能查到同一个人', () => {
    const store = new BindingStore(dir, log)
    store.set('openid-a', { steamId: '76561198205711847', alias: '小周、周星宇', boundAt: 1, source: 'self' })

    const byNick = store.find('小周')
    const byReal = store.find('周星宇')
    expect(byNick).toHaveLength(1)
    expect(byReal).toHaveLength(1)
    expect(byNick[0]?.openid).toBe(byReal[0]?.openid)
    // 但对外称呼只用群名
    expect(primaryName(byReal[0]?.binding.alias)).toBe('小周')
  })

  it('真名不会让另一个人被误命中', () => {
    const store = new BindingStore(dir, log)
    store.set('openid-a', { steamId: '76561198205711847', alias: '小周、周星宇', boundAt: 1, source: 'self' })
    store.set('openid-b', { steamId: '76561198189818115', alias: '芋头、王运琦', boundAt: 1, source: 'self' })

    expect(store.find('周星宇').map((h) => h.openid)).toEqual(['openid-a'])
    expect(store.find('王运琦').map((h) => h.openid)).toEqual(['openid-b'])
  })
})
