/**
 * Git state persistence — load/save Trading-as-Git commit history.
 *
 * Extracted from main.ts. Pure functions + file IO, no instance dependencies.
 *
 * Durability contract: the journal is the account's entire trade history. A
 * torn write (crash mid-`writeFile`) or an unreadable file must NOT boot the
 * account with an empty journal — that is silent amnesia and the account would
 * re-trade as if it held nothing. So the write is atomic (temp+fsync+rename,
 * with a `.bak` sidecar) and the read is LOUD: a corrupt primary is recovered
 * from `.bak` if possible, otherwise it throws `GitJournalCorruptError` and the
 * caller takes that one account offline rather than trading with a blank slate.
 */

import { readFile, rename } from 'fs/promises'
import type { GitExportState } from './git/types.js'
import { dataPath } from '@/core/paths.js'
import { writeFileAtomic } from '@/core/fs-atomic.js'

// ==================== Errors ====================

/**
 * The trade-commit journal exists but could not be parsed and no usable `.bak`
 * backup was found. Thrown by `loadGitState` so the caller can take THAT ONE
 * account offline (never boot it with an empty journal). Carries the account id
 * and the on-disk path for the operator-facing recovery message.
 */
export class GitJournalCorruptError extends Error {
  constructor(
    readonly accountId: string,
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Trade-commit journal for account "${accountId}" is corrupt and no usable backup was found (${path})`,
      options,
    )
    this.name = 'GitJournalCorruptError'
  }
}

// ==================== Paths ====================

function gitFilePath(accountId: string): string {
  return dataPath('trading', accountId, 'commit.json')
}

/** Legacy paths for backward compat. TODO: remove before v1.0 */
const LEGACY_GIT_PATHS: Record<string, string> = {
  'bybit-main': dataPath('crypto-trading', 'commit.json'),
  'alpaca-paper': dataPath('securities-trading', 'commit.json'),
  'alpaca-live': dataPath('securities-trading', 'commit.json'),
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

async function readJsonState(path: string): Promise<GitExportState> {
  return JSON.parse(await readFile(path, 'utf-8')) as GitExportState
}

// ==================== Public API ====================

/**
 * Read saved git state from disk.
 *
 * - Primary missing (ENOENT) → try the legacy path; still missing → `undefined`
 *   (a genuinely new account — unchanged behavior).
 * - Primary present but unreadable/unparseable → recover from `${primary}.bak`
 *   if it parses (quarantining the bad file aside, never deleting it); else
 *   throw `GitJournalCorruptError`. Never silently returns an empty journal.
 */
export async function loadGitState(accountId: string): Promise<GitExportState | undefined> {
  const primary = gitFilePath(accountId)

  try {
    return await readJsonState(primary)
  } catch (err) {
    if (!isENOENT(err)) {
      // Primary exists but is corrupt — try to recover before failing loud.
      return await recoverFromBackup(accountId, primary, err)
    }
    // Primary is absent — fall through to the legacy fallback.
  }

  const legacy = LEGACY_GIT_PATHS[accountId]
  if (legacy) {
    try {
      return await readJsonState(legacy)
    } catch (err) {
      if (isENOENT(err)) return undefined // no saved state anywhere → new account
      // A migrated account whose legacy journal is corrupt is the same hazard:
      // fail loud rather than boot with amnesia.
      throw new GitJournalCorruptError(accountId, legacy, { cause: err })
    }
  }
  return undefined
}

/**
 * Try `${primary}.bak`. If it parses, quarantine the corrupt primary aside
 * (never delete — an operator may want to inspect it) and return the recovered
 * state with a loud warning. If there is no usable backup, throw.
 */
async function recoverFromBackup(
  accountId: string,
  primary: string,
  primaryErr: unknown,
): Promise<GitExportState> {
  const backupPath = `${primary}.bak`
  let recovered: GitExportState
  try {
    recovered = await readJsonState(backupPath)
  } catch {
    // No `.bak`, or it is also corrupt — nothing safe to boot with.
    throw new GitJournalCorruptError(accountId, primary, { cause: primaryErr })
  }

  const quarantine = `${primary}.corrupt-${Date.now()}`
  await rename(primary, quarantine).catch(() => { /* best-effort; keep booting from .bak */ })
  console.error(
    `[trading] account "${accountId}": trade-commit journal was corrupt — recovered from ${backupPath}. ` +
    `Quarantined the bad file at ${quarantine} (not deleted; inspect if needed).`,
  )
  return recovered
}

/** Create a callback that persists git state to disk on each commit. */
export function createGitPersister(accountId: string): (state: GitExportState) => Promise<void> {
  const filePath = gitFilePath(accountId)
  return async (state: GitExportState) => {
    // Atomic + fsync + `.bak` sidecar: a crash mid-write can never truncate the
    // journal, and the sidecar is the recovery source for `loadGitState`.
    await writeFileAtomic(filePath, JSON.stringify(state, null, 2), { backup: true, fsync: true })
  }
}
