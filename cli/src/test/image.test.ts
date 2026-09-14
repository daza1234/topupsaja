import '../bootstrap.js'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeImagePart, isImagePath, attachPath } from '@topupsaja/core/session/context.js'
import { messagesTokens } from '@topupsaja/core/session/compaction.js'
import { addPathMessage } from '../usage.js'
import { AgentSession } from '@topupsaja/core/session/store.js'
import { AskUserManager, type AgentRuntime } from '@topupsaja/core/agent/runtime.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-image-'))
const origCwd = process.cwd()

// PNG 1x1 transparan (bukan validasi isi — cukup bytes untuk base64).
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

before(() => {
  process.chdir(tmp)
  fs.writeFileSync(path.join(tmp, 'foto.png'), PNG_1PX)
  fs.writeFileSync(path.join(tmp, 'gambar.JPG'), PNG_1PX)
  fs.writeFileSync(path.join(tmp, 'dokumen.txt'), 'teks biasa')
  fs.writeFileSync(path.join(tmp, 'besar.png'), Buffer.alloc(5_000_001, 7))
})

after(() => {
  process.chdir('/')
  fs.rmSync(tmp, { recursive: true, force: true })
})

function fakeRt(session: AgentSession, supportsVision?: boolean): AgentRuntime {
  return {
    cwd: tmp,
    session,
    permissions: {} as AgentRuntime['permissions'],
    emitter: {} as AgentRuntime['emitter'],
    mode: 'code',
    models: [
      {
        id: 'ts/gpt-4.1-nano',
        owned_by: 'openai',
        context_window: 1_000_000,
        pricing: { input: 1, output: 2, cache: 0, unit: 'credits/token' },
        tier: 'hemat',
        supports_vision: supportsVision,
      },
    ],
    abort: false,
    abortController: null,
    checkpointTurns: [],
    turnSnapshots: [],
    customModes: [],
    mcp: [],
    askUser: new AskUserManager(),
  }
}

test('isImagePath: ekstensi gambar dikenali, non-gambar ditolak', async () => {
  assert.ok(isImagePath('a.png'))
  assert.ok(isImagePath('sub/dir/foto.JPG'))
  assert.ok(isImagePath('a.webp'))
  assert.ok(!isImagePath('a.txt'))
  assert.ok(!isImagePath('a.ts'))
  assert.ok(!isImagePath('tanpaekstensi'))
})

test('encodeImagePart: mime map + base64 data-URL', async () => {
  const part = await encodeImagePart(path.join(tmp, 'foto.png'))
  assert.ok(part)
  assert.equal(part!.type, 'image_url')
  assert.ok(part!.type === 'image_url' && part!.image_url.url.startsWith('data:image/png;base64,'))
  const b64 = part!.type === 'image_url' ? part!.image_url.url.split(',')[1] : ''
  assert.equal(Buffer.from(b64, 'base64').length, PNG_1PX.length)

  const jpg = await encodeImagePart(path.join(tmp, 'gambar.JPG'))
  assert.ok(jpg && jpg.type === 'image_url' && jpg.image_url.url.startsWith('data:image/jpeg;base64,'))
  assert.equal(await encodeImagePart(path.join(tmp, 'dokumen.txt')), null, '.txt bukan gambar yang bisa di-encode')
})

test('encodeImagePart: file >5MB → null, file hilang → null', async () => {
  assert.equal(await encodeImagePart(path.join(tmp, 'besar.png')), null)
  assert.equal(await encodeImagePart(path.join(tmp, 'hilang.png')), null)
})

test('messagesTokens: content parts dihitung (text + konstanta image)', async () => {
  const msgs = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'abcd' }, { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,xxx' } }] },
  ]
  // 4 (text) + 1200 (image) + 4 (role) + 8 = 1216 char → 304 token
  assert.equal(messagesTokens(msgs), 304)
  assert.equal(messagesTokens([{ role: 'user', content: 'abcd' }]), 4)
})

test('store: roundtrip pesan content-parts', async () => {
  const s = AgentSession.create(tmp, 'ts/gpt-4.1-nano', 'SYSTEM')
  s.messages.push({
    role: 'user',
    content: [{ type: 'text', text: '[gambar] foto.png' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }],
  })
  await s.save()
  const loaded = (await AgentSession.load(tmp, s.id))!
  const c = loaded.messages[1].content
  assert.ok(Array.isArray(c))
  assert.equal(c[0].type, 'text')
  assert.equal(c[1].type, 'image_url')
})

test('addPathMessage: model non-vision → blok, model vision → user message one-shot', async () => {
  const blocked = AgentSession.create(tmp, 'ts/gpt-4.1-nano', 'SYSTEM')
  const msg1 = await addPathMessage(fakeRt(blocked, false), 'foto.png')
  assert.ok(msg1.includes('tidak mendukung vision'))
  assert.ok(msg1.includes('/model'))
  assert.equal(blocked.messages.length, 1, 'tidak ada pesan baru')

  const allowed = AgentSession.create(tmp, 'ts/gpt-4.1-nano', 'SYSTEM')
  const msg2 = await addPathMessage(fakeRt(allowed, true), 'foto.png')
  assert.ok(msg2.includes('Gambar dilampirkan: foto.png'))
  assert.ok(msg2.includes('KB'))
  const pushed = allowed.messages[1]
  assert.equal(pushed.role, 'user')
  assert.ok(Array.isArray(pushed.content))
  assert.equal(pushed.content[0].type === 'text' && pushed.content[0].text, '[gambar] foto.png')
  assert.equal(pushed.content[1].type, 'image_url')

  const unknown = AgentSession.create(tmp, 'model-lain', 'SYSTEM')
  const msg3 = await addPathMessage(fakeRt(unknown, undefined), 'foto.png')
  assert.ok(msg3.includes('Gambar dilampirkan'), 'model tak dikenal di-scan vision=false → diizinkan')
})

test('attachPath: gambar tidak masuk attached (konteks), teks tetap masuk', async () => {
  const s = AgentSession.create(tmp, 'ts/gpt-4.1-nano', 'SYSTEM')
  await attachPath(s, tmp, 'foto.png')
  assert.equal(s.attached.length, 0)
  await attachPath(s, tmp, 'dokumen.txt')
  assert.equal(s.attached.length, 1)
})
