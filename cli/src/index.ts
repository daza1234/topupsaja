#!/usr/bin/env node
import './bootstrap.js'
import path from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'
import { ApiError, getCredits, listModels, verifyKey } from '@topupsaja/core/api.js'
import { getApiKey, getBaseUrl, loadConfig, saveConfig, PermissionMode } from '@topupsaja/core/config.js'
import { fmtNum } from './ui/format.js'
import { ask, askHidden, closeRl } from './io.js'
import { AgentSession, listSessions, lastSessionId } from '@topupsaja/core/session/store.js'
import { buildSystemPrompt, resolveModeArg, ALL_MODES, discoverCustomModes } from '@topupsaja/core/agent/modes.js'
import type { CustomMode } from '@topupsaja/core/agent/modes.js'
import { PermissionManager } from '@topupsaja/core/agent/permission.js'
import { AskUserManager, AgentEmitter, AgentRuntime } from '@topupsaja/core/agent/runtime.js'
import { loadPermissionRules } from '@topupsaja/core/agent/rules.js'
import { listProjectFiles } from '@topupsaja/core/session/context.js'
import { runOneShot, runPlainRepl } from './ui/plain.js'
import { fetchModels } from '@topupsaja/core/api.js'

const program = new Command()

program
  .name(path.basename(process.argv[1] ?? 'topupsaja'))
  .description('CLI coding agent TopUpSaja — terminal agent TUI dengan prepaid credit.')
  .version('0.9.1')

async function requireKey(): Promise<string> {
  const key = await getApiKey()
  if (!key) {
    console.log(pc.yellow('API key belum diset. Jalankan `topupsaja login` dulu,'))
    console.log(pc.yellow('atau set env TOPUPSAJA_API_KEY.'))
    process.exit(1)
  }
  return key
}

function printApiError(e: unknown): never {
  console.error(pc.red(`✗ ${e instanceof ApiError ? e.message : (e as Error).message}`))
  process.exit(1)
}

const isTty = () => !!process.stdout.isTTY && !!process.stdin.isTTY && !process.env.TOPUPSAJA_PLAIN

// ── tsa login ──
program
  .command('login')
  .description('Simpan API key TopUpSaja ke ~/.topupsaja/config.json (mode 0600)')
  .option('--url <url>', 'Base URL API (default https://api.topupsaja.com)')
  .action(async (opts: { url?: string }) => {
    console.log(pc.dim('Buat API key di dashboard: Settings → API Keys'))
    const key = await askHidden(pc.bold('Paste API key (sk-ts-...): '))
    if (!key.startsWith('sk-ts-')) {
      console.log(pc.red('✗ Format key salah — harus diawali sk-ts-.'))
      process.exit(1)
    }
    process.env.TOPUPSAJA_API_KEY = key // validasi dulu sebelum disimpan
    try {
      const v = await verifyKey(key)
      const patch: { api_key: string; base_url?: string } = { api_key: key }
      if (opts.url) patch.base_url = opts.url.replace(/\/+$/, '')
      saveConfig(patch)
      console.log(pc.green(`✓ Key valid (${v.email}) · saldo ${fmtNum(v.balance)} credit.`))
      console.log(pc.dim(`Base URL: ${await getBaseUrl()}`))
    } catch (e) {
      printApiError(e)
    }
    closeRl()
  })

// ── tsa balance ──
program
  .command('balance')
  .description('Cek saldo credit + usage hari ini')
  .action(async () => {
    await requireKey()
    try {
      const c = await getCredits()
      console.log()
      console.log(`${pc.bold('Saldo')}   : ${pc.green(fmtNum(c.balance) + ' credit')}`)
      console.log(`${pc.bold('API key')} : #${c.api_key_id}`)
      const u = c.usage_today
      console.log(pc.dim('Hari ini:'))
      console.log(pc.dim(`  request  : ${fmtNum(u.requests)}`))
      console.log(pc.dim(`  credit   : ${fmtNum(u.credits_used)}`))
      console.log(pc.dim(`  token in : ${fmtNum(u.prompt_tokens)}`))
      console.log(pc.dim(`  token out: ${fmtNum(u.completion_tokens)}`))
      console.log()
    } catch (e) {
      printApiError(e)
    }
    closeRl()
  })

// ── tsa models ──
program
  .command('models')
  .description('Daftar model aktif + harga credit')
  .action(async () => {
    await requireKey()
    try {
      const { data } = await listModels()
      console.log()
      for (const m of data) {
        console.log(
          `${pc.cyan(m.id.padEnd(32))} ${pc.dim(`[${m.tier}]`)}  in ${fmtNum(m.pricing.input)} / out ${fmtNum(m.pricing.output)} credit/1k tok  ${pc.dim(`ctx ${fmtNum(m.context_window ?? 0)}`)}`
        )
      }
      console.log(pc.dim(`\n${data.length} model · pakai \`topupsaja model <id>\` untuk set default\n`))
    } catch (e) {
      printApiError(e)
    }
    closeRl()
  })

// ── tsa model <id> ──
program
  .command('model')
  .argument('<id>', 'id model (lihat topupsaja models)')
  .description('Set model default untuk sesi agent')
  .action(async (id: string) => {
    await requireKey()
    try {
      const models = await fetchModels()
      const found = models.find((m) => m.id === id || m.id === `ts/${id}`)
      if (!found) {
        console.log(pc.red(`✗ Model '${id}' tidak tersedia. Lihat \`topupsaja models\`.`))
        process.exit(1)
      }
      saveConfig({ model: found.id })
      console.log(pc.green(`✓ Model default: ${found.id}`))
    } catch (e) {
      printApiError(e)
    }
    closeRl()
  })

// ── tsa (default) — sesi interaktif TUI / fallback teks ──
program
  .argument('[prompt]', 'prompt awal opsional — bila diisi, jalankan satu turn lalu keluar')
  .description('Mulai sesi coding agent (TUI Ink bila TTY, fallback teks bila non-TTY)')
  .option('--model <id>', 'model untuk sesi ini (tanpa mengubah default)')
  .option('--continue', 'lanjutkan sesi terakhir di folder ini')
  .option('--resume', 'pilih sesi tersimpan untuk dilanjutkan')
  .option('--mode <mode>', 'mode awal: code | architect | ask | test (alias: plan, act)')
  .option('--permission <mode>', 'permission mode: ask | auto-edit | yolo')
  .option('--plain', 'paksa mode teks polos tanpa TUI Ink')
  .option('-p, --print', 'mode non-interaktif: satu turn, output polos tanpa status bar')
  .option('--output-format <fmt>', 'format output untuk --print: text | json')
  .action(
    async (
      prompt: string | undefined,
      opts: {
        model?: string
        continue?: boolean
        resume?: boolean
        mode?: string
        permission?: string
        plain?: boolean
        print?: boolean
        outputFormat?: string
      }
    ) => {
      await requireKey()
      if (opts.plain) process.env.TOPUPSAJA_PLAIN = '1'
      const cwd = process.cwd()
      const cfg = await loadConfig()

      // ── Mode & permission ──
      const customModes: CustomMode[] = await discoverCustomModes(cwd)
      let mode: string = 'code'
      if (opts.mode) {
        const resolved = resolveModeArg(opts.mode, customModes)
        if (!resolved) {
          console.log(
            pc.red(
              `✗ --mode harus ${ALL_MODES.join(' | ')} (alias: plan, act) atau mode kustom di .tsa/modes/.`
            )
          )
          process.exit(1)
        }
        mode = resolved
      }
      const permOpt = opts.permission as PermissionMode | undefined
      if (permOpt && !['ask', 'auto-edit', 'yolo'].includes(permOpt)) {
        console.log(pc.red('✗ --permission harus ask | auto-edit | yolo.'))
        process.exit(1)
      }
      let permMode: PermissionMode = permOpt ?? cfg.permission_mode ?? 'ask'

      // ── Aturan permission granular (global + project) ──
      const { rules, errors } = await loadPermissionRules(cwd)
      for (const e of errors) console.log(pc.yellow(`⚠ aturan permission: ${e}`))

      // ── Model + daftar model (validasi key sekaligus) ──
      let models
      try {
        models = await fetchModels()
      } catch (e) {
        printApiError(e)
      }
      let model = opts.model ?? cfg.model
      if (model && !models.some((m) => m.id === model)) {
        console.log(pc.yellow(`⚠ Model '${model}' tidak tersedia — pilih dari daftar.`))
        model = undefined
      }
      if (!model) {
        if (isTty()) {
          const { pickFromList } = await import('./tui/components/Picker.js')
          const picked = await pickFromList(
            'Pilih model',
            models.map((m) => ({
              value: m.id,
              label: m.id,
              hint: `[${m.tier}] in ${fmtNum(m.pricing.input)} / out ${fmtNum(m.pricing.output)} cr/1k`,
            }))
          )
          if (!picked) process.exit(1)
          model = picked
          await saveConfig({ model })
        } else {
          console.log(pc.red("✗ Model belum diset. Jalankan `topupsaja model <id>` dulu (non-TTY tidak bisa picker)."))
          process.exit(1)
        }
      }

      // ── Session: baru / --continue / --resume ──
      let session: AgentSession | null = null
      if (opts.resume || opts.continue) {
        const id = opts.resume ? null : await lastSessionId(cwd)
        let chosen: string | null = id
        if (opts.resume) {
          if (!isTty()) {
            console.log(pc.red('✗ --resume butuh TTY (picker sesi). Pakai --continue atau jalankan di terminal.'))
            process.exit(1)
          }
          const { pickFromList } = await import('./tui/components/Picker.js')
          const metas = await listSessions(cwd)
          if (metas.length === 0) {
            console.log(pc.yellow('Tidak ada sesi tersimpan untuk folder ini — mulai sesi baru.'))
          } else {
            chosen = await pickFromList(
              'Lanjutkan sesi',
              metas.slice(0, 30).map((s) => ({
                value: s.id,
                label: s.title,
                hint: `${s.model} · ${new Date(s.updated).toLocaleString('id-ID')}`,
              }))
            )
          }
        }
        if (chosen) {
          session = await AgentSession.load(cwd, chosen)
          if (!session) {
            console.log(pc.yellow(`⚠ Sesi ${chosen} gagal dimuat — mulai sesi baru.`))
            session = null
          }
        }
      }
      if (!session) {
        session = AgentSession.create(cwd, model, await buildSystemPrompt(cwd, mode, customModes))
        session.permissionMode = permMode
      }
      // Flag menang atas nilai tersimpan.
      if (opts.mode) session.mode = mode
      else mode = session.mode
      if (opts.permission) session.permissionMode = permMode
      else permMode = session.permissionMode
      if (session.mode !== mode) mode = session.mode
      if (!session.messages.some((m) => m.role === 'system')) {
        session.messages.unshift({ role: 'system', content: await buildSystemPrompt(cwd, mode, customModes) })
      }

      // ── Runtime headless ──
      const rt: AgentRuntime = {
        cwd,
        session,
        permissions: new PermissionManager(permMode, cfg.tool_allowlist ?? [], rules, cwd),
        emitter: new AgentEmitter(),
        askUser: new AskUserManager(),
        mode,
        customModes,
        models,
        abort: false,
        abortController: null,
        checkpointTurns: [],
        turnSnapshots: [],
        mcp: [],
      }

      // ── MCP stdio (bila ada config mcp.json) ──
      try {
        const { connectMcpServers } = await import('@topupsaja/core/mcp/client.js')
        const conns = await connectMcpServers(cwd, (m) => console.log(pc.dim(m)))
        rt.mcp = conns
      } catch {
        /* tanpa MCP — lanjut */
      }

      const saveAndExit = async (code = 0) => {
        await session!.save()
        process.exit(code)
      }
      process.on('SIGINT', () => saveAndExit(0))

      // ── One-shot: satu turn lalu keluar (plain output) ──
      if (opts.print) {
        if (!prompt) {
          console.error(pc.red("✗ --print/-p butuh positional prompt. Contoh: topupsaja -p 'jelaskan repo ini'"))
          process.exit(1)
        }
        if (opts.outputFormat && !['text', 'json'].includes(opts.outputFormat)) {
          console.error(pc.red("✗ --output-format harus 'text' atau 'json'."))
          process.exit(1)
        }
        try {
          const { runPrint } = await import('./ui/plain.js')
          const out = await runPrint(rt, prompt, opts.outputFormat === 'json' ? 'json' : 'text')
          await session.save()
          if (opts.outputFormat === 'json') console.log(JSON.stringify(out))
          else if (out.result.trim()) console.log(out.result.trim())
          process.exit(0)
        } catch (e) {
          console.error(pc.red(`✗ ${(e as Error).message}`))
          await saveAndExit(1)
        }
        return
      }

      if (prompt) {
        try {
          await runOneShot(rt, prompt)
        } catch (e) {
          console.error(pc.red(`✗ ${(e as Error).message}`))
          saveAndExit(1)
        }
        saveAndExit(0)
        return
      }

      // ── Interaktif: TUI Ink (TTY) atau REPL teks (non-TTY) ──
      try {
        if (isTty()) {
          const { startTui } = await import('./tui/main.js')
          const files = await listProjectFiles(cwd)
          await startTui(rt, files)
          saveAndExit(0)
        } else {
          await runPlainRepl(rt)
          saveAndExit(0)
        }
      } catch (e) {
        console.error(pc.red(`✗ ${(e as Error).message}`))
        saveAndExit(1)
      }
    }
  )

program.parseAsync(process.argv).catch((e) => {
  console.error(pc.red(`✗ ${(e as Error).message}`))
  process.exit(1)
})
