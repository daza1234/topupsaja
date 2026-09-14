export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority?: 'high' | 'medium' | 'low'
}

const VALID_STATUS = new Set(['pending', 'in_progress', 'completed', 'cancelled'])
const VALID_PRIORITY = new Set(['high', 'medium', 'low'])

/** State todo per sesi — di-update tool todo_write, di-render panel live. */
export class TodoStore {
  items: TodoItem[] = []
  version = 0
  onChange?: (items: TodoItem[]) => void

  set(raw: unknown): { ok: boolean; error?: string } {
    if (!Array.isArray(raw)) return { ok: false, error: 'todos harus array.' }
    const items: TodoItem[] = []
    for (const it of raw) {
      const obj = it as Record<string, unknown>
      const content = typeof obj.content === 'string' ? obj.content : ''
      const status = String(obj.status ?? 'pending')
      if (!content.trim()) return { ok: false, error: 'setiap item butuh content.' }
      if (!VALID_STATUS.has(status)) {
        return { ok: false, error: `status '${status}' tidak valid (pending|in_progress|completed|cancelled).` }
      }
      const priority = obj.priority === undefined ? undefined : String(obj.priority)
      if (priority !== undefined && !VALID_PRIORITY.has(priority)) {
        return { ok: false, error: `priority '${priority}' tidak valid (high|medium|low).` }
      }
      items.push({
        content: content.trim(),
        status: status as TodoItem['status'],
        priority: priority as TodoItem['priority'] | undefined,
      })
    }
    this.items = items
    this.version++
    this.onChange?.(items)
    return { ok: true }
  }

  /** Render checklist teks (untuk fallback non-TTY & prompt agent). */
  render(): string {
    if (this.items.length === 0) return '(todo kosong)'
    const icon: Record<TodoItem['status'], string> = {
      pending: '[ ]',
      in_progress: '[~]',
      completed: '[x]',
      cancelled: '[-]',
    }
    return this.items
      .map((t) => `${icon[t.status]} ${t.content}${t.priority ? ` (${t.priority})` : ''}`)
      .join('\n')
  }
}
