import { resolve } from 'pathe'
import { getHost } from '../host.js'

export interface LocalRunResult {
  code: number
  stdout: string
  stderr: string
}

/** Jalankan command shell lokal (dipakai /run, /terminal). Timeout 60s, maxBuffer 1MB. */
export async function runLocal(cwd: string, cmd: string, timeoutMs = 60_000): Promise<LocalRunResult> {
  return getHost().exec.exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: getHost().env })
}

/** Format output [terminal] untuk riwayat + tampilan: fenced block + exit code, cap 10k char. */
export function formatRunOutput(cmd: string, r: LocalRunResult): string {
  let out = r.stdout
  if (r.stderr) out += (out ? '\n' : '') + r.stderr
  if (out.length > 10_000) out = out.slice(0, 10_000) + '\n... (output dipotong 10k char)'
  const status = r.code === 0 ? 'exit 0' : `exit ${r.code}`
  return `[terminal] $ ${cmd}\n\`\`\`\n${out || '(tanpa output)'}\n\`\`\`\n${status}`
}
