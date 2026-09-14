/**
 * Host abstraction — satu-satunya jembatan core ke lingkungan eksekusi.
 * Core tidak boleh import node:fs / node:child_process / node:os langsung
 * (core juga berjalan di webview Tauri via IPC). CLI memasang host Node
 * (host-node.ts); app desktop memasang host berbasis Tauri invoke.
 *
 * Panggilan harus lewat getHost() (lazy, bukan const module-level) agar
 * setHost() bisa dipanggil di entrypoint sebelum modul lain dipakai.
 */

export interface HostDirent {
  name: string
  isFile(): boolean
  isDirectory(): boolean
}

export interface HostStats {
  size: number
  mtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
}

/**
 * FS host — semua method ASYNC (Promise). Webview Tauri hanya bisa invoke
 * async; Node mem-bungkus sync di balik Promise. Jangan reintroduce sync.
 */
export interface HostFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  readFile(path: string, encoding: 'base64'): Promise<string>
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: string | Uint8Array, opts?: 'utf8' | { encoding?: string; mode?: number }): Promise<void>
  stat(path: string): Promise<HostStats>
  readdir(path: string): Promise<string[]>
  readdir(path: string, opts: { withFileTypes: true }): Promise<HostDirent[]>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  exists(path: string): Promise<boolean>
  unlink(path: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
}

export interface HostSpawnOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  stdio?: ('pipe' | 'ignore')[]
}

/** Proses child minimal — event & stream yang dipakai core saja. */
export interface HostStdin {
  write(data: string): void
  end(): void
  writable: boolean
}
export interface HostProcess {
  stdin: HostStdin
  stdout: { on(event: 'data', cb: (chunk: string) => void): void; setEncoding(enc: string): void }
  stderr: { on(event: 'data', cb: (chunk: string) => void): void }
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): void
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void
  kill(signal?: string): void
}

export interface HostExecOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeout?: number
  maxBuffer?: number
}

export interface HostExec {
  spawn(command: string, args: string[], opts?: HostSpawnOptions): HostProcess
  /** execFile promisified — resolve stdout, reject Error (stderr di message). */
  execFile(command: string, args: string[], opts?: HostExecOptions): Promise<string>
  /** exec shell-string — resolve {code, stdout, stderr}, tidak reject untuk exit ≠ 0. */
  exec(command: string, opts?: HostExecOptions): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface HostCrypto {
  randomBytes(size: number): Uint8Array
  /** hex string acak sepanjang bytes*2. */
  randomHex(bytes: number): string
  sha256hex(data: string): string
  sha1hex(data: string): string
}

export interface Host {
  fs: HostFs
  exec: HostExec
  crypto: HostCrypto
  homedir(): string
  tmpdir(): string
  cwd(): string
  env: Record<string, string | undefined>
}

let current: Host | null = null

/** Pasang host implementation — wajib dipanggil di entrypoint sebelum core dipakai. */
export function setHost(h: Host): void {
  current = h
}

/** Host aktif. Lempar jelas bila lupa setHost (bukan TypeError samar). */
export function getHost(): Host {
  if (!current) throw new Error('Host belum diset — panggil setHost() di entrypoint')
  return current
}
