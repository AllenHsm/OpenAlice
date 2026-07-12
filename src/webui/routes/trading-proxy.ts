/**
 * BFF proxy for `/api/trading/*` — Alice → UTA.
 *
 * UI talks to Alice on a single origin (decision #2 of UTA-split v1); this
 * route forwards every trading request unchanged to the UTA service. v1
 * has no auth between the two — UTA is bound to 127.0.0.1 only, so the
 * trust boundary is the host, not the request.
 *
 * Stream-friendly: forwards request body, returns UTA's Response as-is so
 * `Content-Type` / chunked transfer / SSE headers pass through. A short
 * connect timeout (1s) fails fast when UTA is down, so the agent loop
 * doesn't hang on a dead backend.
 */

import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { describeTradingMode, type TradingModePolicy } from '../../services/trading-mode.js'
import { readUTAServiceToken } from '../../core/uta-service-token.js'
import { isAllowedOrigin } from '../middleware/auth.js'
import type { Logger } from '../../core/app-logger.js'

// Total request timeout. UTA is on the loopback interface so connect is
// instant — this guards against handlers that legitimately take seconds
// (broker queries, contract searches) hanging Alice forever. 30s is
// well above the typical broker-API SLA without being a footgun.
const PROXY_TIMEOUT_MS = 30_000
const STATUS_TIMEOUT_MS = 1_000

/** Methods Hono's `app.all` actually dispatches. Empty body methods get a
 *  null body forwarded. */
const PASSTHROUGH_HEADERS: readonly string[] = [
  // Forward common identifying headers; strip hop-by-hop / Host so the UTA
  // sees its own host.
  'accept', 'accept-language', 'content-type', 'content-length',
  'user-agent', 'cache-control', 'pragma', 'x-request-id',
]

export function createTradingProxyRoutes(opts: {
  utaBaseUrl?: string
  disabledReason?: 'lite_mode'
  getPolicy?: () => TradingModePolicy
  /** Optional structured logger — records proxy failures with the correlation
   *  id so Alice's log lines up with UTA's access log. */
  logger?: Logger
  /** CSRF-trusted Origins (mirrors the auth middleware's set). Used by the
   *  venue-mutation Origin rider that closes the loopback-passthrough gap. */
  csrfTrustedOrigins?: string[]
  /** Service-token reader for the Alice↔UTA auth boundary. Injectable for
   *  tests; defaults to the shared token module. */
  readServiceToken?: (o?: { forceReload?: boolean }) => Promise<string | undefined>
}): Hono {
  const app = new Hono()
  const base = opts.utaBaseUrl?.replace(/\/$/, '')
  const disabledReason = opts.disabledReason
  const log = opts.logger
  const csrfTrustedOrigins = new Set(opts.csrfTrustedOrigins ?? [])
  const readServiceToken = opts.readServiceToken ?? readUTAServiceToken
  const getPolicy = opts.getPolicy ?? (() => ({
    mode: disabledReason === 'lite_mode' ? 'lite' : 'pro',
    source: disabledReason === 'lite_mode' ? 'env' : 'auto',
    envLocked: disabledReason === 'lite_mode',
    hasUTAConfig: false,
  }))

  app.get('/status', async (c) => {
    const policy = getPolicy()
    if (policy.mode === 'lite') {
      return c.json({
        available: false,
        state: 'unavailable',
        reason: 'lite_mode',
        mode: policy.mode,
        modeSource: policy.source,
        envLocked: policy.envLocked,
        hasUTAConfig: policy.hasUTAConfig,
        hint: describeTradingMode('lite'),
      })
    }
    if (!base) {
      return c.json({
        available: false,
        state: 'unavailable',
        reason: 'not_configured',
        mode: policy.mode,
        modeSource: policy.source,
        envLocked: policy.envLocked,
        hasUTAConfig: policy.hasUTAConfig,
        hint: 'Trading service is not configured.',
      })
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS)
    try {
      const res = await fetch(`${base}/__uta/health`, { signal: controller.signal })
      if (!res.ok) {
        return c.json({
          available: false,
          state: 'unavailable',
          reason: `health_${res.status}`,
          mode: policy.mode,
          modeSource: policy.source,
          envLocked: policy.envLocked,
          hasUTAConfig: policy.hasUTAConfig,
          hint: 'Trading service is not healthy.',
        })
      }
      const health = await res.json() as { startedAt?: string; utas?: number }
      return c.json({
        available: true,
        state: 'available',
        mode: policy.mode,
        modeSource: policy.source,
        envLocked: policy.envLocked,
        hasUTAConfig: policy.hasUTAConfig,
        hint: describeTradingMode(policy.mode),
        startedAt: health.startedAt,
        utas: health.utas ?? 0,
      })
    } catch (err) {
      return c.json({
        available: false,
        state: 'unavailable',
        reason: err instanceof Error ? err.message : String(err),
        mode: policy.mode,
        modeSource: policy.source,
        envLocked: policy.envLocked,
        hasUTAConfig: policy.hasUTAConfig,
        hint: 'Trading service is not reachable.',
      })
    } finally {
      clearTimeout(timer)
    }
  })

  app.all('*', async (c) => {
    const policy = getPolicy()
    if (policy.mode === 'lite') {
      return c.json({
        error: 'UTA disabled',
        detail: 'Trading mode is lite',
        hint: describeTradingMode('lite'),
      }, 503)
    }
    if (policy.mode === 'readonly' && isVenueMutation(c.req.method, c.req.path)) {
      return c.json({
        error: 'Trading mode is readonly',
        detail: 'Venue-mutating broker writes are disabled in readonly mode',
        hint: describeTradingMode('readonly'),
      }, 403)
    }
    // CSRF rider — closes the loopback-passthrough gap. Alice's auth
    // middleware skips its Origin check for loopback requests, so a browser
    // page on a rogue local origin could otherwise drive a venue mutation
    // through this proxy. Re-check the Origin here for venue writes only.
    // Absent Origin (curl / CLI / server-to-server) stays allowed, matching
    // the auth middleware's documented stance.
    if (isVenueMutation(c.req.method, c.req.path)) {
      const origin = c.req.header('origin')
      if (origin && !isAllowedOrigin(origin, c, csrfTrustedOrigins)) {
        return c.json({ error: 'Forbidden: origin not allowed', code: 'CSRF_ORIGIN' }, 403)
      }
    }
    if (!base) {
      return c.json({
        error: 'UTA unavailable',
        detail: 'UTA URL is not configured',
        hint: 'Trading service is not reachable. Alice is running in lite mode.',
      }, 503)
    }
    const incoming = c.req.raw
    // Reconstruct target URL: Hono's `c.req.path` is the *full* path
    // including the mount prefix (`/api/trading/uta`, not `/uta`), so
    // we forward it as-is.
    const target = `${base}${c.req.path}${url(incoming).search}`

    const forwardHeaders = new Headers()
    for (const name of PASSTHROUGH_HEADERS) {
      const v = incoming.headers.get(name)
      if (v !== null) forwardHeaders.set(name, v)
    }
    // Correlation id: reuse the caller's x-request-id (already in the
    // passthrough allowlist) or mint one, so a single id threads Alice's proxy
    // log and UTA's access log for the same request.
    const reqId = forwardHeaders.get('x-request-id') ?? randomUUID()
    forwardHeaders.set('x-request-id', reqId)
    // Actor tag: ALWAYS 'user' for this human-approval path. `x-alice-actor`
    // is NOT in the passthrough allowlist, so any inbound value was already
    // dropped — setting it here is spoof-proof. UTA's policy gate treats
    // 'user' as human-approved (allowed in pro mode regardless of allowAiTrading).
    forwardHeaders.set('x-alice-actor', 'user')
    // Service token for the Alice↔UTA auth boundary.
    const token = await readServiceToken()
    if (token) forwardHeaders.set('authorization', `Bearer ${token}`)

    // Buffer the request body so a 401 self-heal retry can re-send it. The
    // trading / simulator API carries only small JSON bodies, so buffering
    // here does not affect response streaming (SSE / chunked responses still
    // pass through untouched below). Drop any forwarded content-length so
    // fetch computes the correct one from the buffered body.
    const bodyBuf = hasBody(incoming.method) ? await incoming.arrayBuffer() : null
    forwardHeaders.delete('content-length')

    const doFetch = async (): Promise<Response> => {
      const controller = new AbortController()
      const connectTimer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS)
      try {
        return await fetch(target, {
          method: incoming.method,
          headers: forwardHeaders,
          body: bodyBuf,
          signal: controller.signal,
          redirect: 'manual',
        })
      } finally {
        clearTimeout(connectTimer)
      }
    }

    let upstream: Response
    try {
      upstream = await doFetch()
      // Self-heal a rotated service token: on 401, re-read (forceReload) and
      // retry exactly once.
      if (upstream.status === 401) {
        const fresh = await readServiceToken({ forceReload: true })
        if (fresh) forwardHeaders.set('authorization', `Bearer ${fresh}`)
        await upstream.text().catch(() => { /* drain discarded 401 body */ })
        upstream = await doFetch()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log?.warn('uta proxy request failed', { reqId, method: incoming.method, path: c.req.path, error: msg })
      return c.json({
        error: 'UTA unavailable',
        detail: msg,
        hint: 'Trading service is not reachable. Alice is running in lite mode.',
      }, 502)
    }

    // Re-wrap with a fresh Headers object so downstream middleware (CORS,
    // etc.) can still mutate them. `fetch()` returns a Response whose
    // headers carry an immutable guard per the WHATWG spec — handing it
    // back as-is makes any later `headers.set(...)` throw.
    const headers = new Headers()
    upstream.headers.forEach((value, name) => { headers.set(name, value) })
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    })
  })

  return app
}

function isVenueMutation(method: string, path: string): boolean {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return false
  const normalized = path.toLowerCase()
  return (
    normalized.includes('/wallet/push') ||
    normalized.includes('/wallet/place-order') ||
    normalized.includes('/wallet/close-position') ||
    normalized.includes('/wallet/cancel-order') ||
    normalized.includes('/simulate-price') ||
    normalized.startsWith('/api/simulator') ||
    normalized.startsWith('/simulator')
  )
}

function url(req: Request): URL {
  try { return new URL(req.url) } catch { return new URL('http://localhost/') }
}

function hasBody(method: string): boolean {
  const m = method.toUpperCase()
  return m !== 'GET' && m !== 'HEAD'
}
