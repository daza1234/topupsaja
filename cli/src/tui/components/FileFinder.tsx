import React, { useMemo, useState } from 'react'
import { Text, Box, useInput } from 'ink'

/** Subsequence fuzzy match. Return skor (lebih besar = lebih cocok) atau null. */
export function fuzzyScore(pattern: string, text: string): number | null {
  if (!pattern) return 1
  const p = pattern.toLowerCase()
  const t = text.toLowerCase()
  let score = 0
  let ti = 0
  let prev = -2
  for (let pi = 0; pi < p.length; pi++) {
    const found = t.indexOf(p[pi], ti)
    if (found === -1) return null
    score += 1
    if (found === prev + 1) score += 3 // huruf beruntun
    if (found === 0 || '/-_. '.includes(t[found - 1])) score += 4 // awal kata/segmen
    prev = found
    ti = found + 1
  }
  return score - Math.floor(t.length / 10) // prefer nama pendek
}

export function fuzzyFind(files: string[], query: string, limit = 20): string[] {
  const scored: { f: string; s: number }[] = []
  for (const f of files) {
    const s = fuzzyScore(query, f)
    if (s !== null) scored.push({ f, s })
  }
  return scored
    .sort((a, b) => b.s - a.s || a.f.localeCompare(b.f))
    .slice(0, limit)
    .map((x) => x.f)
}

interface Props {
  files: string[]
  onPick: (path: string) => void
  onCancel: () => void
}

/** Overlay Ctrl+P: cari file proyek (fuzzy), Enter sisipkan @path ke input. */
export function FileFinder({ files, onPick, onCancel }: Props) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const matches = useMemo(() => fuzzyFind(files, q), [files, q])
  const selected = Math.min(idx, Math.max(0, matches.length - 1))

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'p')) {
      onCancel()
      return
    }
    if (key.return) {
      const pick = matches[selected]
      if (pick) onPick(pick)
      else onCancel()
      return
    }
    if (key.upArrow) {
      setIdx(Math.max(0, selected - 1))
      return
    }
    if (key.downArrow) {
      setIdx(Math.min(matches.length - 1, selected + 1))
      return
    }
    if (key.backspace || key.delete) {
      setQ((v) => v.slice(0, -1))
      setIdx(0)
      return
    }
    if (input && !key.ctrl) {
      setQ((v) => v + input)
      setIdx(0)
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta"> cari file: {q || '(semua)'} </Text>
      {matches.length === 0 && <Text dimColor> tidak ada file cocok </Text>}
      {matches.slice(0, 10).map((f, i) => (
        <Text key={f} color={i === selected ? 'magenta' : 'dimColor'}>
          {i === selected ? '❯ ' : '  '}
          {f}
        </Text>
      ))}
      <Text dimColor> ↑/↓ navigasi · Enter sisipkan @path · Esc tutup </Text>
    </Box>
  )
}
