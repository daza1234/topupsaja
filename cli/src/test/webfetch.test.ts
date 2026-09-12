import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webFetch } from '../agent/exec.js'

function htmlResponse(html: string, status = 200, ctype = 'text/html; charset=utf-8'): Response {
  return new Response(html, { status, headers: { 'content-type': ctype } })
}

test('web_fetch: HTML → strip jadi teks', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () =>
    htmlResponse(
      '<html><head><script>evil()</script></head><body><h1>Judul</h1><p>Halo &amp; hai</p><a href="#">link</a></body></html>'
    )) as typeof fetch
  try {
    const r = await webFetch({ url: 'https://example.com/docs' })
    assert.equal(r.ok, true)
    assert.match(r.output, /Judul/)
    assert.match(r.output, /Halo & hai/)
    assert.doesNotMatch(r.output, /<|evil/)
  } finally {
    globalThis.fetch = orig
  }
})

test('web_fetch: JSON polos diteruskan tanpa strip', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () =>
    htmlResponse('{"a": 1, "b": "<tag>"}', 200, 'application/json')) as typeof fetch
  try {
    const r = await webFetch({ url: 'https://example.com/api.json' })
    assert.equal(r.ok, true)
    assert.ok(r.output.includes('{"a": 1, "b": "<tag>"}'))
  } finally {
    globalThis.fetch = orig
  }
})

test('web_fetch: HTTP 500 → err', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () => htmlResponse('boom', 500)) as typeof fetch
  try {
    const r = await webFetch({ url: 'https://example.com/' })
    assert.equal(r.ok, false)
    assert.match(r.output, /HTTP 500/)
  } finally {
    globalThis.fetch = orig
  }
})

test('web_fetch: network error → err', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  try {
    const r = await webFetch({ url: 'https://example.com/' })
    assert.equal(r.ok, false)
    assert.match(r.output, /Gagal fetch/)
  } finally {
    globalThis.fetch = orig
  }
})

test('web_fetch: bukan http/https → err tanpa fetch', async () => {
  const orig = globalThis.fetch
  let called = 0
  globalThis.fetch = (async () => {
    called++
    return htmlResponse('x')
  }) as typeof fetch
  try {
    const r = await webFetch({ url: 'ftp://example.com/x' })
    assert.equal(r.ok, false)
    assert.equal(called, 0)
  } finally {
    globalThis.fetch = orig
  }
})

test('web_fetch: cap dipotong dengan penanda', async () => {
  const orig = globalThis.fetch
  const big = 'x'.repeat(30_000)
  globalThis.fetch = (async () => htmlResponse(`<p>${big}</p>`, 200, 'text/plain')) as typeof fetch
  try {
    const r = await webFetch({ url: 'https://example.com/big' }, 5000)
    assert.equal(r.ok, true)
    assert.ok(r.output.length < 6000)
    assert.match(r.output, /dipotong 5000 char/)
  } finally {
    globalThis.fetch = orig
  }
})

test('web_fetch: content-type binari → ditolak', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () => htmlResponse('\x00\x01', 200, 'application/octet-stream')) as typeof fetch
  try {
    const r = await webFetch({ url: 'https://example.com/blob' })
    assert.equal(r.ok, false)
    assert.match(r.output, /bukan teks/)
  } finally {
    globalThis.fetch = orig
  }
})
