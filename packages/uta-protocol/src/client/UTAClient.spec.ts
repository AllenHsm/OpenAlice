import { describe, it, expect } from 'vitest'
import { createUTAClient, UTAHttpError } from './UTAClient.js'

/** Capture the RequestInit the client hands to fetch so we can assert headers. */
function recordingFetch(response: Response): { fetch: typeof globalThis.fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return response
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers as Record<string, string> | undefined
  return h?.[name]
}

describe('createUTAClient — x-request-id correlation seam', () => {
  it('mints an x-request-id header when the caller supplies none', async () => {
    const { fetch, calls } = recordingFetch(new Response('{"ok":true}', { status: 200 }))
    const client = createUTAClient({ baseUrl: 'http://127.0.0.1:47333', fetch })
    await client.get('/api/trading/utas')
    const id = headerOf(calls[0]?.init, 'x-request-id')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reuses a caller-supplied requestId (Alice→UTA correlation)', async () => {
    const { fetch, calls } = recordingFetch(new Response('{"ok":true}', { status: 200 }))
    const client = createUTAClient({ baseUrl: 'http://127.0.0.1:47333', fetch })
    await client.request('GET', '/api/trading/utas', { requestId: 'corr-abc' })
    expect(headerOf(calls[0]?.init, 'x-request-id')).toBe('corr-abc')
  })

  it('threads the requestId onto UTAHttpError (field + message) on non-2xx', async () => {
    const { fetch } = recordingFetch(new Response('{"error":"boom"}', { status: 500 }))
    const client = createUTAClient({ baseUrl: 'http://127.0.0.1:47333', fetch })
    const err = await client.request('POST', '/api/trading/x', { requestId: 'corr-xyz' }).catch((e) => e)
    expect(err).toBeInstanceOf(UTAHttpError)
    expect((err as UTAHttpError).requestId).toBe('corr-xyz')
    expect((err as UTAHttpError).status).toBe(500)
    expect((err as Error).message).toContain('boom')
    expect((err as Error).message).toContain('x-request-id: corr-xyz')
  })
})
