/**
 * Host implementation untuk webview Tauri — semua fs/exec lewat invoke IPC.
 *
 * ponytail: batas sengaja diterima di Sesi A (sebagian sudah diperbaiki di Sesi D):
 * - exec.spawn kini punya kill + stdin via exec_kill/exec_write Rust (registry spawn-id).
 * - fs.writeFile hanya utf8 (fs_write_file Rust pakai String). Binary write
 *   belum ada pemakaian di core; bila perlu, tambah param base64 di Rust.
 * - env di-hydrate sekali dari daftar key tetap via os_env (bukan snapshot penuh).
 */
import { invoke, Channel } from '@tauri-apps/api/core'
import { setHost } from '@topupsaja/core/host.js'
import type { Host, HostProcess, HostExecOptions, HostStats, HostDirent } from '@topupsaja/core/host.js'

// ── crypto sync (interface host sync; Web Crypto async → implementasi kecil) ──

function randomBytes(size: number): Uint8Array {
  const b = new Uint8Array(size)
  crypto.getRandomValues(b)
  return b
}

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/** Padding SHA (message length bits + 0x80 + zeros). */
function shaPadded(data: string): Uint8Array {
  const bytes = new TextEncoder().encode(data)
  const len = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6)
  len.set(bytes)
  len[bytes.length] = 0x80
  const dv = new DataView(len.buffer)
  const bits = bytes.length * 8
  dv.setUint32(len.length - 8, Math.floor(bits / 0x1_0000_0000), false)
  dv.setUint32(len.length - 4, bits >>> 0, false)
  return len
}

// ponytail: sha1/sha256 murni JS — dipakai utk nama dir sesi & hashing ringan,
// bukan kripto sensitif. Web Crypto async, interface host butuh sync.
function sha1Hex(data: string): string {
  const m = shaPadded(data)
  const dv = new DataView(m.buffer)
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let i = 0; i < m.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false)
    for (let j = 16; j < 80; j++) {
      const n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]
      w[j] = (n << 1) | (n >>> 31)
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4
    for (let j = 0; j < 80; j++) {
      let f: number, k: number
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999 }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc }
      else { f = b ^ c ^ d; k = 0xca62c1d6 }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) | 0
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0
  }
  return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function sha256Hex(data: string): string {
  const m = shaPadded(data)
  const dv = new DataView(m.buffer)
  const w = new Uint32Array(64)
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  for (let i = 0; i < m.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false)
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3)
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10)
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + SHA256_K[j] + w[j]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

// ── fs ──

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function wrapStat(s: { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean }): HostStats {
  return {
    size: s.size,
    mtimeMs: s.mtimeMs,
    isFile: () => s.isFile,
    isDirectory: () => s.isDirectory,
  }
}

function wrapDirent(e: { name: string; isFile: boolean; isDirectory: boolean }): HostDirent {
  return { name: e.name, isFile: () => e.isFile, isDirectory: () => e.isDirectory }
}

async function readHostFile(path: string, encoding?: string): Promise<string | Uint8Array> {
  if (encoding === 'utf8') return invoke<string>('fs_read_text', { path })
  const b64 = await invoke<string>('fs_read_file', { path })
  return encoding === 'base64' ? b64 : b64ToBytes(b64)
}

// ── exec via Channel ──

type ExecEvent =
  | { type: 'spawned'; id: string }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'close'; code: number }
  | { type: 'error'; message: string }

function spawnHost(command: string, args: string[], opts?: { cwd?: string }): HostProcess {
  type L = { data: (c: string) => void; err: (c: string) => void; close: (c: number | null) => void; error: (e: Error) => void }
  const l: L = { data: () => {}, err: () => {}, close: () => {}, error: () => {} }
  let spawnId: string | null = null
  const proc: HostProcess = {
    stdin: {
      write: (c) => { if (spawnId) invoke('exec_write', { id: spawnId, data: String(c) }).catch(() => {}) },
      end: () => {},
      writable: true,
    },
    stdout: { on: (_e, cb) => { l.data = cb }, setEncoding: () => {} },
    stderr: { on: (_e, cb) => { l.err = cb } },
    on(ev, cb) {
      if (ev === 'error') l.error = cb as (e: Error) => void
      else l.close = cb as (c: number | null) => void
    },
    kill: () => { if (spawnId) invoke('exec_kill', { id: spawnId }).catch(() => {}) },
  }
  const ch = new Channel<ExecEvent>()
  ch.onmessage = (e) => {
    if (e.type === 'spawned') spawnId = e.id
    else if (e.type === 'stdout') l.data(e.data)
    else if (e.type === 'stderr') l.err(e.data)
    else if (e.type === 'close') l.close(e.code)
    else l.error(new Error(e.message))
  }
  invoke('exec_spawn', { command, args, cwd: opts?.cwd ?? null, onEvent: ch }).catch((e) =>
    l.error(new Error(String(e)))
  )
  return proc
}

// ── host ──

const ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SHELL', 'LANG',
  'TOPUPSAJA_API_KEY', 'TOPUPSAJA_API_URL',
]

export async function installHostTauri(): Promise<void> {
  // ponytail: homedir/cwd/env di-hydrate sekali saat install (IPC async),
  // kemudian sinkron di interface host. cwd desktop = cwd proses saat launch.
  const [homedir, cwd] = await Promise.all([invoke<string>('os_homedir'), invoke<string>('os_cwd')])
  const env = await invoke<Record<string, string>>('os_env', { keys: ENV_KEYS })

  const tauriHost: Host = {
    fs: {
      readFile(path: string, encoding?: string) { return readHostFile(path, encoding) as never },
      writeFile: (path, data, opts) => {
        if (data instanceof Uint8Array) {
          // ponytail: binary write belum didukung Rust — tulis via b64 decode ke string utf8.
          const text = new TextDecoder().decode(data)
          return invoke('fs_write_file', { path, data: text, mode: modeOf(opts) })
        }
        return invoke('fs_write_file', { path, data: data as string, mode: modeOf(opts) })
      },
      stat: async (path) => wrapStat(await invoke('fs_stat', { path })),
      readdir: async (path, opts?: { withFileTypes: true }) => {
        if (opts?.withFileTypes) {
          const entries = await invoke<{ name: string; isFile: boolean; isDirectory: boolean }[]>('fs_readdir', { path, withFileTypes: true })
          return entries.map(wrapDirent) as never
        }
        return (await invoke<{ name: string }[]>('fs_readdir', { path, withFileTypes: false })).map((e) => e.name) as never
      },
      mkdir: (path, opts?) => invoke('fs_mkdir', { path, recursive: opts?.recursive ?? null }),
      exists: (path) => invoke<boolean>('fs_exists', { path }),
      unlink: (path) => invoke('fs_unlink', { path }),
      chmod: (path, mode) => invoke('fs_chmod', { path, mode }),
    },

    exec: {
      spawn: spawnHost,

      execFile: (command, args, opts?: HostExecOptions) =>
        new Promise<string>((resolve, reject) => {
          let out = ''
          const proc = spawnHost(command, args, { cwd: opts?.cwd })
          proc.stdout.on('data', (c) => (out += c))
          proc.stderr.on('data', (c) => (out += c))
          proc.on('error', (e) => reject(new Error(e.message)))
          proc.on('close', (code) => {
            if (code === 0) resolve(out)
            else reject(new Error(out.trim() || `exit ${code}`))
          })
        }),

      exec: (command, opts?: HostExecOptions) =>
        new Promise((resolve) => {
          let stdout = ''
          let stderr = ''
          const proc = spawnHost('bash', ['-c', command], { cwd: opts?.cwd })
          proc.stdout.on('data', (c) => (stdout += c))
          proc.stderr.on('data', (c) => (stderr += c))
          proc.on('error', (e) => resolve({ code: 1, stdout, stderr: e.message }))
          proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
        }),
    },

    crypto: {
      randomBytes,
      randomHex: (bytes) => [...randomBytes(bytes)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      sha256hex: (data) => sha256Hex(data),
      sha1hex: (data) => sha1Hex(data),
    },

    homedir: () => homedir,
    tmpdir: () => homedir,
    cwd: () => cwd,
    env,
  }

  setHost(tauriHost)
}

function modeOf(opts?: 'utf8' | { encoding?: string; mode?: number }): number | null {
  if (typeof opts === 'object' && opts !== null && typeof opts.mode === 'number') return opts.mode
  return null
}