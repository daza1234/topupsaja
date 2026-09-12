import readline from 'node:readline'
import pc from 'picocolors'

let rl: readline.Interface | null = null
let stdinClosed = false
const lineQueue: string[] = []
let lineWaiters: ((v: string) => void)[] = []

/** Interface readline bersama — satu stdin, dipakai berurutan. */
export function getRl(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !!process.stdin.isTTY,
    })
    // Kumpulkan baris lebih awal agar tidak hilang antar pertanyaan
    // (readline membuang 'line' tanpa pending question, terutama di pipe).
    rl.on('line', (l) => {
      const w = lineWaiters.shift()
      if (w) w(l)
      else lineQueue.push(l)
    })
    rl.on('close', () => {
      stdinClosed = true
      const ws = lineWaiters
      lineWaiters = []
      for (const w of ws) w('')
    })
  }
  return rl
}

export function closeRl(): void {
  rl?.close()
  rl = null
}

/**
 * Baca satu baris input. TTY: pakai rl.question (editing penuh).
 * Pipe/non-TTY: antrean 'line' agar baris yang datang lebih awal tak hilang.
 * Return '' bila EOF (stdin tutup).
 */
export function ask(prompt: string): Promise<string> {
  getRl()
  if (process.stdin.isTTY) {
    return new Promise((resolve) => {
      const r = getRl()!
      const onClose = () => resolve('')
      r.once('close', onClose)
      r.question(prompt, (ans) => {
        r.removeListener('close', onClose)
        resolve(ans)
      })
    })
  }
  // non-TTY
  if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift()!)
  if (stdinClosed) return Promise.resolve('')
  return new Promise((resolve) => lineWaiters.push(resolve))
}

/** Prompt y/n — hanya terima y/n. */
export async function askYesNo(question: string, def = false): Promise<boolean> {
  while (true) {
    const suffix = def ? ' [Y/n] ' : ' [y/N] '
    const ans = (await ask(pc.bold(question + suffix))).trim().toLowerCase()
    if (ans === 'y' || ans === 'yes' || (ans === '' && def && !stdinClosed)) return true
    if (ans === 'n' || ans === 'no' || (ans === '' && !def)) return false
  }
}

/** Baca satu baris tanpa echo (untuk paste API key). Return '' bila stdin tutup. */
export function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const r = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    })
    const origWrite = (r as unknown as { _writeToOutput: (s: string) => void })._writeToOutput
    ;(r as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      // Prompt tampil apa adanya; karakter ketikan disamarkan.
      if (s.includes(prompt)) origWrite.call(r, s)
      else origWrite.call(r, '•')
    }
    const onClose = () => resolve('')
    r.once('close', onClose)
    r.question(prompt, (ans) => {
      r.removeListener('close', onClose)
      process.stdout.write('\n')
      r.close()
      resolve(ans.trim())
    })
  })
}
