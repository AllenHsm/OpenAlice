/**
 * Respawn policy — pure decision logic for auto-restarting a crashed child.
 *
 * Deliberately free of timers and child_process so it is trivially unit-testable
 * and can be consumed identically from the dev guardian (TS source), the prod
 * guardian (`prod.mjs`, built dist), and the desktop guardian (Electron main).
 * The carriers own the actual `setTimeout` / `spawn`; this only answers "should
 * I respawn, and after how long?".
 *
 * Behaviour:
 *   - Exponential backoff: attempt N waits `min(maxDelayMs, base * factor^(N-1))`.
 *   - Give up after `maxConsecutiveCrashes` respawn attempts — the crash whose
 *     attempt number exceeds the cap returns `give-up` instead of `respawn`.
 *   - A spawn that stays healthy for `healthyResetMs` (reported via `onSpawned`)
 *     resets the consecutive-crash counter, so a process that runs fine for a
 *     while and later crashes starts a fresh backoff sequence rather than
 *     inheriting old strikes.
 */

export interface RespawnPolicyOptions {
  /** First backoff delay, in ms. Default 1000. */
  baseDelayMs?: number
  /** Exponential growth factor per attempt. Default 2. */
  factor?: number
  /** Ceiling for the backoff delay, in ms. Default 60000. */
  maxDelayMs?: number
  /** Respawn attempts permitted before giving up. Default 10. */
  maxConsecutiveCrashes?: number
  /** Uptime after a healthy spawn that resets the crash counter, in ms. Default 300000 (5m). */
  healthyResetMs?: number
}

export type RespawnDecision =
  | { action: 'respawn'; delayMs: number; attempt: number }
  | { action: 'give-up'; attempt: number }

export interface RespawnPolicy {
  /** Record a crash and decide whether/when to respawn. `now` is injectable for tests. */
  onCrash(now?: number): RespawnDecision
  /** Record that a (health-gated) spawn came up. Enables the healthy-uptime reset. */
  onSpawned(now?: number): void
  /** Forget all crash history (e.g. on an operator-triggered restart). */
  reset(): void
}

export function createRespawnPolicy(opts: RespawnPolicyOptions = {}): RespawnPolicy {
  const baseDelayMs = opts.baseDelayMs ?? 1000
  const factor = opts.factor ?? 2
  const maxDelayMs = opts.maxDelayMs ?? 60_000
  const maxConsecutiveCrashes = opts.maxConsecutiveCrashes ?? 10
  const healthyResetMs = opts.healthyResetMs ?? 300_000

  let consecutiveCrashes = 0
  let lastHealthyAt: number | null = null

  return {
    onCrash(now = Date.now()): RespawnDecision {
      // If the most recent healthy spawn stayed up long enough, this crash
      // begins a fresh sequence. Consume the timestamp so a respawn that never
      // reports healthy can't keep re-triggering the reset.
      if (lastHealthyAt !== null && now - lastHealthyAt >= healthyResetMs) {
        consecutiveCrashes = 0
        lastHealthyAt = null
      }
      consecutiveCrashes += 1
      const attempt = consecutiveCrashes
      if (attempt > maxConsecutiveCrashes) {
        return { action: 'give-up', attempt }
      }
      const delayMs = Math.min(maxDelayMs, Math.round(baseDelayMs * factor ** (attempt - 1)))
      return { action: 'respawn', delayMs, attempt }
    },
    onSpawned(now = Date.now()): void {
      lastHealthyAt = now
    },
    reset(): void {
      consecutiveCrashes = 0
      lastHealthyAt = null
    },
  }
}
