import { ChatMessage, ContentPart, ModelInfo, chatCompletion } from '../api.js'
import type { AgentRuntime } from '../agent/runtime.js'

/** Estimasi token kasar: jumlah karakter / 4. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

const KEEP_RECENT = 8
const MAX_TRANSCRIPT_CHARS = 60_000
/** Estimasi biaya konteks per gambar (char) — vision token bervariasi. */
const IMAGE_PART_CHARS = 1200

function contentChars(content: ChatMessage['content']): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let n = 0
    for (const p of content as ContentPart[]) {
      n += p.type === 'text' ? p.text.length : IMAGE_PART_CHARS
    }
    return n
  }
  return 0
}

function contentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as ContentPart[])
      .map((p) => (p.type === 'text' ? p.text : '[image]'))
      .join('\n')
  }
  return ''
}

/** Estimasi token seluruh messages (chars/4, termasuk system). */
export function messagesTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    chars += contentChars(m.content)
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length
    chars += (m.tool_call_id?.length ?? 0) + m.role.length + 8
  }
  return estimateTokens(chars)
}

export function contextWindowFor(models: ModelInfo[], modelId: string): number | null {
  const m = models.find((x) => x.id === modelId)
  return m?.context_window ?? null
}

/** Ambil pesan system (selalu index 0). */
function systemMsg(messages: ChatMessage[]): ChatMessage | null {
  return messages[0]?.role === 'system' ? messages[0] : null
}

/**
 * Cari titik potong aman: recent dimulai dari pesan user agar pasangan
 * assistant(tool_calls)+tool(result) tidak tercerai.
 */
function safeCut(rest: ChatMessage[], keep: number): number {
  let i = Math.max(0, rest.length - keep)
  while (i < rest.length && rest[i].role !== 'user') i++
  return Math.min(i, rest.length)
}

function transcript(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      lines.push(`[tool result ${m.tool_call_id ?? ''}]\n${contentText(m.content)}`)
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      lines.push(
        `[assistant tool_calls]\n${m.tool_calls
          .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
          .join('\n')}`
      )
    } else {
      lines.push(`[${m.role}]\n${contentText(m.content)}`)
    }
  }
  const t = lines.join('\n\n')
  return t.length > MAX_TRANSCRIPT_CHARS ? t.slice(-MAX_TRANSCRIPT_CHARS) : t
}

/** Model termurah (pricing.output) dari daftar model aktif. */
export function cheapestModel(models: ModelInfo[], fallback: string): string {
  if (models.length === 0) return fallback
  const sorted = [...models].sort((a, b) => a.pricing.output - b.pricing.output)
  return sorted[0].id
}

/**
 * Ringkas pesan lama via 1 call chat (model termurah aktif).
 * Sisakan system + ringkasan + N pesan terakhir.
 */
export async function compactNow(rt: AgentRuntime): Promise<boolean> {
  const { session, emitter } = rt
  const sys = systemMsg(session.messages)
  const rest = sys ? session.messages.slice(1) : session.messages
  if (rest.length < 4) return false

  const cut = safeCut(rest, KEEP_RECENT)
  if (cut <= 0) return false
  const old = rest.slice(0, cut)
  const recent = rest.slice(cut)

  const summaryModel = cheapestModel(rt.models, session.model)
  emitter.emit(
    'notice',
    `Konteks mendekati batas — meringkas ${old.length} pesan lama (model ${summaryModel})...`
  )

  const prompt = `Ringkas percakapan coding-agent berikut dalam Bahasa Indonesia untuk dipakai sebagai konteks lanjutan. Pertahankan: tujuan user, keputusan penting, file yang sudah dibaca/diubah (path), hasil tool penting, dan langkah yang belum selesai. Maksimal ~400 kata.\n\n<transkrip>\n${transcript(old)}\n</transkrip>`

  let summary: string
  try {
    const r = await chatCompletion({
      model: summaryModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    })
    if (r.creditsUsed !== undefined) session.creditsUsed += r.creditsUsed
    if (r.balance !== undefined) session.lastBalance = r.balance
    summary = r.data.choices?.[0]?.message?.content?.trim() ?? ''
  } catch (e) {
    emitter.emit('error', `Compaction gagal: ${(e as Error).message}`)
    return false
  }
  if (!summary) return false

  const newMessages: ChatMessage[] = []
  if (sys) newMessages.push(sys)
  newMessages.push({
    role: 'user',
    content: `<ringkasan_sesi_sebelumnya>\n${summary}\n</ringkasan_sesi_sebelumnya>\n\nLanjutkan pekerjaan dari ringkasan di atas.`,
  })
  newMessages.push(...recent)

  session.messages = newMessages
  session.save()
  emitter.emit('notice', `Compaction selesai: ${old.length} pesan → ringkasan. Konteks: ~${messagesTokens(session.messages)} token.`)
  return true
}

/**
 * Trigger otomatis: bila estimasi token > 70% context window → ringkas.
 * Return true bila compaction terjadi.
 */
export async function maybeCompact(rt: AgentRuntime): Promise<boolean> {
  const window = contextWindowFor(rt.models, rt.session.model)
  if (!window) return false
  const used = messagesTokens(rt.session.messages)
  if (used <= window * 0.7) return false
  if (rt.permissions.mode !== 'yolo') {
    rt.emitter.emit(
      'notice',
      `Perkiraan konteks ${used.toLocaleString('id-ID')}/${window.toLocaleString('id-ID')} token (>70%).`
    )
  }
  return compactNow(rt)
}
