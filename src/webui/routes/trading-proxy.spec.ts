import { describe, expect, it, vi, afterEach } from 'vitest'
import { createTradingProxyRoutes } from './trading-proxy.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createTradingProxyRoutes — UTA optional carrier', () => {
  it('reports lite-mode status when the carrier is intentionally disabled', async () => {
    const app = createTradingProxyRoutes({ disabledReason: 'lite_mode' })
    const res = await app.request('/status')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      available: false,
      state: 'unavailable',
      reason: 'lite_mode',
    })
  })

  it('returns 503 for trading calls when lite mode disables the carrier', async () => {
    const app = createTradingProxyRoutes({ disabledReason: 'lite_mode' })
    const res = await app.request('/uta')
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: 'UTA disabled',
      detail: 'Trading mode is lite',
    })
  })

  it('reports the effective mode in status', async () => {
    const app = createTradingProxyRoutes({ disabledReason: 'lite_mode' })
    const res = await app.request('/status')
    await expect(res.json()).resolves.toMatchObject({
      mode: 'lite',
      modeSource: 'env',
      envLocked: true,
    })
  })

  it('blocks venue-mutating writes in readonly mode', async () => {
    const app = createTradingProxyRoutes({
      utaBaseUrl: 'http://127.0.0.1:47333',
      getPolicy: () => ({ mode: 'readonly', source: 'config', envLocked: false, hasUTAConfig: true }),
    })
    const res = await app.request('/api/trading/uta/alpaca/wallet/push', { method: 'POST' })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      error: 'Trading mode is readonly',
    })
  })

  it('allows local proposal writes in readonly mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ))
    const app = createTradingProxyRoutes({
      utaBaseUrl: 'http://127.0.0.1:47333',
      getPolicy: () => ({ mode: 'readonly', source: 'config', envLocked: false, hasUTAConfig: true }),
    })
    const res = await app.request('/api/trading/uta/alpaca/wallet/stage-place-order', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
  })

  it('reports unavailable status when no carrier URL is configured', async () => {
    const app = createTradingProxyRoutes({})
    const res = await app.request('/status')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      available: false,
      state: 'unavailable',
      reason: 'not_configured',
    })
  })

  it('returns 503 for trading calls when no carrier URL is configured', async () => {
    const app = createTradingProxyRoutes({})
    const res = await app.request('/uta')
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: 'UTA unavailable',
    })
  })

  it('reports available status from UTA health', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, startedAt: '2026-07-05T00:00:00.000Z', utas: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ))
    const app = createTradingProxyRoutes({ utaBaseUrl: 'http://127.0.0.1:47333' })
    const res = await app.request('/status')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      available: true,
      state: 'available',
      startedAt: '2026-07-05T00:00:00.000Z',
      utas: 2,
    })
  })
})

// ==================== Service-auth + actor tagging + CSRF rider ====================
// These ride the human-approval (live-order) path: browser → BFF proxy → UTA.

const PRO = () => ({ mode: 'pro' as const, source: 'auto' as const, envLocked: false, hasUTAConfig: true })

describe('createTradingProxyRoutes — actor tagging + service token', () => {
  it('forwards x-alice-actor: user (spoof-proof) and the service token', async () => {
    const seen: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init)
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const app = createTradingProxyRoutes({
      utaBaseUrl: 'http://127.0.0.1:47333',
      getPolicy: PRO,
      readServiceToken: async () => 'proxy-token',
    })
    const res = await app.request('/api/trading/uta/alpaca/wallet/stage-place-order', {
      method: 'POST',
      headers: { 'x-alice-actor': 'agent' }, // attempted spoof — must be overridden
      body: '{}',
    })
    expect(res.status).toBe(200)
    const headers = seen[0]?.headers as Headers
    expect(headers.get('x-alice-actor')).toBe('user')
    expect(headers.get('authorization')).toBe('Bearer proxy-token')
  })

  it('self-heals a rotated token: 401 → re-read (forceReload) → retry once', async () => {
    const seenAuth: Array<string | null> = []
    const statuses = [401, 200]
    let i = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seenAuth.push((init.headers as Headers).get('authorization'))
      const status = statuses[i++] ?? 200
      return new Response(JSON.stringify({ ok: status === 200 }), { status, headers: { 'content-type': 'application/json' } })
    }))
    const readServiceToken = async (o?: { forceReload?: boolean }) => (o?.forceReload ? 'fresh' : 'stale')
    const app = createTradingProxyRoutes({ utaBaseUrl: 'http://127.0.0.1:47333', getPolicy: PRO, readServiceToken })
    const res = await app.request('/api/trading/uta/alpaca/wallet/stage-place-order', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(seenAuth).toEqual(['Bearer stale', 'Bearer fresh'])
  })
})

describe('createTradingProxyRoutes — CSRF rider (loopback-passthrough gap)', () => {
  it('venue mutation with cross-origin Origin → 403 before proxying', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const app = createTradingProxyRoutes({ utaBaseUrl: 'http://127.0.0.1:47333', getPolicy: PRO })
    const res = await app.request('/api/trading/uta/alpaca/wallet/push', {
      method: 'POST',
      headers: { origin: 'http://evil.example.com', host: 'localhost:3002' },
    })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ code: 'CSRF_ORIGIN' })
    expect(fetchSpy).not.toHaveBeenCalled() // rejected before the upstream call
  })

  it('same-origin venue mutation passes the rider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })))
    const app = createTradingProxyRoutes({ utaBaseUrl: 'http://127.0.0.1:47333', getPolicy: PRO, readServiceToken: async () => 't' })
    const res = await app.request('/api/trading/uta/alpaca/wallet/push', {
      method: 'POST',
      headers: { origin: 'http://localhost:3002', host: 'localhost:3002' },
    })
    expect(res.status).toBe(200)
  })

  it('absent Origin (curl / CLI) is still allowed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })))
    const app = createTradingProxyRoutes({ utaBaseUrl: 'http://127.0.0.1:47333', getPolicy: PRO, readServiceToken: async () => 't' })
    const res = await app.request('/api/trading/uta/alpaca/wallet/push', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('non-venue-mutation reads are not subject to the rider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"utas":[]}', { status: 200, headers: { 'content-type': 'application/json' } })))
    const app = createTradingProxyRoutes({ utaBaseUrl: 'http://127.0.0.1:47333', getPolicy: PRO, readServiceToken: async () => 't' })
    // A cross-origin GET would be blocked by a naive rider; ours only gates venue writes.
    const res = await app.request('/api/trading/uta', {
      method: 'GET',
      headers: { origin: 'http://evil.example.com', host: 'localhost:3002' },
    })
    expect(res.status).toBe(200)
  })
})
