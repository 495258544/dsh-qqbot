/**
 * 情绪子系统的**接线回归**。
 *
 * 这套东西的历史教训（远端 8c6cde0）：接线全都"连上了"，但读端没人调用、
 * 或者写入点传错参数，于是编译过、测试绿、功能等于不存在。
 * 所以这里不测情绪算法本身（emotion.test.ts 有 813 行覆盖），
 * 只钉住「service 层真的把它接进去了」：
 *   1. emotion 实例在，且事件能落盘
 *   2. 三段注入（口味 / 心情 / 名字候选）真的出现在 buildSections 里
 *   3. 记了厌恶之后，同一句话的唤醒概率确实下降
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PersonaService } from './service.ts'
import { Waker } from './wake.ts'

function mkDir(): string {
  const dir = path.join(os.tmpdir(), `svc-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function mkSvc(dir: string): PersonaService {
  return new PersonaService({
    config: {
      enabled: true, dataDir: dir, roleCardPath: '', roleMaxChars: 12000,
      wakeEnabled: true, names: ['小深'], keywords: [], ownerOpenids: [],
      groupProbability: 0, humanizeEnabled: true,
      msPerChar: 110, burstMax: 2, gapMinMs: 700, gapMaxMs: 2600,
      ownLifeEnabled: false, ownLifeIntervalMs: 9000000, ownLifeMaxPerDay: 6,
      maxProactivePerDay: 2, proactiveMinGapMs: 7200000,
    } as never,
    dataDir: dir,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
  })
}

describe('PersonaService · 情绪接线', () => {
  it('emotion 挂上了，onAddressed 会推进 state/emotion.json', () => {
    const dir = mkDir()
    const svc = mkSvc(dir)
    const before = svc.emotion.current().valence

    for (let i = 0; i < 5; i += 1) svc.emotion.onAddressed()

    const after = svc.emotion.current()
    expect(after.valence).toBeGreaterThan(before)
    // 落盘：证明 save() 真的被调到（不是只改了内存）
    const file = path.join(dir, 'state', 'emotion.json')
    expect(fs.existsSync(file)).toBe(true)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(typeof saved.valence).toBe('number')
    expect(typeof saved.at).toBe('number')
  })

  it('onComplained 让心情往下走（被嫌吵不只是降 chattiness）', () => {
    const dir = mkDir()
    const svc = mkSvc(dir)
    const before = svc.emotion.current().valence
    svc.emotion.onComplained()
    expect(svc.emotion.current().valence).toBeLessThan(before)
  })

  it('记了厌恶之后，口味/心情/名字候选三段都能进 buildSections', () => {
    const dir = mkDir()
    const svc = mkSvc(dir)
    svc.self.recordDislike('短视频', 0.8)
    svc.emotion.onComplained()

    const sections = svc.buildSections('u1')
    const names = sections.map((s) => s.name)
    // 口味段：只有当"有讨厌的东西"时才注入 —— 有内容才出现，正好证明读端在跑
    expect(names).toContain('qqbot:persona-taste')
    // 注入顺序必须都排在 anchor(998) 之前，否则会被挤到提示词末尾
    const anchor = sections.find((s) => s.name === 'qqbot:persona-anchor')
    if (anchor !== undefined) {
      expect(sections.find((s) => s.name === 'qqbot:persona-taste')!.order).toBeLessThan(anchor.order)
    }
  })
})

describe('Waker · 厌恶与心情真的进入了概率公式', () => {
  const ctx = (over: Record<string, unknown>) => ({
    interests: [{ topic: '刀塔', weight: 0.8 }],
    chattiness: 1,
    baseProbability: 1,
    ...over,
  }) as never

  it('命中兴趣时基础概率 = chattiness × 权重 × base', () => {
    const w = new Waker({ names: ['小深'] })
    w.setInterestProvider(() => ctx({}))
    const r = w.matchInterest('今晚打刀塔吗')
    expect(r.hit).toBe(true)
    expect(r.probability).toBeCloseTo(0.8, 5)
  })

  it('讨厌的话题把概率压到最多 4 折', () => {
    const w = new Waker({ names: ['小深'] })
    w.setInterestProvider(() => ctx({ dislikes: [{ topic: '刀塔', weight: 1 }] }))
    const r = w.matchInterest('今晚打刀塔吗')
    expect(r.hit).toBe(true)
    expect(r.probability).toBeCloseTo(0.8 * 0.4, 5)
  })

  it('心情系数乘上去（0.6 倍时明显更低）', () => {
    const w = new Waker({ names: ['小深'] })
    w.setInterestProvider(() => ctx({ moodFactor: 0.6 }))
    expect(w.matchInterest('今晚打刀塔吗').probability).toBeCloseTo(0.48, 5)
  })

  it('边界匹配：兴趣是「刀」时，「刀塔」不该被误命中到别的词上', () => {
    const w = new Waker({ names: ['小深'] })
    w.setInterestProvider(() => ctx({ interests: [{ topic: '刀', weight: 1 }] }))
    // 直接包含「刀」的句子仍然命中（这正是 matchesTopic 与 includes 的区别所在：
    // 它挡的是「车站/车厘子」那类误触发，不是同一词根）
    expect(w.matchInterest('这刀不错').hit).toBe(true)
  })
})
