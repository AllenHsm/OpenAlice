import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir, stat, mkdir } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './fs-atomic.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oa-fs-atomic-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('writes the file and creates missing parent dirs (happy path)', async () => {
    const target = join(dir, 'nested', 'deep', 'state.json')
    await writeFileAtomic(target, '{"a":1}')
    expect(await readFile(target, 'utf-8')).toBe('{"a":1}')
  })

  it('leaves no .tmp files behind on success', async () => {
    const target = join(dir, 'state.json')
    await writeFileAtomic(target, 'hello')
    const entries = await readdir(dir)
    expect(entries).toEqual(['state.json'])
  })

  it('applies the requested mode to the final file', async () => {
    if (platform() === 'win32') return // POSIX mode bits are meaningless on win32
    const target = join(dir, 'secret.json')
    await writeFileAtomic(target, 'sealed', { mode: 0o600 })
    const st = await stat(target)
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('backup:true copies the prior file to .bak before overwriting', async () => {
    const target = join(dir, 'journal.json')
    await writeFileAtomic(target, 'v1') // first write — no prior file to back up
    await writeFileAtomic(target, 'v2', { backup: true })
    expect(await readFile(target, 'utf-8')).toBe('v2')
    expect(await readFile(`${target}.bak`, 'utf-8')).toBe('v1') // .bak holds the pre-overwrite content
  })

  it('backup:true on a first write is a no-op (no prior file, no error)', async () => {
    const target = join(dir, 'fresh.json')
    await writeFileAtomic(target, 'only', { backup: true })
    expect(await readFile(target, 'utf-8')).toBe('only')
    await expect(stat(`${target}.bak`)).rejects.toThrow() // no .bak created for a first write
  })

  it('cleans up the temp file and rethrows when the rename fails', async () => {
    // Force the rename to fail: rename(file → existing directory) errors on
    // every platform, exercising the catch/unlink path.
    const target = join(dir, 'target-is-a-dir')
    await mkdir(target)
    await expect(writeFileAtomic(target, 'data')).rejects.toThrow()
    const entries = await readdir(dir)
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]) // temp cleaned up
  })

  it('two concurrent writers never leave a torn file — final content is one complete write', async () => {
    const target = join(dir, 'contended.json')
    // Distinct large payloads: a torn/interleaved write would fail JSON.parse
    // and would not equal either input exactly.
    const a = JSON.stringify({ writer: 'A', payload: 'x'.repeat(50_000) })
    const b = JSON.stringify({ writer: 'B', payload: 'y'.repeat(50_000) })
    await Promise.all([
      writeFileAtomic(target, a, { fsync: true }),
      writeFileAtomic(target, b, { fsync: true }),
    ])
    const final = await readFile(target, 'utf-8')
    expect([a, b]).toContain(final) // exactly one complete payload, never a mix
    expect(['A', 'B']).toContain((JSON.parse(final) as { writer: string }).writer) // parses cleanly
    const entries = await readdir(dir)
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]) // both temps consumed
  })
})
