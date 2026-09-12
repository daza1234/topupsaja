import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAskUserTool } from '../agent/loop.js'
import { installPrintAskUserGuard } from '../ui/plain.js'
import { AskUserManager, AgentEmitter, type AgentRuntime } from '../agent/runtime.js'
import { AgentSession } from '../session/store.js'
import { PermissionManager } from '../agent/permission.js'
import { TOOL_SCHEMAS } from '../agent/tools.js'
import { READ_ONLY, READ_ONLY_SCHEMAS } from '../agent/subagent.js'

const CWD = '/tmp'

function fakeRt(): AgentRuntime {
  return {
    cwd: CWD,
    session: AgentSession.create(CWD, 'ts/model-x', 'SYSTEM'),
    permissions: new PermissionManager('ask'),
    emitter: new AgentEmitter(),
    askUser: new AskUserManager(),
    mode: 'code',
    models: [],
    abort: false,
    abortController: null,
    checkpointTurns: [],
    turnSnapshots: [],
    customModes: [],
    mcp: [],
  }
}

const OPTS = [
  { label: 'Prisma', description: 'ORM lengkap, migrasi bawaan' },
  { label: 'Drizzle', description: 'Ringan, SQL-first' },
  { label: 'Sequelize' },
]

test('ask_user: pilih opsi → output label + deskripsi, event request/result ter-emit', async () => {
  const rt = fakeRt()
  const requests: unknown[] = []
  const results: unknown[] = []
  const offs = [
    rt.emitter.on('ask_user_request', (req) => {
      requests.push(req)
      rt.askUser.answer(req.id, { kind: 'option', label: 'Prisma' })
    }),
    rt.emitter.on('ask_user_result', (res) => results.push(res)),
  ]
  const r = await runAskUserTool(rt, { question: 'ORM apa yang mau dipakai?', options: OPTS })
  offs.forEach((off) => off())
  assert.equal(r.ok, true)
  assert.ok(r.output.includes('Jawaban user: Prisma'))
  assert.ok(r.output.includes('ORM lengkap, migrasi bawaan'))
  assert.equal(requests.length, 1)
  assert.equal(results.length, 1)
})

test('ask_user: pilih opsi tanpa deskripsi → label saja', async () => {
  const rt = fakeRt()
  rt.emitter.on('ask_user_request', (req) => rt.askUser.answer(req.id, { kind: 'option', label: 'Sequelize' }))
  const r = await runAskUserTool(rt, { question: 'ORM?', options: OPTS })
  assert.ok(r.output.includes('Jawaban user: Sequelize'))
  assert.ok(!r.output.includes('undefined'))
})

test('ask_user: free text → output teks user', async () => {
  const rt = fakeRt()
  rt.emitter.on('ask_user_request', (req) => rt.askUser.answer(req.id, { kind: 'text', text: 'pakai raw SQL saja' }))
  const r = await runAskUserTool(rt, { question: 'ORM?', options: OPTS })
  assert.equal(r.ok, true)
  assert.ok(r.output.includes('Jawaban user: pakai raw SQL saja'))
})

test('ask_user: cancel → instruksi cari pendekatan lain', async () => {
  const rt = fakeRt()
  rt.emitter.on('ask_user_request', (req) => rt.askUser.answer(req.id, { kind: 'cancel' }))
  const r = await runAskUserTool(rt, { question: 'ORM?', options: OPTS })
  assert.equal(r.ok, true)
  assert.ok(r.output.includes('membatalkan'))
  assert.ok(r.output.includes('pendekatan lain'))
  assert.ok(r.output.includes('asumsi'))
})

test('ask_user: argumen invalid → error result (tanpa event)', async () => {
  const rt = fakeRt()
  let events = 0
  rt.emitter.on('ask_user_request', () => events++)
  const noQ = await runAskUserTool(rt, { options: OPTS })
  assert.equal(noQ.ok, false)
  const fewOpts = await runAskUserTool(rt, { question: 'q', options: [{ label: 'satu' }] })
  assert.equal(fewOpts.ok, false)
  const noOpts = await runAskUserTool(rt, { question: 'q' })
  assert.equal(noOpts.ok, false)
  assert.equal(events, 0)
  // 6 opsi → error
  const six = await runAskUserTool(rt, {
    question: 'q',
    options: [1, 2, 3, 4, 5, 6].map((i) => ({ label: `o${i}` })),
  })
  assert.equal(six.ok, false)
  // opsi tanpa label di-filter → tinggal 2 valid → jalan
  rt.emitter.on('ask_user_request', (req) => rt.askUser.answer(req.id, { kind: 'option', label: 'A' }))
  const filtered = await runAskUserTool(rt, {
    question: 'q',
    options: [{ label: 'A' }, { description: 'tanpa label' }, { label: 'B' }],
  })
  assert.equal(filtered.ok, true)
})

test('ask_user: bukan tool subagent (read-only schemas) dan bukan read-only set', () => {
  assert.equal(READ_ONLY.has('ask_user'), false)
  assert.ok(!READ_ONLY_SCHEMAS.some((s) => (s as { function: { name: string } }).function.name === 'ask_user'))
  assert.ok(TOOL_SCHEMAS.some((s) => (s as { function: { name: string } }).function.name === 'ask_user'))
})

test('ask_user: tidak kena approval/read-only (decide selalu allow)', () => {
  const pm = new PermissionManager('ask')
  assert.equal(pm.decide('ask_user', {}, { readOnlyMode: true }), 'allow')
  assert.equal(pm.decide('ask_user', {}, { readOnlyMode: false }), 'allow')
  assert.equal(pm.needsAsk('ask_user'), false)
})

// ── multi-select (v0.8.0) ──

test('ask_user multi-select: jawaban options → output "A; C"', async () => {
  const rt = fakeRt()
  rt.emitter.on('ask_user_request', (req) => {
    assert.equal(req.multiSelect, true)
    rt.askUser.answer(req.id, { kind: 'options', labels: ['A', 'C'] })
  })
  const r = await runAskUserTool(rt, {
    question: 'pilih yang di-install',
    multi_select: true,
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
  })
  assert.equal(r.ok, true)
  assert.equal(r.output, 'Jawaban user: A; C')
})

test('ask_user multi-select: single answer juga ok', async () => {
  const rt = fakeRt()
  rt.emitter.on('ask_user_request', (req) => rt.askUser.answer(req.id, { kind: 'options', labels: ['B'] }))
  const r = await runAskUserTool(rt, {
    question: 'q',
    multi_select: true,
    options: [{ label: 'A' }, { label: 'B' }],
  })
  assert.ok(r.output.includes('Jawaban user: B'))
})

test('ask_user: multi_select flag diteruskan ke request; single tidak', async () => {
  const rt = fakeRt()
  let sawMulti: boolean | undefined
  rt.emitter.on('ask_user_request', (req) => {
    sawMulti = req.multiSelect
    rt.askUser.answer(req.id, { kind: 'cancel' })
  })
  await runAskUserTool(rt, { question: 'q', multi_select: true, options: OPTS })
  assert.equal(sawMulti, true)
  await runAskUserTool(rt, { question: 'q', options: OPTS })
  assert.equal(sawMulti, false)
})

// ── installPrintAskUserGuard: --print tidak menggantung ──

test('installPrintAskUserGuard: request ter-emit → auto-cancel + return detach', async () => {
  const rt = fakeRt()
  const detach = installPrintAskUserGuard(rt)
  const req = rt.askUser.newRequest('butuh keputusan?', OPTS, false)
  const answerPromise = rt.askUser.awaitAnswer(req.id)
  rt.emitter.emit('ask_user_request', req)
  const answer = await answerPromise
  detach()
  assert.deepEqual(answer, { kind: 'cancel' })
})
