import { join } from 'pathe'
import { getHost } from '../host.js'
import { ApiError, ChatMessage, ContentPart, streamChat } from '../api.js'
import { TOOL_SCHEMAS, mcpToolSchemas } from './tools.js'
import { executeTool, describeTool, runHook, editFilePartial } from './exec.js'
import { classifyBash } from './shell-safety.js'
import { runSubagent } from './subagent.js'
import { parseMcpToolName } from '../mcp/client.js'
import { PermissionManager, NEED_APPROVAL } from './permission.js'
import { loadPermissionRules, type PermissionLogEntry } from './rules.js'
import { messagesTokens, contextWindowFor, maybeCompact } from '../session/compaction.js'
import { syncContextMessage } from '../session/context.js'
import { buildSystemPrompt, isReadOnlyMode } from './modes.js'
import { loadConfig } from '../config.js'
import type { ToolResult } from './exec.js'
import type { AgentRuntime } from './runtime.js'
import { AgentSession } from '../session/store.js'

const MAX_STEPS = 40

export interface TurnResult {
  /** true bila turn selesai normal, false bila dibatalkan/error saldo. */
  completed: boolean
}

function parseToolArgs(call: { function: { name: string; arguments: string } }): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    throw new Error(`Argumen tool '${call.function.name}' bukan JSON valid.`)
  }
}

function denyReadonly(mode: string): string {
  const hint =
    mode === 'architect'
      ? 'Susun rencana dan sarankan user menjalankan /code.'
      : 'Jelaskan/jawab tanpa mengubah file atau mengeksekusi command.'
  return `DITOLAK: mode ${mode.toUpperCase()} read-only — tool tulis/eksekusi tidak diizinkan. Jangan coba lagi; ${hint}`
}

const DENY_USER =
  'User MENOLAK eksekusi tool ini. Jangan coba ulangi aksi yang sama. Tanya user atau gunakan pendekatan lain.'

const ASK_USER_CANCEL =
  'User membatalkan pertanyaan. Jangan ulangi pertanyaan yang sama; gunakan pendekatan lain atau asumsi paling aman dan sebutkan asumsinya.'

/** Target ringkas untuk audit log: bash → command, write/edit → path, web_fetch → URL. */
function auditTarget(tool: string, args: Record<string, unknown>, cwd: string): string {
  if (tool === 'bash') return String(args.command ?? '').slice(0, 120)
  if (tool === 'write_file' || tool === 'edit_file') return String(args.path ?? '')
  if (tool === 'web_fetch') return String(args.url ?? '').slice(0, 120)
  if (tool.startsWith('mcp__')) return cwd ? String(Object.keys(args)) : ''
  return ''
}

/** Catat keputusan permission ke audit log sesi (persist bersama save() per tool call). */
function logPermission(
  rt: AgentRuntime,
  tool: string,
  args: Record<string, unknown>,
  decision: PermissionLogEntry['decision'],
  approved?: boolean
): void {
  rt.session.logPermission({
    at: new Date().toISOString(),
    tool,
    target: auditTarget(tool, args, rt.cwd),
    decision,
    approved,
  })
}

/** Hot-reload aturan permission tiap awal turn — tanpa fs.watch (murah, robust). */
async function reloadRules(rt: AgentRuntime): Promise<void> {
  const { rules, errors } = await loadPermissionRules(rt.cwd)
  const sig = JSON.stringify(rules)
  if (sig === rt.permissions.rulesSig) return
  rt.permissions.rulesSig = sig
  rt.permissions.rules = rules
  for (const e of errors) rt.emitter.emit('notice', `aturan permission: ${e}`)
  rt.emitter.emit('notice', `aturan permission dimuat ulang: ${rules.length} aturan`)
}

/**
 * Eksekusi tool ask_user: emit ask_user_request, tunggu jawaban UI
 * (bukan approval — selalu diizinkan, tanpa hooks pre/post).
 */
export async function runAskUserTool(rt: AgentRuntime, args: Record<string, unknown>): Promise<ToolResult> {
  const question = String(args.question ?? '').trim()
  const raw = Array.isArray(args.options) ? args.options : []
  const options: { label: string; description?: string }[] = []
  for (const o of raw) {
    if (o === null || typeof o !== 'object') continue
    const label = String((o as Record<string, unknown>).label ?? '').trim()
    if (!label) continue
    const desc = (o as Record<string, unknown>).description
    options.push(desc === undefined ? { label } : { label, description: String(desc) })
  }
  if (!question) return { ok: false, output: 'Error: ask_user butuh field "question" (string).' }
  if (options.length < 2 || options.length > 5) {
    return { ok: false, output: 'Error: ask_user butuh 2–5 opsi berlabel (options).' }
  }
  const multiSelect = args.multi_select === true
  const req = rt.askUser.newRequest(question, options, multiSelect)
  // Daftarkan waiter SEBELUM emit agar jawaban sinkron dari UI tidak hilang.
  const answerPromise = rt.askUser.awaitAnswer(req.id)
  rt.emitter.emit('ask_user_request', req)
  const answer = await answerPromise
  rt.emitter.emit('ask_user_result', { id: req.id, answer })
  let output: string
  if (answer.kind === 'cancel') {
    output = ASK_USER_CANCEL
  } else if (answer.kind === 'option') {
    const opt = options.find((o) => o.label === answer.label)
    output = opt?.description
      ? `Jawaban user: ${opt.label} — ${opt.description}`
      : `Jawaban user: ${opt?.label ?? answer.label}`
  } else if (answer.kind === 'options') {
    output = `Jawaban user: ${answer.labels.join('; ')}`
  } else {
    output = `Jawaban user: ${answer.text}`
  }
  return { ok: true, output }
}

/** Dispatch tool built-in, task (subagent), dan mcp__*. */
async function dispatchTool(
  rt: AgentRuntime,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (name === 'task') {
    const text = await runSubagent(rt, String(args.task ?? ''))
    return { ok: true, output: text }
  }
  if (name.startsWith('mcp__')) {
    const parsed = parseMcpToolName(name)
    const conn = rt.mcp.find((c) => c.name === parsed?.server)
    if (!conn || conn.status !== 'connected') {
      return { ok: false, output: `Server MCP '${parsed?.server ?? '?'}' tidak aktif. Coba /mcp.` }
    }
    try {
      const out = await conn.callTool(parsed!.tool, args)
      return { ok: true, output: out || '(hasil kosong)' }
    } catch (e) {
      return { ok: false, output: (e as Error).message }
    }
  }
  return executeTool(name, args, { todos: rt.session.todos, rt })
}

/** Eksekusi tool dengan hooks pre/post (config.hooks). */
async function executeWithHooks(
  rt: AgentRuntime,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const hooks = (await loadConfig()).hooks
  if (hooks?.pre_tool_use) {
    const pre = await runHook(hooks.pre_tool_use, name, args, rt.cwd)
    if (!pre.ok) {
      return {
        ok: false,
        output: `DITOLAK oleh hook pre_tool_use: ${pre.output.trim().slice(0, 300)}`,
      }
    }
  }
  const result = await dispatchTool(rt, name, args)
  if (result.ok && hooks?.post_tool_use) {
    const post = await runHook(hooks.post_tool_use, name, args, rt.cwd)
    if (post.output.trim()) {
      rt.emitter.emit('notice', `hook post_tool_use: ${post.output.trim().slice(0, 300)}`)
    }
  }
  return result
}

/**
 * Satu turn agent (headless, semua request streaming): kirim messages + tools
 * → jalankan tool_calls (dengan permission) → ulangi sampai reply final.
 * Semua progres dilempar via rt.emitter: delta, tool_start, tool_result,
 * approval_request, approval_result, status, notice, todo, done, error.
 */
export async function runTurn(rt: AgentRuntime, userInput: string): Promise<TurnResult> {
  const { session, emitter } = rt
  rt.abort = false
  rt.abortController = new AbortController()
  const signal = rt.abortController.signal
  rt.checkpointTurns.push([])
  rt.turnSnapshots.push(new Map())

  // Hot-reload aturan permission (bila settings.json berubah sejak turn lalu).
  await reloadRules(rt)

  // System message konteks lampiran (idempotent, survive compaction).
  const droppedAttachments = syncContextMessage(session)
  if (droppedAttachments > 0) {
    emitter.emit('notice', `${droppedAttachments} lampiran dilewati (total konteks lampiran >60k char).`)
  }

  session.noteUserMessage(userInput)
  session.messages.push({ role: 'user', content: userInput })
  await session.save()

  for (let step = 0; step < MAX_STEPS; step++) {
    if (rt.abort) {
      emitter.emit('notice', 'Turn dibatalkan user.')
      emitter.emit('done', { completed: false })
      await session.save()
      return { completed: false }
    }

    // Compaction otomatis sebelum request bila konteks >70%.
    await maybeCompact(rt)

    let result
    try {
      result = await streamChat(
        {
          model: session.model,
          messages: session.messages,
          tools: [...TOOL_SCHEMAS, ...mcpToolSchemas(rt.mcp)],
          tool_choice: 'auto',
          max_tokens: 16384,
        },
        {
          onDelta: (t) => emitter.emit('delta', t),
          onCredits: (c) => {
            /* credit dilempar bersama event status */
          },
        },
        { signal }
      )
    } catch (err) {
      if (signal.aborted) {
        emitter.emit('notice', 'Turn dibatalkan user.')
        emitter.emit('done', { completed: false })
        await session.save()
        return { completed: false }
      }
      const msg = err instanceof ApiError ? err.message : (err as Error).message
      if (err instanceof ApiError && err.status === 402) {
        // Pesan server sudah format "Saldo kredit Anda habis. Silakan top-up di: <url>"
        emitter.emit('error', `[Gagal] ${msg}`)
      } else {
        emitter.emit('error', msg)
      }
      emitter.emit('done', { completed: false })
      return { completed: false }
    }

    // Akumulasi credit sesi (dari settle server).
    if (result.creditsUsed !== undefined) session.creditsUsed += result.creditsUsed
    // Saldo terakhir dari server (chunk SSE settle / header non-stream).
    if (result.balance !== undefined) session.lastBalance = result.balance

    // Akumulasi token sesi (guard: chunk kadang tanpa usage).
    if (result.usage?.prompt_tokens !== undefined) session.tokensIn += result.usage.prompt_tokens
    if (result.usage?.completion_tokens !== undefined) session.tokensOut += result.usage.completion_tokens

    const window = contextWindowFor(rt.models, session.model)
    emitter.emit('status', {
      model: session.model,
      promptTokens: result.usage?.prompt_tokens,
      completionTokens: result.usage?.completion_tokens,
      creditsUsed: result.creditsUsed,
      balance: result.balance,
      contextPct: window ? Math.min(100, Math.round((messagesTokens(session.messages) / window) * 100)) : undefined,
    })

    // Push assistant message apa adanya (termasuk tool_calls bila ada).
    const assistantMsg: ChatMessage = { role: 'assistant', content: result.content || null }
    if (result.toolCalls.length) assistantMsg.tool_calls = result.toolCalls
    session.messages.push(assistantMsg)

    if (result.toolCalls.length === 0) {
      await session.save()
      emitter.emit('done', { completed: true })
      return { completed: true }
    }

    // ── Eksekusi tool calls ──
    for (const call of result.toolCalls) {
      if (rt.abort) break
      const id = call.id
      const name = call.function.name
      let args: Record<string, unknown>
      try {
        args = parseToolArgs(call)
      } catch (e) {
        session.messages.push({ role: 'tool', tool_call_id: id, content: `Error: ${(e as Error).message}` })
        emitter.emit('tool_result', { id, ok: false, output: (e as Error).message })
        continue
      }

      emitter.emit('tool_start', { id, name, desc: describeTool(name, args) })

      // todo_write → sampaikan state baru ke UI.
      if (name === 'todo_write') {
        session.todos.onChange = (items) => emitter.emit('todo', items)
      }

      let resultContent: string
      let resultImage: ContentPart | undefined
      const readOnly = isReadOnlyMode(rt.mode, rt.customModes)
      const bashClass = name === 'bash' ? classifyBash(String(args.command ?? '')) : null
      if (readOnly && NEED_APPROVAL.has(name)) {
        resultContent = denyReadonly(rt.mode)
        logPermission(rt, name, args, 'readonly-deny')
        emitter.emit('tool_result', { id, ok: false, output: resultContent })
      } else if (bashClass === 'deny') {
        resultContent =
          'DITOLAK: command berbahaya (klasifikasi deny) — tidak dieksekusi di mode permission apa pun, termasuk yolo dan allowlist. Jangan coba ulangi command ini.'
        logPermission(rt, name, args, 'bash-deny')
        emitter.emit('tool_result', { id, ok: false, output: resultContent })
      } else if (name === 'ask_user') {
        const r = await runAskUserTool(rt, args)
        emitter.emit('tool_result', { id, ok: r.ok, output: r.output })
        resultContent = r.output
      } else {
        const decision = rt.permissions.decide(name, args, { readOnlyMode: readOnly })
        if (decision === 'deny') {
          resultContent = `DITOLAK: aturan permission granular (action: deny) menolak tool '${name}'. Jangan coba ulangi aksi ini; gunakan pendekatan lain atau minta user menyesuaikan aturan di .tsa/settings.json / ~/.topupsaja/settings.json.`
          logPermission(rt, name, args, 'deny')
          emitter.emit('tool_result', { id, ok: false, output: resultContent })
        } else if (decision === 'allow') {
          logPermission(rt, name, args, 'allow')
          const r = await executeWithHooks(rt, name, args)
          emitter.emit('tool_result', { id, ok: r.ok, output: r.output })
          resultContent = r.output
          resultImage = r.image
        } else {
          logPermission(rt, name, args, 'ask')
          const req = await rt.permissions.makeRequest(name, args)
          // Daftarkan waiter SEBELUM emit agar jawaban sinkron dari UI tidak hilang.
          const answerPromise = rt.permissions.awaitAnswer(req.id)
          emitter.emit('approval_request', req)
          const ans = await answerPromise
          emitter.emit('approval_result', {
            id: req.id,
            approved: ans.approved,
            always: ans.always,
            alwaysPattern: ans.alwaysPattern,
            hunks: ans.hunks,
          })
          logPermission(rt, name, args, 'ask', ans.approved)
          if (!ans.approved) {
            resultContent = DENY_USER
            emitter.emit('tool_result', { id, ok: false, output: 'User menolak tool ini.' })
          } else if (ans.hunks && name === 'edit_file') {
            // Per-hunk: hooks pre sudah lewat approval; tetap post/format lewat executeWithHooks
            // lewat jalur partial — stage/tulis/format dilakukan editFilePartial.
            const r = await editFilePartial(rt, args as { path: string; old_string: string; new_string: string }, ans.hunks)
            emitter.emit('tool_result', { id, ok: r.ok, output: r.output })
            resultContent = r.output
          } else {
            const r = await executeWithHooks(rt, name, args)
            emitter.emit('tool_result', { id, ok: r.ok, output: r.output })
            resultContent = r.output
            resultImage = r.image
          }
        }
      }

      session.messages.push({
        role: 'tool',
        tool_call_id: id,
        content: resultImage
          ? [{ type: 'text', text: resultContent }, resultImage]
          : resultContent,
      })
      await session.save()
    }
  }

  emitter.emit('notice', `Turn berhenti: batas ${MAX_STEPS} langkah tercapai.`)
  emitter.emit('done', { completed: true })
  await session.save()
  return { completed: true }
}

/** Helper mode untuk UI slash-commands. Rebuild system message agar prompt sesuai mode. */
export async function setMode(rt: AgentRuntime, mode: string): Promise<void> {
  rt.mode = mode
  rt.session.mode = mode
  if (rt.session.messages[0]?.role === 'system') {
    rt.session.messages[0] = { role: 'system', content: await buildSystemPrompt(rt.cwd, mode, rt.customModes) }
  }
  await rt.session.save()
  rt.emitter.emit('mode_changed', { mode, permissionMode: rt.permissions.mode })
}

export async function setPermissionMode(rt: AgentRuntime, pm: PermissionManager['mode']): Promise<void> {
  rt.permissions.mode = pm
  rt.session.permissionMode = pm
  await rt.session.save()
  rt.emitter.emit('mode_changed', { mode: rt.mode, permissionMode: pm })
}

/** /new, /new-task: sesi baru dengan mode & permission kini (MCP & runtime tak disentuh). */
export async function startNewSession(rt: AgentRuntime): Promise<AgentSession> {
  const s = AgentSession.create(rt.cwd, rt.session.model, await buildSystemPrompt(rt.cwd, rt.mode, rt.customModes))
  s.mode = rt.mode
  s.permissionMode = rt.permissions.mode
  await s.save()
  rt.session = s
  rt.checkpointTurns = []
  rt.turnSnapshots = []
  return s
}
