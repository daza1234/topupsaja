import React from 'react'
import { Text, Box } from 'ink'
import { fmtNum } from '../../ui/format.js'

const MODE_LABEL: Record<string, { text: string; color: string }> = {
  code: { text: 'CODE', color: 'green' },
  architect: { text: 'ARCHITECT', color: 'yellow' },
  ask: { text: 'ASK', color: 'magenta' },
  test: { text: 'TEST', color: 'blue' },
}

interface Props {
  mode: string
  permMode: string
  model: string
  status: {
    promptTokens?: number
    completionTokens?: number
    creditsUsed?: number
    balance?: number
    contextPct?: number
  } | null
  busy: boolean
  /** Total credit terpakai sepanjang sesi. */
  sessionCredits?: number
}

/** Status bar bawah: mode, permission, model, token, saldo, konteks. */
export function StatusBar({ mode, permMode, model, status, busy, sessionCredits }: Props) {
  const label = MODE_LABEL[mode] ?? { text: mode.toUpperCase(), color: 'cyan' }
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="row" columnGap={2}>
      <Text bold color={label.color}>
        {label.text}
      </Text>
      <Text color="magenta">{permMode}</Text>
      <Text dimColor>{model}</Text>
      {busy && <Text color="cyan">…</Text>}
      {status?.promptTokens !== undefined && <Text dimColor>↑{fmtNum(status.promptTokens)}</Text>}
      {status?.completionTokens !== undefined && <Text dimColor>↓{fmtNum(status.completionTokens)}</Text>}
      {status?.contextPct !== undefined && (
        <Text color={status.contextPct > 70 ? 'yellow' : 'dimColor'}>ctx {status.contextPct}%</Text>
      )}
      {status?.creditsUsed !== undefined && <Text color="yellow">-{fmtNum(status.creditsUsed)} cr</Text>}
      {sessionCredits !== undefined && sessionCredits > 0 && (
        <Text color="yellow">sesi {fmtNum(sessionCredits)} cr</Text>
      )}
      {status?.balance !== undefined && <Text color="green">saldo {fmtNum(status.balance)}</Text>}
    </Box>
  )
}
