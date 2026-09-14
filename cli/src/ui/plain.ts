import pc from 'picocolors'
import { ApiError, getCredits, fetchModels } from '@topupsaja/core/api.js'
import { ask, askYesNo, closeRl, getRl } from '../io.js'
import { runTurn, setMode, setPermissionMode, startNewSession } from '@topupsaja/core/agent/loop.js'
import { compactNow, messagesTokens, contextWindowFor } from '@topupsaja/core/session/compaction.js'
import { detachPath, addDoc, expandMentions, loadAgentsMd } from '@topupsaja/core/session/context.js'
import { buildSystemPrompt, resolveModeArg, discoverCustomModes, modeNotice, ALL_MODES, MODE_INFO } from '@topupsaja/core/agent/modes.js'
import { AgentSession, listSessions } from '@topupsaja/core/session/store.js'
import { discoverCommands, renderCommand } from '../commands.js'
import { parseMcpToolName, mapPromptArgs } from '@topupsaja/core/mcp/client.js'
import { helpText as baseHelp, SHORT_HELP, settingsText, apiText, applyApiKey, addPathMessage, costText, mcpStatusText } from '../usage.js'
import { undoLastTurn, diffCheckpoints } from '@topupsaja/core/agent/checkpoints.js'
import { runLocal, formatRunOutput } from '@topupsaja/core/agent/commands-run.js'
import { collectDiff, generateCommitMessage, performCommit } from '@topupsaja/core/agent/commit.js'
import { rulesSummary, derivePatternFromCommand, permissionLogLines } from '@topupsaja/core/agent/rules.js'
import type { AgentRuntime } from '@topupsaja/core/agent/runtime.js'
import type { AskUserRequest } from '@topupsaja/core/agent/runtime.js'
import { fmtNum, truncate } from './format.js'

/** Help penuh: built-in (berkelompok) + custom commands (discovery per pemanggilan). */
function fullHelp(cwd: string): string {
  return baseHelp(discoverCommands(cwd))
}

const INIT_PROMPT =
  'Buat file AGENTS.md di root project ini. Isi ringkas dan padat: deskripsi project (deteksi dari struktur & package manifest), cara install/build/dev/test, konvensi kode yang terlihat, dan struktur folder utama. Tulis dalam Bahasa Indonesia.'

/** Banner sesi teks polos. */
export async function banner(rt: AgentRuntime): Promise<void> {
  const agents = (await loadAgentsMd(rt.cwd)) ? ' · AGENTS.md dimuat' : ''
  const rules = rt.permissions.rules.length > 0 ? ` · ${rt.permissions.rules.length} aturan` : ''
  const lines = [
    `${pc.bold(pc.cyan('topupsaja'))} ${pc.dim('v2 — coding agent TopUpSaja (mode non-TTY)')}`,
    pc.dim(
      `model: ${rt.session.model} · mode: ${rt.mode} · permission: ${rt.permissions.mode}${rules}${agents}`
    ),
    pc.dim(`cwd: ${rt.cwd}`),
    pc.dim(SHORT_HELP),
  ]
  process.stdout.write(lines.join('\n') + '\n\n')
}

/** Pasang listener event → stdout (warna). Return fungsi detach. */
export function installPlainListeners(rt: AgentRuntime): () => void {
  let inApproval = false

  const offs = [
    rt.emitter.on('delta', (t) => process.stdout.write(t)),
    rt.emitter.on('tool_start', ({ name, desc }) => {
      process.stdout.write(`\n${pc.magenta('●')} ${pc.bold(name)} ${pc.dim(desc)}\n`)
    }),
    rt.emitter.on('tool_result', ({ ok, output }) => {
      const first = output.split('\n')[0] ?? ''
      process.stdout.write(
        ok ? `${pc.green('✓')} ${pc.dim(truncate(first, 120))}\n` : `${pc.red('✗ ' + truncate(output, 300))}\n`
      )
    }),
    rt.emitter.on('approval_request', async (req) => {
      inApproval = true
      process.stdout.write(`\n${pc.bold('●')} ${pc.cyan(req.label)}\n`)
      if (req.preview) {
        process.stdout.write(
          req.preview
            .split('\n')
            .map((l) => (l.startsWith('+') ? pc.green(l) : l.startsWith('-') ? pc.red(l) : l))
            .join('\n') + '\n'
        )
      }
      // y = izinkan, a = izinkan + selalu, p = pola (bash saja), n = tolak.
      let approved = false
      let always = false
      let alwaysPattern = false
      while (true) {
        const hint = req.tool === 'bash' ? derivePatternFromCommand(String(req.args.command ?? '')) : null
        const prompt = hint
          ? `Izinkan? [y]a / [n]o / [a]lways tool / [p]ola "${hint}": `
          : 'Izinkan? [y]a / [n]o / [a]lways: '
        const ans = (await ask(pc.bold(prompt))).trim().toLowerCase()
        if (ans === 'y' || ans === 'yes') {
          approved = true
          break
        }
        if (ans === 'a' || ans === 'always') {
          approved = true
          always = true
          break
        }
        if (ans === 'p' && req.tool === 'bash') {
          approved = true
          alwaysPattern = true
          break
        }
        if (ans === 'n' || ans === 'no' || ans === '') break
      }
      const warning = await rt.permissions.answer(
        req.id,
        { approved, always: approved && always, alwaysPattern: approved && alwaysPattern },
        req.tool,
        req.args
      )
      if (warning) process.stdout.write(pc.yellow(`⚠ ${warning}\n`))
      inApproval = false
    }),
    rt.emitter.on('ask_user_request', async (req) => {
      process.stdout.write(`\n${pc.bold('●')} ${pc.cyan('Pertanyaan agent')}\n${req.question}\n`)
      req.options.forEach((o, i) => {
        process.stdout.write(
          `  ${pc.bold(String(i + 1).padStart(2))}. ${pc.bold(o.label)}${o.description ? pc.dim(` — ${o.description}`) : ''}\n`
        )
      })
      const multi = req.multiSelect
      const ans = (
        await ask(
          multi
            ? pc.bold('Pilih (nomor dipisah koma, teks bebas, kosong=batal): ')
            : pc.bold('Jawab (nomor / teks bebas, kosongkan batal): ')
        )
      ).trim()
      if (!ans) {
        rt.askUser.answer(req.id, { kind: 'cancel' })
        return
      }
      if (multi) {
        // `1,3` → semua nomor valid → multi-select; campuran/teks lain → free text.
        const parts = ans.split(',').map((p) => p.trim()).filter(Boolean)
        const nums = parts.map((p) => parseInt(p, 10))
        const allValid = parts.length > 0 && parts.every((p, i) => String(nums[i]) === p && nums[i] >= 1 && nums[i] <= req.options.length)
        if (allValid) {
          const labels = [...new Set(nums)].map((n) => req.options[n - 1].label)
          rt.askUser.answer(req.id, { kind: 'options', labels })
          return
        }
        rt.askUser.answer(req.id, { kind: 'text', text: ans })
        return
      }
      const idx = parseInt(ans, 10)
      if (String(idx) === ans && idx >= 1 && idx <= req.options.length) {
        rt.askUser.answer(req.id, { kind: 'option', label: req.options[idx - 1].label })
      } else {
        rt.askUser.answer(req.id, { kind: 'text', text: ans })
      }
    }),
    rt.emitter.on('status', ({ model, promptTokens, completionTokens, creditsUsed, balance, contextPct }) => {
      const parts = [pc.bold(model)]
      if (promptTokens !== undefined) parts.push(pc.dim(`↑${fmtNum(promptTokens)} tok`))
      if (completionTokens !== undefined) parts.push(pc.dim(`↓${fmtNum(completionTokens)} tok`))
      if (contextPct !== undefined) parts.push(pc.dim(`ctx ${contextPct}%`))
      if (creditsUsed !== undefined) parts.push(pc.yellow(`-${fmtNum(creditsUsed)} credit`))
      if (balance !== undefined) parts.push(pc.green(`saldo ${fmtNum(balance)}`))
      process.stdout.write(pc.dim('  ─ ') + parts.join(pc.dim(' · ')) + '\n')
    }),
    rt.emitter.on('notice', (text) => process.stdout.write(pc.yellow(`⚠ ${text}\n`))),
    rt.emitter.on('error', (message) => process.stdout.write(pc.red(`✗ ${message}\n`))),
    rt.emitter.on('todo', (items) => {
      if (items.length === 0) return
      process.stdout.write(pc.dim('todo:\n') + pc.dim(rt.session.todos.render()) + '\n')
    }),
    rt.emitter.on('done', () => process.stdout.write('\n')),
  ]
  void inApproval
  return () => offs.forEach((off) => off())
}

/** Jalankan satu turn lalu selesai (mode non-interaktif / -p). */
export async function runOneShot(rt: AgentRuntime, prompt: string): Promise<void> {
  const detach = installPlainListeners(rt)
  try {
    await runTurn(rt, await expandMentions(prompt, rt.cwd))
  } finally {
    detach()
  }
}

/**
 * Guard ask_user untuk mode --print: auto-answer cancel + notice stderr —
 * agar turn tidak menggantung menunggu jawaban yang tidak akan datang.
 * Return fungsi detach (dites unit).
 */
export function installPrintAskUserGuard(rt: AgentRuntime): () => void {
  return rt.emitter.on('ask_user_request', (req) => {
    process.stderr.write(`⚠ ask_user tidak tersedia di mode --print — dijawab otomatis (batal).\n`)
    rt.askUser.answer(req.id, { kind: 'cancel' })
  })
}

export interface PrintResult {
  result: string
  session_id: string
  model: string
  tokens: { in: number; out: number }
  credits_used: number
}

/**
 * Mode --print: satu turn headless. Delta dikumpulkan (bukan dicetak),
 * notice/error ke stderr agar stdout bersih untuk pipe/json.
 */
export async function runPrint(
  rt: AgentRuntime,
  prompt: string,
  _format: 'text' | 'json'
): Promise<PrintResult> {
  let text = ''
  let tokIn = 0
  let tokOut = 0
  const detachGuard = installPrintAskUserGuard(rt)
  const offs = [
    rt.emitter.on('delta', (t) => {
      text += t
    }),
    rt.emitter.on('status', ({ promptTokens, completionTokens }) => {
      tokIn += promptTokens ?? 0
      tokOut += completionTokens ?? 0
    }),
    rt.emitter.on('notice', (t) => process.stderr.write(`⚠ ${t}\n`)),
    rt.emitter.on('error', (m) => process.stderr.write(`✗ ${m}\n`)),
  ]
  try {
    await runTurn(rt, await expandMentions(prompt, rt.cwd))
  } finally {
    detachGuard()
    offs.forEach((off) => off())
  }
  return {
    result: text,
    session_id: rt.session.id,
    model: rt.session.model,
    tokens: { in: tokIn, out: tokOut },
    credits_used: rt.session.creditsUsed,
  }
}

async function pickModelPlain(preferred?: string): Promise<string | null> {
  const models = await fetchModels()
  if (models.length === 0) throw new Error('Tidak ada model aktif di server.')
  process.stdout.write('\n')
  models.forEach((m, i) => {
    const cur = m.id === preferred ? pc.green(' ← saat ini') : ''
    process.stdout.write(
      `  ${pc.bold(String(i + 1).padStart(2))}. ${pc.cyan(m.id)} ${pc.dim(`[${m.tier}]`)}  ${pc.dim(`in ${fmtNum(m.pricing.input)} / out ${fmtNum(m.pricing.output)} cr/1k`)}${m.supports_vision ? pc.dim(' [vision]') : ''}${cur}\n`
    )
  })
  process.stdout.write('\n')
  while (true) {
    const ans = (await ask(pc.bold('Pilih model (nomor/id, kosongkan batal): '))).trim()
    if (!ans) return null
    const idx = parseInt(ans, 10)
    if (idx >= 1 && idx <= models.length) return models[idx - 1].id
    const byId = models.find((m) => m.id === ans)
    if (byId) return byId.id
    process.stdout.write(pc.red(`Pilihan tidak valid: '${ans}'.\n`))
  }
}

async function pickSessionPlain(rt: AgentRuntime): Promise<AgentSession | null> {
  const sessions = await listSessions(rt.cwd)
  if (sessions.length === 0) {
    process.stdout.write(pc.yellow('Tidak ada sesi tersimpan untuk folder ini.\n'))
    return null
  }
  process.stdout.write('\n')
  sessions.slice(0, 15).forEach((s, i) => {
    process.stdout.write(
      `  ${pc.bold(String(i + 1).padStart(2))}. ${s.title}  ${pc.dim(`${s.model} · ${new Date(s.updated).toLocaleString('id-ID')}`)}\n`
    )
  })
  process.stdout.write('\n')
  while (true) {
    const ans = (await ask(pc.bold('Pilih sesi (nomor, kosongkan batal): '))).trim()
    if (!ans) return null
    const idx = parseInt(ans, 10)
    if (idx >= 1 && idx <= Math.min(15, sessions.length)) {
      return (await AgentSession.load(rt.cwd, sessions[idx - 1].id)) ?? null
    }
    process.stdout.write(pc.red(`Pilihan tidak valid: '${ans}'.\n`))
  }
}

/** REPL teks polos — fallback non-TTY. */
export async function runPlainRepl(rt: AgentRuntime): Promise<void> {
  banner(rt)
  installPlainListeners(rt)

  // Ctrl+C: saat busy = abort turn (turn ke-2 keluar), idle = keluar.
  let busy = false
  let abortRequested = false
  getRl().on('SIGINT', () => {
    if (busy) {
      abortRequested = true
      rt.abort = true
      rt.abortController?.abort()
      process.stdout.write(pc.yellow('\n⚠ membatalkan turn…\n'))
    } else {
      process.stdout.write('\n')
      process.exit(0)
    }
  })

  const doTurn = async (input: string) => {
    busy = true
    abortRequested = false
    try {
      await runTurn(rt, input)
    } catch (e) {
      process.stdout.write(pc.red(`\n✗ ${(e as Error).message}\n\n`))
    } finally {
      busy = false
    }
  }

  while (true) {
    let input: string
    try {
      input = await ask(pc.cyan(pc.bold('> ')))
    } catch {
      break
    }
    // Non-TTY: '' berarti EOF/empty line — hentikan REPL agar tidak loop.
    if (!process.stdin.isTTY && input.trim() === '') break
    const line = input.trim()
    if (!line) continue

    if (line === '/exit' || line === '/quit') break

    if (line.startsWith('/')) {
      const [cmd] = line.split(/\s+/)
      try {
        switch (cmd) {
          case '/code':
          case '/architect':
          case '/ask':
          case '/test':
          case '/plan':
          case '/act': {
            const m = resolveModeArg(cmd.slice(1), rt.customModes)
            if (m) {
              await setMode(rt, m)
              process.stdout.write(pc.green(modeNotice(m, rt.customModes) + '\n\n'))
            }
            continue
          }
          case '/mode': {
            rt.customModes = await discoverCustomModes(rt.cwd)
            const arg = line.split(/\s+/).slice(1).join(' ').trim()
            if (!arg) {
              process.stdout.write('\n')
              for (const m of ALL_MODES) {
                const cur = m === rt.mode ? pc.green(' ← saat ini') : ''
                process.stdout.write(`  ${pc.bold(m.padEnd(10))} ${pc.dim(MODE_INFO[m])}${cur}\n`)
              }
              for (const c of rt.customModes) {
                const cur = c.name === rt.mode ? pc.green(' ← saat ini') : ''
                process.stdout.write(
                  `  ${pc.bold(c.name.padEnd(10))} ${pc.dim(`${c.description || 'mode kustom'}${c.readOnly ? ' · read-only' : ''} [custom]`)}${cur}\n`
                )
              }
              process.stdout.write(
                pc.dim('\nPemakaian: /mode <nama> (alias: plan, act; kustom: .tsa/modes/*.md)\n\n')
              )
              continue
            }
            const m = resolveModeArg(arg, rt.customModes)
            if (!m) {
              const customList = rt.customModes.length ? `, kustom: ${rt.customModes.map((c) => c.name).join(', ')}` : ''
              process.stdout.write(
                pc.yellow(`Mode tidak dikenal: ${arg}. Pilihan: ${ALL_MODES.join(', ')} (alias: plan, act${customList})\n\n`)
              )
              continue
            }
            await setMode(rt, m)
            process.stdout.write(pc.green(modeNotice(m, rt.customModes) + '\n\n'))
            continue
          }
          case '/permissions': {
            const order = ['ask', 'auto-edit', 'yolo'] as const
            const next = order[(order.indexOf(rt.permissions.mode) + 1) % order.length]
            await setPermissionMode(rt, next)
            const logLines = permissionLogLines(rt.session.permissionLog, 5)
            process.stdout.write(
              pc.green(`Permission mode: ${next}`) +
                pc.dim(` · ${rulesSummary(rt.permissions.rules)}`) +
                (logLines.length ? `\n${pc.dim(logLines.join('\n'))}` : '') +
                '\n\n'
            )
            continue
          }
          case '/sessions': {
            const s = await pickSessionPlain(rt)
            if (s) {
              rt.session = s
              rt.mode = s.mode
              rt.permissions.mode = s.permissionMode
              process.stdout.write(
                pc.green(`Sesi dimuat: ${s.title} (${s.messages.length} pesan)\n\n`)
              )
            }
            continue
          }
          case '/init':
            await doTurn(INIT_PROMPT)
            continue
          case '/todo':
            process.stdout.write(`todo:\n${rt.session.todos.render()}\n\n`)
            continue
          case '/compact':
            busy = true
            try {
              await compactNow(rt)
            } finally {
              busy = false
            }
            continue
          case '/model': {
            const picked = await pickModelPlain(rt.session.model)
            if (picked) {
              rt.session.model = picked
              await rt.session.save()
              process.stdout.write(pc.green(`model diganti ke ${picked}\n\n`))
            }
            continue
          }
          case '/settings':
            process.stdout.write(pc.dim(`\n${await settingsText(rt)}\n\nubah: /model, /permissions, atau \`topupsaja login\` di terminal\n\n`))
            continue
          case '/api': {
            const arg = line.slice(cmd.length).trim()
            if (!arg) {
              process.stdout.write(pc.dim((await apiText()) + '\n\n'))
              continue
            }
            busy = true
            try {
              const msg = await applyApiKey(rt, arg)
              process.stdout.write((msg.startsWith('Key valid') ? pc.green(msg) : pc.yellow(msg)) + '\n\n')
            } finally {
              busy = false
            }
            continue
          }
          case '/add': {
            const arg = line.slice(cmd.length).trim()
            if (!arg) {
              process.stdout.write(pc.dim('Pemakaian: /add <path|folder>  (TUI: /add tanpa arg buka pencari file)\n\n'))
              continue
            }
            process.stdout.write(pc.dim((await addPathMessage(rt, arg)) + '\n\n'))
            continue
          }
          case '/drop': {
            const arg = line.slice(cmd.length).trim()
            if (!arg) {
              process.stdout.write(pc.dim('Pemakaian: /drop <path|all>\n\n'))
              continue
            }
            process.stdout.write(pc.dim((await detachPath(rt.session, rt.cwd, arg)).message + '\n\n'))
            continue
          }
          case '/clear-files': {
            process.stdout.write(pc.dim((await detachPath(rt.session, rt.cwd, 'all')).message + '\n\n'))
            continue
          }
          case '/add-doc': {
            const url = line.slice(cmd.length).trim()
            if (!url) {
              process.stdout.write(pc.dim('Pemakaian: /add-doc <url>\n\n'))
              continue
            }
            process.stdout.write(pc.dim(`Mengambil ${url}…\n`))
            busy = true
            try {
              const r = await addDoc(rt.session, url)
              process.stdout.write((r.ok ? pc.green : pc.yellow)(r.message + '\n\n'))
            } finally {
              busy = false
            }
            continue
          }
          case '/run':
          case '/terminal': {
            const runCmd = line.slice(cmd.length).trim()
            if (!runCmd) {
              process.stdout.write(pc.dim('Pemakaian: /run <command>\n\n'))
              continue
            }
            process.stdout.write(pc.dim(`$ ${runCmd}\n`))
            const r = await runLocal(rt.cwd, runCmd)
            const formatted = formatRunOutput(runCmd, r)
            rt.session.messages.push({ role: 'user', content: formatted })
            await rt.session.save()
            process.stdout.write(pc.dim(formatted + '\n\n'))
            continue
          }
          case '/commit': {
            const d = await collectDiff(rt.cwd)
            if (!d.ok) {
              process.stdout.write(pc.yellow(`⚠ ${d.error}\n\n`))
              continue
            }
            if (!d.diff.trim()) {
              process.stdout.write(pc.dim('Tidak ada perubahan untuk di-commit.\n\n'))
              continue
            }
            process.stdout.write(pc.dim('Membuat pesan commit…\n'))
            busy = true
            let msg: string
            try {
              msg = await generateCommitMessage(rt, d.diff)
            } finally {
              busy = false
            }
            process.stdout.write(pc.cyan(`Pesan commit:\n${msg}\n\n`))
            const yes = await askYesNo('Commit semua perubahan (git add -A + git commit)?')
            if (!yes) {
              process.stdout.write(pc.dim('Commit dibatalkan.\n\n'))
              continue
            }
            const r = await performCommit(rt.cwd, msg)
            process.stdout.write((r.ok ? pc.green(`✓ ${r.output}`) : pc.red(`✗ ${r.output}`)) + '\n\n')
            continue
          }
          case '/new':
          case '/new-task': {
            const s = await startNewSession(rt)
            process.stdout.write(pc.green(`Sesi baru: ${s.id} (model ${s.model})\n\n`))
            continue
          }
          case '/clear':
          case '/reset':
            rt.session.reset(await buildSystemPrompt(rt.cwd, rt.mode, rt.customModes))
            process.stdout.write(pc.dim('Riwayat percakapan di-reset.\n\n'))
            continue
          case '/cost':
            process.stdout.write(pc.dim(costText(rt) + '\n\n'))
            continue
          case '/balance': {
            try {
              const c = await getCredits()
              process.stdout.write(
                pc.green(`saldo ${fmtNum(c.balance)} credit`) +
                  pc.dim(
                    ` · hari ini ${fmtNum(c.usage_today.credits_used)} credit (${c.usage_today.requests} request)` +
                      ` · sesi ini ${fmtNum(rt.session.creditsUsed)} credit\n\n`
                  )
              )
            } catch (e) {
              if (e instanceof ApiError) process.stdout.write(pc.red(`✗ ${e.message}\n\n`))
            }
            continue
          }
          case '/help':
            process.stdout.write(pc.dim(fullHelp(rt.cwd) + '\n\n'))
            continue
          case '/undo': {
            const restored = await undoLastTurn(rt)
            process.stdout.write(
              restored.length
                ? pc.green(`Di-undo: ${restored.join(', ')}\n\n`)
                : pc.dim('Tidak ada turn yang bisa di-undo.\n\n')
            )
            continue
          }
          case '/diff':
            process.stdout.write(pc.dim((await diffCheckpoints(rt)) + '\n\n'))
            continue
          case '/mcp': {
            const arg = line.split(/\s+/).slice(1).join(' ').trim()
            if (rt.mcp.length === 0) {
              process.stdout.write(pc.dim('Tidak ada server MCP. Konfigurasi di <cwd>/.tsa/mcp.json atau ~/.topupsaja/mcp.json.\n\n'))
              continue
            }
            if (arg === 'reconnect') {
              process.stdout.write(pc.dim('Reconnect semua server MCP…\n'))
              for (const c of rt.mcp) await c.reconnect(rt.cwd)
            }
            process.stdout.write(mcpStatusText(rt) + '\n\n')
            continue
          }
          default: {
            if (cmd.startsWith('/mcp__')) {
              const parsed = parseMcpToolName(cmd.slice(1))
              const conn = parsed ? rt.mcp.find((c) => c.name === parsed.server) : undefined
              const def = parsed ? conn?.prompts.find((p) => p.name === parsed.tool) : undefined
              if (!conn || conn.status !== 'connected' || !def) {
                process.stdout.write(
                  pc.yellow(`Prompt MCP tidak ditemukan: ${cmd}. Cek /mcp untuk status server & prompt yang tersedia.\n\n`)
                )
                continue
              }
              const text = await conn.getPrompt(parsed!.tool, mapPromptArgs(def, line.slice(cmd.length).trim()))
              await doTurn(await expandMentions(text, rt.cwd))
              continue
            }
            const cc = discoverCommands(rt.cwd).find((c) => c.name === cmd)
            if (cc) {
              await doTurn(await expandMentions(renderCommand(cc, line.slice(cmd.length).trim()), rt.cwd))
              continue
            }
            process.stdout.write(pc.yellow(`Perintah tidak dikenal: ${cmd}. Coba /help\n\n`))
            continue
          }
        }
      } catch (e) {
        process.stdout.write(pc.red(`✗ ${(e as Error).message}\n\n`))
        continue
      }
    }

    try {
      await doTurn(await expandMentions(line, rt.cwd))
    } catch (e) {
      process.stdout.write(pc.red(`\n✗ ${(e as Error).message}\n\n`))
    }
  }

  closeRl()
}

/** Statistik konteks singkat untuk banner. */
export function contextInfo(rt: AgentRuntime): string {
  const w = contextWindowFor(rt.models, rt.session.model)
  const used = messagesTokens(rt.session.messages)
  if (!w) return `${used} tok`
  return `${used}/${fmtNum(w)} tok (${Math.round((used / w) * 100)}%)`
}
