import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fuzzyFilterFiles, fuzzyScore } from '../tui/fuzzy.js'

test('fuzzy: match subsequence berurutan; urutan terbalik bukan match', () => {
  assert.notEqual(fuzzyScore('src/app/router.ts', 'rt'), null) // r muncul sebelum t
  assert.equal(fuzzyScore('src/main.ts', 'tm'), null) // t hanya muncul setelah m
})

test('fuzzy: non-match mengembalikan null', () => {
  assert.equal(fuzzyScore('src/foo.ts', 'zz'), null)
})

test('fuzzy: basename bonus — match di nama file menang atas match di folder', () => {
  const files = ['application/config.ts', 'src/cart/app.ts']
  assert.equal(fuzzyFilterFiles(files, 'app')[0], 'src/cart/app.ts')
})

test('fuzzy: query tanpa spasi case-insensitive', () => {
  assert.ok(fuzzyFilterFiles(['README.md'], 'read').includes('README.md'))
  assert.ok(fuzzyFilterFiles(['README.md'], 'RDME').includes('README.md'))
})

test('fuzzyFilterFiles: slice limit + urutan stabil saat skor sama', () => {
  const files = ['a/x.ts', 'b/x.ts', 'c/x.ts']
  assert.deepEqual(fuzzyFilterFiles(files, 'x', 2), ['a/x.ts', 'b/x.ts'])
  const same = fuzzyFilterFiles(['z/x.ts', 'a/x.ts'], 'x')
  assert.deepEqual(same, ['a/x.ts', 'z/x.ts'])
})

test('fuzzyFilterFiles: query kosong → files awal sesuai limit', () => {
  assert.deepEqual(fuzzyFilterFiles(['a.ts', 'b.ts'], '', 1), ['a.ts'])
})
