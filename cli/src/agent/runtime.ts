import { EventEmitter } from 'node:events'
import type { ModelInfo } from '../api.js'
import type { TodoItem } from '../storage/todo.js'
import type { AgentSession } from '../session/store.js'
import type { PermissionManager, ApprovalRequest } from './permission.js'
import type { PermissionMode } from '../config.js'
import type { CustomMode } from './modes.js'
import type { McpConnection } from '../mcp/client.js'

export type AskUserOption = { label: string; description?: string }

export interface AskUserRequest {
  id: string
  question: string
  options: AskUserOption[]
  /** true → user boleh memilih lebih dari satu opsi (jawaban kind 'options'). */
  multiSelect?: boolean
}

export type AskUserAnswer =
  | { kind: 'option'; label: string }
  | { kind: 'options'; labels: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'cancel' }

/** Manager ringan request/answer ask_user (pola pending Map PermissionManager). */
export class AskUserManager {
  private seq = 0
  private pending = new Map<string, (a: AskUserAnswer) => void>()

  newRequest(question: string, options: AskUserOption[], multiSelect = false): AskUserRequest {
    return { id: `ask_${++this.seq}_${Date.now().toString(36)}`, question, options, multiSelect }
  }

  /** Jawaban dari UI (dipanggil via emitter callback). */
  answer(id: string, answer: AskUserAnswer): void {
    const resolve = this.pending.get(id)
    if (!resolve) return
    this.pending.delete(id)
    resolve(answer)
  }

  awaitAnswer(id: string): Promise<AskUserAnswer> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
    })
  }
}

export type AgentEventMap = {
  delta: [text: string]
  tool_start: [info: { id: string; name: string; desc: string }]
  tool_result: [info: { id: string; ok: boolean; output: string }]
  approval_request: [req: ApprovalRequest]
  approval_result: [res: { id: string; approved: boolean; always?: boolean; alwaysPattern?: boolean; hunks?: number[] }]
  ask_user_request: [req: AskUserRequest]
  ask_user_result: [res: { id: string; answer: AskUserAnswer }]
  status: [
    info: {
      model: string
      promptTokens?: number
      completionTokens?: number
      creditsUsed?: number
      balance?: number
      contextPct?: number
    },
  ]
  notice: [text: string]
  todo: [items: TodoItem[]]
  mode_changed: [info: { mode: string; permissionMode: PermissionMode }]
  done: [info: { completed: boolean }]
  error: [message: string]
}

/** EventEmitter typed — jembatan headless loop → UI (Ink / teks polos). */
export class AgentEmitter {
  private ee = new EventEmitter()

  on<K extends keyof AgentEventMap>(event: K, fn: (...args: AgentEventMap[K]) => void): () => void {
    this.ee.on(event, fn)
    return () => this.ee.off(event, fn)
  }

  emit<K extends keyof AgentEventMap>(event: K, ...args: AgentEventMap[K]): void {
    this.ee.emit(event, ...args)
  }
}

/** State bersama satu sesi agent yang hidup (dipakai loop, compaction, UI). */
export interface AgentRuntime {
  cwd: string
  session: AgentSession
  permissions: PermissionManager
  emitter: AgentEmitter
  /** Mode id saat ini — builtin ('code'|'architect'|'ask'|'test') atau nama custom mode. */
  mode: string
  /** Custom modes (.tsa/modes + ~/.topupsaja/modes) — discovery sekali di startup. */
  customModes: CustomMode[]
  /** Cache GET /v1/models untuk context window & pilih model ringkasan. */
  models: ModelInfo[]
  /** Set true untuk membatalkan turn yang sedang jalan. */
  abort: boolean
  /** Controller abort turn aktif — di-abort bersama rt.abort agar fetch berhenti mid-stream. */
  abortController: AbortController | null
  /** Stack turn → daftar file yang dimutasi turn itu (untuk /undo). */
  checkpointTurns: string[][]
  /** Snapshot pre-mutasi per turn (in-memory) — /undo restore ke state ini. */
  turnSnapshots: Map<string, string | null>[]
  /** Koneksi MCP stdio aktif (kosong bila tanpa config mcp.json). */
  mcp: McpConnection[]
  /** Manajer pertanyaan ask_user (tool komunikasi, bukan approval). */
  askUser: AskUserManager
}
