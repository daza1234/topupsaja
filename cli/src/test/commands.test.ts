import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverCommands, renderCommand } from '../commands.js'

test('renderCommand: $ARGUMENTS diganti (semua kemunculan)', () => {
  const cmd = { name: '/x', description: '', body: 'lakukan: $ARGUMENTS (arg: $ARGUMENTS)' }
  assert.equal(renderCommand(cmd, 'tes'), 'lakukan: tes (arg: tes)')
})

test('discoverCommands: frontmatter description + body, project menang atas global', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-cmd-'))
  fs.mkdirSync(path.join(tmp, '.tsa', 'commands'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, '.tsa', 'commands', 'review.md'),
    '---\ndescription: Review kode terakhir\n---\nReview perubahan ini: $ARGUMENTS'
  )
  fs.writeFileSync(
    path.join(tmp, '.tsa', 'commands', 'plain.md'),
    'Tanpa frontmatter, isi saja'
  )
  // file non-.md diabaikan
  fs.writeFileSync(path.join(tmp, '.tsa', 'commands', 'ignore.txt'), 'bukan command')

  const cmds = discoverCommands(tmp)
  const review = cmds.find((c) => c.name === '/review')
  assert.ok(review)
  assert.equal(review!.description, 'Review kode terakhir')
  assert.ok(review!.body.includes('$ARGUMENTS'))
  assert.ok(cmds.find((c) => c.name === '/plain'))
  assert.equal(cmds.find((c) => c.name === '/ignore'), undefined)

  after(() => fs.rmSync(tmp, { recursive: true, force: true }))
})
