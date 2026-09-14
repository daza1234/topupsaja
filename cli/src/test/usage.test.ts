import '../bootstrap.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costText, formatDuration } from '../usage.js'
import { AgentSession } from '@topupsaja/core/session/store.js'
import { AskUserManager, type AgentRuntime } from '@topupsaja/core/agent/runtime.js'

function fakeRt(session: AgentSession): AgentRuntime {
  return {
    cwd: '/tmp',
    session,
    permissions: {} as AgentRuntime['permissions'],
    emitter: {} as AgentRuntime['emitter'],
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

test('formatDuration: detik / menit / jam', () => {
  assert.equal(formatDuration(30_000), '30s')
  assert.equal(formatDuration(90_000), '1m 30s')
  assert.equal(formatDuration(3_600_000 + 120_000), '1j 2m')
})

test('costText: tanpa last_balance → tanpa baris sisa', () => {
  const s = AgentSession.create('/tmp', 'ts/gpt-4.1-nano', 'SYSTEM')
  s.tokensIn = 100
  s.tokensOut = 50
  s.creditsUsed = 12
  const text = costText(fakeRt(s))
  assert.ok(text.includes('credit : 12 terpakai sesi ini'))
  assert.ok(!text.includes('sisa'))
})

test('costText: dengan last_balance → baris sisa tampil', () => {
  const s = AgentSession.create('/tmp', 'ts/gpt-4.1-nano', 'SYSTEM')
  s.creditsUsed = 12
  s.lastBalance = 613_500
  const text = costText(fakeRt(s))
  assert.ok(text.includes('sisa   : 613.500 credit'), text)
})
