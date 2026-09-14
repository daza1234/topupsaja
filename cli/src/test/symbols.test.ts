import '../bootstrap.js'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findSymbol } from '@topupsaja/core/agent/exec.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-symbol-'))
const origCwd = process.cwd()

before(() => {
  process.chdir(tmp)
  fs.writeFileSync(
    path.join(tmp, 'app.ts'),
    `import x from 'y'
export function setMode(m: string): void {}
function helper() {}
class AgentSession {}
const setModeTwo = 1
export interface Config {}
type Alias = string
enum Color { Red }
export const runTurn = async () => {}
`
  )
  fs.writeFileSync(
    path.join(tmp, 'util.py'),
    `import os

def set_mode(mode: str) -> None:
    pass

class Hunter:
    def method_one(self):
        pass

async def async_fn():
    pass
`
  )
  fs.writeFileSync(path.join(tmp, 'main.go'), `package main

func SetMode(m string) {}

func (s *Store) Save() {}

type Store struct {}
`)
  fs.mkdirSync(path.join(tmp, 'node_modules'))
  fs.writeFileSync(path.join(tmp, 'node_modules', 'banned.ts'), 'function setModeBanned() {}\n')
  fs.writeFileSync(path.join(tmp, 'readme.md'), '# setMode di markdown — bukan kode\n')
})

after(() => {
  process.chdir('/')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('find_symbol: definisi TS ditemukan (function, class, const, interface, type, enum)', async () => {
  const r = await findSymbol({ query: 'setmode' })
  assert.ok(r.ok)
  assert.ok(r.output.includes('app.ts:2: export function setMode'), r.output)
  assert.ok(r.output.includes('app.ts:5: const setModeTwo'), r.output)
  assert.ok(!r.output.includes('node_modules'), 'node_modules harus di-skip')
  assert.ok(!r.output.includes('markdown'), 'non-kode tidak dipindai')
})

test('find_symbol: Python def/class', async () => {
  const r = await findSymbol({ query: 'set_mode' })
  assert.ok(r.output.includes('util.py:3: def set_mode'), r.output)
  const r2 = await findSymbol({ query: 'hunter' })
  assert.ok(r2.output.includes('util.py:6: class Hunter'), r2.output)
})

test('find_symbol: Go func/type', async () => {
  const r = await findSymbol({ query: 'store' })
  assert.ok(r.output.includes('main.go:7: type Store'), r.output)
  const r2 = await findSymbol({ query: 'save' })
  assert.ok(r2.output.includes('main.go:5: func (s *Store) Save'), r2.output)
})

test('find_symbol: path param membatasi scope, query pendek ditolak', async () => {
  const r = await findSymbol({ query: 'hunter', path: 'util.py' })
  assert.ok(r.output.includes('util.py:6:'))
  assert.ok(!r.output.includes('app.ts'))

  const short = await findSymbol({ query: 'a' })
  assert.ok(!short.ok)
  assert.ok(short.output.includes('minimal 2 karakter'))
})

test('find_symbol: tanpa hasil → pesan dengan jumlah file dipindai', async () => {
  const r = await findSymbol({ query: 'tidakada' })
  assert.ok(r.ok)
  assert.ok(r.output.includes("Tidak ada definisi untuk 'tidakada'"))
  assert.ok(r.output.includes('file dipindai'))
})

test('find_symbol: cap 50 hasil', async () => {
  const lines: string[] = []
  for (let i = 0; i < 60; i++) {
    lines.push(`function bigfn${String(i).padStart(3, '0')}() {}`)
  }
  fs.writeFileSync(path.join(tmp, 'many.js'), lines.join('\n') + '\n')
  const r = await findSymbol({ query: 'bigfn' })
  const matchLines = r.output.split('\n').filter((l) => l.includes('many.js:'))
  assert.equal(matchLines.length, 50)
  assert.ok(r.output.includes('(hasil di-cap 50)'))
})
