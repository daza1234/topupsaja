import React, { useEffect, useMemo, useState } from 'react'
import { Box, Static, Text, useApp, useInput } from 'ink'
import type { AgentRuntime } from '@topupsaja/core/agent/runtime.js'
import { runTurn, setMode, setPermissionMode, startNewSession } from '@topupsaja/core/agent/loop.js'
import { compactNow } from '@topupsaja/core/session/compaction.js'
import { detachPath, addDoc, expandMentions } from '@topupsaja/core/session/context.js'
import { buildSystemPrompt, resolveModeArg, discoverCustomModes, modeNotice, ALL_MODES, MODE_INFO } from '@topupsaja/core/agent/modes.js'
import type { Mode } from '@topupsaja/core/agent/modes.js'
import { AgentSession, listSessions } from '@topupsaja/core/session/store.js'
import { fetchModels, getCredits, ApiError } from '@topupsaja/core/api.js'
import { saveConfig } from '@topupsaja/core/config.js'
import { discoverCommands, renderCommand } from '../commands.js'
import { parseMcpToolName, mapPromptArgs, mcpPromptName } from '@topupsaja/core/mcp/client.js'
import { helpText as baseHelp, SHORT_HELP, settingsText, apiText, applyApiKey, addPathMessage, costText, mcpStatusText } from '../usage.js'
import { undoLastTurn, diffCheckpoints } from '@topupsaja/core/agent/checkpoints.js'
import { runLocal, formatRunOutput } from '@topupsaja/core/agent/commands-run.js'
import { collectDiff, generateCommitMessage, performCommit } from '@topupsaja/core/agent/commit.js'
import { useAgentBridge, type Block } from './hooks.js'
import { BlockView } from './components/MessageList.js'
import { ChatInput } from './components/ChatInput.js'
import { ApprovalDialog } from './components/ApprovalDialog.js'
import { AskUserDialog } from './components/AskUserDialog.js'
import { rulesSummary, permissionLogLines } from '@topupsaja/core/agent/rules.js'
import { FileFinder } from './components/FileFinder.js'
import { StatusBar } from './components/StatusBar.js'
import { TodoPanel } from './components/TodoPanel.js'
import { ListPicker } from './components/Picker.js'
import { fmtNum } from '../ui/format.js'

const INIT_PROMPT =
  'Buat file AGENTS.md di root project ini. Isi ringkas dan padat: deskripsi project (deteksi dari struktur & package manifest), cara install/build/dev/test, konvensi kode yang terlihat, dan struktur folder utama. Tulis dalam Bahasa Indonesia.'

export function App({ rt, files }: { rt: AgentRuntime; files: string[] }) {
  const { exit } = useApp()
  const bridge = useAgentBridge(rt)
  const [model, setModel] = useState(rt.session.model)
  const [cwd] = useState(rt.cwd)
  const [inject, setInject] = useState<{ text: string; nonce: number } | undefined>(undefined)
  const [confirm, setConfirm] = useState<{ question: string; onAnswer: (yes: boolean) => void } | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null)
  const customCommands = useMemo(() => discoverCommands(rt.cwd), [rt.cwd])
  const customModes = rt.customModes
  const helpText = baseHelp(customCommands)

  useInput(
    (input, key) => {
      if (key.escape && !bridge.approval && !bridge.askUser) {
        rt.abort = true
        rt.abortController?.abort()
      }
    },
    { isActive: bridge.busy }
  )

  const overlayActive = bridge.overlay !== null
  const expandedTool =
    expandedToolId === null
      ? undefined
      : bridge.blocks.find(
          (b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool' && b.id === expandedToolId
        )

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'p') {
        bridge.setOverlay({ kind: 'files' })
      }
    },
    { isActive: !bridge.busy && !bridge.approval && !overlayActive && !confirm }
  )

  // Ctrl+O: toggle output lengkap tool block terakhir (dirender live di bawah transcript).
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'o') {
        const tools = bridge.blocks.filter((b) => b.kind === 'tool' && b.id)
        const last = tools[tools.length - 1]
        if (last && last.kind === 'tool' && last.id) {
          const id = last.id
          setExpandedToolId((cur) => (cur === id ? null : id))
        }
      }
    },
    { isActive: !bridge.approval && !bridge.askUser && !overlayActive && !confirm }
  )

  // Drain antrean: saat agent selesai (busy false) & tidak ada dialog/overlay, kirim berikutnya.
  useEffect(() => {
    if (bridge.busy || queue.length === 0) return
    if (bridge.approval || bridge.askUser || overlayActive || confirm) return
    const [next, ...rest] = queue
    setQueue(rest)
    void handleSubmit(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge.busy, queue, bridge.approval, bridge.askUser, overlayActive, confirm])

  function quit() {
    void rt.session.save()
    exit()
  }

  async function handleSubmit(raw: string) {
    if (bridge.busy) {
      setQueue((q) => [...q, raw])
      return
    }
    bridge.addUserBlock(raw)

    if (raw.startsWith('/')) {
      await handleSlash(raw)
      return
    }

    bridge.setBusy(true)
    try {
      await runTurn(rt, await expandMentions(raw, rt.cwd))
    } catch (e) {
      bridge.addNotice(`error: ${(e as Error).message}`)
      bridge.setBusy(false)
    }
  }

  function switchMode(m: string) {
    void setMode(rt, m)
    bridge.addNotice(modeNotice(m, rt.customModes))
  }

  /** Slash /mcp__<server>__<prompt> [args...] → prompts/get → turn baru dengan body prompt. */
  async function dispatchMcpPrompt(cmd: string, argsString: string) {
    const parsed = parseMcpToolName(cmd.slice(1))
    const conn = parsed ? rt.mcp.find((c) => c.name === parsed.server) : undefined
    const def = parsed ? conn?.prompts.find((p) => p.name === parsed.tool) : undefined
    if (!conn || conn.status !== 'connected' || !def) {
      bridge.addNotice(
        `Prompt MCP tidak ditemukan: ${cmd}. Cek /mcp untuk status server & prompt yang tersedia.`
      )
      return
    }
    bridge.setBusy(true)
    try {
      const text = await conn.getPrompt(parsed!.tool, mapPromptArgs(def, argsString))
      await runTurn(rt, await expandMentions(text, rt.cwd))
    } catch (e) {
      bridge.addNotice(`error: ${(e as Error).message}`)
      bridge.setBusy(false)
    }
  }

  async function handleSlash(line: string) {
    const [cmd] = line.split(/\s+/)
    switch (cmd) {
      case '/code':
      case '/architect':
      case '/ask':
      case '/test':
      case '/plan':
      case '/act': {
        const m = resolveModeArg(cmd.slice(1))
        if (m) switchMode(m)
        return
      }
      case '/mode': {
        rt.customModes = await discoverCustomModes(rt.cwd)
        const arg = line.slice(cmd.length).trim()
        if (arg) {
          const m = resolveModeArg(arg, rt.customModes)
          if (!m) {
            bridge.addNotice(
              `Mode tidak dikenal: ${arg}. Pilihan: ${ALL_MODES.join(', ')} (alias: plan, act${rt.customModes.length ? `, kustom: ${rt.customModes.map((c) => c.name).join(', ')}` : ''}).`
            )
            return
          }
          switchMode(m)
          return
        }
        bridge.setOverlay({ kind: 'mode' })
        return
      }
      case '/permissions': {
        const order = ['ask', 'auto-edit', 'yolo'] as const
        const next = order[(order.indexOf(rt.permissions.mode) + 1) % order.length]
        await setPermissionMode(rt, next)
        const logLines = permissionLogLines(rt.session.permissionLog, 5)
        bridge.addNotice(
          `Permission mode: ${next} · ${rulesSummary(rt.permissions.rules)}` +
            (logLines.length ? `\n${logLines.join('\n')}` : '')
        )
        return
      }
      case '/sessions':
        bridge.setOverlay({ kind: 'sessions' })
        return
      case '/init':
        bridge.setBusy(true)
        await runTurn(rt, INIT_PROMPT)
        return
      case '/todo':
        bridge.addNotice(`Todo:\n${rt.session.todos.render()}`)
        return
      case '/compact':
        bridge.setBusy(true)
        await compactNow(rt)
        bridge.setBusy(false)
        return
      case '/model':
        bridge.setOverlay({ kind: 'model' })
        return
      case '/settings':
        bridge.setOverlay({ kind: 'settings' })
        return
      case '/api': {
        const arg = line.slice(cmd.length).trim()
        if (!arg) {
          bridge.addNotice(await apiText())
          return
        }
        bridge.setBusy(true)
        const msg = await applyApiKey(rt, arg)
        bridge.setBusy(false)
        bridge.addNotice(msg)
        return
      }
      case '/add': {
        const arg = line.slice(cmd.length).trim()
        if (!arg) {
          bridge.setOverlay({ kind: 'add' })
          return
        }
        bridge.addNotice(await addPathMessage(rt, arg))
        return
      }
      case '/drop': {
        const arg = line.slice(cmd.length).trim()
        if (!arg) {
          bridge.addNotice('Pemakaian: /drop <path|all>')
          return
        }
        bridge.addNotice((await detachPath(rt.session, rt.cwd, arg)).message)
        return
      }
      case '/clear-files':
        bridge.addNotice((await detachPath(rt.session, rt.cwd, 'all')).message)
        return
      case '/add-doc': {
        const url = line.slice(cmd.length).trim()
        if (!url) {
          bridge.addNotice('Pemakaian: /add-doc <url>')
          return
        }
        bridge.addNotice(`Mengambil ${url}…`)
        bridge.addNotice((await addDoc(rt.session, url)).message)
        return
      }
      case '/run':
      case '/terminal': {
        const runCmd = line.slice(cmd.length).trim()
        if (!runCmd) {
          bridge.addNotice('Pemakaian: /run <command>')
          return
        }
        bridge.addNotice(`$ ${runCmd}`)
        const r = await runLocal(rt.cwd, runCmd)
        const formatted = formatRunOutput(runCmd, r)
        rt.session.messages.push({ role: 'user', content: formatted })
        await rt.session.save()
        bridge.addNotice(formatted)
        return
      }
      case '/commit': {
        const d = await collectDiff(rt.cwd)
        if (!d.ok) {
          bridge.addNotice(d.error)
          return
        }
        if (!d.diff.trim()) {
          bridge.addNotice('Tidak ada perubahan untuk di-commit.')
          return
        }
        bridge.setBusy(true)
        let msg: string
        try {
          msg = await generateCommitMessage(rt, d.diff)
        } catch (e) {
          bridge.addNotice(`error: ${(e as Error).message}`)
          bridge.setBusy(false)
          return
        }
        bridge.setBusy(false)
        bridge.addNotice(`Pesan commit:\n${msg}`)
        setConfirm({
          question: 'Commit semua perubahan (git add -A + git commit)?',
          onAnswer: async (yes) => {
            setConfirm(null)
            if (!yes) {
              bridge.addNotice('Commit dibatalkan.')
              return
            }
            const r = await performCommit(rt.cwd, msg)
            bridge.addNotice(r.ok ? `✓ ${r.output}` : `✗ ${r.output}`)
          },
        })
        return
      }
      case '/new':
      case '/new-task': {
        const s = await startNewSession(rt)
        bridge.clearBlocks()
        bridge.addNotice(`Sesi baru: ${s.id} (model ${s.model})`)
        return
      }
      case '/clear':
      case '/reset':
        rt.session.reset(await buildSystemPrompt(rt.cwd, rt.mode, customModes ?? rt.customModes))
        bridge.clearBlocks()
        bridge.addNotice('Riwayat di-reset.')
        return
      case '/cost':
        bridge.addNotice(costText(rt))
        return
      case '/balance':
        try {
          const c = await getCredits()
          bridge.addNotice(
            `saldo ${fmtNum(c.balance)} credit · hari ini ${fmtNum(c.usage_today.credits_used)} credit (${c.usage_today.requests} request) · sesi ini ${fmtNum(rt.session.creditsUsed)} credit`
          )
        } catch (e) {
          bridge.addNotice(`error: ${e instanceof ApiError ? e.message : (e as Error).message}`)
        }
        return
      case '/help':
        bridge.addNotice(helpText)
        return
      case '/undo': {
        const restored = await undoLastTurn(rt)
        bridge.addNotice(restored.length ? `Di-undo: ${restored.join(', ')}` : 'Tidak ada turn yang bisa di-undo.')
        return
      }
      case '/diff':
        bridge.addNotice(await diffCheckpoints(rt))
        return
      case '/mcp': {
        const arg = line.split(/\s+/).slice(1).join(' ').trim()
        if (rt.mcp.length === 0) {
          bridge.addNotice('Tidak ada server MCP. Konfigurasi di <cwd>/.tsa/mcp.json atau ~/.topupsaja/mcp.json.')
          return
        }
        if (arg === 'reconnect') {
          bridge.addNotice('Reconnect semua server MCP…')
          for (const c of rt.mcp) await c.reconnect(rt.cwd)
        }
        bridge.addNotice(mcpStatusText(rt))
        return
      }
      case '/exit':
      case '/quit':
        quit()
        return
      default: {
        if (cmd.startsWith('/mcp__')) {
          await dispatchMcpPrompt(cmd, line.slice(cmd.length).trim())
          return
        }
        const cc = customCommands.find((c) => c.name === cmd)
        if (!cc) {
          bridge.addNotice(`Perintah tidak dikenal: ${cmd}. ${SHORT_HELP}`)
          return
        }
        const args = line.slice(cmd.length).trim()
        bridge.setBusy(true)
        try {
          await runTurn(rt, renderCommand(cc, args))
        } catch (e) {
          bridge.addNotice(`error: ${(e as Error).message}`)
          bridge.setBusy(false)
        }
        return
      }
    }
  }

  // ── Overlay: pilih model / sesi / file / mode / settings ──

  return (
    <Box flexDirection="column">
      <Static items={bridge.blocks.map((b, i) => ({ key: `b${i}`, block: b }))}>
        {({ key, block }) => <BlockView key={key} block={block} />}
      </Static>

      {bridge.streaming && (
        <Box marginTop={1} flexDirection="column">
          <BlockView block={{ kind: 'assistant', text: bridge.streaming }} />
        </Box>
      )}

      {expandedTool && (
        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
          <BlockView block={expandedTool} expanded />
          <Text dimColor> ctrl+o tutup</Text>
        </Box>
      )}

      {bridge.approval && (
        <ApprovalDialog
          req={bridge.approval}
          onAnswer={(approved, always, extra) => {
            void rt.permissions
              .answer(
                bridge.approval!.id,
                {
                  approved,
                  always,
                  alwaysPattern: extra?.alwaysPattern,
                  hunks: extra?.hunks,
                },
                bridge.approval!.tool,
                bridge.approval!.args
              )
              .then((warning) => {
                if (warning) bridge.addNotice(warning)
              })
          }}
        />
      )}

      {bridge.askUser && !bridge.approval && (
        <AskUserDialog
          req={bridge.askUser}
          onAnswer={(answer) => rt.askUser.answer(bridge.askUser!.id, answer)}
        />
      )}

      {confirm && !bridge.approval && (
        <ConfirmDialog question={confirm.question} onAnswer={confirm.onAnswer} />
      )}

      {bridge.overlay?.kind === 'model' && (
        <ModelPicker
          rt={rt}
          onCancel={() => bridge.setOverlay(null)}
          onSelect={(id) => {
            rt.session.model = id
            void rt.session.save()
            void saveConfig({ model: id })
            setModel(id)
            bridge.setOverlay(null)
            bridge.addNotice(`Model diganti ke ${id}`)
          }}
        />
      )}

      {bridge.overlay?.kind === 'mode' && (
        <ModePicker
          rt={rt}
          current={rt.mode}
          onCancel={() => bridge.setOverlay(null)}
          onSelect={(m) => {
            bridge.setOverlay(null)
            switchMode(m)
          }}
        />
      )}

      {bridge.overlay?.kind === 'settings' && (
        <SettingsOverlay rt={rt} onCancel={() => bridge.setOverlay(null)} />
      )}

      {bridge.overlay?.kind === 'files' && (
        <FileFinder
          files={files}
          onPick={(p) => {
            bridge.setOverlay(null)
            setInject({ text: `@${p} `, nonce: Date.now() })
          }}
          onCancel={() => bridge.setOverlay(null)}
        />
      )}

      {bridge.overlay?.kind === 'add' && (
        <FileFinder
          files={files}
          onPick={(p) => {
            bridge.setOverlay(null)
            void addPathMessage(rt, p).then((m) => bridge.addNotice(m))
          }}
          onCancel={() => bridge.setOverlay(null)}
        />
      )}

      {bridge.overlay?.kind === 'sessions' && (
        <SessionPicker
          rt={rt}
          onCancel={() => bridge.setOverlay(null)}
          onSelect={(id) => {
            void AgentSession.load(rt.cwd, id).then((s) => {
              bridge.setOverlay(null)
              if (!s) {
                bridge.addNotice(`Gagal memuat sesi ${id}.`)
                return
              }
              rt.session = s
              rt.mode = s.mode
              rt.permissions.mode = s.permissionMode
              setModel(s.model)
              bridge.clearBlocks()
              bridge.addNotice(`Sesi dimuat: ${s.title} (${s.messages.length} pesan)`)
            })
          }}
        />
      )}

      <TodoPanel items={bridge.todos} />

      <ChatInput
        active={!bridge.approval && !bridge.askUser && !overlayActive && !confirm}
        busy={bridge.busy}
        files={files}
        queue={queue}
        commands={[
          ...customCommands.map((c) => c.name),
          ...rt.mcp.flatMap((c) => c.prompts.map((p) => `/${mcpPromptName(c.name, p.name)}`)),
        ]}
        inject={inject}
        onSubmit={handleSubmit}
      />

      <StatusBar
        mode={bridge.mode}
        permMode={bridge.permMode}
        model={model}
        status={bridge.status}
        busy={bridge.busy}
        sessionCredits={rt.session.creditsUsed}
      />
      <Text dimColor>
        {' '}
        cwd {cwd} · Esc batalkan turn · ctrl+p cari file · ctrl+o expand tool · ctrl+c keluar
      </Text>
    </Box>
  )
}

function ModelPicker({
  rt,
  onSelect,
  onCancel,
}: {
  rt: AgentRuntime
  onSelect: (id: string) => void
  onCancel: () => void
}) {
  const [items, setItems] = useState<{ label: string; hint?: string; value: string }[] | null>(null)
  React.useEffect(() => {
    fetchModels()
      .then((models) =>
        setItems(
          models.map((m) => ({
            value: m.id,
            label: m.id,
            hint: `[${m.tier}] in ${fmtNum(m.pricing.input)} / out ${fmtNum(m.pricing.output)} cr/1k${m.supports_vision ? ' [vision]' : ''}`,
          }))
        )
      )
      .catch(() => setItems([]))
  }, [rt])
  if (!items) return <Text dimColor>memuat model…</Text>
  return <ListPicker title="Pilih model" items={items} active onSelect={onSelect} onCancel={onCancel} />
}

function ModePicker({
  rt,
  current,
  onSelect,
  onCancel,
}: {
  rt: AgentRuntime
  current: string
  onSelect: (m: string) => void
  onCancel: () => void
}) {
  const items = [
    ...ALL_MODES.map((m) => ({
      value: m as string,
      label: `${m}${m === current ? '  ← saat ini' : ''}`,
      hint: MODE_INFO[m],
    })),
    ...rt.customModes.map((c) => ({
      value: c.name,
      label: `${c.name} [custom]${c.name === current ? '  ← saat ini' : ''}`,
      hint: `${c.description}${c.readOnly ? ' · read-only' : ''}`,
    })),
  ]
  return <ListPicker title="Pilih mode" items={items} active onSelect={onSelect} onCancel={onCancel} />
}

function SettingsOverlay({ rt, onCancel }: { rt: AgentRuntime; onCancel: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null)
  React.useEffect(() => {
    settingsText(rt).then((t) => setLines(t.split('\n')))
  }, [rt])
  useInput((input, key) => {
    if (key.escape) onCancel()
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold color="cyan">
        Settings (read-only)
      </Text>
      {lines ? (
        lines.map((l, i) => <Text key={i}>{l}</Text>)
      ) : (
        <Text dimColor>memuat…</Text>
      )}
      <Text dimColor> Esc tutup · ubah nilai via /model, /permissions, atau `topupsaja login` di terminal</Text>
    </Box>
  )
}

function ConfirmDialog({ question, onAnswer }: { question: string; onAnswer: (yes: boolean) => void }) {
  useInput((input, key) => {
    const isEnter = key.return || input === '\r' || input === '\n'
    if (input === 'y' || isEnter) onAnswer(true)
    else if (input === 'n' || key.escape) onAnswer(false)
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>
        ● {question}
      </Text>
      <Box marginTop={1}>
        <Text bold>
          [<Text color="green">y</Text>]a &nbsp; [<Text color="red">n</Text>]o
        </Text>
      </Box>
    </Box>
  )
}

function SessionPicker({
  rt,
  onSelect,
  onCancel,
}: {
  rt: AgentRuntime
  onSelect: (id: string) => void
  onCancel: () => void
}) {
  const [items, setItems] = useState<{ value: string; label: string; hint: string }[] | null>(null)
  React.useEffect(() => {
    listSessions(rt.cwd).then((sessions) =>
      setItems(
        sessions.map((s) => ({
          value: s.id,
          label: s.title,
          hint: `${s.model} · ${new Date(s.updated).toLocaleString('id-ID')}`,
        }))
      )
    )
  }, [rt])
  if (items === null) return <Text dimColor>memuat sesi…</Text>
  if (items.length === 0) {
    return <Text color="yellow"> Tidak ada sesi tersimpan untuk folder ini.</Text>
  }
  return <ListPicker title="Lanjutkan sesi" items={items} active onSelect={onSelect} onCancel={onCancel} />
}
