import type { CustomCommand } from './commands.js'
import { discoverCommands } from './commands.js'
import { getApiKey, getBaseUrl, loadConfig, maskKey, saveConfig } from './config.js'
import { ApiError, verifyKey } from './api.js'
import { fmtNum } from './ui/format.js'
import { attachPath } from './session/context.js'
import { rulesSummary } from './agent/rules.js'
import type { AgentRuntime } from './agent/runtime.js'

/**
 * Sumber tunggal daftar slash-command & help — dipakai TUI (autocomplete),
 * plain REPL (help), agar tidak bifurkasi.
 */
export const SLASH_COMMANDS = [
  '/code', '/architect', '/ask', '/test', '/mode', '/plan', '/act',
  '/permissions', '/settings', '/api', '/model',
  '/add', '/drop', '/clear-files', '/add-doc',
  '/run', '/terminal', '/commit', '/init',
  '/new', '/new-task', '/sessions', '/clear', '/reset', '/cost', '/compact', '/todo',
  '/balance', '/undo', '/diff', '/mcp', '/help', '/exit',
]

export const SHORT_HELP =
  'perintah: /mode /code /architect /ask /test /add /drop /add-doc /run /commit /new /cost /settings /api /model /clear /undo /diff /mcp /help /exit — @path/file sisip isi file'

/** Help berkelompok: Mode, Model & Config, Konteks, Eksekusi, Sesi, Utilitas. */
export function helpText(custom: CustomCommand[]): string {
  const customLines = custom.length
    ? '\nKustom:\n' + custom.map((c) => `  ${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n')
    : ''
  return `perintah:
Mode     : /code /architect /ask /test /mode — alias: /plan, /act · mode kustom: .tsa/modes/*.md + ~/.topupsaja/modes/*.md (refresh otomatis di /mode)
Model    : /model /permissions /settings /api <key> — key baru via /api atau \`topupsaja login\`
           aturan granular: .tsa/settings.json & ~/.topupsaja/settings.json — contoh:
           { "tool": "bash", "pattern": "npm install*", "action": "allow" } (juga dibuat via tombol [p]ola saat approval)
           { "tool": "read_file", "pattern": "*.env*", "action": "deny" } · { "tool": "web_fetch", "pattern": "*localhost*", "action": "deny" }
           precedence: deny absolut > spesifisitas pattern > ask > allow; ask berlaku juga di yolo; deny klasifikasi bash tetap absolut
Konteks  : /add <path> /drop <path|all> /clear-files /add-doc <url> — @path sisip file ke pesan
Eksekusi : /run <cmd> · /terminal <cmd> · /commit · /init · bash aman (read-only) auto-izin, berbahaya ditolak keras · web_fetch ambil URL → teks
Sesi     : /new (/new-task) · /sessions · /clear (/reset) · /cost · /compact · /todo
Utilitas : /balance · /undo · /diff · /mcp [reconnect] · /permissions (mode + riwayat keputusan) · prompt MCP: /mcp__<server>__<prompt> · /help · /exit${customLines}`
}

/** /cost: durasi sesi terformat (Xj Xm / Xm Yd / Yd). */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}j ${m % 60}m`
}

/** /settings: teks info config (dipakai overlay TUI & plain, paritas). */
export function settingsText(rt: AgentRuntime): string {
  const cmds = discoverCommands(rt.cwd)
  const cfg = loadConfig()
  return [
    `model      : ${rt.session.model}  (ubah: /model)`,
    `permission : ${rt.permissions.mode}  (ubah: /permissions)`,
    `aturan     : ${rulesSummary(rt.permissions.rules)}`,
    `base URL   : ${getBaseUrl()}`,
    `API key    : ${maskKey(getApiKey())}`,
    `hooks      : ${cfg.hooks?.pre_tool_use || cfg.hooks?.post_tool_use ? 'aktif' : 'tidak ada'}`,
    `formatter  : ${cfg.hooks?.format_command || 'tidak ada'}`,
    `commands   : ${cmds.length} kustom (.tsa/commands, ~/.topupsaja/commands)`,
  ].join('\n')
}

/** /api: info key masked + base URL + cara ganti key. */
export function apiText(): string {
  return `API key: ${maskKey(getApiKey())} · base URL: ${getBaseUrl()} — ganti key: /api <key_baru> (buat key di dashboard web).`
}

/**
 * `/add <path>`: file/folder biasa → lampiran konteks; gambar → user message
 * vision one-shot (diblokir bila model aktif tidak mendukung vision).
 */
export function addPathMessage(rt: AgentRuntime, target: string): string {
  const r = attachPath(rt.session, rt.cwd, target)
  if (!r.image) return r.message
  const model = rt.models.find((m) => m.id === rt.session.model)
  if (model && model.supports_vision === false) {
    return `Model ${rt.session.model} tidak mendukung vision — ganti model via /model.`
  }
  rt.session.messages.push({
    role: 'user',
    content: [{ type: 'text', text: `[gambar] ${r.image.path}` }, r.image.part],
  })
  rt.session.save()
  const kb = Math.max(1, Math.round(r.image.bytes / 1024))
  return `Gambar dilampirkan: ${r.image.path} (${fmtNum(kb)} KB)`
}

/**
 * `/api <key>`: verify kandidat key → sukses: simpan ke config + set env sesi
 * (env override lama sampai restart) → pesan status. Gagal: pesan actionable.
 */
export async function applyApiKey(rt: AgentRuntime, key: string): Promise<string> {
  if (!key.startsWith('sk-ts-')) {
    return 'Format key salah — harus diawali sk-ts-. Contoh: /api sk-ts-...'
  }
  try {
    const v = await verifyKey(key)
    saveConfig({ api_key: key })
    // getApiKey() env-first — tanpa set env, sesi berjalan tetap pakai key lama.
    process.env.TOPUPSAJA_API_KEY = key
    rt.session.lastBalance = v.balance
    rt.session.save()
    return `Key valid (${v.email}) · saldo ${fmtNum(v.balance)} credit.`
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      return 'Key tidak valid. Perbarui key Anda: /api <key_baru> — buat key di dashboard web.'
    }
    return (e as Error).message
  }
}

/** /mcp: status per server — koneksi, jumlah tool & prompt. */
export function mcpStatusText(rt: AgentRuntime): string {
  return rt.mcp
    .map(
      (c) =>
        `${c.name}: ${c.status}${c.error ? ` (${c.error})` : ''} · ${c.tools.length} tool · ${c.prompts.length} prompt`
    )
    .join('\n')
}

/** /cost: rincian pemakaian sesi. */
export function costText(rt: AgentRuntime): string {
  const lines = [
    `model  : ${rt.session.model}`,
    `durasi : ${formatDuration(Date.now() - rt.session.created)}`,
    `token  : ↑${fmtNum(rt.session.tokensIn)} in · ↓${fmtNum(rt.session.tokensOut)} out`,
    `credit : ${fmtNum(rt.session.creditsUsed)} terpakai sesi ini`,
  ]
  if (rt.session.lastBalance !== undefined) {
    lines.push(`sisa   : ${fmtNum(rt.session.lastBalance)} credit`)
  }
  return lines.join('\n')
}
