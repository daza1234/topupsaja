import '../bootstrap.js'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSystemPrompt, isReadOnlyMode, resolveModeArg, ALL_MODES, MODE_ALIASES } from '@topupsaja/core/agent/modes.js'
import type { Mode } from '@topupsaja/core/agent/modes.js'
import { AgentSession, projectSessionDir, normalizeMode } from '@topupsaja/core/session/store.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-modes-'))
const origCwd = process.cwd()

before(() => process.chdir(tmp))
after(() => {
  process.chdir('/')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(projectSessionDir(tmp), { recursive: true, force: true })
})

test('MODE_ALIASES: plan→architect, act→code, identitas lainnya', async () => {
  assert.equal(MODE_ALIASES['plan'], 'architect')
  assert.equal(MODE_ALIASES['act'], 'code')
  for (const m of ALL_MODES) assert.equal(MODE_ALIASES[m], m)
})

test('resolveModeArg: case-insensitive, unknown → null', async () => {
  assert.equal(resolveModeArg('PLAN'), 'architect')
  assert.equal(resolveModeArg(' Ask '), 'ask')
  assert.equal(resolveModeArg('test'), 'test')
  assert.equal(resolveModeArg('kode'), null)
  assert.equal(resolveModeArg(''), null)
})

test('isReadOnlyMode: architect & ask read-only', async () => {
  assert.equal(isReadOnlyMode('architect'), true)
  assert.equal(isReadOnlyMode('ask'), true)
  assert.equal(isReadOnlyMode('code'), false)
  assert.equal(isReadOnlyMode('test'), false)
})

test('modeSection: masing-masing mode punya seksi di system prompt', async () => {
  const arch = await buildSystemPrompt(tmp, 'architect')
  assert.ok(arch.includes('MODE ARCHITECT'), 'architect harus punya seksi ARCHITECT')
  assert.ok(arch.includes('/code'), 'architect menyarankan /code')

  const ask = await buildSystemPrompt(tmp, 'ask')
  assert.ok(ask.includes('MODE ASK'), 'ask harus punya seksi ASK')
  assert.ok(!ask.includes('rencana langkah-langkah bernomor'), 'ask tanpa kewajiban rencana')

  const testMode = await buildSystemPrompt(tmp, 'test')
  assert.ok(testMode.includes('MODE TEST'), 'test harus punya seksi TEST')
  assert.ok(testMode.includes('test runner'), 'test menyebut deteksi test runner')

  const code = await buildSystemPrompt(tmp, 'code')
  assert.ok(!code.includes('MODE ARCHITECT'))
  assert.ok(!code.includes('MODE ASK'))
  assert.ok(!code.includes('MODE TEST'))
})

test('normalizeMode: back-compat plan/act + fallback code', async () => {
  assert.equal(normalizeMode('plan'), 'architect')
  assert.equal(normalizeMode('act'), 'code')
  assert.equal(normalizeMode('ask'), 'ask')
  assert.equal(normalizeMode('aneh'), 'code')
  assert.equal(normalizeMode(undefined), 'code')
})

test('load(): sesi lama tersimpan plan/act dimap ke architect/code', async () => {
  const s = AgentSession.create(tmp, 'ts/gpt-4.1-nano', 'SYSTEM')
  await s.save()
  const file = path.join(projectSessionDir(tmp), `${s.id}.json`)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>

  raw.mode = 'plan'
  fs.writeFileSync(file, JSON.stringify(raw))
  assert.equal((await AgentSession.load(tmp, s.id))!.mode, 'architect')

  raw.mode = 'act'
  fs.writeFileSync(file, JSON.stringify(raw))
  assert.equal((await AgentSession.load(tmp, s.id))!.mode, 'code')

  // Mode baru tidak berubah.
  raw.mode = 'test' as unknown as Mode
  fs.writeFileSync(file, JSON.stringify(raw))
  assert.equal((await AgentSession.load(tmp, s.id))!.mode, 'test')
})
