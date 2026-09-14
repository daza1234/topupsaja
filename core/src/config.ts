import { join } from 'pathe'
import { getHost } from './host.js'

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

function configDir(): string {
  return join(getHost().homedir(), '.topupsaja')
}
function configFile(): string {
  return join(configDir(), 'config.json')
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await getHost().fs.readFile(configFile(), 'utf8')
    return JSON.parse(raw) as Config
  } catch {
    return {}
  }
}

/** Simpan config (merge) dengan permission 0600. */
export async function saveConfig(patch: Partial<Config>): Promise<void> {
  const merged = { ...(await loadConfig()), ...patch }
  await getHost().fs.mkdir(configDir(), { recursive: true })
  await getHost().fs.writeFile(configFile(), JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
  try {
    await getHost().fs.chmod(configFile(), 0o600)
  } catch {
    /* ignore (windows) */
  }
}

/** Env TOPUPSAJA_API_KEY selalu menang atas file config. */
export async function getApiKey(): Promise<string | undefined> {
  return getHost().env.TOPUPSAJA_API_KEY || (await loadConfig()).api_key || undefined
}

/** Env TOPUPSAJA_API_URL > config > default. */
export async function getBaseUrl(): Promise<string> {
  const cfg = await loadConfig()
  return (
    getHost().env.TOPUPSAJA_API_URL ||
    cfg.base_url ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, '')
}

/** Key tampil ter-mask: sk-ts-****abcd (untuk /settings, /api). */
export function maskKey(key?: string): string {
  if (!key) return '(belum diset)'
  return key.length > 8 ? `${key.slice(0, 6)}****${key.slice(-4)}` : '****'
}