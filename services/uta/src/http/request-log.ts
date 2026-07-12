/**
 * UTA HTTP access-log middleware.
 *
 * Mounted early (before the route table) so every request — including 404s —
 * is covered. For each request it:
 *   1. Reads the inbound `x-request-id` (Alice's trading proxy sets it) or mints
 *      one, so a single correlation id threads Alice's proxy log and UTA's
 *      access log for the same call.
 *   2. Stashes it on the context (`c.set('reqId')`) for handlers/error paths.
 *   3. Echoes it back as a response header.
 *   4. Emits one structured `http` event (reqId, method, path, status, ms).
 *
 * Note: the status logged for a *thrown* handler reflects the response present
 * when the `finally` unwinds, which may precede Hono's onError substitution.
 * Ordinary (non-throwing) responses log their true status. Access logging is
 * best-effort observability, never on the request's critical path.
 */

import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { Logger } from '@/core/app-logger.js'

/** Context variables this middleware contributes. */
export type RequestLogVariables = { reqId: string }

export function createRequestLog(log: Logger): MiddlewareHandler<{ Variables: RequestLogVariables }> {
  return async (c, next) => {
    const reqId = c.req.header('x-request-id') ?? randomUUID()
    c.set('reqId', reqId)
    c.header('x-request-id', reqId)
    const start = Date.now()
    try {
      await next()
    } finally {
      log.event('http', {
        reqId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Date.now() - start,
      })
    }
  }
}
