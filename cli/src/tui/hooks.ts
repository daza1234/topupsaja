import { useEffect, useRef, useState } from 'react'
import type { AgentRuntime } from '@topupsaja/core/agent/runtime.js'
import type { AskUserRequest } from '@topupsaja/core/agent/runtime.js'
import type { TodoItem } from '@topupsaja/core/storage/todo.js'
import type { ApprovalRequest } from '@topupsaja/core/agent/permission.js'
import type { PermissionMode } from '@topupsaja/core/config.js'

export type Block =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; desc: string; ok?: boolean; output?: string }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string }

export interface StatusInfo {
  model: string
  promptTokens?: number
  completionTokens?: number
  creditsUsed?: number
  balance?: number
  contextPct?: number
}

export interface Overlay {
  kind: 'model' | 'sessions' | 'files' | 'add' | 'mode' | 'settings'
}

/** Jembatan event-emitter agent loop → React state untuk TUI Ink. */
export function useAgentBridge(rt: AgentRuntime) {
  const [blocks, setBlocks] = useState<Block[]>([])
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<StatusInfo | null>(null)
  const [todos, setTodos] = useState<TodoItem[]>(rt.session.todos.items)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [askUser, setAskUser] = useState<AskUserRequest | null>(null)
  const [mode, setModeState] = useState<string>(rt.mode)
  const [permMode, setPermMode] = useState<PermissionMode>(rt.permissions.mode)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const streamingRef = useRef('')

  useEffect(() => {
    const offs = [
      rt.emitter.on('delta', (t) => {
        streamingRef.current += t
        setStreaming(streamingRef.current)
      }),
      rt.emitter.on('tool_start', ({ id, name, desc }) => {
        flushStreaming()
        setBlocks((prev) => [...prev, { kind: 'tool', name, desc }])
        toolIdRef.current = id
      }),
      rt.emitter.on('tool_result', ({ id, ok, output }) => {
        if (toolIdRef.current === id) {
          toolIdRef.current = null
          setBlocks((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.kind === 'tool') {
              const copy = [...prev]
              copy[copy.length - 1] = { ...last, ok, output }
              return copy
            }
            return [...prev, { kind: 'tool', name: '?', desc: '', ok, output }]
          })
        } else {
          setBlocks((prev) => [...prev, { kind: 'tool', name: '?', desc: '', ok, output }])
        }
      }),
      rt.emitter.on('approval_request', (req) => setApproval(req)),
      rt.emitter.on('approval_result', () => setApproval(null)),
      rt.emitter.on('ask_user_request', (req) => {
        flushStreaming()
        setAskUser(req)
      }),
      rt.emitter.on('ask_user_result', () => setAskUser(null)),
      rt.emitter.on('status', (info) => setStatus(info)),
      rt.emitter.on('notice', (text) => {
        flushStreaming()
        setBlocks((prev) => [...prev, { kind: 'notice', text }])
      }),
      rt.emitter.on('error', (message) => {
        flushStreaming()
        setBlocks((prev) => [...prev, { kind: 'error', text: message }])
      }),
      rt.emitter.on('todo', (items) => setTodos([...items])),
      rt.emitter.on('mode_changed', ({ mode, permissionMode }) => {
        setModeState(mode)
        setPermMode(permissionMode)
      }),
      rt.emitter.on('done', () => {
        flushStreaming()
        setBusy(false)
      }),
    ]
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toolIdRef = useRef<string | null>(null)

  function flushStreaming() {
    if (streamingRef.current) {
      const text = streamingRef.current
      streamingRef.current = ''
      setStreaming('')
      setBlocks((prev) => [...prev, { kind: 'assistant', text }])
    }
  }

  function addUserBlock(text: string) {
    setBlocks((prev) => [...prev, { kind: 'user', text }])
  }

  function addNotice(text: string) {
    setBlocks((prev) => [...prev, { kind: 'notice', text }])
  }

  function clearBlocks() {
    streamingRef.current = ''
    setStreaming('')
    setBlocks([])
    setStatus(null)
  }

  return {
    blocks,
    streaming,
    busy,
    status,
    todos,
    approval,
    askUser,
    mode,
    permMode,
    overlay,
    setOverlay,
    setBusy,
    addUserBlock,
    addNotice,
    clearBlocks,
    setPermMode,
  }
}
