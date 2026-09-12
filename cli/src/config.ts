import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type PermissionMode = 'ask' | 'auto-edit' | 'yolo'

export interface HooksConfig {
  /** Command dijalankan sebelum tool; exit ≠ 0 = tool ditolak. Env: TSA_TOOL, TSA_TOOL_INPUT, TSA_CWD. */
  pre_tool_use?: string
  /** Command dijalankan setelah tool sukses; output jadi notice. */
  post_tool_use?: string
  /** Formatter otomatis setelah write_file/edit_file sukses; {file} → path absolut. Exit ≠ 0 = notice saja. */
  format_command?: string
}

export interface Config {
  api_key?: string
  base_url?: string
  model?: string
  permission_mode?: PermissionMode
  /** Tool yang selalu diizinkan tanpa approval (jawaban "always"). */
  tool_allowlist?: string[]
  /** Hooks sederhana pre/post tool. */
  hooks?: HooksConfig
}

export const DEFAULT_BASE_URL = 'https://api.topupsaja.com'

const CONFIG_DIR = path.join(os.homedir(), '.topupsaja')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export function loadConfig(): Config {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    return JSON.parse(raw) as Config
  } catch {
    return {}
  }
}

/** Simpan config (merge) dengan permission 0600. */
export function saveConfig(patch: Partial<Config>): void {
  const merged = { ...loadConfig(), ...patch }
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(CONFIG_FILE, 0o600)
  } catch {
    /* ignore (windows) */
  }
}

/** Env TOPUPSAJA_API_KEY selalu menang atas file config. */
export function getApiKey(): string | undefined {
  return process.env.TOPUPSAJA_API_KEY || loadConfig().api_key || undefined
}

/** Env TOPUPSAJA_API_URL > config > default. */
export function getBaseUrl(): string {
  const cfg = loadConfig()
  return (
    process.env.TOPUPSAJA_API_URL ||
    cfg.base_url ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, '')
}

/** Key tampil ter-mask: sk-ts-****abcd (untuk /settings, /api). */
export function maskKey(key?: string): string {
  if (!key) return '(belum diset)'
  return key.length > 8 ? `${key.slice(0, 6)}****${key.slice(-4)}` : '****'
}
