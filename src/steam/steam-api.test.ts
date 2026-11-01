/**
 * Steam API 的证书降级逻辑。
 *
 * 背景：本机装了 SteamTools / Watt Toolkit 这类加速工具时，api.steampowered.com 被 hosts
 * 指向 127.0.0.1 并用自签 CA 转发。Node 不读系统证书库 → 校验失败 → 一句 "fetch failed"，
 * 上层完全看不出原因，模型还可能把它误说成"这人没绑定"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

const httpsRequestMock = vi.fn()

vi.mock('node:https', () => ({
  request: (...args: unknown[]) => httpsRequestMock(...args),
}))

const { SteamApi } = await import('./steam-api.ts')

/** 造一个够用的 https.request 假实现：收到 end() 后吐一段 body */
function fakeHttps(status: number, body: string) {
  return (_url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding: () => void }
    res.statusCode = status
    res.setEncoding = () => {}
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void }
    req.end = () => {
      cb(res)
      // 下一帧再发数据，模拟真实异步流
      process.nextTick(() => {
        res.emit('data', Buffer.from(body, 'utf8'))
        res.emit('end')
      })
    }
    req.destroy = () => {}
    return req
  }
}

const PLAYERS = {
  response: {
    players: [
      { steamid: '76561198205711847', personaname: '小周', personastate: 0, communityvisibilitystate: 3 },
    ],
  },
}

const KEY = 'A'.repeat(32)

function makeApi(logs: string[]) {
  return new SteamApi({ apiKey: KEY, timeoutMs: 5000, log: (m) => logs.push(m) })
}

function certError(code: string) {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })
}

describe('SteamApi · 证书链不被信任时降级重试', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    httpsRequestMock.mockReset()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('fetch 报 UNABLE_TO_VERIFY_LEAF_SIGNATURE → 用 https 重试并拿到数据', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(certError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')) as unknown as typeof fetch
    httpsRequestMock.mockImplementation(fakeHttps(200, JSON.stringify(PLAYERS)))

    const logs: string[] = []
    const map = await makeApi(logs).getSummaries(['76561198205711847'])

    expect(httpsRequestMock).toHaveBeenCalledTimes(1)
    expect(map.get('76561198205711847')?.personaName).toBe('小周')
    // 降级要留下可追溯的日志，且只提示一次
    expect(logs.some((m) => m.includes('证书链不被信任'))).toBe(true)
  })

  it('降级提示只打一次，后续请求不再重复刷日志', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(certError('SELF_SIGNED_CERT_IN_CHAIN')) as unknown as typeof fetch
    httpsRequestMock.mockImplementation(fakeHttps(200, JSON.stringify(PLAYERS)))

    const logs: string[] = []
    const api = makeApi(logs)
    await api.getSummaries(['76561198205711847'])
    await api.getSummaries(['76561198205711847'])

    expect(httpsRequestMock).toHaveBeenCalledTimes(2)
    expect(logs.filter((m) => m.includes('证书链不被信任'))).toHaveLength(1)
  })

  it('普通网络错误（连不上）不降级，直接报 network', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    ) as unknown as typeof fetch

    await expect(makeApi([]).getSummaries(['76561198205711847'])).rejects.toMatchObject({ kind: 'network' })
    expect(httpsRequestMock).not.toHaveBeenCalled()
  })

  it('fetch 正常时不碰 https 兜底路径', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(PLAYERS), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch

    const map = await makeApi([]).getSummaries(['76561198205711847'])

    expect(httpsRequestMock).not.toHaveBeenCalled()
    expect(map.get('76561198205711847')?.personaName).toBe('小周')
  })

  it('降级后仍按 HTTP 状态分类（403 是 key 失效，不是网络问题）', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(certError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')) as unknown as typeof fetch
    httpsRequestMock.mockImplementation(fakeHttps(403, ''))

    await expect(makeApi([]).getSummaries(['76561198205711847'])).rejects.toMatchObject({ kind: 'unauthorized' })
  })
})
