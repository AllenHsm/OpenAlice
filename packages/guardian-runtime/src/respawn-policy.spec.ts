import { describe, it, expect } from 'vitest'
import { createRespawnPolicy } from './respawn-policy.js'

describe('createRespawnPolicy', () => {
  it('backs off exponentially, capped at maxDelayMs', () => {
    const p = createRespawnPolicy() // base 1000, factor 2, cap 60000, max 10
    const delays = Array.from({ length: 10 }, () => p.onCrash(0))
    expect(delays.map((d) => (d.action === 'respawn' ? d.delayMs : -1)))
      .toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000])
    expect(delays.every((d) => d.action === 'respawn')).toBe(true)
    expect(delays[0]).toMatchObject({ action: 'respawn', attempt: 1 })
    expect(delays[9]).toMatchObject({ action: 'respawn', attempt: 10 })
  })

  it('gives up once respawn attempts exceed maxConsecutiveCrashes', () => {
    const p = createRespawnPolicy({ maxConsecutiveCrashes: 3 })
    expect(p.onCrash(0)).toMatchObject({ action: 'respawn', attempt: 1, delayMs: 1000 })
    expect(p.onCrash(0)).toMatchObject({ action: 'respawn', attempt: 2, delayMs: 2000 })
    expect(p.onCrash(0)).toMatchObject({ action: 'respawn', attempt: 3, delayMs: 4000 })
    expect(p.onCrash(0)).toEqual({ action: 'give-up', attempt: 4 }) // one past the cap
    expect(p.onCrash(0)).toEqual({ action: 'give-up', attempt: 5 }) // stays given-up
  })

  it('resets the counter after a healthy spawn stays up healthyResetMs', () => {
    const p = createRespawnPolicy({ healthyResetMs: 1000 })
    expect(p.onCrash(0)).toMatchObject({ attempt: 1 })
    expect(p.onCrash(0)).toMatchObject({ attempt: 2 })
    p.onSpawned(0) // healthy spawn observed at t=0
    // Next crash is >= healthyResetMs after the healthy spawn → fresh sequence.
    expect(p.onCrash(1000)).toMatchObject({ action: 'respawn', attempt: 1, delayMs: 1000 })
  })

  it('does NOT reset when the healthy spawn stayed up less than healthyResetMs', () => {
    const p = createRespawnPolicy({ healthyResetMs: 1000 })
    p.onCrash(0) // attempt 1
    p.onCrash(0) // attempt 2
    p.onSpawned(0)
    expect(p.onCrash(999)).toMatchObject({ attempt: 3 }) // 999 < 1000 → no reset, keeps counting
  })

  it('does not repeatedly reset when a respawn never becomes healthy', () => {
    const p = createRespawnPolicy({ healthyResetMs: 1000 })
    p.onSpawned(0) // last healthy spawn at t=0
    // First crash long after the healthy spawn → reset to attempt 1.
    expect(p.onCrash(5000)).toMatchObject({ attempt: 1 })
    // No onSpawned since (respawn never came up); the stale healthy timestamp
    // must NOT reset again — backoff has to keep progressing.
    expect(p.onCrash(9000)).toMatchObject({ attempt: 2 })
    expect(p.onCrash(13000)).toMatchObject({ attempt: 3 })
  })

  it('reset() clears crash history', () => {
    const p = createRespawnPolicy()
    p.onCrash(0)
    p.onCrash(0)
    p.reset()
    expect(p.onCrash(0)).toMatchObject({ action: 'respawn', attempt: 1, delayMs: 1000 })
  })

  it('honours custom base/factor', () => {
    const p = createRespawnPolicy({ baseDelayMs: 500, factor: 3, maxDelayMs: 100_000 })
    expect(p.onCrash(0)).toMatchObject({ delayMs: 500 })   // 500 * 3^0
    expect(p.onCrash(0)).toMatchObject({ delayMs: 1500 })  // 500 * 3^1
    expect(p.onCrash(0)).toMatchObject({ delayMs: 4500 })  // 500 * 3^2
  })
})
