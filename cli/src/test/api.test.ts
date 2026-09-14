import '../bootstrap.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamChat, withRetry, isRetryableError, ApiError } from '@topupsaja/core/api.js'

// Env minimal agar config module tidak error.
process.env.TOPUPSAJA_API_KEY = process.env.TOPUPSAJA_API_KEY ?? 'sk-ts-test'
process.env.TOPUPSAJA_API_URL = 'http://localhost:59999'

function sseResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function sse(chunks: Record<string, unknown>[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
}

test('streamChat: parse delta + usage + credits event', async () => {
  const origFetch = globalThis.fetch
  let sawDelta = ''
  globalThis.fetch = (async () =>
    sseResponse(
      sse([
        { choices: [{ delta: { content: 'Halo ' } }] },
        { choices: [{ delta: { content: 'dunia' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
        { credits_used: 777, balance: 9999 },
      ])
    )) as typeof fetch
  try {
    const r = await streamChat({ model: 'm', messages: [] }, { onDelta: (t) => (sawDelta += t) })
    assert.equal(r.content, 'Halo dunia')
    assert.equal(sawDelta, 'Halo dunia')
    assert.equal(r.usage?.prompt_tokens, 10)
    assert.equal(r.creditsUsed, 777)
    assert.equal(r.balance, 9999)
    assert.equal(r.toolCalls.length, 0)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('streamChat: delta tool_calls ter-akumulasi per index', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    sseResponse(
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write', arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
      ])
    )) as typeof fetch
  try {
    const r = await streamChat({ model: 'm', messages: [] })
    assert.equal(r.toolCalls.length, 1)
    assert.equal(r.toolCalls[0].id, 'call_1')
    assert.equal(r.toolCalls[0].function.name, 'write')
    assert.equal(r.toolCalls[0].function.arguments, '{"path":"a.txt"}')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('streamChat: HTTP error sebelum chunk → fallback non-stream', async () => {
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls === 1) return sseResponse('err', 500) // stream gagal
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fallback ok' }, finish_reason: 'stop' }], usage: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }) as typeof fetch
  try {
    const r = await streamChat({ model: 'm', messages: [] })
    assert.equal(r.content, 'fallback ok')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('streamChat: fallback ikut retry 5xx sebelum sukses', async () => {
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls <= 2) return new Response('{"error":{"message":"boom"}}', { status: 502 })
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok setelah retry' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }) as typeof fetch
  try {
    const r = await streamChat({ model: 'm', messages: [] })
    assert.equal(r.content, 'ok setelah retry')
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('withRetry: tidak me-retry error klien 4xx', async () => {
  let calls = 0
  const fn = async () => {
    calls++
    throw new ApiError(402, 'saldo habis')
  }
  await assert.rejects(() => withRetry(fn), /saldo habis/)
  assert.equal(calls, 1)
})

test('isRetryableError: 429/5xx/network ya, 4xx tidak', () => {
  assert.equal(isRetryableError(new ApiError(429, 'x')), true)
  assert.equal(isRetryableError(new ApiError(502, 'x')), true)
  assert.equal(isRetryableError(new ApiError(402, 'x')), false)
  assert.equal(isRetryableError(new ApiError(404, 'x')), false)
  assert.equal(isRetryableError(new TypeError('fetch failed')), true)
})
