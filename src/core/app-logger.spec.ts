import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppLogger } from './app-logger.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'app-logger-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('createAppLogger', () => {
  it('filters records below the configured level', () => {
    const file = join(dir, 'lvl.log')
    const log = createAppLogger({ file, name: 't', level: 'warn', mirrorConsole: false })
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    const content = readFileSync(file, 'utf-8')
    expect(content).not.toContain('"msg":"d"')
    expect(content).not.toContain('"msg":"i"')
    expect(content).toContain('"msg":"w"')
    expect(content).toContain('"msg":"e"')
  })

  it('merges parent name + child bindings + per-call fields into each record', () => {
    const file = join(dir, 'child.log')
    const log = createAppLogger({ file, name: 'root', mirrorConsole: false })
    log.child({ reqId: 'abc' }).info('hi', { extra: 1 })
    const rec = JSON.parse(readFileSync(file, 'utf-8').trim().split('\n')[0]!)
    expect(rec).toMatchObject({ name: 'root', reqId: 'abc', extra: 1, msg: 'hi', level: 'info' })
    expect(typeof rec.ts).toBe('string')
  })

  it('serializes Error fields (name/message/stack)', () => {
    const file = join(dir, 'err.log')
    const log = createAppLogger({ file, name: 't', mirrorConsole: false })
    log.error('boom', { error: new Error('kaboom') })
    const rec = JSON.parse(readFileSync(file, 'utf-8').trim().split('\n')[0]!)
    expect(rec.error).toMatchObject({ name: 'Error', message: 'kaboom' })
    expect(typeof rec.error.stack).toBe('string')
  })

  it('event() always writes to the file, even above the level threshold', () => {
    const file = join(dir, 'ev.log')
    const log = createAppLogger({ file, name: 't', level: 'error', mirrorConsole: false })
    log.event('http', { status: 200 })
    const content = readFileSync(file, 'utf-8')
    expect(content).toContain('"msg":"http"')
    expect(content).toContain('"status":200')
  })

  it('rotates at maxBytes: shifts base → .1 → .2 and drops the oldest', () => {
    const file = join(dir, 'rot.log')
    // maxBytes tiny → every record after the first forces a rotation, so each
    // file holds exactly one line. keep=3 → base + .1 + .2 only.
    const log = createAppLogger({ file, name: 'rot', maxBytes: 1, keep: 3, mirrorConsole: false })
    for (let i = 0; i < 6; i++) log.info(`mark${i}`) // mark0..mark5

    // Newest at base, older shifted down, .3 never created.
    expect(readFileSync(file, 'utf-8')).toContain('"msg":"mark5"')
    expect(readFileSync(`${file}.1`, 'utf-8')).toContain('"msg":"mark4"')
    expect(readFileSync(`${file}.2`, 'utf-8')).toContain('"msg":"mark3"')
    expect(existsSync(`${file}.3`)).toBe(false)

    // The three oldest lines were dropped as the window slid forward.
    const all = [file, `${file}.1`, `${file}.2`].map((f) => readFileSync(f, 'utf-8')).join('')
    for (const dropped of ['mark0', 'mark1', 'mark2']) expect(all).not.toContain(`"msg":"${dropped}"`)
  })

  it('swallows sink failures without throwing (never takes down the caller)', () => {
    // Parent path is a regular file, so mkdirSync/openSync both fail — the
    // logger must degrade to a silent no-op, never throw into the trading path.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const badFile = join(blocker, 'nested', 'bad.log')
    const log = createAppLogger({ file: badFile, name: 't', mirrorConsole: false })
    expect(() => {
      log.info('should not throw')
      log.error('nor this', { error: new Error('x') })
      log.event('http', { status: 500 })
    }).not.toThrow()
    expect(existsSync(badFile)).toBe(false)
  })

  it('mirrors to stdout (info/debug) and stderr (warn/error) when mirrorConsole is true', () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const log = createAppLogger({ file: join(dir, 'm.log'), name: 't', mirrorConsole: true })
    log.info('hello')
    log.error('boom')
    expect(String(outSpy.mock.calls[0]?.[0])).toContain('"msg":"hello"')
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('"msg":"boom"')
  })

  it('does not touch the console when mirrorConsole is false', () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const log = createAppLogger({ file: join(dir, 'q.log'), name: 't', mirrorConsole: false })
    log.info('quiet')
    log.error('also quiet')
    expect(outSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })
})
