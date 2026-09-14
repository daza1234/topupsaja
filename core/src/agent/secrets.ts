import { getHost } from '../host.js'
import { join } from 'pathe'

/**
 * Proteksi secret-path: file yang berisi kredensial tidak boleh terbaca
 * otomatis walau klasifikasi bash/read_file menyatakan "safe" — output bisa
 * berisi API key dan masuk konteks model (jalur eksfiltrasi via prompt
 * injection). Semua akses → downgrade ke 'ask' (wajib approval user),
 * bahkan di mode yolo.
 */

/** Fragmen path (lowercase) yang selalu dianggap secret. */
const SECRET_FRAGMENTS = [
  '.topupsaja/config.json',
  '.tsa/settings.json',
]

/** Regex: kemunculan `.env…` di mana pun (app.env, .env.local, dst). */
const ENV_TOKEN = /\.env([.\w]*)/i

function expandHome(s: string): string {
  if (s === '~') return getHost().homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    return join(getHost().homedir(), s.slice(2))
  }
  return s
}

/** True bila string (command bash atau path file) menyentuh file secret. */
export function touchesSecretPath(raw: string): boolean {
  const s = expandHome(String(raw ?? '')).toLowerCase()
  if (!s) return false
  if (SECRET_FRAGMENTS.some((frag) => s.includes(frag))) return true
  if (ENV_TOKEN.test(s)) return true
  // config dir CLI apa pun bentuknya (~/.topupsaja/**)
  if (s.includes('.topupsaja')) return true
  return false
}

/** True bila tool call ini membaca/menulis file secret. */
export function touchesSecretTool(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'bash') return touchesSecretPath(String(args.command ?? ''))
  if (tool === 'read_file' || tool === 'write_file' || tool === 'edit_file') {
    return touchesSecretPath(String(args.path ?? ''))
  }
  return false
}
