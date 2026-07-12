/**
 * The core safety proof for the in-UTA venue-write gate.
 *
 * `assertVenueWriteAllowed` is the LAST line of defense on the live-order
 * path — it holds even when a caller bypasses Alice's tool layer and BFF
 * proxy and hits UTA directly with a valid service token. This spec pins the
 * full 12-case matrix:
 *
 *     {actor: user / agent / absent} × {mode: pro / readonly} × {allowAiTrading: on / off}
 *
 * plus the lite-mode short-circuit.
 */

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { assertVenueWriteAllowed } from './venue-policy.js'
import type { UTAEngineContext } from '../types.js'

type Mode = 'lite' | 'readonly' | 'pro'
type Actor = 'user' | 'agent' | undefined

/** Drive the gate through a real Hono Context so header parsing (actor) and
 *  Response construction are exercised exactly as in production. */
async function runGate(opts: { mode: Mode; allowAiTrading: boolean; actor: Actor }) {
  const ctx = {
    policy: {
      mode: async () => opts.mode,
      allowAiTrading: async () => opts.allowAiTrading,
    },
  } as unknown as UTAEngineContext

  const app = new Hono()
  app.post('/x', async (c) => {
    const denied = await assertVenueWriteAllowed(ctx, c)
    return denied ?? c.json({ allowed: true })
  })

  const headers: Record<string, string> = {}
  if (opts.actor) headers['x-alice-actor'] = opts.actor
  const res = await app.request('/x', { method: 'POST', headers })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, code: (body as { code?: string }).code, allowed: (body as { allowed?: boolean }).allowed === true }
}

interface Case {
  actor: Actor
  mode: 'pro' | 'readonly'
  allow: boolean
  status: number
  code?: string
  outcome: 'pass' | 'readonly' | 'ai-disabled'
}

// The 12-case matrix. Expected outcomes:
//   - readonly → always 403 TRADING_READONLY (reads OK, writes blocked)
//   - pro + actor=user → always pass (human approval, allowAiTrading irrelevant)
//   - pro + actor=agent|absent → pass iff allowAiTrading on, else 403 AI_TRADING_DISABLED
const MATRIX: Case[] = [
  // actor = user (human-approved path via BFF proxy)
  { actor: 'user', mode: 'pro', allow: true, status: 200, outcome: 'pass' },
  { actor: 'user', mode: 'pro', allow: false, status: 200, outcome: 'pass' },
  { actor: 'user', mode: 'readonly', allow: true, status: 403, code: 'TRADING_READONLY', outcome: 'readonly' },
  { actor: 'user', mode: 'readonly', allow: false, status: 403, code: 'TRADING_READONLY', outcome: 'readonly' },
  // actor = agent (Alice's agent client)
  { actor: 'agent', mode: 'pro', allow: true, status: 200, outcome: 'pass' },
  { actor: 'agent', mode: 'pro', allow: false, status: 403, code: 'AI_TRADING_DISABLED', outcome: 'ai-disabled' },
  { actor: 'agent', mode: 'readonly', allow: true, status: 403, code: 'TRADING_READONLY', outcome: 'readonly' },
  { actor: 'agent', mode: 'readonly', allow: false, status: 403, code: 'TRADING_READONLY', outcome: 'readonly' },
  // actor = absent (raw curl / any local process — treated like agent, never trusted)
  { actor: undefined, mode: 'pro', allow: true, status: 200, outcome: 'pass' },
  { actor: undefined, mode: 'pro', allow: false, status: 403, code: 'AI_TRADING_DISABLED', outcome: 'ai-disabled' },
  { actor: undefined, mode: 'readonly', allow: true, status: 403, code: 'TRADING_READONLY', outcome: 'readonly' },
  { actor: undefined, mode: 'readonly', allow: false, status: 403, code: 'TRADING_READONLY', outcome: 'readonly' },
]

describe('assertVenueWriteAllowed — 12-case policy matrix', () => {
  for (const tc of MATRIX) {
    const label = `actor=${tc.actor ?? 'absent'} mode=${tc.mode} allowAiTrading=${tc.allow ? 'on' : 'off'} → ${tc.outcome} (${tc.status})`
    it(label, async () => {
      const r = await runGate({ mode: tc.mode, allowAiTrading: tc.allow, actor: tc.actor })
      expect(r.status).toBe(tc.status)
      if (tc.status === 200) {
        expect(r.allowed).toBe(true)
      } else {
        expect(r.code).toBe(tc.code)
      }
    })
  }

  it('matrix covers exactly 12 cases (3 actors × 2 modes × 2 toggles)', () => {
    expect(MATRIX).toHaveLength(12)
  })
})

describe('assertVenueWriteAllowed — lite-mode short-circuit', () => {
  for (const actor of ['user', 'agent', undefined] as Actor[]) {
    it(`lite mode → 503 regardless of actor=${actor ?? 'absent'} / allowAiTrading`, async () => {
      const r = await runGate({ mode: 'lite', allowAiTrading: true, actor })
      expect(r.status).toBe(503)
      expect(r.code).toBe('TRADING_LITE')
    })
  }
})
