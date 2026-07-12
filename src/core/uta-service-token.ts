/**
 * Shared-secret bearer token for the Alice ↔ UTA HTTP boundary.
 *
 * UTA binds 127.0.0.1 only, but "on the loopback interface" is NOT an
 * authorization boundary: any local process — a rogue script, a
 * compromised dependency, another user on a shared host — can POST a live
 * order straight to UTA's venue-mutating routes, bypassing the tool-layer
 * `allowAiTrading` gate and the BFF readonly gate. This token IS the auth
 * boundary: UTA rejects mutating requests that don't present it.
 *
 * Resolution order:
 *   1. env `OPENALICE_UTA_TOKEN`  — ops override / container secret injection.
 *   2. a token file at the OPENALICE_HOME root, beside `sealing.key`
 *      (deliberately NOT under the portable `data/` subtree — it is
 *      machine-bound material, like the sealing key, and must never ride a
 *      `data/` backup / cloud-sync off the box). See src/core/paths.ts.
 *
 * Bootstrap is race-safe: Alice and UTA both call `loadOrCreate` at boot.
 * The file is created with the `wx` flag (exclusive create), so the first
 * writer wins and any loser re-reads the winner's token. Two concurrent
 * creators therefore always converge on one secret.
 *
 * Rotation: delete the token file (and clear `OPENALICE_UTA_TOKEN`), then
 * restart both processes. There is no online rotation — the HTTP client
 * self-heals a *single* stale token via a 401-retry (it re-reads with
 * `forceReload`), but a permanent rotation needs the restart so both
 * sides re-converge on the new secret from disk/env.
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { userDataHome } from './paths.js'

const TOKEN_BYTES = 32

/** Path to the token file — beside `sealing.key` at the OPENALICE_HOME root,
 *  outside `data/`. Resolved lazily so tests can stub OPENALICE_HOME + reset
 *  modules (paths.ts captures the home at import time). */
export function utaServiceTokenPath(): string {
  return resolve(userDataHome, 'uta-service.token')
}

// Module-level memo so per-request reads (the BFF proxy, the agent client)
// don't hit disk every call. `forceReload` bypasses it to heal a rotated
// token. Deliberately NOT an in-flight-promise dedup: two concurrent
// loadOrCreate calls should genuinely race at the filesystem so the
// wx/EEXIST convergence path is the real, tested behaviour.
let cached: string | undefined

export interface TokenReadOptions {
  /** Bypass the in-process memo and re-resolve from env + disk. */
  forceReload?: boolean
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === code
}

/**
 * Resolve the token if one already exists (env or file). Returns undefined
 * when neither is present — callers that must have a token use
 * `loadOrCreateUTAServiceToken`. Never creates the file.
 */
export async function readUTAServiceToken(opts: TokenReadOptions = {}): Promise<string | undefined> {
  if (!opts.forceReload && cached !== undefined) return cached

  const fromEnv = process.env['OPENALICE_UTA_TOKEN']?.trim()
  if (fromEnv) {
    cached = fromEnv
    return cached
  }

  try {
    const raw = (await readFile(utaServiceTokenPath(), 'utf-8')).trim()
    if (raw.length > 0) {
      cached = raw
      return cached
    }
    // Empty file — treat as "no token"; do NOT memoize the emptiness so a
    // later create is picked up.
    return undefined
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return undefined
    throw err
  }
}

/**
 * Resolve the token, creating a fresh one (persisted, owner-only) when none
 * exists. Race-safe across processes via `wx` exclusive create + EEXIST
 * re-read. Both Alice and UTA call this at boot.
 */
export async function loadOrCreateUTAServiceToken(opts: TokenReadOptions = {}): Promise<string> {
  if (!opts.forceReload && cached !== undefined) return cached

  const existing = await readUTAServiceToken(opts)
  if (existing) return existing

  const token = randomBytes(TOKEN_BYTES).toString('hex')
  const path = utaServiceTokenPath()
  try {
    await mkdir(dirname(path), { recursive: true })
    // Exclusive create: if another process (the co-booting UTA/Alice) beat us
    // to it, `wx` throws EEXIST and we adopt their token instead of clobbering.
    await writeFile(path, token, { flag: 'wx', mode: 0o600 })
    // writeFile's `mode` is ignored on some platforms — chmod again, best-effort.
    await chmod(path, 0o600).catch(() => { /* noop — platform without chmod */ })
    cached = token
    return token
  } catch (err) {
    if (isErrno(err, 'EEXIST')) {
      const raw = (await readFile(path, 'utf-8')).trim()
      cached = raw
      return raw
    }
    throw err
  }
}

/** Drop the in-process memo. Test-only seam; production heals via the
 *  `forceReload` path on the read/load functions. */
export function __resetUTAServiceTokenCacheForTests(): void {
  cached = undefined
}
