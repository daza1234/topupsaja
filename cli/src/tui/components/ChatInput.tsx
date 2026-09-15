import React, { useEffect, useRef, useState } from 'react'
import { Text, Box, useInput } from 'ink'
import { SLASH_COMMANDS } from '../../usage.js'
import { applyEditorKey, clearAll, gotoEnd, insertAt, type EditorState } from '../editor.js'
import { fuzzyFilterFiles } from '../fuzzy.js'

interface Props {
  active: boolean
  busy: boolean
  files: string[]
  /** Custom slash commands (dari .tsa/commands & ~/.topupsaja/commands). */
  commands?: string[]
  /** Sisipkan teks ke input (mis. @path dari FileFinder Ctrl+P). */
  inject?: { text: string; nonce: number }
  /** Pesan yang mengantre saat agent busy (dirender di atas input). */
  queue?: string[]
  onSubmit: (text: string) => void
}

/** Input chat dengan editor cursor penuh: Enter kirim, Shift/Alt+Enter baris baru,
 *  ↑/↓ riwayat, Tab lengkapi autocomplete @path (fuzzy) & slash-command,
 *  ←/→/Home/End/Ctrl+A-E/B-F/W/K/U editing. Operasi murni ada di editor.ts. */
export function ChatInput({ active, busy, files, commands, inject, queue, onSubmit }: Props) {
  const [ed, setEd] = useState<EditorState>({ value: '', cursor: 0 })
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [sugIdx, setSugIdx] = useState(0)
  const lastNonce = useRef(-1)
  const allCommands = commands && commands.length > 0 ? [...SLASH_COMMANDS, ...commands] : SLASH_COMMANDS

  useEffect(() => {
    if (inject && inject.nonce !== lastNonce.current) {
      lastNonce.current = inject.nonce
      setEd((s) => insertAt(s, inject.text))
    }
  }, [inject])

  // ── Autocomplete: token di kiri cursor ──
  const beforeCursor = ed.value.slice(0, ed.cursor)
  const lastWord = beforeCursor.split(/\s/).pop() ?? ''
  let suggestions: string[] = []
  if (lastWord.startsWith('@')) {
    suggestions = fuzzyFilterFiles(files, lastWord.slice(1), 8)
  } else if (beforeCursor === lastWord && lastWord.startsWith('/')) {
    suggestions = allCommands.filter((c) => c.startsWith(lastWord)).slice(0, 8)
  }
  const sugActive = suggestions.length > 0

  function complete() {
    const pick = suggestions[sugIdx] ?? suggestions[0]
    if (!pick) return
    const token = lastWord.startsWith('@') ? `@${pick} ` : `${pick} `
    const head = ed.value.slice(0, ed.cursor - lastWord.length) + token
    setEd({ value: head + ed.value.slice(ed.cursor), cursor: head.length })
    setSugIdx(0)
  }

  useInput(
    (input, key) => {
      if (key.upArrow || key.downArrow) {
        if (sugActive) {
          setSugIdx((i) => (key.upArrow ? Math.max(0, i - 1) : Math.min(suggestions.length - 1, i + 1)))
        } else if (key.upArrow && history.length > 0) {
          const next = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1)
          setHistIdx(next)
          setEd(gotoEnd({ value: history[next] ?? '', cursor: 0 }))
        } else if (key.downArrow && histIdx >= 0) {
          const next = histIdx + 1
          setHistIdx(next >= history.length ? -1 : next)
          setEd(gotoEnd({ value: next >= history.length ? '' : history[next] ?? '', cursor: 0 }))
        }
        return
      }

      if (key.tab && sugActive) {
        complete()
        return
      }

      const r = applyEditorKey(ed, input, key)
      if (r.handled) {
        setEd(r.state)
        setSugIdx(0)
        return
      }

      // Enter bisa datang sebagai chunk '\r'/'\n' tunggal atau menempel di
      // akhir paste (mis. "/help\r"). Teks sebelum newline diketik, lalu kirim.
      // Paste multiline (newline di tengah chunk) → sisipkan baris baru,
      // perilaku seperti meta+Enter, BUKAN submit.
      const enterIdx = input.indexOf('\r') !== -1 ? input.indexOf('\r') : input.indexOf('\n')
      if (enterIdx !== -1) {
        const hasInteriorNewline =
          /[\r\n]/.test(input.slice(0, enterIdx)) || /[\r\n]/.test(input.slice(enterIdx + 1))
        if (hasInteriorNewline) {
          setEd(insertAt(ed, input.replace(/\r\n?/g, '\n').replace(/\n$/, '')))
          setSugIdx(0)
          return
        }
        const full = ed.value.slice(0, ed.cursor) + input.slice(0, enterIdx) + ed.value.slice(ed.cursor)
        const text = full.trim()
        if (text) {
          setHistory((h) => [...h, text].slice(-50))
          setHistIdx(-1)
          setEd(clearAll())
          onSubmit(text)
        }
      }
    },
    { isActive: active }
  )

  const { value, cursor } = ed
  const at = cursor < value.length ? value[cursor] : undefined
  const pre = at === '\n' ? value.slice(0, cursor + 1) : value.slice(0, cursor)
  const inv = at === undefined || at === '\n' ? ' ' : at
  const post = at === undefined ? '' : value.slice(cursor + 1)

  return (
    <Box flexDirection="column">
      {queue && queue.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {queue.map((q, i) => (
            <Text key={i} dimColor>
              ⏳ [{i + 1}] {q}
            </Text>
          ))}
        </Box>
      )}
      {sugActive && (
        <Box flexDirection="column" paddingLeft={2}>
          {suggestions.map((s, i) => (
            <Text key={s} color={i === sugIdx ? 'cyan' : 'dimColor'}>
              {i === sugIdx ? '❯ ' : '  '}
              {s}
            </Text>
          ))}
          <Text dimColor> Tab untuk lengkapi</Text>
        </Box>
      )}
      <Box
        borderStyle="round"
        borderColor={busy ? 'gray' : 'cyan'}
        paddingX={1}
        marginTop={sugActive || (queue && queue.length > 0) ? 0 : 1}
      >
        <Text color="cyan" bold>
          {busy ? '  … ' : '> '}
        </Text>
        {value === '' ? (
          <Text>
            {active ? <Text inverse> </Text> : ''}
            <Text dimColor>
              {busy
                ? 'agent sedang bekerja — Enter untuk antre, Esc batalkan turn'
                : 'ketik pesan, / untuk perintah, @ untuk sisip file'}
            </Text>
          </Text>
        ) : (
          <Text>
            {pre}
            <Text inverse>{inv}</Text>
            {post}
          </Text>
        )}
      </Box>
    </Box>
  )
}
