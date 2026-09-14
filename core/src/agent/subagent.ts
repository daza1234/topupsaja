import { ChatMessage, streamChat } from '../api.js'
import { executeTool } from './exec.js'
import type { AgentRuntime } from './runtime.js'

const MAX_STEPS = 15
const RESULT_LIMIT = 10_000

const SUBAGENT_SYSTEM = `Kamu adalah subagent riset read-only untuk coding agent tsa. Tugasmu: membaca kode (read_file, glob, grep) dan menjawab pertanyaan parent agent secara RINGKAS dan PADAT dalam Bahasa Indonesia.
ATURAN:
- Kamu HANYA punya tool read_file, glob, grep — tidak bisa menulis/mengeksekusi apa pun.
- Maksimal ${MAX_STEPS} langkah. Efisien: baca hanya file yang relevan.
- Jawaban akhir: temuan utama + path file:baris referensi. Tanpa basa-basi.`

export const READ_ONLY = new Set(['read_file', 'glob', 'grep'])

export const READ_ONLY_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Baca isi file teks. Return isi file dengan nomor baris.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path file (relatif atau absolut)' },
          offset: { type: 'integer', description: 'Nomor baris awal (1-indexed), opsional' },
          limit: { type: 'integer', description: 'Jumlah baris maksimal, opsional' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Cari file by pattern glob (mis. "src/**/*.ts").',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern glob relatif cwd' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Cari teks/regex rekursif di file. Return file:baris: konten.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern regex (JS regex syntax)' },
          path: { type: 'string', description: 'File atau direktori awal, default cwd' },
        },
        required: ['pattern'],
      },
    },
  },
] as const

/**
 * Subagent headless read-only: loop kecil dengan {read_file, glob, grep},
 * model sama dengan parent, tanpa compaction & tanpa approval (read-only).
 * Return teks jawaban final (truncate 10k) untuk dipakai sebagai tool result.
 */
export async function runSubagent(rt: AgentRuntime, task: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SUBAGENT_SYSTEM },
    { role: 'user', content: task },
  ]

  for (let step = 0; step < MAX_STEPS; step++) {
    if (rt.abort) return '(subagent dibatalkan user)'

    let result
    try {
      result = await streamChat(
        {
          model: rt.session.model,
          messages,
          tools: READ_ONLY_SCHEMAS,
          tool_choice: 'auto',
          max_tokens: 4096,
        },
        {},
        { signal: rt.abortController?.signal }
      )
    } catch (err) {
      if (rt.abortController?.signal.aborted) return '(subagent dibatalkan user)'
      return `(subagent gagal: ${(err as Error).message})`
    }

    if (result.creditsUsed !== undefined) rt.session.creditsUsed += result.creditsUsed

    const msg: ChatMessage = { role: 'assistant', content: result.content || null }
    if (result.toolCalls.length) msg.tool_calls = result.toolCalls
    messages.push(msg)

    if (result.toolCalls.length === 0) {
      const text = result.content.trim()
      return text.length > RESULT_LIMIT ? text.slice(0, RESULT_LIMIT) + '\n... (dipotong)' : text
    }

    for (const call of result.toolCalls) {
      const name = call.function.name
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: argumen bukan JSON valid.' })
        continue
      }
      if (!READ_ONLY.has(name)) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `DITOLAK: subagent read-only — tool '${name}' tidak diizinkan.`,
        })
        continue
      }
      const r = await executeTool(name, args, { todos: rt.session.todos, rt })
      messages.push({ role: 'tool', tool_call_id: call.id, content: r.output })
    }
  }

  return '(subagent berhenti: batas langkah tercapai tanpa jawaban final)'
}
