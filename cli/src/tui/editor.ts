/** Model editor composer murni (state + operasi cursor) — di-test tanpa ink. */

export interface EditorState {
  value: string
  cursor: number
}

/** Subset field key dari ink useInput yang dipakai editor. */
export interface EditorKey {
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  home?: boolean
  end?: boolean
  backspace?: boolean
  delete?: boolean
  tab?: boolean
  return?: boolean
  escape?: boolean
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c)

export function insertAt(s: EditorState, text: string): EditorState {
  if (!text) return s
  return { value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor), cursor: s.cursor + text.length }
}

export function deleteLeft(s: EditorState): EditorState {
  if (s.cursor === 0) return s
  return { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 }
}

export function deleteRight(s: EditorState): EditorState {
  if (s.cursor >= s.value.length) return s
  return { value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1), cursor: s.cursor }
}

export function moveLeft(s: EditorState): EditorState {
  return { ...s, cursor: Math.max(0, s.cursor - 1) }
}

export function moveRight(s: EditorState): EditorState {
  return { ...s, cursor: Math.min(s.value.length, s.cursor + 1) }
}

export function wordLeft(s: EditorState): EditorState {
  let i = s.cursor
  while (i > 0 && isSpace(s.value[i - 1])) i--
  while (i > 0 && !isSpace(s.value[i - 1])) i--
  return { value: s.value, cursor: i }
}

export function wordRight(s: EditorState): EditorState {
  let i = s.cursor
  while (i < s.value.length && isSpace(s.value[i])) i++
  while (i < s.value.length && !isSpace(s.value[i])) i++
  return { value: s.value, cursor: i }
}

export function killWordLeft(s: EditorState): EditorState {
  const t = wordLeft(s).cursor
  return { value: s.value.slice(0, t) + s.value.slice(s.cursor), cursor: t }
}

/** Ctrl+K: hapus s/d akhir baris; kalau baris sudah habis di cursor, hapus newline. */
export function killRight(s: EditorState): EditorState {
  const nl = s.value.indexOf('\n', s.cursor)
  if (nl === -1) return { value: s.value.slice(0, s.cursor), cursor: s.cursor }
  if (nl === s.cursor) {
    return { value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1), cursor: s.cursor }
  }
  return { value: s.value.slice(0, s.cursor) + s.value.slice(nl), cursor: s.cursor }
}

export function lineStart(s: EditorState): EditorState {
  return { value: s.value, cursor: s.value.lastIndexOf('\n', s.cursor - 1) + 1 }
}

export function lineEnd(s: EditorState): EditorState {
  const nl = s.value.indexOf('\n', s.cursor)
  return { value: s.value, cursor: nl === -1 ? s.value.length : nl }
}

export function gotoEnd(s: EditorState): EditorState {
  return { value: s.value, cursor: s.value.length }
}

export function clearAll(): EditorState {
  return { value: '', cursor: 0 }
}

const handled = (state: EditorState) => ({ state, handled: true })

/** Terapkan satu keypress editor. Enter/submit, Tab, ↑/↓ sengaja di luar
 *  (butuh konteks saran/riwayat/submit) — ditangani komponen ChatInput. */
export function applyEditorKey(
  s: EditorState,
  input: string,
  key: EditorKey
): { state: EditorState; handled: boolean } {
  if (key.ctrl && !key.meta) {
    if (input === 'a') return handled(lineStart(s))
    if (input === 'e') return handled(lineEnd(s))
    if (input === 'b') return handled(moveLeft(s))
    if (input === 'f') return handled(moveRight(s))
    if (input === 'w') return handled(killWordLeft(s))
    if (input === 'k') return handled(killRight(s))
    if (input === 'u') return handled(clearAll())
    if (input === 'h') return handled(deleteLeft(s))
  }
  if (key.leftArrow) return handled(key.ctrl || key.meta ? wordLeft(s) : moveLeft(s))
  if (key.rightArrow) return handled(key.ctrl || key.meta ? wordRight(s) : moveRight(s))
  if (key.home) return handled(lineStart(s))
  if (key.end) return handled(lineEnd(s))
  if (key.backspace || key.delete) {
    if (key.meta) return handled(killWordLeft(s)) // Alt+Backspace (ESC BS / ESC DEL)
    // Terminal kirim Backspace sebagai 0x7f → ink label 'delete' dengan input '\x7f'.
    // Tombol Delete asli (ESC [3~) datang dengan input '' → forward delete.
    if (key.delete && input !== '\x7f') return handled(deleteRight(s))
    return handled(deleteLeft(s))
  }
  if (key.meta && !key.ctrl) {
    if (input === 'b') return handled(wordLeft(s)) // Alt+B / Alt+F word jump
    if (input === 'f') return handled(wordRight(s))
    if (input) return handled(insertAt(s, input.replace(/\r/g, '\n'))) // Alt/Shift+Enter → newline
    return { state: s, handled: false }
  }
  if (input && !key.ctrl && !key.return && !key.tab && !key.escape && !/[\r\n]/.test(input)) {
    return handled(insertAt(s, input))
  }
  return { state: s, handled: false }
}
