import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { glob, grepSync } from '../agent/exec.js'
import { loadIgnore, isIgnored } from '../session/context.js'

let tmp = ''
beforeEach(() => {
  if (!tmp) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-test-'))
    fs.writeFileSync(path.join(tmp, 'app.ts'), 'export const x = 42\n// TODO fix\n')
    fs.writeFileSync(path.join(tmp, 'readme.md'), '# halo\nisi readme\n')
    fs.mkdirSync(path.join(tmp, 'src'))
    fs.writeFileSync(path.join(tmp, 'src', 'util.ts'), 'export function helper() { return 1 }\n')
    fs.mkdirSync(path.join(tmp, 'dist'))
    fs.writeFileSync(path.join(tmp, 'dist', 'bundle.js'), 'var bundled=1\n')
    process.chdir(tmp)
  }
})

after(() => {
  process.chdir('/')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('glob: match pattern dan skip dir default + gitignore', () => {
  const r1 = glob({ pattern: '**/*.ts' })
  assert.ok(r1.ok)
  assert.ok(r1.output.includes('app.ts'))
  assert.ok(r1.output.includes('src/util.ts'))

  const r2 = glob({ pattern: '**/*.js' })
  assert.ok(r2.ok)
  // dist/ di-exclude default — bundle.js tidak boleh muncul
  assert.ok(!r2.output.includes('bundle.js'))
})

test('grep: cari konten dengan nomor baris, skip ignored', () => {
  const r1 = grepSync({ pattern: 'export' })
  assert.ok(r1.ok)
  assert.ok(r1.output.includes('app.ts:1:'))
  assert.ok(r1.output.includes('src/util.ts:1:'))

  const r2 = grepSync({ pattern: 'bundled' })
  assert.ok(r2.ok)
  assert.ok(!r2.output.includes('dist/bundle.js'))
})

test('ignore: semantik gitignore penuh via paket ignore', () => {
  fs.writeFileSync(path.join(tmp, '.gitignore'), 'secret/\n*.log\n')
  const ig = loadIgnore(tmp)
  assert.equal(isIgnored(ig, 'secret/key.pem'), true)
  assert.equal(isIgnored(ig, 'debug.log'), true)
  assert.equal(isIgnored(ig, 'src/util.ts'), false)
  // default exclude tetap berlaku tanpa .gitignore
  const ig2 = loadIgnore(path.join(tmp, 'src'))
  assert.equal(isIgnored(ig2, 'app.ts'), false)
})
