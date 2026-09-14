import '../bootstrap.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runTurn } from '@topupsaja/core/agent/loop.js'
import { PermissionManager } from '@topupsaja/core/agent/permission.js'
import { AskUserManager, AgentEmitter, type AgentRuntime } from '@topupsaja/core/agent/runtime.js'
import { AgentSession } from '@topupsaja/core/session/store.js'
import type { PermissionRule } from '@topupsaja/core/agent/rules.js'

// ── Env hermetic: tmp HOME (session/config) + tmp cwd (bash/write) ──
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-loop-home-'))
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-loop-proj-'))
const oldHome = process.env.HOME
const oldUrl = process.env.TOPUPSAJA_API_URL
process.env.HOME = home
process.env.TOPUPSAJA_API_URL = 'http://localhost:59999'
process.env.TOPUPSAJA_API_KEY = process.env.TOPUPSAJA_API_KEY ?? 'sk-ts-test'
process.chdir(proj)

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function sse(chunks: Record<string, unknown>[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
}

/** Antrean respons: tiap tool call → respons tool_calls + respons teks final. */
function toolResponses(calls: { name: string; args: unknown }[]): Response[] {
  const out: Response[] = []
  for (const c of calls) {
    out.push(
      sseResponse(
        sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      function: { name: c.name, arguments: JSON.stringify(c.args) },
                    },
                  ],
                },
              },
            ],
          },
        ])
      )
    )
    out.push(sseResponse(sse([{ choices: [{ delta: { content: 'selesai' } }] }])))
  }
  return out
}

function makeRt(rules: PermissionRule[] = [], mode: 'ask' | 'yolo' = 'ask'): AgentRuntime {
  return {
    cwd: proj,
    session: AgentSession.create(proj, 'ts/model-x', 'SYSTEM'),
    permissions: new PermissionManager(mode, [], rules, proj),
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

/** Tulis rules ke project settings.json (hot-reload per turn membaca dari file). */
function writeProjRules(rules: { tool: string; pattern: string; action: string }[]): void {
  fs.mkdirSync(path.join(proj, '.tsa'), { recursive: true })
  fs.writeFileSync(path.join(proj, '.tsa', 'settings.json'), JSON.stringify({ permissions: rules }))
}

function clearProjRules(): void {
  fs.rmSync(path.join(proj, '.tsa'), { recursive: true, force: true })
}

/** Respons teks final polos (turn tanpa tool call) — 1 fetch per turn. */
function textResponses(n: number): Response[] {
  return Array.from({ length: n }, () => sseResponse(sse([{ choices: [{ delta: { content: 'selesai' } }] }])))
}

function mockFetch(responses: Response[]): () => void {
  const orig = globalThis.fetch
  const queue = [...responses]
  globalThis.fetch = (async () => {
    const next = queue.shift()
    if (!next) throw new Error('fetch mock habis')
    return next
  }) as typeof fetch
  return () => {
    globalThis.fetch = orig
  }
}

test.after(() => {
  process.chdir('/')
  if (oldHome === undefined) delete process.env.HOME
  else process.env.HOME = oldHome
  if (oldUrl === undefined) delete process.env.TOPUPSAJA_API_URL
  else process.env.TOPUPSAJA_API_URL = oldUrl
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(proj, { recursive: true, force: true })
})

test('loop: bash risky + approve → file tercipta, approval_request ter-emit', async () => {
  const rt = makeRt()
  let approvals = 0
  rt.emitter.on('approval_request', (req) => {
    approvals++
    rt.permissions.answer(req.id, { approved: true }, req.tool, req.args)
  })
  const detachFetch = mockFetch(toolResponses([{ name: 'bash', args: { command: 'echo hi > out.txt' } }]))
  try {
    const r = await runTurn(rt, 'buat out.txt')
    assert.equal(r.completed, true)
    assert.equal(approvals, 1)
    assert.ok(fs.existsSync(path.join(proj, 'out.txt')))
  } finally {
    detachFetch()
    fs.rmSync(path.join(proj, 'out.txt'), { force: true })
  }
})

test('loop: bash risky + reject → tool ditolak, file tidak ada', async () => {
  const rt = makeRt()
  rt.emitter.on('approval_request', (req) => rt.permissions.answer(req.id, { approved: false }, req.tool, req.args))
  const results: { ok: boolean; output: string }[] = []
  rt.emitter.on('tool_result', (info) => results.push(info))
  const detachFetch = mockFetch(toolResponses([{ name: 'bash', args: { command: 'echo hi > out.txt' } }]))
  try {
    const r = await runTurn(rt, 'buat file')
    assert.equal(r.completed, true)
    assert.ok(results.some((x) => x.output.includes('menolak')), 'ada tool_result penolakan')
    assert.equal(fs.existsSync(path.join(proj, 'out.txt')), false)
  } finally {
    detachFetch()
  }
})

test('loop: rule deny echo → ditolak langsung TANPA approval_request', async () => {
  writeProjRules([{ tool: 'bash', pattern: 'echo *', action: 'deny' }])
  const rt = makeRt()
  const results: { ok: boolean; output: string }[] = []
  rt.emitter.on('tool_result', (info) => results.push(info))
  let approvals = 0
  rt.emitter.on('approval_request', () => approvals++)
  const detachFetch = mockFetch(toolResponses([{ name: 'bash', args: { command: 'echo tidak-jalan' } }]))
  try {
    const r = await runTurn(rt, 'echo')
    assert.equal(r.completed, true)
    assert.equal(approvals, 0)
    const denied = results.find((x) => !x.ok)
    assert.ok(denied, 'ada tool_result gagal')
    assert.match(denied.output, /DITOLAK/)
  } finally {
    detachFetch()
    clearProjRules()
  }
})

test('loop: rule ask + mode yolo → approval_request tetap ter-emit', async () => {
  writeProjRules([{ tool: 'bash', pattern: 'echo *', action: 'ask' }])
  const rt = makeRt([], 'yolo')
  rt.emitter.on('approval_request', (req) => rt.permissions.answer(req.id, { approved: true }, req.tool, req.args))
  let approvals = 0
  rt.emitter.on('approval_request', () => approvals++)
  const detachFetch = mockFetch(toolResponses([{ name: 'bash', args: { command: 'echo yolo-ask' } }]))
  try {
    const r = await runTurn(rt, 'echo')
    assert.equal(r.completed, true)
    assert.equal(approvals, 1)
  } finally {
    detachFetch()
    clearProjRules()
  }
})

test('loop: ask_user e2e → tool result berisi jawaban multi-select', async () => {
  const rt = makeRt()
  rt.emitter.on('ask_user_request', (req) => {
    rt.askUser.answer(req.id, { kind: 'options', labels: ['Prisma', 'Sequelize'] })
  })
  const detachFetch = mockFetch(
    toolResponses([
      {
        name: 'ask_user',
        args: {
          question: 'ORM?',
          multi_select: true,
          options: [{ label: 'Prisma' }, { label: 'Drizzle' }, { label: 'Sequelize' }],
        },
      },
    ])
  )
  try {
    const r = await runTurn(rt, 'tanya user')
    assert.equal(r.completed, true)
    const toolMsg = rt.session.messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg)
    assert.ok(String(toolMsg.content).includes('Jawaban user: Prisma; Sequelize'))
  } finally {
    detachFetch()
  }
})

test('loop: audit log — keputusan deny tercatat di session.permissionLog', async () => {
  writeProjRules([{ tool: 'bash', pattern: 'echo *', action: 'deny' }])
  const rt = makeRt()
  const detachFetch = mockFetch(toolResponses([{ name: 'bash', args: { command: 'echo satu' } }]))
  try {
    await runTurn(rt, 'log 1')
    const denyEntry = rt.session.permissionLog.find((e) => e.decision === 'deny')
    assert.ok(denyEntry, 'entri deny ada')
    assert.equal(denyEntry.tool, 'bash')
    assert.ok(denyEntry.target.includes('echo satu'))
  } finally {
    detachFetch()
    clearProjRules()
  }
})

test('loop: audit log — ask→approved tercatat', async () => {
  const rt = makeRt()
  rt.emitter.on('approval_request', (req) => rt.permissions.answer(req.id, { approved: true }, req.tool, req.args))
  const detachFetch = mockFetch(toolResponses([{ name: 'bash', args: { command: 'echo dua > dua.txt' } }]))
  try {
    await runTurn(rt, 'log 2')
    const askEntries = rt.session.permissionLog.filter((e) => e.decision === 'ask')
    assert.ok(askEntries.length >= 1, 'entri ask ada')
    assert.equal(askEntries.some((e) => e.approved === true), true)
  } finally {
    detachFetch()
    fs.rmSync(path.join(proj, 'dua.txt'), { force: true })
  }
})

test('loop: hot-reload — rules berubah antar turn → notice dimuat ulang sekali', async () => {
  const rt = makeRt()
  let reloadCount = 0
  rt.emitter.on('notice', (t) => {
    if (t.includes('dimuat ulang')) reloadCount++
  })
  const detachFetch = mockFetch(textResponses(3))
  try {
    await runTurn(rt, 'turn 1')
    assert.equal(reloadCount, 0)
    writeProjRules([{ tool: 'bash', pattern: 'echo *', action: 'allow' }])
    await runTurn(rt, 'turn 2')
    assert.equal(reloadCount, 1)
    assert.equal(rt.permissions.rules.length, 1)
    await runTurn(rt, 'turn 3')
    assert.equal(reloadCount, 1) // tanpa perubahan → tidak ada reload lagi
  } finally {
    detachFetch()
    clearProjRules()
  }
})
