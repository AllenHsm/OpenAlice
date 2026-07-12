import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createRequestLog } from './request-log.js'
import type { Logger } from '@/core/app-logger.js'

/** Minimal Logger stub that records `event()` calls. */
function stubLogger(): { log: Logger; events: Array<{ name: string; fields?: Record<string, unknown> }> } {
  const events: Array<{ name: string; fields?: Record<string, unknown> }> = []
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    event: vi.fn((name: string, fields?: Record<string, unknown>) => { events.push({ name, fields }) }),
    child: vi.fn(() => log),
  } as unknown as Logger
  return { log, events }
}

describe('createRequestLog', () => {
  it('mints an x-request-id, echoes it, and emits one http event with timing', async () => {
    const { log, events } = stubLogger()
    const app = new Hono()
    app.use('*', createRequestLog(log))
    app.get('/ping', (c) => c.text('pong'))

    const res = await app.request('/ping')
    const id = res.headers.get('x-request-id')

    expect(id).toBeTruthy()
    expect(events).toHaveLength(1)
    expect(events[0]!.name).toBe('http')
    expect(events[0]!.fields).toMatchObject({ reqId: id, method: 'GET', path: '/ping', status: 200 })
    expect(typeof events[0]!.fields?.ms).toBe('number')
  })

  it('propagates an inbound x-request-id (Alice→UTA correlation)', async () => {
    const { log, events } = stubLogger()
    const app = new Hono()
    app.use('*', createRequestLog(log))
    app.get('/ping', (c) => c.text('pong'))

    const res = await app.request('/ping', { headers: { 'x-request-id': 'corr-123' } })

    expect(res.headers.get('x-request-id')).toBe('corr-123')
    expect(events[0]!.fields).toMatchObject({ reqId: 'corr-123' })
  })

  it('still emits an event when the handler throws', async () => {
    const { log, events } = stubLogger()
    const app = new Hono()
    app.use('*', createRequestLog(log))
    app.get('/boom', () => { throw new Error('kaboom') })
    app.onError((_e, c) => c.text('err', 500))

    const res = await app.request('/boom')

    expect(res.status).toBe(500)
    expect(events).toHaveLength(1)
    expect(events[0]!.fields).toMatchObject({ path: '/boom' })
  })
})
