import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEditorKey,
  insertAt,
  killRight,
  lineEnd,
  lineStart,
  wordLeft,
  wordRight,
  type EditorState,
} from '../tui/editor.js'

const st = (value: string, cursor: number): EditorState => ({ value, cursor })

test('insert di tengah cursor, cursor maju', () => {
  const s = insertAt(st('ab', 1), 'X')
  assert.deepEqual(s, st('aXb', 2))
})

test('←/→ geser 1 char, clamp di ujung', () => {
  assert.equal(applyEditorKey(st('abc', 2), '', { leftArrow: true }).state.cursor, 1)
  assert.equal(applyEditorKey(st('abc', 0), '', { leftArrow: true }).state.cursor, 0)
  assert.equal(applyEditorKey(st('abc', 3), '', { rightArrow: true }).state.cursor, 3)
})

test('backspace hapus char sebelum cursor; Delete forward saat ESC [3~', () => {
  const b = applyEditorKey(st('abc', 2), '\x7f', { delete: true })
  assert.deepEqual(b.state, st('ac', 1))
  const f = applyEditorKey(st('abc', 1), '', { delete: true })
  assert.deepEqual(f.state, st('ac', 1))
})

test('Ctrl+W / Alt+Backspace kill word kiri', () => {
  assert.deepEqual(applyEditorKey(st('hello wor', 9), 'w', { ctrl: true }).state, st('hello ', 6))
  const alt = applyEditorKey(st('hello world', 11), '\x7f', { delete: true, meta: true })
  assert.equal(alt.state.value, 'hello ')
})

test('word jump: Ctrl+← dan Alt+F', () => {
  assert.equal(wordLeft(st('foo bar baz', 11)).cursor, 8)
  assert.equal(wordRight(st('foo bar baz', 0)).cursor, 3)
  assert.equal(applyEditorKey(st('foo bar', 7), '', { leftArrow: true, ctrl: true }).state.cursor, 4)
  assert.equal(applyEditorKey(st('foo bar', 0), 'f', { meta: true }).state.cursor, 3)
})

test('Home/Ctrl+A dan End/Ctrl+E per baris multi-line', () => {
  assert.deepEqual(lineStart(st('aa\nbb', 4)), st('aa\nbb', 3))
  assert.deepEqual(lineEnd(st('aa\nbb', 3)), st('aa\nbb', 5))
  assert.equal(applyEditorKey(st('aa\nbb', 4), 'a', { ctrl: true }).state.cursor, 3)
})

test('Ctrl+K kill ke akhir baris, lalu hapus newline', () => {
  assert.deepEqual(killRight(st('ab\ncd', 1)), st('a\ncd', 1))
  assert.deepEqual(killRight(st('ab\ncd', 2)), st('abcd', 2))
})

test('Ctrl+U clear all; Enter/Tab bukan urusan reducer (unhandled)', () => {
  assert.deepEqual(applyEditorKey(st('abc', 2), 'u', { ctrl: true }).state, st('', 0))
  assert.equal(applyEditorKey(st('abc', 1), '\r', { return: true }).handled, false)
  assert.equal(applyEditorKey(st('abc', 1), '\r', {}).handled, false)
  assert.equal(applyEditorKey(st('abc', 1), '', { tab: true }).handled, false)
  assert.equal(applyEditorKey(st('abc', 1), '', { escape: true, meta: true }).handled, false)
})

test('karakter biasa disisip; paste multi-baris bukan urusan reducer', () => {
  assert.deepEqual(applyEditorKey(st('ac', 1), 'b', {}).state, st('abc', 2))
  assert.equal(applyEditorKey(st('a', 1), 'x\ny', {}).handled, false)
})
