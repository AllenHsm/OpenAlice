/**
 * UTA client SDK — HTTP transport from Alice to the UTA service.
 *
 * `createUTAClient({ baseUrl })` returns a low-level HTTP helper. Higher-
 * level adapters (`UTAManagerSDK`, `UTAAccountSDK` in
 * `src/services/uta-client/`) layer typed domain operations on top.
 *
 * Errors are normalized into JS Errors. Future iterations may add zod-
 * validation per endpoint and `WireBrokerError` round-trip for typed
 * downstream error handling in the AI tool layer.
 */

import { randomUUID } from 'node:crypto'

export interface UTAClientOptions {
  /** UTA service base URL, e.g. `http://127.0.0.1:47333`. */
  baseUrl: string
  /** Optional fetch override (for testing). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch
  /** Request timeout in ms. Default 15s. */
  timeoutMs?: number
  /**
   * Bearer-token provider for the Alice ↔ UTA auth boundary. Called per
   * request; the impl is expected to memoize so this is cheap. When the UTA
   * service answers 401, the client re-invokes with `{ forceReload: true }`
   * and retries ONCE, so a rotated token self-heals without a restart.
   * Omit to send no `authorization` header (local dev with auth disabled).
   */
  authToken?: (opts?: { forceReload?: boolean }) => string | undefined | Promise<string | undefined>
  /**
   * Actor tag sent as `x-alice-actor`, consumed by UTA's in-process policy
   * gate. Alice's agent path sends `'agent'`; the human-approval BFF proxy
   * overrides to `'user'` on its own (it does not use this client).
   */
  actor?: 'agent' | 'user'
}

export interface UTAClient {
  readonly baseUrl: string
  request<T = unknown>(method: string, path: string, opts?: RequestOpts): Promise<T>
  get<T = unknown>(path: string, params?: Record<string, string | number | undefined>): Promise<T>
  post<T = unknown>(path: string, body?: unknown): Promise<T>
  put<T = unknown>(path: string, body?: unknown): Promise<T>
  delete<T = unknown>(path: string): Promise<T>
}

export interface RequestOpts {
  body?: unknown
  params?: Record<string, string | number | undefined>
  signal?: AbortSignal
  /** Correlation id to thread onto the request as `x-request-id`. When omitted,
   *  the client mints one so every Alice→UTA call is traceable end to end. */
  requestId?: string
}

export class UTAHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
    /** `x-request-id` correlating this failure with the UTA-side access log. */
    public readonly requestId?: string,
  ) {
    super(requestId ? `${message} [x-request-id: ${requestId}]` : message)
    this.name = 'UTAHttpError'
  }
}

export function createUTAClient(options: UTAClientOptions): UTAClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15_000

  function buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }
    return url.toString()
  }

  /** Build the per-request header set: content-type + the Alice→UTA
   *  correlation id, plus (when configured) the actor tag and bearer token.
   *  `forceReload` re-resolves the token on the 401 self-heal retry. */
  async function buildHeaders(requestId: string, forceReload: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-request-id': requestId }
    if (options.actor) headers['x-alice-actor'] = options.actor
    if (options.authToken) {
      const token = await options.authToken({ forceReload })
      if (token) headers['authorization'] = `Bearer ${token}`
    }
    return headers
  }

  async function request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    const url = buildUrl(path, opts.params)
    // Correlation id: reuse a caller-supplied id or mint one. This is the single
    // header-injection seam for Alice→UTA — the auth/actor headers ride the
    // same object rather than threading new arguments through every caller.
    const requestId = opts.requestId ?? randomUUID()

    const send = async (forceReload: boolean): Promise<Response> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const signal = opts.signal ?? controller.signal
      const init: RequestInit = {
        method,
        headers: await buildHeaders(requestId, forceReload),
        signal,
      }
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
      try {
        return await fetchImpl(url, init)
      } finally {
        clearTimeout(timer)
      }
    }

    let res = await send(false)
    // Self-heal a rotated service token: on 401, drop the memoized token,
    // re-resolve from env/disk, and retry exactly once. Bounded to one retry
    // so a genuinely-wrong token surfaces as an error rather than looping.
    if (res.status === 401 && options.authToken) {
      await res.text().catch(() => { /* drain the discarded 401 body */ })
      res = await send(true)
    }

    const text = await res.text()
    const body = text ? safeJSON(text) : undefined
    if (!res.ok) {
      const msg = typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : `UTA ${method} ${path} returned ${res.status}`
      throw new UTAHttpError(res.status, body, msg, requestId)
    }
    return body as T
  }

  return {
    baseUrl,
    request,
    get: <T>(path: string, params?: Record<string, string | number | undefined>) =>
      request<T>('GET', path, { params }),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
    delete: <T>(path: string) => request<T>('DELETE', path),
  }
}

function safeJSON(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}
