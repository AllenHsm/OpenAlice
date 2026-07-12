/**
 * Tests for the Alice↔UTA service-token bootstrap.
 *
 * The token resolves env → file, is created race-safely (wx exclusive create
 * so two concurrent boots converge on one secret), and is memoized per
 * process with a forceReload escape hatch.
 *
 * `paths.ts` captures OPENALICE_HOME at import time, so each test stubs the
 * env and re-imports the module (vi.resetModules) to get a fresh home + fresh
 * in-process memo.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

type TokenModule = typeof import('./uta-service-token.js')

async function freshHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'uta-token-'))
}

async function loadModule(home: string, envToken?: string): Promise<TokenModule> {
  vi.stubEnv('OPENALICE_HOME', home)
  vi.stubEnv('OPENALICE_UTA_TOKEN', envToken ?? '')
  vi.resetModules()
  return import('./uta-service-token.js')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('loadOrCreateUTAServiceToken', () => {
  it('creates a token file (64-char hex) when none exists', async () => {
    const home = await freshHome()
    const mod = await loadModule(home)
    const token = await mod.loadOrCreateUTAServiceToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    // Persisted beside sealing.key at the home root, NOT under data/.
    expect(mod.utaServiceTokenPath()).toBe(resolve(home, 'uta-service.token'))
    const onDisk = (await readFile(mod.utaServiceTokenPath(), 'utf-8')).trim()
    expect(onDisk).toBe(token)
  })

  it('is idempotent — a second call returns the same token', async () => {
    const home = await freshHome()
    const mod = await loadModule(home)
    const a = await mod.loadOrCreateUTAServiceToken()
    const b = await mod.loadOrCreateUTAServiceToken()
    expect(a).toBe(b)
  })

  it('adopts an existing file token instead of overwriting it', async () => {
    const home = await freshHome()
    await mkdir(home, { recursive: true })
    await writeFile(resolve(home, 'uta-service.token'), 'preexisting-token-value')
    const mod = await loadModule(home)
    expect(await mod.loadOrCreateUTAServiceToken()).toBe('preexisting-token-value')
  })

  it('bootstrap race: two concurrent loadOrCreate calls converge on ONE token', async () => {
    const home = await freshHome()
    const mod = await loadModule(home)
    // Genuine filesystem race — both start before either has written; the
    // wx-exclusive create + EEXIST re-read must make them agree.
    const [a, b] = await Promise.all([
      mod.loadOrCreateUTAServiceToken(),
      mod.loadOrCreateUTAServiceToken(),
    ])
    expect(a).toBe(b)
    const onDisk = (await readFile(mod.utaServiceTokenPath(), 'utf-8')).trim()
    expect(onDisk).toBe(a)
  })
})

describe('readUTAServiceToken', () => {
  it('returns undefined when neither env nor file is present', async () => {
    const home = await freshHome()
    const mod = await loadModule(home)
    expect(await mod.readUTAServiceToken()).toBeUndefined()
  })

  it('env OPENALICE_UTA_TOKEN takes precedence over the file', async () => {
    const home = await freshHome()
    await mkdir(home, { recursive: true })
    await writeFile(resolve(home, 'uta-service.token'), 'file-token')
    const mod = await loadModule(home, 'env-token-wins')
    expect(await mod.readUTAServiceToken()).toBe('env-token-wins')
  })

  it('reads a token created by loadOrCreate (shared file source)', async () => {
    const home = await freshHome()
    const mod = await loadModule(home)
    const created = await mod.loadOrCreateUTAServiceToken()
    // Fresh memo, same file → same token.
    mod.__resetUTAServiceTokenCacheForTests()
    expect(await mod.readUTAServiceToken({ forceReload: true })).toBe(created)
  })
})
