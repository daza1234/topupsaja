/**
 * Klasifikasi bash command → 'safe' | 'risky' | 'deny'.
 * File MURNI (tanpa import) agar murah dites dengan node --test.
 *
 * - safe : read-only umum (ls, cat, git status, …) → auto-izin di semua permission mode.
 * - risky: selain safe (termasuk redirect, unknown command) → jalur approval normal.
 * - deny : berbahaya (sudo, curl|sh, rm -rf /, …) → hard-deny di semua mode.
 *           Deny dicek SEBELUM safe — compound `ls && rm -rf /` tetap deny.
 */

export type BashClass = 'safe' | 'risky' | 'deny'

/** Pattern deny pada SELURUH command string (sebelum split compound). */
const WHOLE_DENY: RegExp[] = [
  /\|\s*(?:ba)?sh\b/, // pipa ke shell: curl … | sh, wget … | bash
  /:\s*\(\)\s*\{/, // fork bomb :(){ :|:& };:
  />\s*\/dev\/sd/, // tulis mentah ke disk
]

/** Pattern deny per segmen (first-word anchored, setelah strip env prefix). */
const SEGMENT_DENY: RegExp[] = [
  /^sudo\b/,
  /^(?:shutdown|reboot|halt)\b/,
  /^init\s+0\b/,
  /^mkfs/,
  /^dd\s[^;&|]*\bof=\/dev\//,
  /^rm\s+(?:[^;&|]*\s)?(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)\s+(?:\/|~)(?![\w./-])/,
  /^chmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)?777\s+\/(?![\w.-])/,
]

/** Pattern risky pada SELURUH command string (redirect, substitusi). */
const RISKY_WHOLE: RegExp[] = [
  /[<>]/, // redirect > >> < (dan 2>&1)
  /`/, // command substitution backtick
  /\$\(/, // command substitution $()
  /<\(/, // proses substitusi
]

const SAFE_FIRST = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'file', 'du', 'df',
  'grep', 'rg', 'which', 'echo',
])

const GIT_SAFE_SUB = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'blame', 'shortlog',
])

/** Guard find: flag yang menulis/mengeksekusi → tidak safe. */
const FIND_UNSAFE_FLAGS = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fls)$/

/** Buang leading env assignment (FOO=bar) berulang kali. */
function stripEnv(seg: string): string {
  let s = seg.trim()
  const re = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/
  while (re.test(s)) s = s.replace(re, '')
  return s.trim()
}

/** Satu segmen (sudah strip env) safe menurut allowlist first-word? */
function isSegmentSafe(s: string): boolean {
  if (!s) return true
  const words = s.split(/\s+/)
  const cmd = words[0]
  const rest = words.slice(1)
  if (cmd === 'cd') return true
  if (SAFE_FIRST.has(cmd)) return true
  if (cmd === 'find') return rest.length > 0 && !rest.some((w) => FIND_UNSAFE_FLAGS.test(w))
  if (cmd === 'git') {
    const sub = rest[0]
    if (!sub) return false
    if (sub === 'tag') return rest.length === 1 // `git tag` (list) ok, `git tag v1` tidak
    if (sub === 'branch' || sub === 'remote') {
      // hanya bentuk list read-only: `git branch`, `git branch -va`, `git remote -v`
      const flags = rest.slice(1)
      return flags.every((w) => /^-(?:[vrma]+$|-(?:all|remotes|list|show-current))$/.test(w))
    }
    return GIT_SAFE_SUB.has(sub)
  }
  if (cmd === 'node') return rest.length > 0 && rest.every((w) => w === '--version' || w === '-v')
  if (cmd === 'npm') return rest[0] === 'ls' || rest[0] === 'outdated'
  if (cmd === 'tsc') return rest.includes('--noEmit')
  if (cmd === 'python3') return rest.length === 1 && (rest[0] === '--version' || rest[0] === '-V')
  if (cmd === 'pip' || cmd === 'pip3') return rest.length === 1 && rest[0] === '--version'
  return false // unknown → risky
}

/** Klasifikasi command bash (string mentah dari argumen tool). */
export function classifyBash(command: string): BashClass {
  const trimmed = command.trim()
  if (!trimmed) return 'risky'

  // 1. deny — whole-string (pipa ke shell, fork bomb, raw disk)
  for (const re of WHOLE_DENY) {
    if (re.test(trimmed)) return 'deny'
  }

  // 2. deny — per segmen first-word (sudo, rm -rf /, dd of=/dev/, …)
  const segments = trimmed.split(/(?:\|\||&&|;|\|)/)
  for (const seg of segments) {
    const s = stripEnv(seg)
    if (!s) continue
    for (const re of SEGMENT_DENY) {
      if (re.test(s)) return 'deny'
    }
  }

  // 3. risky — redirect/backtick/substitusi dicek pada SELURUH string
  for (const re of RISKY_WHOLE) {
    if (re.test(trimmed)) return 'risky'
  }

  // 4. safe — SEMUA segmen harus first-word allowlist
  for (const seg of segments) {
    if (!isSegmentSafe(stripEnv(seg))) return 'risky'
  }
  return 'safe'
}
