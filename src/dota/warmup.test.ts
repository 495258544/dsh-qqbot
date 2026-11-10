import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDotaWarmup, type WarmupDeps } from './warmup.ts'
import type { Logger } from '../types.ts'

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

// 每个用例一个独立 dataDir：warmup 的幂等靠落盘状态+文件锁，隔离目录才能互不干扰
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-warmup-'))
  dirs.push(dir)
  return dir
}

function makeLogger() {
  const info: string[] = []
  const warn: string[] = []
  const logger: Logger = {
    info: (m) => { info.push(String(m)) },
    warn: (m) => { warn.push(String(m)) },
    debug() {},
    error() {},
  }
  return { logger, info, warn }
}

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
  const log = makeLogger()
  const deps = {
    // 默认关掉失败冷却，方便在单测里立刻验证「只补失败账号」
    config: { enabled: true, hour: 3, withinHours: 30, tz: 'Asia/Shanghai', retryCooldownMs: 0, ...o.config },
    logger: log.logger,
    bindings: o.bindings ?? (() => [
      { openid: 'o1', alias: '小周', steamId: STEAM_A },
      { openid: 'o2', alias: '江铭鑫', steamId: STEAM_B },
    ]),
    service,
    dataDir: tmpDir(),
  } as WarmupDeps
  const handle = createDotaWarmup(deps)
  return {
    ...log,
    calls,
    deps,
    handle,
    /** 模拟 dsh-unlag 热重载：同一份 deps 又建了一个新实例 */
    spawn: () => createDotaWarmup(deps),
  }
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

  it('传给 service 的第三参是预热专用请求策略（更长超时 + 重试）', async () => {
    const policies: unknown[] = []
    const { handle } = harness({
      warmRecent: async (_a, _h, policy) => { policies.push(policy); return 1 },
    })
    await handle.tick(AT_3AM)
    expect(policies).toHaveLength(2)
    expect(policies[0]).toMatchObject({ timeoutMs: 20_000, retries: 2, retryBaseDelayMs: 500 })
  })

  it('同一天只跑一次（落盘状态幂等）', async () => {
    const { handle, calls } = harness()
    await handle.tick(AT_3AM)
    const second = await handle.tick(AT_3AM + 60_000)
    expect(second.reason).toBe('already-ran')
    expect(calls).toHaveLength(2) // 第一次的 2 个账号，没有重复
  })

  it('热重载后的新实例不会重跑（2026-11-10 事故回归）', async () => {
    const h = harness()
    const first = await h.handle.tick(AT_3AM)
    expect(first.ran).toBe(true)
    const second = await h.spawn().tick(AT_3AM)
    expect(second.reason).toBe('already-ran')
    expect(h.calls).toHaveLength(2)
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

  it('整批抖动后只补失败账号，不重复打已成功的人', async () => {
    let round = 0
    const { handle, calls, spawn } = harness({
      warmRecent: async (accountId: number) => {
        round++
        calls.push({ accountId, withinHours: 30 })
        // 第一轮 A 成功、B 超时；第二轮 B 恢复
        if (round === 2) throw new Error('OpenDota 超时')
        return 1
      },
    })
    const first = await handle.tick(AT_3AM)
    expect(first.matches).toBe(1)
    expect(calls).toHaveLength(2)

    const retry = await spawn().tick(AT_3AM + 60_000)
    expect(retry.ran).toBe(true)
    expect(retry.matches).toBe(2)
    expect(calls).toHaveLength(3) // 只多了失败的那个 B
    expect(calls[2]?.accountId).toBe(accountIdOf(STEAM_B))
  })

  it('失败账号在冷却期内不反复打', async () => {
    const seen: number[] = []
    const { handle } = harness({
      config: { retryCooldownMs: 5 * 60_000 },
      warmRecent: async (accountId: number) => {
        seen.push(accountId)
        throw new Error('网络炸了')
      },
    })
    const first = await handle.tick(AT_3AM)
    expect(first.ran).toBe(true)
    expect(seen).toHaveLength(2)

    const cooled = await handle.tick(AT_3AM + 60_000)
    expect(cooled.reason).toBe('cooldown')
    expect(seen).toHaveLength(2)

    const after = await handle.tick(AT_3AM + 6 * 60_000)
    expect(after.ran).toBe(true)
    expect(seen).toHaveLength(4)
  })

  it('并发 tick 防重入（文件锁）', async () => {
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

  it('0 场时明说 0 场，绝不承诺「白天有完整技能数据」', async () => {
    const { handle, info } = harness({ warmRecent: async () => 0 })
    const r = await handle.tick(AT_3AM)
    expect(r.matches).toBe(0)
    const text = info.join('\n')
    expect(text).toContain('0 场')
    expect(text).toContain('无需触发解析')
    expect(text).not.toContain('完整技能')
  })

  it('有人失败时打 warn 并明说「可能仍是半解析」', async () => {
    const { handle, warn, info } = harness({
      warmRecent: async (accountId: number) => {
        if (accountId === accountIdOf(STEAM_A)) throw new Error('请求 OpenDota 超时')
        return 0
      },
    })
    await handle.tick(AT_3AM)
    const text = warn.join('\n')
    expect(text).toContain('预热未完成')
    expect(text).toContain('半解析')
    expect(text).toContain('只补失败账号')
    expect(info.join('\n')).not.toContain('白天查询可拿到完整技能')
  })
})
