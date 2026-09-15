import { getApiKey, getBaseUrl } from './config.js'

export interface ModelInfo {
  id: string
  owned_by: string
  context_window: number | null
  pricing: { input: number; output: number; cache: number; unit: string }
  tier: string
  supports_vision?: boolean
}

export interface Credits {
  balance: number
  api_key_id: number
  usage_today: {
    requests: number
    credits_used: number
    prompt_tokens: number
    completion_tokens: number
  }
}

export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

/** Bagian konten multimodal (vision): teks atau gambar base64 data-URL. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** Delta tool_calls dalam streaming (OpenAI format). */
export interface ToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

export interface ChatResponse {
  choices: {
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: ToolCall[]
    }
    finish_reason: string
  }[]
  usage?: Usage
}

/** Error API dengan status + pesan ramah-user (Bahasa Indonesia). */
export class ApiError extends Error {
  status: number
  type: string
  /** Delay dari header Retry-After (ms), bila ada. */
  retryAfterMs?: number

  constructor(status: number, message: string, type = 'api_error', retryAfterMs?: number) {
    super(message)
    this.status = status
    this.type = type
    this.retryAfterMs = retryAfterMs
  }
}

function headers(apiKey: string | undefined): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey ?? ''}`,
    'Content-Type': 'application/json',
  }
}

async function parseError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => ({}))
  const msg: string = body?.error?.message ?? body?.error ?? `HTTP ${res.status}`
  const type: string = body?.error?.type ?? 'api_error'

  const ra = Number(res.headers.get('retry-after'))
  const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined

  const friendly: Record<number, string> = {
    401: 'API key tidak valid atau dicabut. Perbarui key: /api <key_baru> (buat key di dashboard web).',
    402: msg, // pesan dari server sudah berisi URL top-up
    403: 'Akun atau API key dinonaktifkan.',
    404: `Model tidak tersedia. ${msg}`,
    429: `Rate limit tercapai. ${msg}`,
    503: 'Server sedang maintenance. Cek status.topupsaja.com',
  }
  return new ApiError(res.status, friendly[res.status] ?? msg, type, retryAfterMs)
}

const HTTP_TIMEOUT_MS = 120_000

// ── Retry / backoff ──────────────────────────────────────────────
// Retry: network error, timeout, 429, 5xx (≤3 retry, 1s/2s/4s + jitter,
// hormati Retry-After). No-retry: 400/401/402/403/404/422 & abort user.
const RETRY_DELAYS_MS = [1000, 2000, 4000]
const MAX_RETRIES = 3

export function isRetryableError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500
  const name = (err as Error | undefined)?.name
  return name === 'TypeError' || name === 'TimeoutError' // fetch failed / timeout
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface RetryOptions {
  signal?: AbortSignal
  /** Dipanggil sebelum menunggu antar percobaan. */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void
}

/** Jalankan fn dengan retry network/429/5xx. Abort user (signal) tidak di-retry. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const aborted = opts.signal?.aborted || (err as Error)?.name === 'AbortError'
      if (aborted || !isRetryableError(err) || attempt >= MAX_RETRIES) throw err
      const delay =
        err instanceof ApiError && err.retryAfterMs
          ? err.retryAfterMs
          : RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] + Math.floor(Math.random() * 250)
      opts.onRetry?.(attempt + 1, err, delay)
      await sleep(delay, opts.signal)
    }
  }
}

async function apiGet<T>(path_: string, opts: RetryOptions = {}): Promise<T> {
  const base = await getBaseUrl()
  const key = await getApiKey()
  const res = await withRetry(async () => {
    const r = await fetch(`${base}${path_}`, {
      headers: headers(key),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!r.ok) throw await parseError(r)
    return r
  }, opts)
  return (await res.json()) as T
}

export function listModels(): Promise<{ object: string; data: ModelInfo[] }> {
  return apiGet('/v1/models')
}

/** Daftar model aktif saja (helper dipakai CLI & TUI). */
export async function fetchModels(): Promise<ModelInfo[]> {
  const res = await listModels()
  return res.data
}

export function getCredits(): Promise<Credits> {
  return apiGet('/v1/credits')
}

export interface VerifyResult {
  ok: boolean
  email: string
  api_key_id: number
  balance: number
}

/**
 * GET /api/v1/auth/verify — validasi kandidat API key (Bearer param, bukan key
 * global). Dipakai `/api <key>` dan `tsa login` supaya satu jalur verifikasi.
 */
export async function verifyKey(key?: string, opts: RetryOptions = {}): Promise<VerifyResult> {
  const candidate = key ?? (await getApiKey())
  const base = await getBaseUrl()
  const res = await withRetry(async () => {
    const r = await fetch(`${base}/api/v1/auth/verify`, {
      headers: {
        Authorization: `Bearer ${candidate ?? ''}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!r.ok) throw await parseError(r)
    return r
  }, opts)
  return (await res.json()) as VerifyResult
}

export interface ChatResult {
  data: ChatResponse
  creditsUsed?: number
  balance?: number
}

/**
 * POST /v1/chat/completions (non-streaming).
 * Dipakai sebagai fallback streaming dan untuk call ringkasan compaction.
 * Header X-Credits-Used / X-Credits-Remaining dari server ikut dikembalikan.
 */
export async function chatCompletion(
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {}
): Promise<ChatResult> {
  const base = await getBaseUrl()
  const key = await getApiKey()
  const res = await withRetry(async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify({ ...body, stream: false }),
      signal: opts.signal
        ? AbortSignal.any([AbortSignal.timeout(HTTP_TIMEOUT_MS), opts.signal])
        : AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!r.ok) throw await parseError(r)
    return r
  }, { signal: opts.signal })
  const data = (await res.json()) as ChatResponse
  const used = res.headers.get('x-credits-used')
  const remaining = res.headers.get('x-credits-remaining')
  return {
    data,
    creditsUsed: used !== null ? Number(used) : undefined,
    balance: remaining !== null ? Number(remaining) : undefined,
  }
}

export interface StreamCallbacks {
  onDelta?: (text: string) => void
  onCredits?: (info: { credits_used: number; balance: number }) => void
}

export interface StreamResult {
  content: string
  toolCalls: ToolCall[]
  usage?: Usage
  creditsUsed?: number
  balance?: number
}

interface ToolCallPart {
  id: string
  name: string
  args: string
}

/** Gabungkan bagian tool_calls delta per index menjadi ToolCall utuh. */
function assembleToolCalls(parts: Map<number, ToolCallPart>): ToolCall[] {
  return [...parts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, p]) => ({
      id: p.id || `call_${i}`,
      type: 'function' as const,
      function: { name: p.name, arguments: p.args || '{}' },
    }))
}

/**
 * POST /v1/chat/completions streaming universal (SSE) — untuk turn teks maupun
 * turn ber-tools. Delta `tool_calls` diakumulasi per index (id/name/arguments
 * di-concat). Retry hanya sebelum chunk valid pertama; bila stream gagal
 * sebelum chunk valid pertama, ulangi sekali non-stream. `opts.signal`
 * (mis. Esc user) meng-abort fetch — mid-stream abort melempar AbortError.
 */
export async function streamChat(
  body: Record<string, unknown>,
  cb: StreamCallbacks = {},
  opts: { signal?: AbortSignal } = {}
): Promise<StreamResult> {
  let receivedAny = false
  let res: Response
  const base = await getBaseUrl()
  const key = await getApiKey()
  try {
    res = await withRetry(
      () =>
        fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: headers(key),
          body: JSON.stringify({ ...body, stream: true }),
          signal: opts.signal
            ? AbortSignal.any([AbortSignal.timeout(HTTP_TIMEOUT_MS), opts.signal])
            : AbortSignal.timeout(HTTP_TIMEOUT_MS),
        }),
      { signal: opts.signal }
    )
    if (!res.ok) throw await parseError(res)
    if (!res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const err = new Error('bukan-sse')
      ;(err as Error & { notSSE?: boolean }).notSSE = true
      throw err
    }
  } catch (err) {
    // Abort user tidak pernah jatuh ke fallback non-stream.
    if (opts.signal?.aborted || (err as Error).name === 'AbortError') throw err
    // Fallback non-stream sekali (fetch error / HTTP error / bukan SSE).
    return fallbackNonStream(body, cb, opts.signal)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let usage: Usage | undefined
  let creditsUsed: number | undefined
  let balance: number | undefined
  const parts = new Map<number, ToolCallPart>()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const payload = trimmed.slice(6).trim()
        if (payload === '[DONE]') continue
        let chunk: Record<string, unknown> & {
          choices?: { delta?: { content?: string | null; tool_calls?: ToolCallDelta[] } }[]
          usage?: Usage
          error?: { message?: string; type?: string }
          credits_used?: number
          balance?: number
        }
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue // JSON parsial — abaikan
        }
        receivedAny = true
        if (chunk.credits_used !== undefined) {
          creditsUsed = Number(chunk.credits_used)
          balance = Number(chunk.balance ?? 0)
          cb.onCredits?.({ credits_used: creditsUsed, balance: balance ?? 0 })
          continue
        }
        if (chunk.error) {
          throw new ApiError(500, chunk.error.message ?? 'Upstream error', chunk.error.type)
        }
        if (chunk.usage) usage = chunk.usage
        const delta = chunk.choices?.[0]?.delta
        if (typeof delta?.content === 'string' && delta.content) {
          content += delta.content
          cb.onDelta?.(delta.content)
        }
        if (delta?.tool_calls?.length) {
          for (const tc of delta.tool_calls) {
            const p = parts.get(tc.index) ?? { id: '', name: '', args: '' }
            if (tc.id) p.id = p.id ? p.id : tc.id
            if (tc.function?.name) p.name += tc.function.name
            if (tc.function?.arguments) p.args += tc.function.arguments
            parts.set(tc.index, p)
          }
        }
      }
    }
  } catch (err) {
    // Abort user → lempar apa adanya (loop tangkap sebagai AbortError).
    throw err
  }

  return {
    content,
    toolCalls: assembleToolCalls(parts),
    usage,
    creditsUsed,
    balance,
  }
}

/** Fallback non-stream bila stream gagal sebelum chunk pertama. */
async function fallbackNonStream(
  body: Record<string, unknown>,
  cb: StreamCallbacks,
  signal?: AbortSignal
): Promise<StreamResult> {
  const r = await chatCompletion(body, { signal })
  const msg = r.data.choices?.[0]?.message
  const content = msg?.content ?? ''
  if (content) cb.onDelta?.(content)
  return {
    content,
    toolCalls: msg?.tool_calls ?? [],
    usage: r.data.usage,
    creditsUsed: r.creditsUsed,
    balance: r.balance,
  }
}
