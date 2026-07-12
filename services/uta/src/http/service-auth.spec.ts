/**
 * Tests for the UTA service-auth middleware (the token gate).
 *
 * v1 contract:
 *   - Mutating methods (POST/PUT/DELETE/PATCH) require `Authorization: Bearer <token>`.
 *   - GETs stay open this release.
 *   - Wrong / missing / wrong-length token → 401.
 *   - OPENALICE_UTA_AUTH=0 (disabled: true) bypasses the gate entirely.
 */

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createServiceAuthMiddleware } from './service-auth.js'

const TOKEN = 'a'.repeat(64) // 32 bytes hex, same shape as the real token

function makeApp(opts: { token: string | undefined; disabled?: boolean }) {
  const app = new Hono()
  app.use('/api/*', createServiceAuthMiddleware(opts))
  app.get('/api/trading/utas', (c) => c.json({ ok: true }))
  app.post('/api/trading/uta/x/wallet/push', (c) => c.json({ pushed: true }))
  app.delete('/api/trading/uta/x/snapshots/y', (c) => c.json({ deleted: true }))
  // Public health lives outside /api/* — the gate must never see it.
  app.get('/__uta/health', (c) => c.json({ ok: true }))
  return app
}

function req(app: Hono, method: string, path: string, token?: string) {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`
  return app.request(path, { method, headers })
}

describe('service-auth middleware', () => {
  it('rejects a mutating request with NO token (401)', async () => {
    const app = makeApp({ token: TOKEN })
    const res = await req(app, 'POST', '/api/trading/uta/x/wallet/push')
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('UTA_SERVICE_AUTH')
  })

  it('rejects a mutating request with the WRONG token (401)', async () => {
    const app = makeApp({ token: TOKEN })
    const res = await req(app, 'POST', '/api/trading/uta/x/wallet/push', 'b'.repeat(64))
    expect(res.status).toBe(401)
  })

  it('accepts a mutating request with the CORRECT token', async () => {
    const app = makeApp({ token: TOKEN })
    const res = await req(app, 'POST', '/api/trading/uta/x/wallet/push', TOKEN)
    expect(res.status).toBe(200)
    expect((await res.json()).pushed).toBe(true)
  })

  it('gates DELETE too (mutating method)', async () => {
    const app = makeApp({ token: TOKEN })
    expect((await req(app, 'DELETE', '/api/trading/uta/x/snapshots/y')).status).toBe(401)
    expect((await req(app, 'DELETE', '/api/trading/uta/x/snapshots/y', TOKEN)).status).toBe(200)
  })

  it('lets GETs through WITHOUT a token (v1: reads stay open)', async () => {
    const app = makeApp({ token: TOKEN })
    const res = await req(app, 'GET', '/api/trading/utas')
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('OPENALICE_UTA_AUTH=0 bypass: mutating request passes with no token', async () => {
    const app = makeApp({ token: TOKEN, disabled: true })
    const res = await req(app, 'POST', '/api/trading/uta/x/wallet/push')
    expect(res.status).toBe(200)
  })

  it('fail-closed: no configured token + not disabled → 401 on writes', async () => {
    const app = makeApp({ token: undefined })
    expect((await req(app, 'POST', '/api/trading/uta/x/wallet/push', TOKEN)).status).toBe(401)
    // ...but GETs still pass (reads open this release).
    expect((await req(app, 'GET', '/api/trading/utas')).status).toBe(200)
  })

  it('timing-safe path: a wrong-LENGTH token is rejected (length-mismatch branch)', async () => {
    const app = makeApp({ token: TOKEN })
    // Shorter than expected → timingSafeEqual would throw on unequal buffers;
    // the guard returns false instead of leaking via an exception.
    const res = await req(app, 'POST', '/api/trading/uta/x/wallet/push', 'short')
    expect(res.status).toBe(401)
    // Equal-length-but-different also 401 (constant-time compare branch).
    const res2 = await req(app, 'POST', '/api/trading/uta/x/wallet/push', 'c'.repeat(64))
    expect(res2.status).toBe(401)
  })

  it('a malformed Authorization header (no Bearer prefix) is rejected', async () => {
    const app = makeApp({ token: TOKEN })
    const res = await app.request('/api/trading/uta/x/wallet/push', {
      method: 'POST',
      headers: { authorization: TOKEN }, // missing "Bearer " prefix
    })
    expect(res.status).toBe(401)
  })
})
