import React, { useState } from 'react'
import { Text, Box, useInput, useApp } from 'ink'

export interface PickItem {
  label: string
  hint?: string
  value: string
}

interface Props {
  title: string
  items: PickItem[]
  active: boolean
  onSelect: (value: string) => void
  onCancel: () => void
}

/** List picker generik dalam TUI (↑/↓, Enter pilih, Esc batal). */
export function ListPicker({ title, items, active, onSelect, onCancel }: Props) {
  const [idx, setIdx] = useState(0)

  useInput(
    (input, key) => {
      const isEnter = key.return || input === '\r' || input === '\n'
      if (key.upArrow) setIdx((i) => Math.max(0, i - 1))
      else if (key.downArrow) setIdx((i) => Math.min(items.length - 1, i + 1))
      else if (isEnter) onSelect(items[idx]?.value ?? '')
      else if (key.escape) onCancel()
    },
    { isActive: active }
  )

  const visible = items.slice(Math.max(0, idx - 9), Math.max(0, idx - 9) + 12)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      {visible.map((it) => {
        const i = items.indexOf(it)
        const sel = i === idx
        return (
          <Text key={it.value} color={sel ? 'cyan' : undefined} bold={sel}>
            {sel ? '❯ ' : '  '}
            {it.label}
            {it.hint ? <Text dimColor> {it.hint}</Text> : null}
          </Text>
        )
      })}
      <Text dimColor>
        ↑/↓ navigasi · Enter pilih · Esc batal {items.length > 12 ? `(total ${items.length})` : ''}
      </Text>
    </Box>
  )
}

/** Picker standalone (Ink app kecil) — dipakai sebelum TUI utama start. */
export async function pickFromList(title: string, items: PickItem[]): Promise<string | null> {
  const { render } = await import('ink')
  return new Promise((resolve) => {
    let done = false
    const el = React.createElement(StandalonePicker, {
      title,
      items,
      onPick: (v: string | null) => {
        if (done) return
        done = true
        resolve(v)
      },
    })
    const instance = render(el)
    instance.waitUntilExit().catch(() => resolve(null))
  })
}

function StandalonePicker({
  title,
  items,
  onPick,
}: {
  title: string
  items: PickItem[]
  onPick: (v: string | null) => void
}) {
  const { exit } = useApp()
  const [idx, setIdx] = useState(0)

  useInput((input, key) => {
    const isEnter = key.return || input === '\r' || input === '\n'
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1))
    else if (key.downArrow) setIdx((i) => Math.min(items.length - 1, i + 1))
    else if (isEnter) {
      exit()
      onPick(items[idx]?.value ?? null)
    } else if (key.escape || input === 'q') {
      exit()
      onPick(null)
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      {items.map((it, i) => (
        <Text key={it.value} color={i === idx ? 'cyan' : undefined} bold={i === idx}>
          {i === idx ? '❯ ' : '  '}
          {it.label}
          {it.hint ? <Text dimColor> {it.hint}</Text> : null}
        </Text>
      ))}
      <Text dimColor>↑/↓ navigasi · Enter pilih · Esc/q batal</Text>
    </Box>
  )
}
