import fs from 'node:fs'
import pc from 'picocolors'
import { saveConfig, loadConfig, PermissionMode } from '../config.js'
import { classifyBash } from './shell-safety.js'
import { touchesSecretTool } from './secrets.js'
import { decideRule, savePatternRule, derivePatternFromCommand, type PermissionRule } from './rules.js'

/** Tool yang butuh approval (tergantung permission mode). */
export const NEED_APPROVAL = new Set(['write_file', 'edit_file', 'bash'])

/** Diff sederhana baris-per-baris untuk preview edit_file. */
export function simpleDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++
      j++
      continue
    }
    while (i < oldLines.length && !newLines.includes(oldLines[i])) {
      out.push(`- ${oldLines[i]}`)
      i++
    }
    while (j < newLines.length && !oldLines.includes(newLines[j])) {
      out.push(`+ ${newLines[j]}`)
      j++
    }
  }
  return out.join('\n')
}

export function truncateForPreview(s: string, maxLines = 40): string {
  const lines = s.split('\n')
  if (lines.length <= maxLines) return s
  return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} baris lagi)`
}

export interface ApprovalRequest {
  id: string
  tool: string
  args: Record<string, unknown>
  preview: string
  label: string
}

export interface ApprovalAnswer {
  approved: boolean
  /** true bila user memilih "selalu izinkan tool ini" (masuk allowlist). */
  always?: boolean
  /** true bila user memilih "izinkan pola <prefix>*" (bash saja → rule allow project). */
  alwaysPattern?: boolean
  /** Subset hunk edit_file yang dipilih (undefined/[] = semua). */
  hunks?: number[]
}

export type PermissionDecision = 'allow' | 'ask' | 'deny'

export interface DecideContext {
  /** Mode read-only (architect/ask/custom read-only) — deny tool tulis/eksekusi, tidak bisa diluberkan rule. */
  readOnlyMode: boolean
}

/**
 * PermissionManager — mode ask | auto-edit | yolo + allowlist per-tool
 * + aturan granular (allow/ask/deny dengan glob).
 * ask: write/edit/bash selalu tanya (kecuali tool di allowlist).
 * auto-edit: write/edit otomatis, bash tetap tanya.
 * yolo: semua otomatis.
 */
export class PermissionManager {
  mode: PermissionMode
  allowlist: Set<string>
  rules: PermissionRule[]
  cwd: string
  /** Signature rules terakhir yang dimuat (untuk hot-reload per turn). */
  rulesSig: string
  private seq = 0
  private pending = new Map<string, (a: ApprovalAnswer) => void>()

  constructor(mode: PermissionMode, allowlist: string[] = [], rules: PermissionRule[] = [], cwd = process.cwd()) {
    this.mode = mode
    this.allowlist = new Set(allowlist)
    this.rules = rules
    this.cwd = cwd
    this.rulesSig = JSON.stringify(rules)
  }

  /**
   * Jawaban approval dari UI. Return string warning (bila "always" ter-bayangi
   * rule granular → tidak disimpan) atau null. Pemanggil menampilkan warning.
   */
  answer(id: string, answer: ApprovalAnswer, tool?: string, args?: Record<string, unknown>): string | null {
    const resolve = this.pending.get(id)
    if (!resolve) return null
    this.pending.delete(id)
    if (answer.approved && answer.always && tool) {
      // Rule granular ask/deny yang match tool+args → jangan tulis allowlist
      // (akan ter-bayangi / melanggar rule user yang lebih spesifik).
      const ruleAction = decideRule(this.rules, tool, args ?? {}, this.cwd)
      if (ruleAction === 'ask' || ruleAction === 'deny') {
        resolve(answer)
        return `Izin 'always' tidak disimpan: ada rule granular (${ruleAction}) yang match untuk ${tool}.`
      }
      this.allowlist.add(tool)
      const cfg = loadConfig()
      const list = new Set(cfg.tool_allowlist ?? [])
      list.add(tool)
      saveConfig({ tool_allowlist: [...list] })
    }
    if (answer.approved && answer.alwaysPattern && tool === 'bash' && args) {
      const cmd = String(args.command ?? '')
      const pattern = derivePatternFromCommand(cmd)
      if (pattern) {
        const file = savePatternRule(this.cwd, tool, pattern)
        if (file) {
          resolve(answer)
          return `Rule allow dibuat: bash "${pattern}" (${file}).`
        }
      }
    }
    resolve(answer)
    return null
  }

  /**
   * Tentukan nasib tool. Return 'allow' | 'deny' (tanpa bertanya) atau
   * 'ask' — pemanggil harus emit approval_request lalu memanggil answer().
   * Tool MCP (mcp__*) diklasifikasi seperti bash: butuh approval di
   * ask/auto-edit, bisa masuk allowlist.
   */
  needsAsk(tool: string): boolean {
    if (this.mode === 'yolo') return false
    if (this.allowlist.has(tool)) return false
    const cls = tool.startsWith('mcp__') ? 'bash' : tool
    if (this.mode === 'auto-edit') return cls === 'bash'
    return NEED_APPROVAL.has(cls)
  }

  /**
   * Keputusan lengkap atas satu tool call (urutan):
   * (1) mode read-only → deny tool tulis/eksekusi (tidak bisa diluberkan rule);
   * (2) bash → classifyBash deny → deny absolut;
   * (3) rule granular deny → deny absolut;
   * (4) secret path (.env, ~/.topupsaja, ~/.tsa) → ask wajib (bahkan yolo);
   * (5) rule granular lain → allow/ask (ask berlaku bahkan di yolo);
   * (6) allowlist per-tool → allow;
   * (7) logika mode lama (needsAsk). bash safe → allow otomatis di semua mode.
   */
  decide(tool: string, args: Record<string, unknown>, ctx: DecideContext): PermissionDecision {
    const cls = tool.startsWith('mcp__') ? 'bash' : tool
    // Gate read-only pakai nama tool mentah (perilaku lama — mcp__* tidak termasuk).
    if (ctx.readOnlyMode && NEED_APPROVAL.has(tool)) return 'deny'
    if (tool === 'bash' && classifyBash(String(args.command ?? '')) === 'deny') return 'deny'
    const ruleAction = decideRule(this.rules, tool, args, this.cwd)
    if (ruleAction === 'deny') return 'deny'
    if (touchesSecretTool(tool, args)) return 'ask'
    if (ruleAction) return ruleAction
    if (this.allowlist.has(tool)) return 'allow'
    if (this.mode === 'yolo') return 'allow'
    if (tool === 'bash' && classifyBash(String(args.command ?? '')) === 'safe') return 'allow'
    if (this.mode === 'auto-edit') return cls === 'bash' ? 'ask' : 'allow'
    return NEED_APPROVAL.has(cls) ? 'ask' : 'allow'
  }

  static buildPreview(tool: string, args: Record<string, unknown>): { label: string; preview: string } {
    switch (tool) {
      case 'bash':
        return { label: `Jalankan command`, preview: String(args.command ?? '') }
      case 'write_file': {
        const exists = fs.existsSync(String(args.path))
        const content = String(args.content ?? '')
        let preview: string
        if (exists) {
          const cur = fs.readFileSync(String(args.path), 'utf8')
          preview = simpleDiff(cur, content)
        } else {
          preview = content
            .split('\n')
            .map((l) => `+ ${l}`)
            .join('\n')
        }
        return { label: `Tulis file ${args.path}`, preview: truncateForPreview(preview) }
      }
      case 'edit_file':
        return {
          label: `Edit file ${args.path}`,
          preview: truncateForPreview(simpleDiff(String(args.old_string ?? ''), String(args.new_string ?? ''))),
        }
      default:
        return { label: tool, preview: '' }
    }
  }

  newRequestId(): string {
    return `apr_${++this.seq}_${Date.now().toString(36)}`
  }

  /** Untuk UI: buat request lengkap dengan preview siap tampil. */
  makeRequest(tool: string, args: Record<string, unknown>): ApprovalRequest {
    const { label, preview } = PermissionManager.buildPreview(tool, args)
    return { id: this.newRequestId(), tool, args, preview, label }
  }

  /** Tunggu jawaban user atas request id. */
  awaitAnswer(id: string): Promise<ApprovalAnswer> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
    })
  }
}

/** Warna label preview untuk fallback non-TTY. */
export function colorPreview(preview: string): string {
  return preview
    .split('\n')
    .map((l) => (l.startsWith('+') ? pc.green(l) : l.startsWith('-') ? pc.red(l) : l))
    .join('\n')
}
