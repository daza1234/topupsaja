import React, { useMemo, useState } from 'react'
import { Text, Box, useInput } from 'ink'
import type { ApprovalRequest } from '@topupsaja/core/agent/permission.js'
import { splitHunks } from '@topupsaja/core/agent/hunks.js'
import { derivePatternFromCommand } from '@topupsaja/core/agent/rules.js'

interface Props {
  req: ApprovalRequest
  onAnswer: (approved: boolean, always?: boolean, extra?: { alwaysPattern?: boolean; hunks?: number[] }) => void
}

/** Dialog approval: preview diff/command + [y]es [n]o [a]lways [p]ola + per-hunk (edit_file). */
export function ApprovalDialog({ req, onAnswer }: Props) {
  const isEdit = req.tool === 'edit_file'
  const hunks = useMemo(() => (isEdit ? splitHunks(req.preview) : []), [isEdit, req.preview])
  const hunkMode = hunks.length >= 2
  const [cursor, setCursor] = useState(0)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const bashPattern = req.tool === 'bash' ? derivePatternFromCommand(String(req.args.command ?? '')) : null

  useInput((input, key) => {
    const isEnter = key.return || input === '\r' || input === '\n'
    if (hunkMode) {
      if (key.upArrow || input === 'k') {
        setCursor((c) => Math.max(0, c - 1))
        return
      }
      if (key.downArrow || input === 'j') {
        setCursor((c) => Math.min(hunks.length - 1, c + 1))
        return
      }
      if (input === ' ') {
        setPicked((prev) => {
          const next = new Set(prev)
          const n = cursor + 1
          if (next.has(n)) next.delete(n)
          else next.add(n)
          return next
        })
        return
      }
    }
    if (input === 'y' || (isEnter && !hunkMode)) onAnswer(true)
    else if (isEnter && hunkMode) {
      // Hunk terpilih (kosong → semua).
      const sel = [...picked].sort((a, b) => a - b)
      onAnswer(true, false, sel.length ? { hunks: sel } : undefined)
    } else if (input === 'n' || key.escape) onAnswer(false)
    else if (input === 'a') onAnswer(true, true)
    else if (input === 'p' && req.tool === 'bash') onAnswer(true, false, { alwaysPattern: true })
  })

  const previewLines = req.preview.split('\n').slice(0, 24)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginTop={1}
    >
      <Text color="yellow" bold>
        ● {req.label} — butuh izin
      </Text>
      {previewLines.map((l, i) => (
        <Text key={i} color={l.startsWith('+') ? 'green' : l.startsWith('-') ? 'red' : undefined}>
          {l}
        </Text>
      ))}
      {req.preview.split('\n').length > 24 && <Text dimColor>... (preview dipotong)</Text>}
      {hunkMode && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{hunks.length} hunk — pilih yang mau diterapkan:</Text>
          {hunks.map((h, i) => {
            const n = i + 1
            const on = picked.has(n)
            const cur = i === cursor
            return (
              <Text key={n} color={cur ? 'cyan' : on ? 'green' : undefined}>
                {cur ? '❯ ' : '  '}
                {on ? '[x]' : '[ ]'} hunk {n}: {h.lines.length} baris
                <Text dimColor> ({h.lines[0]?.slice(0, 40)})</Text>
              </Text>
            )
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text bold>
          [<Text color="green">y</Text>]a &nbsp; [<Text color="red">n</Text>]o &nbsp; [
          <Text color="cyan">a</Text>]lways — selalu izinkan {req.tool}
          {bashPattern ? (
            <>
              {' '}
              &nbsp; [<Text color="magenta">p</Text>]ola "{bashPattern}"
            </>
          ) : null}
        </Text>
      </Box>
      {hunkMode && (
        <Text dimColor>
          j/k pilih hunk · space toggle · Enter terapkan hunk terpilih (kosong = semua) · y semua · n tolak
        </Text>
      )}
    </Box>
  )
}
