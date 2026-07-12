/**
 * In-UTA authorization gate for venue-mutating routes.
 *
 * This is the LAST line of defense on the live-order path. It runs INSIDE
 * the UTA service, so it holds even when a caller bypasses Alice's tool
 * layer and the BFF proxy and talks to UTA directly (with a valid service
 * token). The equivalent gates elsewhere — `allowAiTrading` in Alice's tool
 * layer, `readonly` in the BFF proxy — protect only their own path; this one
 * protects the venue itself.
 *
 * `assertVenueWriteAllowed` returns a `Response` to short-circuit (deny), or
 * `null` to allow the handler to proceed. It is called at the TOP of each of
 * UTA's four venue-mutating routes (push / place-order / close-position /
 * cancel-order) and over every simulator mutation. Stage / commit / reject
 * stay UNGATED beyond the service token, so the stage-then-ask approval flow
 * still works while `allowAiTrading` is off.
 */

import type { Context } from 'hono'
import type { UTAEngineContext } from '../types.js'

/**
 * Manual-approval message — mirrors the tool layer's `tradingPush` copy
 * (`src/tool/trading.ts`) so the direct-UTA path tells the operator exactly
 * what the AI-tool path does.
 */
export const MANUAL_APPROVAL_MESSAGE =
  'Push requires manual approval (AI trading is disabled). Tell the user to review and approve the pending operations in the Web UI (Trading as Git page, or the account detail page).'

/**
 * Gate a venue write. Order:
 *   1. mode 'lite'     → 503 (trading carrier disabled)
 *   2. mode 'readonly' → 403 (reads OK, venue writes blocked — mirrors the BFF proxy)
 *   3. actor !== 'user' (agent or absent) AND allowAiTrading off → 403 (manual approval)
 *   4. otherwise allow — per-account guards downstream still apply.
 */
export async function assertVenueWriteAllowed(ctx: UTAEngineContext, c: Context): Promise<Response | null> {
  const mode = await ctx.policy.mode()

  if (mode === 'lite') {
    return c.json({
      error: 'Trading mode is lite',
      detail: 'Venue-mutating broker writes are disabled in lite mode',
      code: 'TRADING_LITE',
    }, 503)
  }

  if (mode === 'readonly') {
    // Mirror the BFF proxy's readonly response shape (trading-proxy.ts).
    return c.json({
      error: 'Trading mode is readonly',
      detail: 'Venue-mutating broker writes are disabled in readonly mode',
      code: 'TRADING_READONLY',
    }, 403)
  }

  // pro mode. Human-approved writes (actor 'user', set spoof-proof by the BFF
  // proxy) are always allowed. Agent-initiated OR unauthenticated-actor writes
  // require the operator's explicit `allowAiTrading` opt-in.
  const actor = c.req.header('x-alice-actor')
  if (actor !== 'user') {
    const allowed = await ctx.policy.allowAiTrading()
    if (!allowed) {
      return c.json({
        error: MANUAL_APPROVAL_MESSAGE,
        code: 'AI_TRADING_DISABLED',
      }, 403)
    }
  }

  return null
}
