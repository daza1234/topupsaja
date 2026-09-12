import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globMatch } from '../agent/patterns.js'

test('glob: "npm *" match command berawalan npm, miss selain itu', () => {
  assert.equal(globMatch('npm *', 'npm install'), true)
  assert.equal(globMatch('npm *', 'npm install foo --save'), true)
  assert.equal(globMatch('npm *', 'xnpm install'), false)
  assert.equal(globMatch('npm *', 'npm'), false) // butuh spasi + sisa
  assert.equal(globMatch('npm *', 'yarn install'), false)
})

test('glob: "*" tidak melewati slash, "**" melewati slash', () => {
  assert.equal(globMatch('src/**', 'src/a/b.ts'), true)
  assert.equal(globMatch('src/**', 'src/a.ts'), true)
  assert.equal(globMatch('src/*', 'src/a.ts'), true)
  assert.equal(globMatch('src/*', 'src/a/b.ts'), false)
  assert.equal(globMatch('**/*.test.ts', 'deep/nested/x.test.ts'), true)
})

test('glob: path relatif "*.env*" (write_file deny env)', () => {
  assert.equal(globMatch('*.env*', '.env'), true)
  assert.equal(globMatch('*.env*', 'app.env.local'), true)
  assert.equal(globMatch('*.env*', 'src/.env'), false) // * tidak lewat slash
  assert.equal(globMatch('**/.env*', 'src/.env'), true)
  assert.equal(globMatch('*.env*', 'environment.ts'), false)
})

test('glob: wildcard nama tool MCP', () => {
  assert.equal(globMatch('mcp__x__*', 'mcp__x__tool'), true)
  assert.equal(globMatch('mcp__x__*', 'mcp__y__tool'), false)
  assert.equal(globMatch('*', 'mcp__x__tool'), true) // * di nama tool (tanpa slash)
  assert.equal(globMatch('mcp__x__*', 'mcp__x__a__b'), true) // * tetap match sisa string
})

test('glob: "?" tepat satu karakter, case-sensitive, escape regex', () => {
  assert.equal(globMatch('cat ?', 'cat a'), true)
  assert.equal(globMatch('cat ?', 'cat ab'), false)
  assert.equal(globMatch('cat ?', 'cat .'), true)
  assert.equal(globMatch('npm *', 'NPM install'), false) // case-sensitive
  assert.equal(globMatch('a.b', 'aXb'), false) // titik di-escape, bukan any-char
  assert.equal(globMatch('a.b', 'a.b'), true)
})

test('glob: pattern kosong → false; karakter khusus regex aman', () => {
  assert.equal(globMatch('', 'apa pun'), false)
  assert.equal(globMatch('(a|b)', '(a|b)'), true)
  assert.equal(globMatch('(a|b)', 'a'), false)
})

test('glob: cache — panggilan berulang hasil konsisten (regex di-cache)', () => {
  for (let i = 0; i < 50; i++) {
    assert.equal(globMatch('npm *', 'npm install'), true)
    assert.equal(globMatch('npm *', 'yarn install'), false)
    assert.equal(globMatch('src/**', 'src/a/b.ts'), true)
    assert.equal(globMatch('src/*', 'src/a/b.ts'), false)
  }
  // pattern yang menyebabkan cache clear (>500 entri) tetap benar
  for (let i = 0; i < 600; i++) {
    globMatch(`p${i} *`, `p${i} x`)
  }
  assert.equal(globMatch('npm *', 'npm install'), true)
  assert.equal(globMatch('src/*', 'src/a/b.ts'), false)
})
