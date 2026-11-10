import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenDotaApi } from './opendota.ts'

afterEach(() => vi.unstubAllGlobals())

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response('', { status: code, headers })
}
function timeoutError(): Error {
  const err = new Error('signal timed out')
  err.name = 'TimeoutError'
  return err
}

/** 预热专用策略：退避基数压到 1ms，别让单测真的等 */
const POLICY = { timeoutMs: 20_000, retries: 2, retryBaseDelayMs: 1 }

describe('OpenDotaApi · 请求策略（群聊零重试 / 预热可重试）', () => {
  it('默认不传 policy：一次超时就失败，群聊不会干等', async () => {
    const fetch = vi.fn().mockRejectedValue(timeoutError())
    vi.stubGlobal('fetch', fetch)
    const api = new OpenDotaApi({ timeoutMs: 8000 })

    await expect(api.recentMatches(61227014)).rejects.toMatchObject({
      kind: 'timeout',
      message: expect.stringContaining('8000ms'),
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('policy 可覆盖单次超时，错误信息里报的是覆盖后的值', async () => {
    const fetch = vi.fn().mockRejectedValue(timeoutError())
    vi.stubGlobal('fetch', fetch)
    const api = new OpenDotaApi({ timeoutMs: 8000 })

    await expect(api.recentMatches(61227014, undefined, POLICY)).rejects.toMatchObject({
      kind: 'timeout',
      message: expect.stringContaining('20000ms'),
    })
  })

  it('timeout 抖动：重试到第 3 次成功，总共 3 次请求', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(timeoutError())
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(ok([]))
    vi.stubGlobal('fetch', fetch)
    const api = new OpenDotaApi({ timeoutMs: 8000 })

    await expect(api.recentMatches(61227014, undefined, POLICY)).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('network 错误同样重试', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(ok([]))
    vi.stubGlobal('fetch', fetch)
    const api = new OpenDotaApi()

    await expect(api.recentMatches(61227014, undefined, POLICY)).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('5xx 重试；重试次数被上限 2 截断（不会无限打）', async () => {
    const fetch = vi.fn().mockResolvedValue(status(503))
    vi.stubGlobal('fetch', fetch)
    const api = new OpenDotaApi()

    await expect(api.recentMatches(61227014, undefined, { ...POLICY, retries: 99 }))
      .rejects.toMatchObject({ kind: 'server' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('429 不走瞬时重试：保留原来的 Retry-After 策略', async () => {
    const fetch = vi.fn().mockResolvedValue(status(429))
    vi.stubGlobal('fetch', fetch)
    const api = new OpenDotaApi()

    await expect(api.recentMatches(61227014, undefined, POLICY))
      .rejects.toMatchObject({ kind: 'rate-limit' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('404 / 形状错误不重试（重试多少次都不会变）', async () => {
    const fetch404 = vi.fn().mockResolvedValue(status(404))
    vi.stubGlobal('fetch', fetch404)
    const api = new OpenDotaApi()
    await expect(api.recentMatches(61227014, undefined, POLICY))
      .rejects.toMatchObject({ kind: 'not-found' })
    expect(fetch404).toHaveBeenCalledTimes(1)

    const fetchBad = vi.fn().mockResolvedValue(ok({ not: 'an array' }))
    vi.stubGlobal('fetch', fetchBad)
    await expect(api.recentMatches(61227014, undefined, POLICY))
      .rejects.toMatchObject({ kind: 'bad-response' })
    expect(fetchBad).toHaveBeenCalledTimes(1)
  })

  it('matchDetails 也透传 policy（单场请求同样能扛抖动）', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(status(404))
    vi.stubGlobal('fetch', fetch)
    const api = new OpenDotaApi()

    await expect(api.matchDetails(9075953759, POLICY))
      .rejects.toMatchObject({ kind: 'not-found' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
