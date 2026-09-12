import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentSession, projectSessionDir } from '../session/store.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-store-'))
const origCwd = process.cwd()

before(() => process.chdir(tmp))
after(() => {
  process.chdir('/')
  fs.rmSync(tmp, { recursive: true, force: true })
  // bersihkan artefak sesi di ~/.topupsaja/projects/<hash>
  fs.rmSync(projectSessionDir(tmp), { recursive: true, force: true })
})

test('session: create → save → load roundtrip', () => {
  const s = AgentSession.create(tmp, 'ts/gpt-4.1-nano', 'SYSTEM')
  s.title = 'tes store'
  s.permissionMode = 'yolo'
  s.creditsUsed = 1234
  s.messages.push({ role: 'user', content: 'halo' })
  s.todos.set([{ content: 'langkah', status: 'pending' }])
  s.checkpoints['a.txt'] = { content: 'basel', at: new Date().toISOString() }
  const file = s.save()
  assert.ok(file, 'save harus mengembalikan path file')

  const loaded = AgentSession.load(tmp, s.id)
  assert.ok(loaded)
  assert.equal(loaded!.title, 'tes store')
  assert.equal(loaded!.model, 'ts/gpt-4.1-nano')
  assert.equal(loaded!.permissionMode, 'yolo')
  assert.equal(loaded!.creditsUsed, 1234)
  assert.equal(loaded!.messages.length, 2) // system + user
  assert.equal(loaded!.todos.items[0]?.content, 'langkah')
  assert.equal(loaded!.checkpoints['a.txt']?.content, 'basel')
})

test('session: load file yang tidak ada → null', () => {
  assert.equal(AgentSession.load(tmp, 'tidak-ada-999'), null)
})

test('session: noteUserMessage set judul sekali', () => {
  const s = AgentSession.create(tmp, 'm', 'S')
  s.noteUserMessage('  halo dunia  ')
  assert.equal(s.title, 'halo dunia')
  s.noteUserMessage('judul kedua')
  assert.equal(s.title, 'halo dunia') // tidak menimpa
})

test('session: roundtrip attached/docs/tokens/mode', () => {
  const s = AgentSession.create(tmp, 'ts/gpt-4.1-nano', 'SYSTEM')
  s.attached = [{ path: 'a.txt', content: 'isi a', added_at: new Date().toISOString() }]
  s.docs = [{ url: 'https://example.com', title: 'Contoh', content: 'teks', added_at: new Date().toISOString() }]
  s.tokensIn = 120
  s.tokensOut = 45
  s.lastBalance = 613_000
  s.mode = 'architect'
  s.save()

  const loaded = AgentSession.load(tmp, s.id)!
  assert.equal(loaded.mode, 'architect')
  assert.equal(loaded.tokensIn, 120)
  assert.equal(loaded.tokensOut, 45)
  assert.equal(loaded.lastBalance, 613_000)
  assert.equal(loaded.attached?.length, 1)
  assert.equal(loaded.attached?.[0].path, 'a.txt')
  assert.equal(loaded.docs?.length, 1)
  assert.equal(loaded.docs?.[0].url, 'https://example.com')
})

test('session: last_balance undefined → tidak ada di file', () => {
  const s = AgentSession.create(tmp, 'm', 'S')
  s.save()
  const raw = JSON.parse(fs.readFileSync(s.file()!, 'utf8'))
  assert.equal(raw.last_balance, undefined)
  const loaded = AgentSession.load(tmp, s.id)!
  assert.equal(loaded.lastBalance, undefined)
})
