import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GitExportState } from './git/types.js'

/**
 * git-persistence resolves paths via `@/core/paths.js`, which captures
 * OPENALICE_HOME at import. Each test re-imports under a fresh temp home
 * (config-accounts.spec.ts pattern).
 */
let home: string
let savedHome: string | undefined

async function loadModule() {
  vi.resetModules()
  process.env['OPENALICE_HOME'] = home
  return await import('./git-persistence.js')
}

function commitPath(accountId: string): string {
  return join(home, 'data', 'trading', accountId, 'commit.json')
}

async function writeFileEnsured(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** Opaque-to-persistence JSON blob shaped like a git state, distinct per marker. */
function stateWith(marker: string): GitExportState {
  return { commits: [{ hash: marker }], head: marker } as unknown as GitExportState
}

beforeEach(async () => {
  savedHome = process.env['OPENALICE_HOME']
  home = await mkdtemp(join(tmpdir(), 'oa-git-persist-'))
})
afterEach(async () => {
  if (savedHome === undefined) delete process.env['OPENALICE_HOME']
  else process.env['OPENALICE_HOME'] = savedHome
  vi.resetModules()
  await rm(home, { recursive: true, force: true })
})

describe('git-persistence round-trip', () => {
  it('persist → load returns the same state', async () => {
    const mod = await loadModule()
    const state = stateWith('c1')
    await mod.createGitPersister('acct')(state)
    expect(await mod.loadGitState('acct')).toEqual(state)
  })

  it('persisting twice leaves a .bak holding the previous state', async () => {
    const mod = await loadModule()
    const persist = mod.createGitPersister('acct')
    await persist(stateWith('v1'))
    await persist(stateWith('v2'))
    expect(await mod.loadGitState('acct')).toEqual(stateWith('v2'))
    expect(JSON.parse(await readFile(`${commitPath('acct')}.bak`, 'utf-8'))).toEqual(stateWith('v1'))
  })
})

describe('git-persistence loud-fail read', () => {
  it('ENOENT (new account, no legacy) → undefined', async () => {
    const mod = await loadModule()
    expect(await mod.loadGitState('brand-new-acct')).toBeUndefined()
  })

  it('torn primary + valid .bak → recovers from .bak and quarantines the bad file', async () => {
    await writeFileEnsured(commitPath('acct'), 'not valid json {{{')
    await writeFileEnsured(`${commitPath('acct')}.bak`, JSON.stringify(stateWith('good')))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mod = await loadModule()

    expect(await mod.loadGitState('acct')).toEqual(stateWith('good'))

    const entries = await readdir(dirname(commitPath('acct')))
    expect(entries).not.toContain('commit.json') // corrupt primary renamed aside
    expect(entries.some((e) => e.startsWith('commit.json.corrupt-'))).toBe(true) // quarantined, not deleted
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('torn primary + no .bak → throws GitJournalCorruptError carrying accountId + path', async () => {
    await writeFileEnsured(commitPath('acct'), 'not valid json {{{')
    const mod = await loadModule()
    await expect(mod.loadGitState('acct')).rejects.toBeInstanceOf(mod.GitJournalCorruptError)
    await expect(mod.loadGitState('acct')).rejects.toMatchObject({
      accountId: 'acct',
      path: commitPath('acct'),
      name: 'GitJournalCorruptError',
    })
  })

  it('primary ENOENT → falls back to the legacy path when present', async () => {
    // alpaca-paper's legacy journal lives at data/securities-trading/commit.json.
    await writeFileEnsured(join(home, 'data', 'securities-trading', 'commit.json'), JSON.stringify(stateWith('legacy')))
    const mod = await loadModule()
    expect(await mod.loadGitState('alpaca-paper')).toEqual(stateWith('legacy'))
  })
})
