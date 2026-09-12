import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  discoverCustomModes,
  buildSystemPrompt,
  isReadOnlyMode,
  resolveModeArg,
  modeNotice,
  type CustomMode,
} from '../agent/modes.js'
import { normalizeMode } from '../session/store.js'
import { runFormatter, readFile, executeTool } from '../agent/exec.js'
import { messagesTokens } from '../session/compaction.js'
import { TodoStore } from '../storage/todo.js'
import { mapPromptArgs, flattenPromptMessages, type McpPromptDef } from '../mcp/client.js'
import { AskUserManager, type AgentRuntime } from '../agent/runtime.js'
import { AgentSession } from '../session/store.js'

// ── discoverCustomModes ──
test('discoverCustomModes: frontmatter desc + read_only, non-md diabaikan', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-cmodes-'))
  fs.mkdirSync(path.join(tmp, '.tsa', 'modes'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, '.tsa', 'modes', 'reviewer.md'),
    '---\ndescription: Review kode\nread_only: true\n---\nPeriksa perubahan dengan teliti.'
  )
  fs.writeFileSync(
    path.join(tmp, '.tsa', 'modes', 'writer.md'),
    '---\ndescription: Menulis konten\nread_only: false\n---\nTulis konten kreatif.'
  )
  fs.writeFileSync(
    path.join(tmp, '.tsa', 'modes', 'plain.md'),
    'Tanpa frontmatter'
  )
  fs.writeFileSync(path.join(tmp, '.tsa', 'modes', 'notes.txt'), 'bukan mode')

  const modes = discoverCustomModes(tmp)
  const reviewer = modes.find((m) => m.name === 'reviewer')
  assert.ok(reviewer, 'reviewer harus ditemukan')
  assert.equal(reviewer!.description, 'Review kode')
  assert.equal(reviewer!.readOnly, true)
  assert.ok(reviewer!.body.includes('Periksa perubahan'))

  const writer = modes.find((m) => m.name === 'writer')
  assert.ok(writer)
  assert.equal(writer!.readOnly, false)

  const plain = modes.find((m) => m.name === 'plain')
  assert.ok(plain, 'mode tanpa frontmatter tetap terbaca')
  assert.equal(plain!.description, '')
  assert.equal(plain!.readOnly, false)
  assert.equal(modes.find((m) => m.name === 'notes'), undefined, '.txt diabaikan')

  after(() => fs.rmSync(tmp, { recursive: true, force: true }))
})

test('discoverCustomModes: nama file di-lowercase, dir tanpa .md → kosong', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-cmodes2-'))
  fs.mkdirSync(path.join(tmp, '.tsa', 'modes'), { recursive: true })
  fs.writeFileSync(path.join(tmp, '.tsa', 'modes', 'DeepThink.md'), 'mikir dalam')
  assert.equal(discoverCustomModes(tmp)[0].name, 'deepthink')
  assert.deepEqual(discoverCustomModes(os.tmpdir() + '/pasti-tidak-ada-xyz'), [])
  after(() => fs.rmSync(tmp, { recursive: true, force: true }))
})

// ── isReadOnlyMode / resolveModeArg / modeNotice dengan custom ──
const CM: CustomMode[] = [
  { name: 'reviewer', description: 'Review kode', body: 'Periksa.', readOnly: true },
  { name: 'writer', description: 'Menulis', body: 'Tulis.', readOnly: false },
]

test('isReadOnlyMode: custom readOnly → true, non-readOnly → false', () => {
  assert.equal(isReadOnlyMode('reviewer', CM), true)
  assert.equal(isReadOnlyMode('writer', CM), false)
  assert.equal(isReadOnlyMode('architect'), true)
  assert.equal(isReadOnlyMode('code'), false)
  assert.equal(isReadOnlyMode('tidakada', CM), false)
})

test('resolveModeArg: nama custom diterima, case-insensitive; unknown → null', () => {
  assert.equal(resolveModeArg('REVIEWER', CM), 'reviewer')
  assert.equal(resolveModeArg(' writer ', CM), 'writer')
  assert.equal(resolveModeArg('plan'), 'architect')
  assert.equal(resolveModeArg('gakada', CM), null)
})

test('modeNotice: custom dirangkai dari description + readOnly', () => {
  const n = modeNotice('reviewer', CM)
  assert.ok(n.includes('REVIEWER'))
  assert.ok(n.includes('Review kode'))
  assert.ok(n.includes('read-only'))
  assert.ok(modeNotice('code').includes('CODE'))
})

// ── buildSystemPrompt custom ──
test('buildSystemPrompt: custom section muncul; readOnly → aturan read-only', () => {
  const p1 = buildSystemPrompt(os.tmpdir(), 'reviewer', CM)
  assert.ok(p1.includes('MODE REVIEWER AKTIF'))
  assert.ok(p1.includes('Periksa.'))
  assert.ok(p1.includes('AKAN DITOLAK'))
  assert.ok(p1.includes('BUKAN sandbox'))

  const p2 = buildSystemPrompt(os.tmpdir(), 'writer', CM)
  assert.ok(p2.includes('MODE WRITER AKTIF'))
  assert.ok(!p2.includes('AKAN DITOLAK'), 'non-readOnly tanpa blok read-only')

  // builtin tetap jalan dengan daftar custom diisi
  const p3 = buildSystemPrompt(os.tmpdir(), 'architect', CM)
  assert.ok(p3.includes('MODE ARCHITECT'))
  // mode tak dikenal (tanpa custom) → tanpa section mode
  const p4 = buildSystemPrompt(os.tmpdir(), 'modehilang', [])
  assert.ok(!p4.includes('AKTIF (mode kustom'))
})

// ── normalizeMode dengan custom ──
test('normalizeMode: mode custom valid disimpan, unknown → code, plan/act tetap dipetakan', () => {
  assert.equal(normalizeMode('reviewer', CM), 'reviewer')
  assert.equal(normalizeMode('writer', CM), 'writer')
  assert.equal(normalizeMode('aneh', CM), 'code')
  assert.equal(normalizeMode('architect', CM), 'architect')
  assert.equal(normalizeMode('plan'), 'architect')
  assert.equal(normalizeMode(undefined), 'code')
})

// ── runFormatter ──
test('runFormatter: command mengubah file tmp (sed)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-fmt-'))
  const file = path.join(tmp, 'a.txt')
  fs.writeFileSync(file, 'halo\n')
  const r = await runFormatter(`sed -i 's/halo/HI/' {file}`, tmp, 'a.txt')
  assert.ok(r.ok, `harus ok: ${r.output}`)
  assert.equal(fs.readFileSync(file, 'utf8'), 'HI\n')
  after(() => fs.rmSync(tmp, { recursive: true, force: true }))
})

test('runFormatter: exit ≠ 0 → err dengan output, file tetap utuh', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-fmt2-'))
  const file = path.join(tmp, 'b.txt')
  fs.writeFileSync(file, 'utuh\n')
  const r = await runFormatter(`echo "boom" && exit 3`, tmp, 'b.txt')
  assert.equal(r.ok, false)
  assert.ok(r.output.includes('exit 3'))
  assert.ok(r.output.includes('boom'))
  assert.equal(fs.readFileSync(file, 'utf8'), 'utuh\n')
  after(() => fs.rmSync(tmp, { recursive: true, force: true }))
})

test('runFormatter: {file} jadi path absolut', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-fmt3-'))
  const r = await runFormatter(`cat {file}`, tmp, 'x.txt')
  // file tidak ada — cat gagal, path absolut terlihat di stderr
  assert.equal(r.ok, false)
  assert.ok(r.output.includes(path.join(tmp, 'x.txt')), 'path absolut disubstitusi')
  after(() => fs.rmSync(tmp, { recursive: true, force: true }))
})

// ── MCP prompts: mapPromptArgs + flattenPromptMessages ──
test('mapPromptArgs: positional → nama argumen, sisa digabung ke terakhir, missing → kosong', () => {
  const prompt: McpPromptDef = {
    name: 'hello',
    arguments: [{ name: 'target' }, { name: 'message' }],
  }
  assert.deepEqual(mapPromptArgs(prompt, 'budi halo semuanya'), { target: 'budi', message: 'halo semuanya' })
  assert.deepEqual(mapPromptArgs(prompt, 'budi'), { target: 'budi', message: '' })
  assert.deepEqual(mapPromptArgs(prompt, ''), { target: '', message: '' })
  assert.deepEqual(mapPromptArgs(undefined, 'x y z'), {})
  const single: McpPromptDef = { name: 'one', arguments: [{ name: 'a' }] }
  assert.deepEqual(mapPromptArgs(single, 'satu dua tiga'), { a: 'satu dua tiga' })
})

test('flattenPromptMessages: gabung text, prefix [role] untuk non-user', () => {
  const res = {
    messages: [
      { role: 'user', content: { type: 'text', text: 'Review ini:' } },
      { role: 'assistant', content: { type: 'text', text: 'Saya akan membantu.' } },
    ],
  }
  const out = flattenPromptMessages(res)
  assert.ok(out.startsWith('Review ini:'))
  assert.ok(out.includes('[assistant] Saya akan membantu.'))
  assert.ok(!out.includes('[user]'))
  assert.equal(flattenPromptMessages(undefined), '')
  assert.equal(flattenPromptMessages({ messages: [] }), '')
})

// ── read_file gambar (vision) ──
const IMG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-rfimg-'))
fs.writeFileSync(
  path.join(IMG_DIR, 'kecil.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
)
fs.writeFileSync(path.join(IMG_DIR, 'besar.png'), Buffer.alloc(5_000_001, 7))
fs.writeFileSync(path.join(IMG_DIR, 'teks.txt'), 'biasa')

function fakeRt(supportsVision?: boolean): AgentRuntime {
  const session = AgentSession.create(IMG_DIR, 'ts/model-x', 'SYSTEM')
  return {
    cwd: IMG_DIR,
    session,
    permissions: {} as AgentRuntime['permissions'],
    emitter: { emit: () => {} } as unknown as AgentRuntime['emitter'],
    mode: 'code',
    models: [
      {
        id: 'ts/model-x',
        owned_by: 'x',
        context_window: 100_000,
        pricing: { input: 1, output: 1, cache: 0, unit: 'credits/token' },
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

test('readFile: gambar → ok + image part + output [gambar]; offset/limit diabaikan', () => {
  process.chdir(IMG_DIR)
  const r = readFile({ path: 'kecil.png', offset: 5, limit: 10 })
  assert.ok(r.ok, r.output)
  assert.ok(r.image, 'image part terisi')
  assert.ok(r.image!.type === 'image_url' && r.image!.image_url.url.startsWith('data:image/png;base64,'))
  assert.ok(r.output.includes('[gambar] kecil.png'))
  assert.ok(r.output.includes('KB'))
})

test('readFile: gambar >5MB → err; file teks tetap path lama', () => {
  process.chdir(IMG_DIR)
  const big = readFile({ path: 'besar.png' })
  assert.equal(big.ok, false)
  assert.ok(big.output.includes('>5MB'))

  const txt = readFile({ path: 'teks.txt' })
  assert.ok(txt.ok)
  assert.ok(!txt.image, 'file teks tanpa image part')
  assert.ok(txt.output.includes('1:'))
})

test('executeTool read_file: model non-vision → err pesan vision; vision → lolos', async () => {
  process.chdir(IMG_DIR)
  const rt = fakeRt(false)
  const denied = await executeTool('read_file', { path: 'kecil.png' }, { todos: new TodoStore(), rt })
  assert.equal(denied.ok, false)
  assert.ok(denied.output.includes('tidak mendukung vision'))
  assert.ok(denied.output.includes('ts/model-x'))
  assert.ok(denied.output.includes('/model'))

  const allowed = await executeTool('read_file', { path: 'kecil.png' }, { todos: new TodoStore(), rt: fakeRt(true) })
  assert.ok(allowed.ok)
  assert.ok(allowed.image)

  const unknown = await executeTool('read_file', { path: 'kecil.png' }, { todos: new TodoStore(), rt: fakeRt(undefined) })
  assert.ok(unknown.ok, 'supports_vision undefined (unknown) → diizinkan')
})

test('messagesTokens: tool message content parts > text-only (sanity parts-aware)', () => {
  const imgPart = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,xxx' } }
  const withParts = [
    { role: 'assistant' as const, content: null, tool_calls: [{ id: 't1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"kecil.png"}' } }] },
    { role: 'tool' as const, tool_call_id: 't1', content: [{ type: 'text' as const, text: '[gambar] kecil.png' }, imgPart] },
  ]
  const textOnly = [
    { role: 'assistant' as const, content: null, tool_calls: [{ id: 't1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"kecil.png"}' } }] },
    { role: 'tool' as const, tool_call_id: 't1', content: '[gambar] kecil.png' },
  ]
  assert.ok(messagesTokens(withParts) > messagesTokens(textOnly))
})

after(() => {
  process.chdir('/')
  fs.rmSync(IMG_DIR, { recursive: true, force: true })
})
