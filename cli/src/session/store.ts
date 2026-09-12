import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { ChatMessage } from '../api.js'
import { TodoItem, TodoStore } from '../storage/todo.js'
import type { PermissionMode } from '../config.js'
import type { CustomMode } from '../agent/modes.js'
import { discoverCustomModes } from '../agent/modes.js'
import type { AttachedFile, AttachedDoc } from './context.js'
import type { PermissionLogEntry } from '../agent/rules.js'

export interface SessionFile {
  id: string
  title: string
  model: string
  created: string
  updated: string
  cwd: string
  mode: string
  permission_mode: PermissionMode
  messages: ChatMessage[]
  todos: TodoItem[]
  /** Total credit terpakai sepanjang sesi (dari settle server). */
  credits_used?: number
  /** Akumulasi token sepanjang sesi (dari usage chunk). */
  tokens_in?: number
  tokens_out?: number
  /** Saldo credit terakhir yang diketahui dari server (settle / verify). */
  last_balance?: number
  /** File dilampirkan via /add (snapshot isi saat dilampirkan). */
  attached?: AttachedFile[]
  /** Dokumen web dilampirkan via /add-doc. */
  docs?: AttachedDoc[]
  /** Checkpoint isi file sebelum mutasi (baseline per path). */
  checkpoints?: Record<string, { content: string | null; at: string }>
  /** Audit log keputusan permission (ring buffer 200 entri terbaru). */
  permission_log?: PermissionLogEntry[]
}

const VALID_MODES: string[] = ['code', 'architect', 'ask', 'test']

/** Map mode tersimpan → id mode kini; plan/act lama → architect/code; nama custom diterima; else 'code'. */
export function normalizeMode(raw: unknown, custom: CustomMode[] = []): string {
  if (raw === 'plan') return 'architect'
  if (raw === 'act') return 'code'
  const s = typeof raw === 'string' ? raw : undefined
  if (s && VALID_MODES.includes(s)) return s
  if (s && custom.some((c) => c.name === s)) return s
  return 'code'
}

export interface SessionMeta {
  id: string
  title: string
  model: string
  updated: number
}

/** Dir project: ~/.topupsaja/projects/<hash-cwd>/sessions/ */
export function projectSessionDir(cwd: string): string {
  const hash = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 16)
  return path.join(os.homedir(), '.topupsaja', 'projects', hash, 'sessions')
}

function safeTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 60)
  return t || 'sesi tanpa judul'
}

/** Sesi agent: riwayat messages + todo, persist ke file tiap turn. */
export class AgentSession {
  id: string
  title: string
  model: string
  created: number
  cwd: string
  mode: string = 'code'
  permissionMode: PermissionMode = 'ask'
  messages: ChatMessage[] = []
  todos = new TodoStore()
  /** Total credit terpakai sepanjang sesi. */
  creditsUsed = 0
  /** Akumulasi token (prompt/completion) sepanjang sesi. */
  tokensIn = 0
  tokensOut = 0
  /** Saldo credit terakhir dari server (event settle / verify). */
  lastBalance: number | undefined
  /** Lampiran file (/add) & dokumen (/add-doc) — konteks extra per turn. */
  attached: AttachedFile[] = []
  docs: AttachedDoc[] = []
  /** Checkpoint baseline per path (untuk /undo, /diff). */
  checkpoints: Record<string, { content: string | null; at: string }> = {}
  /** Audit log keputusan permission (entri terbaru di belakang). */
  permissionLog: PermissionLogEntry[] = []

  constructor(data: { id: string; title: string; model: string; created: number; cwd: string }) {
    this.id = data.id
    this.title = data.title
    this.model = data.model
    this.created = data.created
    this.cwd = data.cwd
  }

  static create(cwd: string, model: string, systemPrompt: string): AgentSession {
    const s = new AgentSession({
      id: new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + crypto.randomBytes(3).toString('hex'),
      title: 'sesi baru',
      model,
      created: Date.now(),
      cwd,
    })
    s.messages.push({ role: 'system', content: systemPrompt })
    return s
  }

  static load(cwd: string, id: string): AgentSession | null {
    try {
      const raw = fs.readFileSync(path.join(projectSessionDir(cwd), `${id}.json`), 'utf8')
      const f = JSON.parse(raw) as SessionFile
      const s = new AgentSession({
        id: f.id,
        title: f.title,
        model: f.model,
        created: Date.parse(f.created) || Date.now(),
        cwd: cwd,
      })
      s.mode = normalizeMode(f.mode, discoverCustomModes(cwd))
      s.permissionMode = f.permission_mode ?? 'ask'
      s.messages = f.messages ?? []
      s.todos.set(f.todos ?? [])
      s.creditsUsed = f.credits_used ?? 0
      s.tokensIn = f.tokens_in ?? 0
      s.tokensOut = f.tokens_out ?? 0
      s.lastBalance = f.last_balance
      s.attached = f.attached ?? []
      s.docs = f.docs ?? []
      s.checkpoints = f.checkpoints ?? {}
      s.permissionLog = f.permission_log ?? []
      return s
    } catch {
      return null
    }
  }

  /** Judul sesi = pesan user pertama (sekali set). */
  noteUserMessage(text: string): void {
    if (this.title === 'sesi baru' && text.trim()) this.title = safeTitle(text)
  }

  reset(systemPrompt: string): void {
    this.messages = [{ role: 'system', content: systemPrompt }]
    this.todos.set([])
    this.title = 'sesi baru'
    this.permissionLog = []
  }

  /** Catat satu keputusan permission (ring buffer 200 entri terbaru). */
  logPermission(entry: PermissionLogEntry): void {
    this.permissionLog.push(entry)
    if (this.permissionLog.length > 200) {
      this.permissionLog = this.permissionLog.slice(-200)
    }
  }

  file(): string {
    return path.join(projectSessionDir(this.cwd), `${this.id}.json`)
  }

  /** Tulis ulang file sesi (append-safe per turn). */
  save(): string | null {
    try {
      const dir = projectSessionDir(this.cwd)
      fs.mkdirSync(dir, { recursive: true })
      const f: SessionFile = {
        id: this.id,
        title: this.title,
        model: this.model,
        created: new Date(this.created).toISOString(),
        updated: new Date().toISOString(),
        cwd: this.cwd,
        mode: this.mode,
        permission_mode: this.permissionMode,
        messages: this.messages,
        todos: this.todos.items,
        credits_used: this.creditsUsed,
        tokens_in: this.tokensIn,
        tokens_out: this.tokensOut,
        last_balance: this.lastBalance,
        attached: this.attached,
        docs: this.docs,
        checkpoints: this.checkpoints,
        permission_log: this.permissionLog,
      }
      fs.writeFileSync(this.file(), JSON.stringify(f, null, 2) + '\n')
      return this.file()
    } catch {
      return null
    }
  }
}

/** Daftar metadata sesi untuk cwd, terbaru dulu. */
export function listSessions(cwd: string): SessionMeta[] {
  const dir = projectSessionDir(cwd)
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const metas: SessionMeta[] = []
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SessionFile
      metas.push({
        id: raw.id,
        title: raw.title ?? 'sesi baru',
        model: raw.model ?? '?',
        updated: Date.parse(raw.updated ?? raw.created ?? '') || 0,
      })
    } catch {
      /* file korup — skip */
    }
  }
  return metas.sort((a, b) => b.updated - a.updated)
}

/** Id sesi terbaru untuk cwd (untuk --continue). */
export function lastSessionId(cwd: string): string | null {
  const list = listSessions(cwd)
  return list.length ? list[0].id : null
}
