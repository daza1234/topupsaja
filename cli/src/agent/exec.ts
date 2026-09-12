import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import pc from 'picocolors'
import { TodoStore } from '../storage/todo.js'
import { loadIgnore, isIgnored, isImagePath, encodeImagePart } from '../session/context.js'
import { stagePreState, markTouched, relPath } from './checkpoints.js'
import { simpleDiff, truncateForPreview } from './permission.js'
import { applyHunks } from './hunks.js'
import { stripHtml } from '../session/context.js'
import { loadConfig } from '../config.js'
import type { ContentPart } from '../api.js'
import type { AgentRuntime } from './runtime.js'

const BASH_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 10_000
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.venv'])

export interface ToolResult {
  ok: boolean
  output: string
  /** Part gambar (vision) — hanya diisi read_file untuk file gambar. */
  image?: ContentPart
}

function err(msg: string): ToolResult {
  return { ok: false, output: msg }
}

function ok(output: string): ToolResult {
  return { ok: true, output: output.slice(0, OUTPUT_LIMIT) + (output.length > OUTPUT_LIMIT ? `\n... (dipotong, ${output.length} char total)` : '') }
}

function resolveSafe(p: string): string {
  return path.resolve(process.cwd(), p)
}

// ── read_file ──
export function readFile(args: { path: string; offset?: number; limit?: number }): ToolResult {
  try {
    const p = resolveSafe(args.path)
    const stat = fs.statSync(p)
    if (stat.isDirectory()) return err(`'${args.path}' adalah direktori.`)
    if (isImagePath(args.path)) {
      const part = encodeImagePart(p)
      if (!part) return err(`Gambar '${args.path}' >5MB — terlalu besar untuk konteks.`)
      const kb = Math.max(1, Math.round(stat.size / 1024))
      return { ok: true, output: `[gambar] ${args.path} (${kb} KB) — terlampir ke konteks.`, image: part }
    }
    const lines = fs.readFileSync(p, 'utf8').split('\n')
    const start = Math.max(Number(args.offset) || 1, 1)
    const limit = Number(args.limit) || 2000
    const slice = lines.slice(start - 1, start - 1 + limit)
    const numbered = slice.map((l, i) => `${String(start + i).padStart(5)}: ${l}`).join('\n')
    return ok(numbered || '(file kosong)')
  } catch (e) {
    return err(`Gagal membaca '${args.path}': ${(e as Error).message}`)
  }
}

// ── write_file ──
export function writeFile(args: { path: string; content: string }): ToolResult {
  try {
    const p = resolveSafe(args.path)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, args.content, 'utf8')
    const lines = args.content.split('\n').length
    return ok(`File '${args.path}' ditulis (${lines} baris).`)
  } catch (e) {
    return err(`Gagal menulis '${args.path}': ${(e as Error).message}`)
  }
}

// ── edit_file ──
export function editFile(args: { path: string; old_string: string; new_string: string }): ToolResult {
  try {
    const p = resolveSafe(args.path)
    const content = fs.readFileSync(p, 'utf8')
    if (args.old_string === args.new_string) return err('old_string dan new_string identik.')
    if (!content.includes(args.old_string)) {
      return err(`old_string tidak ditemukan di '${args.path}'. Pastikan teks exact match (termasuk spasi/indentasi).`)
    }
    const first = content.indexOf(args.old_string)
    const second = content.indexOf(args.old_string, first + 1)
    if (second !== -1) {
      return err(`old_string muncul ${content.split(args.old_string).length - 1}x di '${args.path}' — tidak unik. Perluas konteks old_string agar unik.`)
    }
    fs.writeFileSync(p, content.replace(args.old_string, args.new_string), 'utf8')
    return ok(`'${args.path}' diedit.`)
  } catch (e) {
    return err(`Gagal mengedit '${args.path}': ${(e as Error).message}`)
  }
}

// ── web_fetch ──
const WEB_FETCH_TIMEOUT_MS = 15_000

/**
 * Ambil konten URL → teks (http/https, timeout 15s, redirect follow).
 * HTML di-strip jadi teks polos; hasil di-cap (default 20k char). Tanpa eksekusi JS.
 */
export async function webFetch(args: { url: string }, cap = 20_000): Promise<ToolResult> {
  const url = String(args.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) return err(`URL harus http/https: '${url}'.`)
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS), redirect: 'follow' })
  } catch (e) {
    return err(`Gagal fetch ${url}: ${(e as Error).message}`)
  }
  if (!res.ok) return err(`Fetch ${url} gagal: HTTP ${res.status}.`)
  const ctype = (res.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim()
  const isText =
    ctype === '' ||
    ctype.startsWith('text/') ||
    ctype.includes('json') ||
    ctype.includes('xml') ||
    ctype.includes('javascript')
  if (!isText) {
    return err(`Konten ${url} bukan teks (content-type: ${ctype}) — hanya teks/JSON yang didukung.`)
  }
  const raw = await res.text()
  const text = ctype.includes('html') || /<html[\s>]/i.test(raw) || /^\s*<!doctype html/i.test(raw) ? stripHtml(raw) : raw
  if (!text.trim()) return err(`Konten ${url} kosong.`)
  const body = text.length > cap ? text.slice(0, cap) + `\n... (dipotong ${cap} char)` : text
  return ok(body)
}

// ── edit_file per-hunk ──
/**
 * Eksekusi edit_file dengan subset hunk terpilih: baca file, validasi
 * old_string unik, merge hanya hunk terpilih, tulis + checkpoint + formatter
 * (urutan sama dengan case edit_file di executeTool).
 */
export async function editFilePartial(
  rt: AgentRuntime,
  args: { path: string; old_string: string; new_string: string },
  hunks: number[]
): Promise<ToolResult> {
  try {
    const p = resolveSafe(args.path)
    const content = fs.readFileSync(p, 'utf8')
    if (args.old_string === args.new_string) return err('old_string dan new_string identik.')
    if (!content.includes(args.old_string)) {
      return err(`old_string tidak ditemukan di '${args.path}'. Pastikan teks exact match (termasuk spasi/indentasi).`)
    }
    const first = content.indexOf(args.old_string)
    const second = content.indexOf(args.old_string, first + 1)
    if (second !== -1) {
      return err(`old_string muncul ${content.split(args.old_string).length - 1}x di '${args.path}' — tidak unik; per-hunk tidak bisa diterapkan.`)
    }
    const merged = applyHunks(args.old_string, args.new_string, hunks)
    if (merged === null) {
      return err('Tidak ada perubahan efektif dari hunk terpilih (hasil == teks lama).')
    }
    const rel = relPath(rt.cwd, args.path)
    const skipped = stagePreState(rt, rel)
    if (skipped) rt.emitter.emit('notice', `File > 1MB — checkpoint dilewati: ${skipped}`)
    fs.writeFileSync(p, content.replace(args.old_string, merged), 'utf8')
    markTouched(rt, rel)
    await formatAfterWrite(rt, args.path)
    return ok(`'${args.path}' diedit parsial (hunk: ${hunks.join(', ')}).`)
  } catch (e) {
    return err(`Gagal mengedit '${args.path}': ${(e as Error).message}`)
  }
}

// ── bash ──
export function runBash(args: { command: string }): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', args.command], {
      cwd: process.cwd(),
      env: process.env,
    })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, BASH_TIMEOUT_MS)

    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve(err(`Gagal spawn bash: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) resolve(err(`Command timeout (${BASH_TIMEOUT_MS / 1000}s) dan dihentikan paksa. Output sejauh ini:\n${out.slice(0, OUTPUT_LIMIT)}`))
      else resolve(ok(`exit code: ${code ?? 0}\n${out || '(tidak ada output)'}`))
    })
  })
}

// ── glob ──
function globToRegex(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // '**/' atau '**'
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i++
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '[') {
      const close = pattern.indexOf(']', i)
      re += close === -1 ? '\\[' : pattern.slice(i, close + 1)
      if (close !== -1) i = close
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

function walkFiles(dir: string, base: string, out: string[], ig?: ReturnType<typeof loadIgnore>): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    const rel = path.relative(base, full)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.git')) continue
      if (ig && isIgnored(ig, rel)) continue
      walkFiles(full, base, out, ig)
    } else if (e.isFile()) {
      if (ig && isIgnored(ig, rel)) continue
      out.push(rel)
    }
  }
}

export function glob(args: { pattern: string }): ToolResult {
  try {
    const re = globToRegex(args.pattern)
    const root = path.resolve(process.cwd(), '.')
    const ig = loadIgnore(process.cwd())
    const files: string[] = []
    walkFiles(root, root, files, ig)
    const matches = files.filter((f) => re.test(f)).sort()
    if (matches.length === 0) return ok(`Tidak ada file cocok dengan pattern '${args.pattern}'.`)
    return ok(`${matches.length} file:\n${matches.join('\n')}`)
  } catch (e) {
    return err(`Gagal glob '${args.pattern}': ${(e as Error).message}`)
  }
}

// ── grep ──
function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 512)
  for (const b of sample) {
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) return true
  }
  return false
}

export function grepSync(args: { pattern: string; path?: string }): ToolResult {
  try {
    const re = new RegExp(args.pattern)
    const start = args.path ? resolveSafe(args.path) : process.cwd()
    const ig = loadIgnore(process.cwd())
    const results: string[] = []
    let fileCount = 0

    const searchFile = (p: string) => {
      let buf: Buffer
      try {
        buf = fs.readFileSync(p)
      } catch {
        return
      }
      if (isBinary(buf)) return
      fileCount++
      const lines = buf.toString('utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push(`${path.relative(process.cwd(), p)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          if (results.length >= 200) return
        }
      }
    }

    const search = (p: string) => {
      if (results.length >= 200) return
      const stat = fs.statSync(p)
      if (stat.isFile()) {
        searchFile(p)
        return
      }
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(p, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.isDirectory() && (SKIP_DIRS.has(e.name) || e.name.startsWith('.'))) continue
        const rel = path.relative(process.cwd(), path.join(p, e.name))
        if (ig && isIgnored(ig, rel)) continue
        search(path.join(p, e.name))
        if (results.length >= 200) return
      }
    }

    search(start)
    if (results.length === 0) {
      return ok(`Tidak ada hasil untuk pattern '${args.pattern}' (${fileCount} file dipindai).`)
    }
    const suffix = results.length >= 200 ? `\n... (hasil dipotong di 200 baris)` : ''
    return ok(results.join('\n') + suffix)
  } catch (e) {
    return err(`Gagal grep '${args.pattern}': ${(e as Error).message}`)
  }
}

// ── find_symbol ──
/** Regex definisi per kelompok bahasa (ext → daftar regex dengan capture nama). */
const SYMBOL_PATTERNS: Record<string, RegExp[]> = (() => {
  const tsjs = [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/,
    /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
    /^\s*(?:export\s+)?const\s+(\w+)\s*[=:<]/,
    /^\s*(?:export\s+)?interface\s+(\w+)/,
    /^\s*(?:export\s+)?type\s+(\w+)\s*[={]/,
    /^\s*(?:export\s+)?enum\s+(\w+)/,
  ]
  const py = [/^\s*(?:async\s+)?def\s+(\w+)/, /^\s*class\s+(\w+)/]
  const go = [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, /^type\s+(\w+)\s+/]
  const rust = [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/,
    /^\s*impl(?:<[^>]*>)?(?:\s+\w+\s+for\s+)?\s*(\w+)/,
  ]
  const php = [
    /^\s*(?:abstract\s+|final\s+)?(?:public|private|protected)?\s*(?:static\s+)?function\s+&?(\w+)/,
    /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/,
  ]
  const map: Record<string, RegExp[]> = {}
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) map[ext] = tsjs
  for (const ext of ['.py']) map[ext] = py
  for (const ext of ['.go']) map[ext] = go
  for (const ext of ['.rs']) map[ext] = rust
  for (const ext of ['.php']) map[ext] = php
  return map
})()

const SYMBOL_MAX_RESULTS = 50

export function findSymbol(args: { query: string; path?: string }): ToolResult {
  const query = String(args.query ?? '').trim()
  if (query.length < 2) return err('query minimal 2 karakter.')
  const needle = query.toLowerCase()

  try {
    const start = args.path ? resolveSafe(args.path) : process.cwd()
    const ig = loadIgnore(process.cwd())
    const results: string[] = []
    let fileCount = 0
    let truncated = false

    const searchFile = (p: string) => {
      const ext = path.extname(p).toLowerCase()
      const patterns = SYMBOL_PATTERNS[ext]
      if (!patterns) return
      let buf: Buffer
      try {
        buf = fs.readFileSync(p)
      } catch {
        return
      }
      if (isBinary(buf)) return
      fileCount++
      const rel = path.relative(process.cwd(), p)
      const lines = buf.toString('utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        for (const re of patterns) {
          const m = re.exec(lines[i])
          if (m && m[1].toLowerCase().includes(needle)) {
            results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
            break
          }
        }
        if (results.length >= SYMBOL_MAX_RESULTS) {
          truncated = true
          return
        }
      }
    }

    const search = (p: string) => {
      if (truncated) return
      const stat = fs.statSync(p)
      if (stat.isFile()) {
        searchFile(p)
        return
      }
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(p, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.isDirectory() && (SKIP_DIRS.has(e.name) || e.name.startsWith('.'))) continue
        const rel = path.relative(process.cwd(), path.join(p, e.name))
        if (ig && isIgnored(ig, rel)) continue
        search(path.join(p, e.name))
        if (truncated) return
      }
    }

    search(start)
    if (results.length === 0) {
      return ok(`Tidak ada definisi untuk '${query}' (${fileCount} file dipindai).`)
    }
    const suffix = truncated ? `\n... (hasil di-cap ${SYMBOL_MAX_RESULTS})` : ''
    return ok(results.join('\n') + suffix)
  } catch (e) {
    return err(`Gagal find_symbol '${query}': ${(e as Error).message}`)
  }
}

// ── todo_write ──
export function todoWrite(todos: TodoStore, args: { todos: unknown }): ToolResult {
  const r = todos.set(args.todos)
  if (!r.ok) return err(r.error ?? 'todos tidak valid.')
  return ok(`Todo diperbarui (${todos.items.length} item):\n${todos.render()}`)
}

// ── hooks pre/post_tool_use ──
const HOOK_TIMEOUT_MS = 10_000

/** Jalankan hook command (bash) dengan env TSA_TOOL / TSA_TOOL_INPUT / TSA_CWD. */
export function runHook(
  command: string,
  tool: string,
  args: Record<string, unknown>,
  cwd: string
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: {
        ...process.env,
        TSA_TOOL: tool,
        TSA_TOOL_INPUT: JSON.stringify(args).slice(0, 100_000),
        TSA_CWD: cwd,
      },
    })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), HOOK_TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve(err(`hook spawn gagal: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(ok(out))
      else resolve(err(`exit ${code}: ${out.slice(0, 500)}`))
    })
  })
}

// ── formatter hook (hooks.format_command) ──
const FORMATTER_TIMEOUT_MS = 15_000

/**
 * Jalankan formatter command untuk satu file. `{file}` diganti path absolut.
 * Exit 0 → ok (output = stdout+stderr); exit ≠ 0/timeout → err (file TIDAK diubah oleh fungsi ini).
 * Murni terhadap `command` — pemanggil membaca config (mudah dites).
 */
export function runFormatter(command: string, cwd: string, file: string): Promise<ToolResult> {
  const abs = path.resolve(cwd, file)
  const cmd = command.replaceAll('{file}', abs)
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], { cwd, env: process.env })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, FORMATTER_TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve(err(`spawn gagal: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) resolve(err(`timeout (${FORMATTER_TIMEOUT_MS / 1000}s): ${out.slice(0, 200)}`))
      else if (code === 0) resolve(ok(out))
      else resolve(err(`exit ${code}: ${out.slice(0, 200)}`))
    })
  })
}

/** Bila hooks.format_command diset: jalankan formatter; gagal → notice (file tetap tersimpan). */
async function formatAfterWrite(rt: AgentRuntime, file: string): Promise<void> {
  const cmd = loadConfig().hooks?.format_command?.trim()
  if (!cmd) return
  const fmt = await runFormatter(cmd, rt.cwd, file)
  if (!fmt.ok) rt.emitter.emit('notice', `format gagal: ${fmt.output.slice(0, 200)}`)
}

/** Dispatcher tool → hasil string untuk message role:tool. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  deps: { todos: TodoStore; rt: AgentRuntime }
): Promise<ToolResult> {
  const rt = deps.rt
  switch (name) {
    case 'read_file': {
      const r = readFile(args as { path: string; offset?: number; limit?: number })
      if (r.ok && r.image) {
        const model = rt.models.find((m) => m.id === rt.session.model)
        if (model?.supports_vision === false) {
          return err(
            `'${args.path}' adalah gambar — model ${rt.session.model} tidak mendukung vision. Lampirkan setelah ganti model via /model, atau pakai model vision.`
          )
        }
      }
      return r
    }
    case 'write_file': {
      const rel = relPath(rt.cwd, String(args.path))
      const skipped = stagePreState(rt, rel)
      if (skipped) rt.emitter.emit('notice', `File > 1MB — checkpoint dilewati: ${skipped}`)
      // Diff pasca-edit untuk auto-edit/yolo (di ask, preview approval sudah menunjukkan diff).
      let before: string | null = null
      if (rt.permissions.mode !== 'ask') {
        try {
          before = fs.readFileSync(resolveSafe(String(args.path)), 'utf8')
        } catch {
          before = null
        }
      }
      const r = writeFile(args as { path: string; content: string })
      if (r.ok) {
        markTouched(rt, rel)
        await formatAfterWrite(rt, String(args.path))
        if (rt.permissions.mode !== 'ask') {
          const diff = simpleDiff(before ?? '', String(args.content ?? ''))
          if (diff) r.output += '\n' + truncateForPreview(diff, 30)
        }
      }
      return r
    }
    case 'edit_file': {
      const rel = relPath(rt.cwd, String(args.path))
      const skipped = stagePreState(rt, rel)
      if (skipped) rt.emitter.emit('notice', `File > 1MB — checkpoint dilewati: ${skipped}`)
      const r = editFile(args as { path: string; old_string: string; new_string: string })
      if (r.ok) {
        markTouched(rt, rel)
        await formatAfterWrite(rt, String(args.path))
        if (rt.permissions.mode !== 'ask') {
          const diff = simpleDiff(String(args.old_string ?? ''), String(args.new_string ?? ''))
          if (diff) r.output += '\n' + truncateForPreview(diff, 30)
        }
      }
      return r
    }
    case 'bash':
      return runBash(args as { command: string })
    case 'web_fetch':
      return webFetch(args as { url: string })
    case 'glob':
      return glob(args as { pattern: string })
    case 'grep':
      return grepSync(args as { pattern: string; path?: string })
    case 'find_symbol':
      return findSymbol(args as { query: string; path?: string })
    case 'todo_write':
      return todoWrite(deps.todos, args as { todos: unknown })
    default:
      return err(`Tool '${name}' tidak dikenal.`)
  }
}

/** Satu-baris deskripsi tool untuk status UI. */
export function describeTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
      return `${args.path}${args.offset ? ` (offset ${args.offset})` : ''}`
    case 'write_file':
      return `${args.path}`
    case 'edit_file':
      return `${args.path}`
    case 'bash':
      return String(args.command).slice(0, 120)
    case 'web_fetch':
      return truncateStr(String(args.url ?? ''), 100)
    case 'glob':
      return String(args.pattern)
    case 'grep':
      return `${args.pattern}${args.path ? ` di ${args.path}` : ''}`
    case 'find_symbol':
      return `${args.query}${args.path ? ` di ${args.path}` : ''}`
    case 'todo_write':
      return `${Array.isArray(args.todos) ? args.todos.length : '?'} item`
    case 'task':
      return truncateStr(String(args.task ?? ''), 100)
    default: {
      if (name.startsWith('mcp__')) return truncateStr(JSON.stringify(args), 120)
      return pc.dim(JSON.stringify(args).slice(0, 120))
    }
  }
}

function truncateStr(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
