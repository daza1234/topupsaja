import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render } from 'ink-testing-library'
import { AskUserDialog } from '../tui/components/AskUserDialog.js'
import { ApprovalDialog } from '../tui/components/ApprovalDialog.js'
import type { AskUserRequest, AskUserAnswer } from '../agent/runtime.js'
import type { ApprovalRequest, ApprovalAnswer } from '../agent/permission.js'

const OPTS = [{ label: 'A' }, { label: 'B' }, { label: 'C' }]

function key(stdin: { write(s: string): unknown }, s: string, delayMs = 40): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      stdin.write(s)
      resolve()
    }, delayMs)
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('TUI AskUserDialog multi-select: space toggle + Enter → options', async () => {
  const req: AskUserRequest = { id: 'ask_1', question: 'pilih?', options: OPTS, multiSelect: true }
  const answers: AskUserAnswer[] = []
  const { stdin, unmount } = render(
    <AskUserDialog req={req} onAnswer={(a) => answers.push(a)} />
  )
  await key(stdin, ' ') // toggle A (cursor 0)
  await key(stdin, '\x1b[B') // turun ke B
  await key(stdin, ' ') // toggle B
  await key(stdin, '\r') // kirim
  await sleep(60)
  unmount()
  assert.equal(answers.length, 1)
  assert.deepEqual(answers[0], { kind: 'options', labels: ['A', 'B'] })
})

test('TUI AskUserDialog multi-select: kosong → opsi kursor tunggal', async () => {
  const req: AskUserRequest = { id: 'ask_1', question: 'q', options: OPTS, multiSelect: true }
  const answers: AskUserAnswer[] = []
  const { stdin, unmount } = render(
    <AskUserDialog req={req} onAnswer={(a) => answers.push(a)} />
  )
  await key(stdin, '\x1b[B') // cursor B, tanpa toggle
  await key(stdin, '\r')
  await sleep(60)
  unmount()
  assert.deepEqual(answers[0], { kind: 'option', label: 'B' })
})

test('TUI AskUserDialog single-select: perilaku lama (Enter = opsi kursor)', async () => {
  const req: AskUserRequest = { id: 'ask_1', question: 'q', options: OPTS }
  const answers: AskUserAnswer[] = []
  const { stdin, unmount } = render(
    <AskUserDialog req={req} onAnswer={(a) => answers.push(a)} />
  )
  await key(stdin, '\r')
  await sleep(60)
  unmount()
  assert.deepEqual(answers[0], { kind: 'option', label: 'A' })
})

test('TUI AskUserDialog Esc → cancel', async () => {
  const req: AskUserRequest = { id: 'ask_1', question: 'q', options: OPTS }
  const answers: AskUserAnswer[] = []
  const { stdin, unmount } = render(
    <AskUserDialog req={req} onAnswer={(a) => answers.push(a)} />
  )
  await key(stdin, '\x1b')
  await sleep(60)
  unmount()
  assert.deepEqual(answers[0], { kind: 'cancel' })
})

function approvalReq(partial: Partial<ApprovalRequest>): ApprovalRequest {
  return { id: 'apr_1', tool: 'bash', args: { command: 'npm install' }, preview: 'npm install', label: 'Jalankan command', ...partial }
}

test('TUI ApprovalDialog bash: key p → alwaysPattern', async () => {
  const answers: { approved: boolean; always?: boolean; extra?: { alwaysPattern?: boolean; hunks?: number[] } }[] = []
  const { stdin, unmount } = render(
    <ApprovalDialog
      req={approvalReq({})}
      onAnswer={(approved, always, extra) => answers.push({ approved, always, extra })}
    />
  )
  await key(stdin, 'p')
  await sleep(60)
  unmount()
  assert.equal(answers.length, 1)
  assert.equal(answers[0].approved, true)
  assert.equal(answers[0].extra?.alwaysPattern, true)
})

test('TUI ApprovalDialog edit_file 2 hunk: j/space/Enter → hunks subset', async () => {
  const preview = '- b\n+ X\n- e\n+ Y'
  const answers: { approved: boolean; extra?: { hunks?: number[] } }[] = []
  const { stdin, unmount } = render(
    <ApprovalDialog
      req={approvalReq({ tool: 'edit_file', args: { path: 'f.ts' }, preview })}
      onAnswer={(approved, _always, extra) => answers.push({ approved, extra })}
    />
  )
  await key(stdin, 'j') // kursor ke hunk 2
  await key(stdin, ' ') // toggle hunk 2
  await key(stdin, '\r') // kirim hunk terpilih
  await sleep(60)
  unmount()
  assert.equal(answers.length, 1)
  assert.equal(answers[0].approved, true)
  assert.deepEqual(answers[0].extra?.hunks, [2])
})

test('TUI ApprovalDialog y → approve semua tanpa hunks', async () => {
  const preview = '- b\n+ X\n- e\n+ Y'
  const answers: { approved: boolean; extra?: { hunks?: number[] } }[] = []
  const { stdin, unmount } = render(
    <ApprovalDialog
      req={approvalReq({ tool: 'edit_file', args: { path: 'f.ts' }, preview })}
      onAnswer={(approved, _always, extra) => answers.push({ approved, extra })}
    />
  )
  await key(stdin, 'y')
  await sleep(60)
  unmount()
  assert.deepEqual(answers[0], { approved: true, extra: undefined })
})

test('TUI ApprovalDialog n → reject', async () => {
  const answers: { approved: boolean }[] = []
  const { stdin, unmount } = render(
    <ApprovalDialog req={approvalReq({})} onAnswer={(approved) => answers.push({ approved })} />
  )
  await key(stdin, 'n')
  await sleep(60)
  unmount()
  assert.equal(answers[0].approved, false)
})
