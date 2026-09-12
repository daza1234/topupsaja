import React, { useEffect, useRef, useState } from 'react'
import { Text, Box, useInput } from 'ink'
import { SLASH_COMMANDS } from '../../usage.js'

interface Props {
  active: boolean
  busy: boolean
  files: string[]
  /** Custom slash commands (dari .tsa/commands & ~/.topupsaja/commands). */
  commands?: string[]
  /** Sisipkan teks ke input (mis. @path dari FileFinder Ctrl+P). */
  inject?: { text: string; nonce: number }
  onSubmit: (text: string) => void
}

/** Input chat: Enter kirim, Shift/Alt+Enter baris baru, ↑/↓ riwayat,
 *  Tab lengkapi autocomplete @path & slash-command. */
export function ChatInput({ active, busy, files, commands, inject, onSubmit }: Props) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [sugIdx, setSugIdx] = useState(0)
  const lastNonce = useRef(-1)
  const allCommands = commands && commands.length > 0 ? [...SLASH_COMMANDS, ...commands] : SLASH_COMMANDS

  useEffect(() => {
    if (inject && inject.nonce !== lastNonce.current) {
      lastNonce.current = inject.nonce
      setValue((v) => v + inject.text)
    }
  }, [inject])

  // ── Autocomplete sederhana ──
  const lastWord = value.split(/\s/).pop() ?? ''
  let suggestions: string[] = []
  let suggestionPrefix = ''
  if (lastWord.startsWith('@') && lastWord.length >= 1) {
    suggestionPrefix = lastWord.slice(1)
    const q = suggestionPrefix.toLowerCase()
    suggestions = files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8)
  } else if (value === '/' || (value.startsWith('/') && !value.includes(' ') && value.length >= 1)) {
    suggestionPrefix = value
    suggestions = allCommands.filter((c) => c.startsWith(value)).slice(0, 8)
  }
  const sugActive = suggestions.length > 0

  function complete() {
    const pick = suggestions[sugIdx] ?? suggestions[0]
    if (!pick) return
    if (lastWord.startsWith('@')) {
      const head = value.slice(0, value.length - lastWord.length)
      setValue(`${head}@${pick} `)
    } else {
      setValue(`${pick} `)
    }
    setSugIdx(0)
  }

  useInput(
    (input, key) => {
      // Riwayat ↑/↓ saat tidak ada saran.
      if (key.upArrow && !sugActive) {
        if (history.length === 0) return
        const next = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1)
        setHistIdx(next)
        setValue(history[next] ?? '')
        return
      }
      if (key.downArrow && !sugActive) {
        if (histIdx < 0) return
        const next = histIdx + 1
        if (next >= history.length) {
          setHistIdx(-1)
          setValue('')
        } else {
          setHistIdx(next)
          setValue(history[next] ?? '')
        }
        return
      }

      if (key.tab && sugActive) {
        complete()
        return
      }

      if (key.upArrow && sugActive) {
        setSugIdx((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow && sugActive) {
        setSugIdx((i) => Math.min(suggestions.length - 1, i + 1))
        return
      }

      // Shift/Alt+Enter → baris baru (termasuk paste multiline dengan meta).
      if (key.meta) {
        setValue((v) => v + input.replace(/[\r]/g, '\n').replace(/^\u001b/, ''))
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
          const cleaned = input.replace(/\r\n?/g, '\n').replace(/\n$/, '')
          setValue((v) => v + cleaned)
          setSugIdx(0)
          return
        }
        const before = input.slice(0, enterIdx)
        const next = value + before
        const text = next.trim()
        if (text) {
          setHistory((h) => [...h, text].slice(-50))
          setHistIdx(-1)
          setValue('')
          onSubmit(text)
        }
        return
      }

      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1))
        setSugIdx(0)
        return
      }

      if (key.ctrl && input === 'u') {
        setValue('')
        return
      }

      if (input && !key.ctrl && !key.upArrow && !key.downArrow) {
        setValue((v) => v + input)
        setSugIdx(0)
      }
    },
    { isActive: active }
  )

  const lines = value.split('\n')

  return (
    <Box flexDirection="column">
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
        marginTop={sugActive ? 0 : 1}
      >
        <Text color="cyan" bold>
          {busy ? '  … ' : '> '}
        </Text>
        {value === '' ? (
          <Text dimColor>{busy ? 'agent sedang bekerja — Esc untuk batalkan' : 'ketik pesan, / untuk perintah, @ untuk sisip file'}</Text>
        ) : (
          <Text>{lines.join('\n')}</Text>
        )}
      </Box>
    </Box>
  )
}
