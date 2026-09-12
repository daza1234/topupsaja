import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiError } from '../api.js'

export interface McpServerSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpPromptArgDef {
  name: string
  description?: string
  required?: boolean
}

export interface McpPromptDef {
  name: string
  description?: string
  arguments?: McpPromptArgDef[]
}

const INIT_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 60_000

/** Nama tool MCP untuk UI/dispatch: mcp__<server>__<tool>. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

/** Nama prompt MCP untuk slash: mcp__<server>__<prompt> (UI menambah '/'). */
export function mcpPromptName(server: string, prompt: string): string {
  return `mcp__${server}__${prompt}`
}

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const m = name.match(/^mcp__([^_]+(?:__[^_]+)*?)__([^_]+)$/)
  if (!m) return null
  return { server: m[1], tool: m[2] }
}

/**
 * Mapping positional args user → Record nama argumen prompt.
 * Token di-split whitespace; token i → arguments[i].name; sisa token digabung
 * ke argumen TERAKHIR; argumen tanpa token → string kosong; tanpa deklarasi → semua diabaikan.
 */
export function mapPromptArgs(
  prompt: Pick<McpPromptDef, 'arguments'> | undefined,
  argsString: string
): Record<string, string> {
  const names = (prompt?.arguments ?? []).map((a) => a.name)
  const out: Record<string, string> = {}
  for (const n of names) out[n] = ''
  if (names.length === 0) return out
  const tokens = argsString.trim().split(/\s+/).filter(Boolean)
  tokens.forEach((t, i) => {
    if (i < names.length - 1) out[names[i]] = t
    else if (i === names.length - 1) out[names[i]] = t
    else out[names[names.length - 1]] = `${out[names[names.length - 1]]} ${t}`.trim()
  })
  return out
}

/** Flatten hasil prompts/get: gabung text semua messages; prefix [role] untuk non-user. */
export function flattenPromptMessages(res: unknown): string {
  const msgs =
    (res as { messages?: { role?: string; content?: { type?: string; text?: string } }[] })?.messages ?? []
  return msgs
    .map((m) => {
      const text = m.content?.type === 'text' ? (m.content.text ?? '') : ''
      return m.role === 'user' ? text : `[${m.role}] ${text}`
    })
    .filter((t) => t.trim().length > 0)
    .join('\n\n')
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** Satu koneksi MCP stdio (JSON-RPC newline-delimited via stdin/stdout). */
export class McpConnection {
  readonly name: string
  readonly spec: McpServerSpec
  status: 'starting' | 'connected' | 'error' = 'starting'
  error = ''
  tools: McpToolDef[] = []
  prompts: McpPromptDef[] = []
  private proc: ChildProcess | null = null
  private seq = 0
  private pending = new Map<number, Pending>()
  private buffer = ''
  private waiter: ((line: string) => void)[] = []

  constructor(name: string, spec: McpServerSpec) {
    this.name = name
    this.spec = spec
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: { id?: number; error?: { message?: string }; result?: unknown }
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return // bukan JSON — abaikan
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new ApiError(500, `MCP '${this.name}': ${msg.error.message ?? 'error'}`, 'mcp_error'))
      else p.resolve(msg.result)
      return
    }
    // notifikasi / response tanpa pending — abaikan
  }

  private attach(proc: ChildProcess): void {
    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        const w = this.waiter.shift()
        if (w) w(line)
        else this.handleLine(line)
      }
    })
    proc.stderr!.on('data', () => {
      /* stderr server MCP — abaikan (bisa log) */
    })
    proc.on('exit', (code) => {
      this.status = 'error'
      this.error = `server exit ${code ?? '?'}`
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`MCP '${this.name}' berhenti (exit ${code})`))
      }
      this.pending.clear()
    })
    proc.on('error', (err) => {
      this.status = 'error'
      this.error = err.message
    })
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error(`MCP '${this.name}' tidak berjalan`))
    }
    const id = ++this.seq
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP '${this.name}': timeout ${method} (${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc!.stdin!.write(msg)
    })
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  /** Spawn + initialize + tools/list. */
  async connect(cwd: string): Promise<void> {
    this.proc = spawn(this.spec.command, this.spec.args ?? [], {
      cwd,
      env: { ...process.env, ...(this.spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.attach(this.proc)
    try {
      const res = (await this.request(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, prompts: {} },
          clientInfo: { name: 'tsa-cli', version: '0.6.0' },
        },
        INIT_TIMEOUT_MS
      )) as { serverInfo?: { name?: string } } | undefined
      void res
      this.notify('notifications/initialized', {})
      const listed = (await this.request('tools/list', {}, INIT_TIMEOUT_MS)) as {
        tools?: McpToolDef[]
      }
      this.tools = Array.isArray(listed?.tools) ? listed.tools : []
      // Server tanpa dukungan prompts tidak boleh menggagalkan connect.
      try {
        const pl = (await this.request('prompts/list', {}, INIT_TIMEOUT_MS)) as {
          prompts?: McpPromptDef[]
        }
        this.prompts = Array.isArray(pl?.prompts) ? pl.prompts : []
      } catch {
        this.prompts = []
      }
      this.status = 'connected'
    } catch (err) {
      this.status = 'error'
      this.error = (err as Error).message
      this.stop()
    }
  }

  /** Reconnect: matikan lalu hidupkan ulang. */
  async reconnect(cwd: string): Promise<void> {
    this.stop()
    this.status = 'starting'
    this.error = ''
    await this.connect(cwd)
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.request(
      'tools/call',
      { name: tool, arguments: args },
      CALL_TIMEOUT_MS
    )) as { content?: { type: string; text?: string }[]; isError?: boolean }
    const parts = (res?.content ?? [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
    const text = parts.join('\n')
    if (res?.isError) throw new ApiError(500, `MCP '${this.name}': ${text || 'tool error'}`, 'mcp_error')
    return text
  }

  /** prompts/get → teks gabungan semua messages (flatten). */
  async getPrompt(prompt: string, args: Record<string, string>): Promise<string> {
    const res = await this.request('prompts/get', { name: prompt, arguments: args }, CALL_TIMEOUT_MS)
    return flattenPromptMessages(res)
  }

  stop(): void {
    try {
      this.proc?.stdin?.end()
      this.proc?.kill()
    } catch {
      /* ignore */
    }
    this.proc = null
  }

  /** Baca satu baris mentah (dipakai test via waiter). */
  onLine(fn: (line: string) => void): void {
    this.waiter.push(fn)
  }
}

/** Baca config MCP: ~/.topupsaja/mcp.json lalu <cwd>/.tsa/mcp.json (project menang). */
export function loadMcpConfig(cwd: string): Record<string, McpServerSpec> {
  const files = [
    path.join(os.homedir(), '.topupsaja', 'mcp.json'),
    path.join(cwd, '.tsa', 'mcp.json'),
  ]
  const merged: Record<string, McpServerSpec> = {}
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as {
        mcpServers?: Record<string, McpServerSpec>
      }
      for (const [name, spec] of Object.entries(raw.mcpServers ?? {})) {
        if (spec && typeof spec.command === 'string') merged[name] = spec
      }
    } catch {
      /* tanpa config — skip */
    }
  }
  return merged
}

/** Load config + connect semua server (error tidak melempar — catat di status). */
export async function connectMcpServers(
  cwd: string,
  log: (msg: string) => void = console.error
): Promise<McpConnection[]> {
  const specs = loadMcpConfig(cwd)
  const conns: McpConnection[] = []
  for (const [name, spec] of Object.entries(specs)) {
    const conn = new McpConnection(name, spec)
    await conn.connect(cwd)
    if (conn.status === 'connected') {
      log(`MCP '${name}' terhubung (${conn.tools.length} tool${conn.prompts.length ? `, ${conn.prompts.length} prompt` : ''}).`)
    } else {
      log(`MCP '${name}' gagal: ${conn.error}`)
    }
    conns.push(conn)
  }
  return conns
}
