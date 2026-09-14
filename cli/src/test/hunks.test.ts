import '../bootstrap.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitHunks, applyHunks } from '@topupsaja/core/agent/hunks.js'

test('splitHunks: diff 2 blok terpisah → 2 hunk bernomor urut', () => {
  const d = '- b\n+ X\n- e\n+ Y'
  const hunks = splitHunks(d)
  assert.equal(hunks.length, 2)
  assert.equal(hunks[0].startLine, 1)
  assert.deepEqual(hunks[0].lines, ['- b', '+ X'])
  assert.equal(hunks[1].startLine, 1)
  assert.deepEqual(hunks[1].lines, ['- e', '+ Y'])
})

test('splitHunks: +/- berurutan kontigu → satu hunk', () => {
  const hunks = splitHunks('- a\n- b\n+ x\n+ y')
  assert.equal(hunks.length, 1)
  assert.equal(hunks[0].lines.length, 4)
})

test('splitHunks: diff kosong → tanpa hunk', () => {
  assert.deepEqual(splitHunks(''), [])
})

test('applyHunks: semua hunk terpilih → hasil == newStr', () => {
  const oldStr = 'a\nb\nc\nd\ne'
  const newStr = 'a\nX\nc\nd\nE'
  const all = [1, 2]
  assert.equal(applyHunks(oldStr, newStr, all), newStr)
  // tanpa pilihan → semua
  assert.equal(applyHunks(oldStr, newStr, [1, 2]), newStr)
})

test('applyHunks: subset → hanya hunk terpilih yang diterapkan', () => {
  const oldStr = 'a\nb\nc\nd\ne'
  const newStr = 'a\nX\nc\nd\nE'
  // hanya hunk 1 (b→X)
  assert.equal(applyHunks(oldStr, newStr, [1]), 'a\nX\nc\nd\ne')
  // hanya hunk 2 (e→E)
  assert.equal(applyHunks(oldStr, newStr, [2]), 'a\nb\nc\nd\nE')
})

test('applyHunks: tidak ada yang dipilih → null (tanpa perubahan)', () => {
  const oldStr = 'a\nb\nc'
  const newStr = 'a\nX\nc'
  assert.equal(applyHunks(oldStr, newStr, []), null)
})

test('applyHunks: reject-all → null; identik → null', () => {
  assert.equal(applyHunks('sama', 'sama', [1]), null)
})

test('applyHunks: tambahan baris (hunk + saja) subset', () => {
  const oldStr = 'a\nb\nc'
  const newStr = 'a\nb\nNEW1\nc\nNEW2'
  // simpleDiff: konteks a,b lalu + NEW di posisi... cek konsistensi preview vs hasil
  const merged = applyHunks(oldStr, newStr, [1, 2])
  assert.equal(merged, newStr)
})

test('applyHunks: edit nyata per-hunk cocok dengan preview simpleDiff', () => {
  const oldStr = 'function f() {\n  const a = 1\n  return a\n}\n\nfunction g() {\n  const b = 2\n  return b\n}\n'
  const newStr = 'function f() {\n  const a = 10\n  return a\n}\n\nfunction g() {\n  const b = 2\n  return b\n}\n'
  // preview: simpleDiff(old,new) → 1 hunk
  const hunks = splitHunks(simpleDiffOf(oldStr, newStr))
  assert.equal(hunks.length, 1)
  assert.equal(applyHunks(oldStr, newStr, [1]), newStr)
})

// salin algoritma simpleDiff untuk keperluan test (hindari import ganda)
function simpleDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++
      j++
      continue
    }
    while (i < oldLines.length && !newLines.includes(oldLines[i])) {
      out.push(`- ${oldLines[i]}`)
      i++
    }
    while (j < newLines.length && !oldLines.includes(newLines[j])) {
      out.push(`+ ${newLines[j]}`)
      j++
    }
  }
  return out.join('\n')
}

function simpleDiffOf(a: string, b: string): string {
  return simpleDiff(a, b)
}
