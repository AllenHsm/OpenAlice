/**
 * UTA service-auth middleware — the token gate on UTA's HTTP surface.
 *
 * UTA binds 127.0.0.1 only, but loopback is not an authorization boundary:
 * any local process could otherwise POST a live order to UTA's mutating
 * routes. This middleware requires a shared bearer token (see
 * `src/core/uta-service-token.ts`) so only Alice's agent client and BFF
 * proxy — which present it — can drive venue writes.
 *
 * v1 scope is deliberately narrow to stay backward-compatible for local dev:
 *   - Enforced ONLY on mutating methods (POST/PUT/DELETE/PATCH). GETs stay
 *     open this release (read routes are lower-risk; tightening them later is
 *     additive).
 *   - Mount on `/api/*`; `/__uta/health` is not under `/api/*` and stays
 *     public for Guardian / BFF probes.
 *   - Timing-safe token comparison (`crypto.timingSafeEqual`).
 *   - Escape hatch `OPENALICE_UTA_AUTH=0` disables the gate (a RED boot
 *     warning is logged by the mount site) for constrained local setups.
 *
 * Fail-closed: if no token is configured and the gate is not explicitly
 * disabled, every mutating request is rejected.
 */

import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])
const BEARER_PREFIX = 'Bearer '

export interface ServiceAuthOptions {
  /** The shared secret. `undefined` + not disabled ⇒ every write is 401. */
  token: string | undefined
  /** Escape hatch (OPENALICE_UTA_AUTH=0). When true the gate is a no-op. */
  disabled?: boolean
}

export function createServiceAuthMiddleware(opts: ServiceAuthOptions): MiddlewareHandler {
  const expected = opts.token
  const disabled = opts.disabled === true
  return async (c, next) => {
    if (disabled) return next()
    // v1: only mutating methods are gated; reads stay open.
    if (!MUTATING_METHODS.has(c.req.method.toUpperCase())) return next()

    const header = c.req.header('authorization') ?? ''
    if (!expected || !bearerMatches(header, expected)) {
      return c.json({ error: 'Unauthorized', code: 'UTA_SERVICE_AUTH' }, 401)
    }
    return next()
  }
}

/** Constant-time `Authorization: Bearer <token>` check. */
function bearerMatches(header: string, expected: string): boolean {
  if (!header.startsWith(BEARER_PREFIX)) return false
  return timingSafeEqualString(header.slice(BEARER_PREFIX.length), expected)
}

/**
 * Timing-safe string compare. `timingSafeEqual` throws on length mismatch, so
 * we guard the lengths — but still burn a comparison against ourselves on the
 * mismatch branch so the early return doesn't leak length via timing.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}
