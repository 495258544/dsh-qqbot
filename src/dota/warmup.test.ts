import { describe, it, expect } from 'vitest'
import { createDotaWarmup, type WarmupDeps } from './warmup.ts'
import type { Logger } from '../types.ts'

const silent: Logger = { info() {}, warn() {}, debug() {}, error() {} }

/** 北京时间 → ms（cst(2026,11,6,3,0) = 2026-11-06 03:00 北京） */
function cst(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute)
}

/** 窗口内时刻（凌晨 3 点）与窗口外时刻（凌晨 5 点） */
const AT_3AM = cst(2026, 11, 6, 3, 0)
const AT_5AM = cst(2026, 11, 6, 5, 0)

const STEAM_A = '76561198030654385'
const STEAM_B = '76561198205711847'
const accountIdOf = (sid: string): number => Number(BigInt(sid) - 76561197960265728n)

function harness(o: {
  config?: Partial<WarmupDeps['config']>
  bindings?: WarmupDeps['bindings']
  warmRecent?: WarmupDeps['service']['warmRecent']
} = {}) {
  const calls: Array<{ accountId: number; withinHours: number }> = []
  const service = {
    warmRecent: o.warmRecent ?? (async (accountId: number, withinHours: number) => {
      calls.push({ accountId, withinHours })
      return 2
    }),
  } as unknown as WarmupDeps['service']
  const h = {
    calls,
    deps: {
      config: { enabled: true, hour: 3, withinHours: 30, tz: 'Asia/Shanghai', ...o.config },
      logger: silent,
      bindings: o.bindings ?? (() => [
        { openid: 'o1', alias: '小周', steamId: STEAM_A },
        { openid: 'o2', alias: '江铭鑫', steamId: STEAM_B },
      ]),
      service,
    } as WarmupDeps,
  }
  const handle = createDotaWarmup(h.deps)
  return { ...h, handle }
}

describe('DotaWarmup · 凌晨预热 OpenDota 解析', () => {
  it('窗口外不跑（hour≠配置值）', async () => {
    const { handle } = harness()
    const r = await handle.tick(AT_5AM)
    expect(r).toEqual({ ran: false, people: 0, matches: 0, reason: 'not-window' })
  })

  it('disabled 时不跑', async () => {
    const { handle } = harness({ config: { enabled: false } })
    const r = await handle.tick(AT_3AM)
    expect(r.reason).toBe('disabled')
  })

  it('窗口内跑：每个绑定账号各预热一次（accountId 换算正确）', async () => {
    const { handle, calls } = harness()
    const r = await handle.tick(AT_3AM)
    expect(r.ran).toBe(true)
    expect(r.people).toBe(2)
    expect(r.matches).toBe(4) // 每人 mock 返回 2 场
    expect(calls.map((c) => c.accountId).sort((a, b) => a - b)).toEqual(
      [accountIdOf(STEAM_A), accountIdOf(STEAM_B)].sort((a, b) => a - b),
    )
    expect(calls.every((c) => c.withinHours === 30)).toBe(true)
  })

  it('同一天只跑一次（重启前的幂等）', async () => {
    const { handle, calls } = harness()
    await handle.tick(AT_3AM)
    const second = await handle.tick(AT_3AM + 60_000)
    expect(second.reason).toBe('already-ran')
    expect(calls).toHaveLength(2) // 第一次的 2 个账号，没有重复
  })

  it('第二天是新的一天，会再跑', async () => {
    const { handle, calls } = harness()
    await handle.tick(cst(2026, 11, 6, 3, 0))
    const r = await handle.tick(cst(2026, 11, 7, 3, 0))
    expect(r.ran).toBe(true)
    expect(calls).toHaveLength(4)
  })

  it('重复绑定的 steamId 只预热一次', async () => {
    // 2026-11-05 的真实事故：两个 openid 绑了同一个 steamId，预热不必要地翻倍
    const { handle, calls } = harness({
      bindings: () => [
        { openid: 'o1', alias: '江铭鑫', steamId: STEAM_A },
        { openid: 'o2', alias: '江铭鑫小号', steamId: STEAM_A }, // 同号重复绑定
      ],
    })
    const r = await handle.tick(AT_3AM)
    expect(r.people).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('单人失败不中断整批', async () => {
    const { handle, calls } = harness({
      warmRecent: async (accountId: number) => {
        if (accountId === accountIdOf(STEAM_A)) throw new Error('网络炸了')
        calls.push({ accountId, withinHours: 30 })
        return 1
      },
    })
    const r = await handle.tick(AT_3AM)
    expect(r.ran).toBe(true)
    expect(r.people).toBe(2)
    expect(r.matches).toBe(1) // 只有 B 成功
    expect(calls).toHaveLength(1) // 只有 B 被调
  })

  it('并发 tick 防重入', async () => {
    let inFlight = 0
    let maxConcurrent = 0
    const { handle } = harness({
      warmRecent: async () => {
        inFlight++
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        return 1
      },
    })
    const [a, b] = await Promise.all([handle.tick(AT_3AM), handle.tick(AT_3AM + 1000)])
    const ran = [a, b].filter((x) => x.ran)
    expect(ran.length).toBe(1)
    expect(maxConcurrent).toBe(1)
  })

  it('绑定表为空时不报错', async () => {
    const { handle } = harness({ bindings: () => [] })
    const r = await handle.tick(AT_3AM)
    expect(r).toEqual({ ran: true, people: 0, matches: 0 })
  })
})
