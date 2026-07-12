/**
 * Atomic file writes — write-to-temp + fsync + rename so a crash or torn
 * write never leaves a half-written file where a complete one used to be.
 *
 * The failure this prevents: a bare `writeFile` truncates the target and then
 * streams bytes into it. A power loss / OOM-kill / container SIGKILL mid-stream
 * leaves a zero-length or partially-written file — and for state we later parse
 * (trade-commit journals, sealed broker creds, the migration journal) that
 * reads back as "no state", i.e. silent amnesia. Writing to a sibling temp file
 * and atomically renaming it over the target means readers only ever see the
 * old complete file or the new complete file, never a torn one.
 *
 * Reachable from every co-located service (UTA maps `@/*` → `../../src/*` and
 * tsup bundles it) — import as `@/core/fs-atomic.js`.
 */

import { mkdir, open, copyFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

export interface WriteFileAtomicOptions {
  /** Copy the current file to `${path}.bak` before renaming the new one into
   *  place (best-effort; a missing target on first write is fine). Gives a
   *  recovery sidecar for the corruption case. Default false. */
  backup?: boolean
  /** fsync the temp file's contents to disk before the rename. Default true —
   *  durability is the whole point for state files. Pass false only for
   *  throwaway data where speed matters more than closing the crash window. */
  fsync?: boolean
  /** Mode for the temp file (e.g. 0o600). Rides the temp file so the rename
   *  never exposes a world-readable window for secrets. Default: OS default. */
  mode?: number
}

const WIN32_RENAME_RETRIES = 3
const WIN32_RENAME_RETRY_MS = 50

/**
 * Write `data` to `path` atomically: temp file → (chmod) → fsync → rename.
 * Never leaves a partially-written `path`. See the module header for the
 * failure this prevents.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  opts: WriteFileAtomicOptions = {},
): Promise<void> {
  const { backup = false, fsync = true, mode } = opts
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`

  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = mode === undefined ? await open(tmp, 'w') : await open(tmp, 'w', mode)
    await fh.writeFile(data)
    // Pin the exact mode regardless of the process umask — a secret file must
    // never end up wider than requested because umask happened to be permissive.
    if (mode !== undefined) await fh.chmod(mode)
    if (fsync !== false) await fh.sync()
    await fh.close()
    fh = undefined

    if (backup) {
      // Best-effort: a missing target (first write) is not an error; any other
      // failure is real and should surface.
      await copyFile(path, `${path}.bak`).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      })
    }

    await renameWithRetry(tmp, path)
  } catch (err) {
    if (fh !== undefined) await fh.close().catch(() => { /* already unwinding */ })
    await unlink(tmp).catch(() => { /* temp may never have been created */ })
    throw err
  }
}

/**
 * rename(), retrying briefly on Windows EPERM/EBUSY. On win32 a concurrent
 * reader (AV scanner, search indexer, or the app's own read) can hold a
 * transient lock on the destination that makes the underlying ReplaceFile/
 * rename fail with EPERM/EBUSY; a short retry clears it. POSIX rename is atomic
 * and needs no retry, so this is a no-op there.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const retryable = process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY')
      if (!retryable || attempt >= WIN32_RENAME_RETRIES - 1) throw err
      await sleep(WIN32_RENAME_RETRY_MS)
    }
  }
}
