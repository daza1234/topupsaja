import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  attachPath,
  detachPath,
  stripHtml,
  decodeEntities,
  buildAttachmentContext,
  syncContextMessage,
  CONTEXT_MESSAGE_PREFIX,
  normRel,
} from '../session/context.js'
import { AgentSession, projectSessionDir } from '../session/store.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-attach-'))
const origCwd = process.cwd()

before(() => {
  process.chdir(tmp)
  fs.writeFileSync(path.join(tmp, 'visible.txt'), 'isi visible\n')
  fs.writeFileSync(path.join(tmp, 'foto.png'), 'bukan-beneran-png')
  fs.mkdirSync(path.join(tmp, 'docs'))
  for (let i = 1; i <= 25; i++) {
    fs.writeFileSync(path.join(tmp, 'docs', `f${String(i).padStart(2, '0')}.txt`), `konten ${i}\n`)
  }
})
after(() => {
  process.chdir('/')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(projectSessionDir(tmp), { recursive: true, force: true })
})

function newSession(): AgentSession {
  return AgentSession.create(tmp, 'ts/gpt-4.1-nano', 'SYSTEM')
}

test('attachPath: file langsung masuk attached dengan isi', () => {
  const s = newSession()
  const r = attachPath(s, tmp, 'visible.txt')
  assert.ok(r.ok)
  assert.equal(s.attached.length, 1)
  assert.equal(s.attached[0].path, 'visible.txt')
  assert.ok(s.attached[0].content.includes('isi visible'))
})

test('attachPath: folder expand hormati .gitignore, cap 20 file', () => {
  const s = newSession()
  const r = attachPath(s, tmp, 'docs')
  assert.ok(r.ok)
  assert.equal(s.attached.length, 20, 'harus ter-cap 20 file')
  assert.ok(r.message.includes('20 file'))

  // .gitignore: folder docs2 diabaikan.
  fs.mkdirSync(path.join(tmp, 'docs2'))
  fs.writeFileSync(path.join(tmp, 'docs2', 'rahasia.txt'), 'x')
  fs.writeFileSync(path.join(tmp, '.gitignore'), 'docs2/\n')
  const s2 = newSession()
  const r2 = attachPath(s2, tmp, 'docs2')
  assert.ok(!r2.ok, 'folder yang di-gitignore harus kosong')
})

test('attachPath: gambar → sinyal image (bukan konteks), file hilang error', () => {
  const s = newSession()
  const img = attachPath(s, tmp, 'foto.png')
  assert.ok(img.ok)
  assert.ok(img.image, 'harus ada sinyal image')
  assert.equal(img.image!.path, 'foto.png')
  assert.equal(img.image!.part.type, 'image_url')
  assert.ok(img.image!.part.image_url.url.startsWith('data:image/png;base64,'))
  assert.equal(s.attached.length, 0, 'gambar tidak masuk attached')

  const missing = attachPath(s, tmp, 'tidak-ada.txt')
  assert.ok(!missing.ok)
  assert.ok(missing.message.includes('Tidak ditemukan'))
})

test('attachPath: lampir ulang path sama → replace (tidak duplikat)', () => {
  const s = newSession()
  attachPath(s, tmp, 'visible.txt')
  fs.writeFileSync(path.join(tmp, 'visible.txt'), 'isi baru\n')
  attachPath(s, tmp, 'visible.txt')
  assert.equal(s.attached.length, 1)
  assert.ok(s.attached[0].content.includes('isi baru'))
})

test('detachPath: per path & all', () => {
  const s = newSession()
  attachPath(s, tmp, 'visible.txt')
  const r = detachPath(s, tmp, 'visible.txt')
  assert.ok(r.ok)
  assert.equal(s.attached.length, 0)
  assert.ok(!detachPath(s, tmp, 'visible.txt').ok, 'detach ulang → tidak ada')

  attachPath(s, tmp, 'visible.txt')
  s.docs.push({ url: 'https://x', title: 'x', content: 'c', added_at: new Date().toISOString() })
  const all = detachPath(s, tmp, 'all')
  assert.ok(all.ok)
  assert.equal(s.attached.length, 0)
  assert.equal(s.docs.length, 0)
})

test('normRel: ./ dan absolut dinormalisasi', () => {
  assert.equal(normRel(tmp, './visible.txt'), 'visible.txt')
  assert.equal(normRel(tmp, path.join(tmp, 'visible.txt')), 'visible.txt')
})

test('stripHtml + decodeEntities: tag dibuang, entity diterjemahkan', () => {
  const html = `<html><head><style>p{}</style><script>evil()</script></head>
<body><!-- komentar --><h1>Judul</h1><p>Dua &amp; tiga &#39;kutip&#39; &#x27; lagi</p><br><p>Baris bawah</p></body></html>`
  const text = stripHtml(html)
  assert.ok(!text.includes('<p>'))
  assert.ok(!text.includes('evil()'))
  assert.ok(!text.includes('p{}'))
  assert.ok(text.includes('Judul'))
  assert.ok(text.includes("Dua & tiga 'kutip' ' lagi"))
  assert.ok(decodeEntities('&lt;x&gt;&nbsp;&mdash;') === '<x> —')
})

test('buildAttachmentContext: gabung file+doc, item terbaru diprioritaskan saat melebihi cap', () => {
  const big = 'x'.repeat(25_000)
  const a: { path: string; content: string; added_at: string }[] = [
    { path: 'lama.txt', content: big, added_at: '2026-01-01T00:00:00Z' },
    { path: 'baru.txt', content: big, added_at: '2026-02-01T00:00:00Z' },
  ]
  const d = [{ url: 'https://d', title: 'd', content: big, added_at: '2026-03-01T00:00:00Z' }]
  const block = buildAttachmentContext(a as never, d as never)
  assert.ok(block)
  assert.ok(block!.text.startsWith(CONTEXT_MESSAGE_PREFIX))
  assert.ok(block!.text.includes('https://d'), 'terbaru (doc) harus masuk')
  assert.ok(block!.text.includes('baru.txt'), 'kedua terbaru masuk (total 50k ≤ 60k)')
  assert.ok(!block!.text.includes('lama.txt'), 'terlama harus gugur (75k > 60k)')
  assert.equal(block!.dropped, 1)
})

test('syncContextMessage: idempotent — dua kali panggilan tetap satu message', () => {
  const s = newSession()
  attachPath(s, tmp, 'visible.txt')
  syncContextMessage(s)
  const len1 = s.messages.length
  syncContextMessage(s)
  assert.equal(s.messages.length, len1, 'tidak boleh nambah duplikat')
  assert.equal(s.messages.length, 2, 'system + konteks')
  assert.ok(typeof s.messages[1].content === 'string' && s.messages[1].content.startsWith(CONTEXT_MESSAGE_PREFIX))

  // Roundtrip save/load lalu sync lagi — tetap satu.
  s.save()
  const loaded = AgentSession.load(tmp, s.id)!
  syncContextMessage(loaded)
  assert.equal(
    loaded.messages.filter((m) => typeof m.content === 'string' && m.content.startsWith(CONTEXT_MESSAGE_PREFIX)).length,
    1
  )
})

test('syncContextMessage: tanpa lampiran → message konteks dihapus', () => {
  const s = newSession()
  attachPath(s, tmp, 'visible.txt')
  syncContextMessage(s)
  detachPath(s, tmp, 'all')
  syncContextMessage(s)
  assert.equal(s.messages.length, 1, 'konteks harus terhapus')
})
