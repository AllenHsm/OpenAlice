/**
 * Structured app-level logger with a rotating JSONL file sink.
 *
 * Generalizes `src/workspaces/logger.ts` (a module-level singleton bound to one
 * hard-coded file) into a factory: each `createAppLogger` call owns its own
 * file, level, and rotation state. Alice and UTA — and any subsystem that wants
 * a durable, grep-able trail — each keep a dedicated log under
 * `<OPENALICE_HOME>/logs/` without pulling in a heavyweight logging dependency.
 *
 * Design rules carried over from workspaces/logger.ts:
 *   - Zero dependencies — one JSON line per record, `Error` fields serialized.
 *   - The file sink must NEVER take down the caller. ALL fs errors are
 *     swallowed: a logging failure in the trading path is not an incident.
 *   - `mirrorConsole` (default true) keeps `pnpm dev` output present — the
 *     console.* calls this replaces still surface on stdout/stderr.
 *
 * Adds over workspaces/logger.ts: size-based rotation (`base.log` → `.1` → `.2`
 * …, oldest dropped) so an unattended long-running process can't fill the disk.
 *
 * Writes are synchronous (`writeSync` on a kept-open fd). This keeps rotation
 * correct and cross-platform — the fd is closed before the rename shuffle so
 * Windows (which refuses to rename an open file) works the same as POSIX — at
 * the cost of a blocking syscall per line, which is well within budget for
 * process-level operational logging.
 */

import {
  openSync, writeSync, closeSync, fstatSync, renameSync, rmSync, mkdirSync,
} from 'node:fs'
import { dirname } from 'node:path'

export type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface AppLoggerOptions {
  /** Absolute path to the base log file (e.g. `logsPath('uta.log')`). */
  file: string
  /** Logger name, attached as a binding to every record. */
  name: string
  /** Minimum level. Explicit value wins; else `$OPENALICE_LOG_LEVEL`; else `info`. */
  level?: Level
  /** Rotate before a write would push the base file past this size. Default 5 MiB. */
  maxBytes?: number
  /** Total files to keep: the base plus `keep - 1` rotated backups. Default 3. */
  keep?: number
  /** Also mirror records to stdout/stderr. Default true (dev UX). */
  mirrorConsole?: boolean
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  /**
   * Structured event record (e.g. an HTTP access log line). Always persisted to
   * the file regardless of level; surfaced on the console only at `debug` so
   * routine high-frequency events don't drown `pnpm dev`.
   */
  event(name: string, fields?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}

export function createAppLogger(options: AppLoggerOptions): Logger {
  const file = options.file
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
  const keep = Math.max(1, options.keep ?? 3)
  const mirrorConsole = options.mirrorConsole ?? true
  const levelName = (options.level ?? process.env['OPENALICE_LOG_LEVEL'] ?? 'info').toLowerCase()
  const minLevel: number = LEVELS[levelName as Level] ?? LEVELS.info

  let fd: number | null = null
  let bytesWritten = 0

  function open(): void {
    try {
      mkdirSync(dirname(file), { recursive: true })
      fd = openSync(file, 'a')
      // Seed the byte counter from the file already on disk (append mode) so a
      // restart doesn't ignore accumulated size.
      try { bytesWritten = fstatSync(fd).size } catch { bytesWritten = 0 }
    } catch {
      fd = null
    }
  }

  function rotate(): void {
    // Close, then shift base → .1 → … → .(keep-1), dropping the oldest, and
    // reopen a fresh base. rm each destination first: Windows' renameSync will
    // not overwrite an existing target, and POSIX is happy either way.
    try { if (fd !== null) closeSync(fd) } catch { /* swallow */ }
    fd = null
    for (let k = keep - 1; k >= 1; k--) {
      const src = k === 1 ? file : `${file}.${k - 1}`
      const dst = `${file}.${k}`
      try { rmSync(dst, { force: true }) } catch { /* swallow */ }
      try { renameSync(src, dst) } catch { /* swallow — src may not exist yet */ }
    }
    open()
  }

  function sink(line: string): void {
    if (fd === null) return
    const bytes = Buffer.byteLength(line)
    // Rotate before crossing the cap — but never rotate an empty base, so a
    // single oversized line writes through instead of looping forever.
    if (bytesWritten > 0 && bytesWritten + bytes > maxBytes) rotate()
    if (fd === null) return
    try { writeSync(fd, line); bytesWritten += bytes } catch { /* swallow */ }
  }

  function write(level: Level, msg: string, fields: Record<string, unknown>, toConsole: boolean): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }, replacer) + '\n'
    if (toConsole && mirrorConsole) {
      if (level === 'error' || level === 'warn') process.stderr.write(line)
      else process.stdout.write(line)
    }
    sink(line)
  }

  function emit(level: Level, msg: string, fields: Record<string, unknown>): void {
    if (LEVELS[level] < minLevel) return
    write(level, msg, fields, true)
  }

  function emitEvent(name: string, fields: Record<string, unknown>): void {
    // Always to file; console only at debug (keeps routine events off the dev
    // console while preserving the forensic trail).
    write('info', name, fields, minLevel <= LEVELS.debug)
  }

  function make(bindings: Record<string, unknown>): Logger {
    const merge = (fields?: Record<string, unknown>): Record<string, unknown> =>
      fields === undefined ? bindings : { ...bindings, ...fields }
    return {
      debug: (msg, fields) => emit('debug', msg, merge(fields)),
      info: (msg, fields) => emit('info', msg, merge(fields)),
      warn: (msg, fields) => emit('warn', msg, merge(fields)),
      error: (msg, fields) => emit('error', msg, merge(fields)),
      event: (name, fields) => emitEvent(name, merge(fields)),
      child: (extra) => make({ ...bindings, ...extra }),
    }
  }

  open()
  return make({ name: options.name })
}
