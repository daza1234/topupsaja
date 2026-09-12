import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractCommitMessage, isGitRepo } from '../agent/commit.js'
import { runLocal, formatRunOutput } from '../agent/commands-run.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-commit-'))

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('extractCommitMessage: strip code fence', () => {
  const text = '```.\nfeat(cli): tambah mode test\n\nBody singkat.\n```'
  assert.equal(extractCommitMessage(text), 'feat(cli): tambah mode test\n\nBody singkat.')
})

test('extractCommitMessage: tanpa fence + buang label prefix', () => {
  assert.equal(extractCommitMessage('Pesan commit: fix: perbaiki undo'), 'fix: perbaiki undo')
})

test('extractCommitMessage: body dipotong ke subject + 10 baris', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `baris ${i + 1}`)
  const out = extractCommitMessage(lines.join('\n'))
  assert.equal(out.split('\n').length, 11)
  assert.ok(out.startsWith('baris 1'))
  assert.ok(!out.includes('baris 12'))
})

test('extractCommitMessage: buang baris kosong pinggir', () => {
  assert.equal(extractCommitMessage('\n\n  feat: x  \n\n\n'), 'feat: x')
})

test('isGitRepo: false di folder biasa, true di repo git', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-nogit-'))
  assert.equal(await isGitRepo(plain), false)
  fs.rmSync(plain, { recursive: true, force: true })

  await runLocal(tmp, 'git init -q')
  assert.equal(await isGitRepo(tmp), true)
})

test('runLocal: exit code, stdout, stderr terkumpul', async () => {
  const r = await runLocal(tmp, 'echo halo; echo err >&2; exit 3')
  assert.equal(r.code, 3)
  assert.ok(r.stdout.includes('halo'))
  assert.ok(r.stderr.includes('err'))
})

test('formatRunOutput: fenced block + exit code + cap', () => {
  const out = formatRunOutput('echo hai', { code: 0, stdout: 'hai', stderr: '' })
  assert.ok(out.startsWith('[terminal] $ echo hai'))
  assert.ok(out.includes('```\nhai\n```'))
  assert.ok(out.endsWith('exit 0'))

  const big = formatRunOutput('big', { code: 1, stdout: 'y'.repeat(12_000), stderr: '' })
  assert.ok(big.includes('dipotong 10k char'))
  assert.ok(big.endsWith('exit 1'))
})
