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

describe('createUTAClient — service-auth headers', () => {
  it('sends the actor tag (x-alice-actor) when configured', async () => {
    const { fetch, calls } = recordingFetch(new Response('{"ok":true}', { status: 200 }))
    const client = createUTAClient({ baseUrl: 'http://127.0.0.1:47333', fetch, actor: 'agent' })
    await client.post('/api/trading/uta/x/wallet/push')
    expect(headerOf(calls[0]?.init, 'x-alice-actor')).toBe('agent')
  })

  it('sends Authorization: Bearer <token> from the authToken provider', async () => {
    const { fetch, calls } = recordingFetch(new Response('{"ok":true}', { status: 200 }))
    const client = createUTAClient({ baseUrl: 'http://127.0.0.1:47333', fetch, authToken: () => 'tok-123' })
    await client.post('/api/trading/uta/x/wallet/push')
    expect(headerOf(calls[0]?.init, 'authorization')).toBe('Bearer tok-123')
  })

  it('omits the Authorization header when the provider yields no token', async () => {
    const { fetch, calls } = recordingFetch(new Response('{"ok":true}', { status: 200 }))
    const client = createUTAClient({ baseUrl: 'http://127.0.0.1:47333', fetch, authToken: () => undefined })
    await client.post('/api/trading/uta/x/wallet/push')
    expect(headerOf(calls[0]?.init, 'authorization')).toBeUndefined()
  })

  it('self-heals a rotated token: on 401 it re-resolves with forceReload and retries once', async () => {
    const responses = [
      new Response('{"error":"Unauthorized"}', { status: 401 }),
      new Response('{"ok":true}', { status: 200 }),
    ]
    const calls: Array<{ init?: RequestInit }> = []
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init })
      return responses[calls.length - 1]
    }) as unknown as typeof globalThis.fetch

    const seen: Array<boolean | undefined> = []
    const authToken = (o?: { forceReload?: boolean }) => {
      seen.push(o?.forceReload)
      return o?.forceReload ? 'fresh-token' : 'stale-token'
    }

    const client = createUTAClient({ baseUrl: 'http://127.0.0.1:47333', fetch, authToken })
    const result = await client.post<{ ok: boolean }>('/api/trading/uta/x/wallet/push')

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(2)
    // First attempt: stale token. Retry: forceReload → fresh token.
    expect(headerOf(calls[0]?.init, 'authorization')).toBe('Bearer stale-token')
    expect(headerOf(calls[1]?.init, 'authorization')).toBe('Bearer fresh-token')
    expect(seen).toEqual([false, true])
  })

  it('does NOT retry a 401 when no authToken is configured', async () => {
    const calls: Array<{ init?: RequestInit }> = []
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init })
      return new Response('{"error":"nope"}', { status: 401 })
    }) as unknown as typeof globalThis.fetch
    const client = createUTAClient({ baseUrl: 'http://127.0.0.1:47333', fetch })
    await client.post('/api/trading/uta/x/wallet/push').catch(() => undefined)
    expect(calls).toHaveLength(1)
  })

  it('gives up after a single retry (persistent 401 throws)', async () => {
    const calls: Array<{ init?: RequestInit }> = []
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init })
      return new Response('{"error":"still bad"}', { status: 401 })
    }) as unknown as typeof globalThis.fetch
    const client = createUTAClient({ baseUrl: 'http://127.0.0.1:47333', fetch, authToken: () => 'x' })
    const err = await client.post('/api/trading/uta/x/wallet/push').catch((e) => e)
    expect(err).toBeInstanceOf(UTAHttpError)
    expect((err as UTAHttpError).status).toBe(401)
    expect(calls).toHaveLength(2) // original + one retry, then give up
  })
})
