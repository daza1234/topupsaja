import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { globMatch } from './patterns.js'

export type RuleAction = 'allow' | 'ask' | 'deny'

/** Satu aturan permission granular dari settings.json (global/project). */
export interface PermissionRule {
  tool: string
  /** Glob opsional (default `*`) terhadap match target per tool. */
  pattern: string
  action: RuleAction
  /** Asal rule — project menang atas global saat tie. */
  origin: 'project' | 'global'
}

export interface LoadRulesResult {
  rules: PermissionRule[]
  /** Pesan error rule/file invalid — untuk notice startup. */
  errors: string[]
}

const ACTIONS: Set<string> = new Set(['allow', 'ask', 'deny'])

/**
 * Muat aturan permission: global (~/.topupsaja/settings.json) dulu lalu
 * project (<cwd>/.tsa/settings.json). Rule invalid di-skip + error dikumpulkan.
 * File tidak ada / rusak TIDAK membuat gagal — hanya error utk notice.
 */
export function loadPermissionRules(cwd: string): LoadRulesResult {
  const files: [string, PermissionRule['origin']][] = [
    [path.join(os.homedir(), '.topupsaja', 'settings.json'), 'global'],
    [path.join(cwd, '.tsa', 'settings.json'), 'project'],
  ]
  const rules: PermissionRule[] = []
  const errors: string[] = []
  for (const [file, origin] of files) {
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue // file tidak ada → tanpa rule dari sumber ini
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      errors.push(`${file}: JSON invalid — ${(e as Error).message}`)
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(`${file}: root harus object JSON — diabaikan.`)
      continue
    }
    const perms = (parsed as Record<string, unknown>).permissions
    if (perms === undefined) continue
    if (!Array.isArray(perms)) {
      errors.push(`${file}: "permissions" harus array — diabaikan.`)
      continue
    }
    perms.forEach((entry, i) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${file} permissions[${i}]: bukan object — di-skip.`)
        return
      }
      const r = entry as Record<string, unknown>
      if (typeof r.tool !== 'string' || !r.tool.trim()) {
        errors.push(`${file} permissions[${i}]: field "tool" wajib string — di-skip.`)
        return
      }
      if (r.pattern !== undefined && typeof r.pattern !== 'string') {
        errors.push(`${file} permissions[${i}]: "pattern" harus string — di-skip.`)
        return
      }
      if (typeof r.action !== 'string' || !ACTIONS.has(r.action)) {
        errors.push(`${file} permissions[${i}]: "action" harus allow|ask|deny — di-skip.`)
        return
      }
      rules.push({
        tool: r.tool,
        pattern: typeof r.pattern === 'string' ? r.pattern : '*',
        action: r.action as RuleAction,
        origin,
      })
    })
  }
  return { rules, errors }
}

/** Match target sebuah rule per tool: bash → command penuh; read/write/edit → path rel-cwd; web_fetch → URL; lainnya → nama tool. */
function matchTarget(tool: string, args: Record<string, unknown>, cwd: string): string {
  if (tool === 'bash') return String(args.command ?? '')
  if (tool === 'read_file' || tool === 'write_file' || tool === 'edit_file') {
    const abs = path.resolve(cwd, String(args.path ?? ''))
    return path.relative(cwd, abs).split(path.sep).join('/')
  }
  if (tool === 'web_fetch') return String(args.url ?? '')
  return tool
}

/** Rule match tool ini? tool field & pattern keduanya glob terhadap match target. */
function ruleMatches(rule: PermissionRule, tool: string, target: string): boolean {
  if (!globMatch(rule.tool, tool)) return false
  return globMatch(rule.pattern, target)
}

/** Spesifisitas pattern = jumlah karakter literal (non-wildcard `*`, `?`, `**`). */
function literalChars(s: string): number {
  return s.replace(/[*?]/g, '').length
}

/**
 * Gabungkan semua rule yang match → satu aksi (precedence v2):
 * (1) deny absolut; (2) spesifisitas (karakter literal tool+pattern, tertinggi menang);
 * (3) tie → ask > allow; (4) tie lagi → project > global (rule belakangan menang).
 * Tanpa rule match → null (turun ke logika mode lama).
 */
export function decideRule(
  rules: PermissionRule[],
  tool: string,
  args: Record<string, unknown>,
  cwd: string
): RuleAction | null {
  const target = matchTarget(tool, args, cwd)
  let best: PermissionRule | null = null
  let bestScore = -1
  for (const rule of rules) {
    if (!ruleMatches(rule, tool, target)) continue
    const specificity = literalChars(rule.tool) + literalChars(rule.pattern)
    const askBias = rule.action === 'ask' ? 0.5 : 0
    const score = (rule.action === 'deny' ? Number.POSITIVE_INFINITY : 0) + specificity + askBias
    if (!best || score >= bestScore) {
      best = rule
      bestScore = score
    }
  }
  return best ? best.action : null
}

/**
 * Derivasi pattern always-allow dari command bash (tool pertama + opsional
 * subcommand, tanpa spasi sebelum `*`): `npm install` → `npm install*`,
 * `npm run build --x` → `npm run*`, `ls -la` → `ls*`. Env prefix di-strip.
 * Null bila tidak bisa diderivasi (empty/command berupa path dsb).
 */
export function derivePatternFromCommand(cmd: string): string | null {
  const stripped = cmd.trim().replace(/^[A-Za-z_][A-Za-z0-9_]*=[^ ]* +/, '')
  const tokens = stripped.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const first = tokens[0]
  if (!/^[A-Za-z0-9_./-]+$/.test(first)) return null
  const parts = [first]
  if (tokens.length > 1) {
    const second = tokens[1]
    if (!second.startsWith('-') && /^[-A-Za-z0-9_./:@+]+$/.test(second)) {
      parts.push(second)
    }
  }
  return parts.join(' ') + '*'
}

/** Simpan rule allow berbasis pattern ke <cwd>/.tsa/settings.json (fallback ~/.topupsaja/settings.json). Return path file bila sukses. */
export function savePatternRule(cwd: string, tool: string, pattern: string): string | null {
  const targets: [string, 'project' | 'global'][] = [
    [path.join(cwd, '.tsa', 'settings.json'), 'project'],
    [path.join(os.homedir(), '.topupsaja', 'settings.json'), 'global'],
  ]
  for (const [file] of targets) {
    let root: Record<string, unknown> = {}
    let perms: unknown[] = []
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>
        if (Array.isArray(root.permissions)) perms = root.permissions
      }
    } catch {
      /* file belum ada / rusak → mulai baru */
    }
    const entry = { tool, pattern, action: 'allow' as const }
    const exists = perms.some((p) => {
      const r = p as Record<string, unknown>
      return r.tool === tool && r.pattern === pattern && r.action === 'allow'
    })
    if (!exists) perms.push({ tool, pattern, action: 'allow' })
    root.permissions = perms
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(root, null, 2) + '\n')
      return file
    } catch {
      /* tidak bisa menulis project → coba fallback global */
    }
  }
  return null
}

/** Ringkasan 1 baris aturan aktif (untuk /permissions, banner, /settings). */
export function rulesSummary(rules: PermissionRule[]): string {
  if (rules.length === 0) return 'tanpa aturan granular'
  const count = { allow: 0, ask: 0, deny: 0 }
  for (const r of rules) count[r.action]++
  const contoh = [...rules]
    .reverse()
    .slice(0, 3)
    .map((r) => `${r.action} ${r.tool}${r.pattern === '*' ? '' : ` ${r.pattern}`}`)
    .join(' · ')
  return `${rules.length} aturan (deny ${count.deny} · ask ${count.ask} · allow ${count.allow}) — contoh: ${contoh}`
}

/** Satu entri audit log keputusan permission (ring buffer di sesi). */
export interface PermissionLogEntry {
  at: string
  tool: string
  target: string
  /** 'readonly-deny' | 'bash-deny' | 'deny' | 'allow' | 'ask' | 'mode-allow' | 'mode-ask' */
  decision: string
  /** Bila 'ask': hasil approval user ('approved'/'rejected'/undefined bila belum). */
  approved?: boolean
}

/** Cap ring buffer audit log (entri terbaru dipertahankan). */
export const PERMISSION_LOG_CAP = 200

/** Format N entri log terakhir jadi baris ringkas untuk /permissions. */
export function permissionLogLines(log: PermissionLogEntry[] | undefined, max = 5): string[] {
  const entries = log ?? []
  if (entries.length === 0) return []
  return entries
    .slice(-max)
    .reverse()
    .map((e) => {
      const time = new Date(e.at).toTimeString().slice(0, 5)
      const target = e.target ? ` "${e.target.slice(0, 40)}"` : ''
      const tail =
        e.decision === 'ask'
          ? e.approved === true
            ? 'ask→approved'
            : e.approved === false
              ? 'ask→rejected'
              : 'ask'
          : e.decision
      return `${time} ${e.tool}${target} → ${tail}`
    })
}
