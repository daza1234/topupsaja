import React, { useState } from 'react'
import { Text, Box, useInput } from 'ink'
import type { AskUserRequest, AskUserAnswer } from '../../agent/runtime.js'

interface Props {
  req: AskUserRequest
  onAnswer: (answer: AskUserAnswer) => void
}

/**
 * Dialog pertanyaan ask_user: navigasi opsi ↑/↓ + Enter, free text (ketik
 * langsung, Enter kirim), Esc = batal. Multi-select: Space toggle item,
 * Enter kirim pilihan (kosong → pakai teks; keduanya kosong → opsi kursor).
 */
export function AskUserDialog({ req, onAnswer }: Props) {
  const multi = !!req.multiSelect
  const [sel, setSel] = useState(0)
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<Set<number>>(new Set())

  useInput((input, key) => {
    const isEnter = key.return || input === '\r' || input === '\n'
    if (key.escape) onAnswer({ kind: 'cancel' })
    else if (key.upArrow) setSel((s) => Math.max(0, s - 1))
    else if (key.downArrow) setSel((s) => Math.min(req.options.length - 1, s + 1))
    else if (key.backspace || key.delete) setText((t) => t.slice(0, -1))
    else if (multi && input === ' ') {
      setPicked((prev) => {
        const next = new Set(prev)
        if (next.has(sel)) next.delete(sel)
        else next.add(sel)
        return next
      })
    } else if (isEnter) {
      if (multi) {
        if (picked.size > 0) {
          const labels = [...picked].sort((a, b) => a - b).map((n) => req.options[n].label)
          onAnswer({ kind: 'options', labels })
        } else if (text.trim()) {
          onAnswer({ kind: 'text', text: text.trim() })
        } else {
          onAnswer({ kind: 'option', label: req.options[sel].label })
        }
      } else {
        if (text.trim()) onAnswer({ kind: 'text', text: text.trim() })
        else onAnswer({ kind: 'option', label: req.options[sel].label })
      }
    } else if (input && !key.ctrl && !key.meta) setText((t) => t + input)
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        ● Pertanyaan agent{multi ? ' (multi-select)' : ''}
      </Text>
      <Text>{req.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {req.options.map((o, i) => {
          const cur = i === sel && !text
          const on = multi && picked.has(i)
          return (
            <Text key={i} color={cur ? 'cyan' : on ? 'green' : undefined}>
              {cur ? '❯ ' : '  '}
              {multi ? `${on ? '[x]' : '[ ]'} ` : ''}
              {o.label}
              {o.description ? <Text dimColor> — {o.description}</Text> : null}
            </Text>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text>
          {text ? (
            <>
              jawaban: <Text color="green">{text}</Text>
              <Text dimColor>│</Text>
            </>
          ) : (
            <Text dimColor>ketik utk jawaban bebas · </Text>
          )}
          <Text dimColor>
            {multi ? 'space toggle · ' : ''}↑/↓ pilih · Enter kirim · Esc batal
          </Text>
        </Text>
      </Box>
    </Box>
  )
}
