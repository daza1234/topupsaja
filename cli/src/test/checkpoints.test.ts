import '../bootstrap.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentEmitter, AskUserManager, type AgentRuntime } from '@topupsaja/core/agent/runtime.js'
import { PermissionManager } from '@topupsaja/core/agent/permission.js'
import { TodoStore } from '@topupsaja/core/storage/todo.js'
import { stagePreState, markTouched, undoLastTurn, diffCheckpoints, relPath } from '@topupsaja/core/agent/checkpoints.js'

function makeRuntime(cwd: string): AgentRuntime {
  const session = {
    model: 'ts/test',
    todos: new TodoStore(),
    checkpoints: {} as Record<string, { content: string | null; at: string }>,
    creditsUsed: 0,
    async save() {
      return null
    },
  } as unknown as AgentRuntime['session']
  return {
    cwd,
    session,
    permissions: new PermissionManager('yolo'),
    emitter: new AgentEmitter(),
    mode: 'code',
    models: [],
    abort: false,
    abortController: null,
    checkpointTurns: [],
    turnSnapshots: [],
    customModes: [],
    mcp: [],
    askUser: new AskUserManager(),
  }
}

test('relPath: absolut & relatif dinormalisasi', async () => {
  const cwd = os.tmpdir()
  assert.equal(relPath(cwd, 'a/b.txt'), 'a/b.txt')
  assert.ok(relPath(cwd, path.join(cwd, 'x/y.ts')).endsWith('x/y.ts'))
})

test('checkpoint: stage → mark → undo mengembalikan isi awal per turn', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-ckpt-'))
  const rt = makeRuntime(tmp)
  const file = path.join(tmp, 'cek.txt')
  fs.writeFileSync(file, 'VERSI-1\n')

  // Turn 1: edit ke VERSI-2
  rt.checkpointTurns.push([])
  rt.turnSnapshots.push(new Map())
  let skipped = await stagePreState(rt, 'cek.txt')
  assert.equal(skipped, undefined)
  fs.writeFileSync(file, 'VERSI-2\n')
  markTouched(rt, 'cek.txt')

  // Turn 2: edit ke VERSI-3
  rt.checkpointTurns.push([])
  rt.turnSnapshots.push(new Map())
  await stagePreState(rt, 'cek.txt')
  fs.writeFileSync(file, 'VERSI-3\n')
  markTouched(rt, 'cek.txt')

  // /diff kumulatif: baseline = VERSI-1
  const diff = await diffCheckpoints(rt)
  assert.ok(diff.includes('cek.txt'))
  assert.ok(diff.includes('- VERSI-1') && diff.includes('+ VERSI-3'))

  // Undo turn 2 → kembali ke VERSI-2 (snapshot per-turn)
  const restored = await undoLastTurn(rt)
  assert.deepEqual(restored, ['cek.txt'])
  assert.equal(fs.readFileSync(file, 'utf8'), 'VERSI-2\n')

  // Undo turn 1 → kembali ke VERSI-1
  const restored2 = await undoLastTurn(rt)
  assert.deepEqual(restored2, ['cek.txt'])
  assert.equal(fs.readFileSync(file, 'utf8'), 'VERSI-1\n')

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('checkpoint: file baru → undo menghapus', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-ckpt2-'))
  const rt = makeRuntime(tmp)
  const file = path.join(tmp, 'baru.txt')
  rt.checkpointTurns.push([])
  rt.turnSnapshots.push(new Map())
  await stagePreState(rt, 'baru.txt')
  fs.writeFileSync(file, 'isi baru')
  markTouched(rt, 'baru.txt')

  const restored = await undoLastTurn(rt)
  assert.deepEqual(restored, ['baru.txt'])
  assert.equal(fs.existsSync(file), false)

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('checkpoint: undo tanpa history → kosong', async () => {
  const rt = makeRuntime(os.tmpdir())
  assert.deepEqual(await undoLastTurn(rt), [])
})
