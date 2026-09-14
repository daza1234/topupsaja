import { extname, join, relative, resolve, sep } from 'pathe'
import { getHost } from '../host.js'
import type { HostDirent, HostStats } from '../host.js'
import ignore from 'ignore'
import { ContentPart } from '../api.js'
import type { AgentSession } from './store.js'

const MAX_MENTION_CHARS = 50_000
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.venv', 'build', 'out'])

// Exclude bawaan (selalu diabaikan walau tanpa .gitignore).
const DEFAULT_EXCLUDE = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.venv/',
  'venv/',
  'coverage/',
  '__pycache__/',
  '.gradle/',
  'target/',
  '*.log',
  '.DS_Store',
  '.tsa/',
]

/** Ignore matcher: default exclude + .gitignore cwd (semantik gitignore penuh). */
export async function loadIgnore(cwd: string): Promise<ignore.Ignore> {
  const ig = ignore()
  ig.add(DEFAULT_EXCLUDE)
  try {
    ig.add(await getHost().fs.readFile(join(cwd, '.gitignore'), 'utf8'))
  } catch {
    /* tanpa .gitignore — default saja */
  }
  return ig
}

/** Path relatif cwd diabaikan oleh gitignore/default? */
export function isIgnored(ig: ignore.Ignore, rel: string): boolean {
  if (!rel || rel === '.') return true
  return ig.ignores(rel) || ig.ignores(rel + '/')
}

/** Baca AGENTS.md di cwd (truncate 50k char). Return null bila tidak ada. */
export async function loadAgentsMd(cwd: string): Promise<string | null> {
  for (const name of ['AGENTS.md', 'agents.md']) {
    const p = join(cwd, name)
    try {
      const content = await getHost().fs.readFile(p, 'utf8')
      return content.length > MAX_MENTION_CHARS
        ? content.slice(0, MAX_MENTION_CHARS) + '\n... (dipotong 50k char)'
        : content
    } catch {
      /* lanjut */
    }
  }
  return null
}

/** Memory global ~/.topupsaja/AGENTS.md (label "global"). Return null bila tidak ada. */
export async function loadGlobalAgentsMd(): Promise<string | null> {
  const p = join(getHost().homedir(), '.topupsaja', 'AGENTS.md')
  try {
    const content = await getHost().fs.readFile(p, 'utf8')
    return content.length > MAX_MENTION_CHARS
      ? content.slice(0, MAX_MENTION_CHARS) + '\n... (dipotong 50k char)'
      : content
  } catch {
    return null
  }
}

async function walkProjectFiles(
  dir: string,
  base: string,
  out: string[],
  depth: number,
  ig?: ignore.Ignore,
  ignoreRoot?: string
): Promise<void> {
  if (depth > 6 || out.length >= 2000) return
  let entries: HostDirent[]
  try {
    entries = await getHost().fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= 2000) return
    const full = join(dir, e.name)
    const rel = relative(base, full)
    // Uji ignore terhadap path relatif root ignore (cwd), bukan base walk.
    const relIg = ignoreRoot ? relative(ignoreRoot, full) : rel
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      if (ig && isIgnored(ig, relIg)) continue
      await walkProjectFiles(full, base, out, depth + 1, ig, ignoreRoot)
    } else if (e.isFile()) {
      if (ig && isIgnored(ig, relIg)) continue
      out.push(rel)
    }
  }
}

/** Daftar path file relatif cwd — untuk autocomplete @-mention di TUI. */
export async function listProjectFiles(cwd: string): Promise<string[]> {
  const out: string[] = []
  const ig = await loadIgnore(cwd)
  await walkProjectFiles(cwd, cwd, out, 0, ig, cwd)
  return out.sort()
}

/**
 * Expand @-mention dalam teks: token `@path` yang cocok dengan file/ folder
 * di cwd diganti blok berisi isi file (truncate 50k char per file).
 * Token yang tidak cocok dibiarkan apa adanya.
 */
export async function expandMentions(text: string, cwd: string): Promise<string> {
  const re = /(?:^|(?<=\s))@([^\s@,.;:!?)]+)/g
  let result = ''
  let last = 0
  for (const m of text.matchAll(re)) {
    const rel = m[1]
    const abs = resolve(cwd, rel)
    let content: string | null = null
    try {
      const stat = await getHost().fs.stat(abs)
      if (stat.isDirectory()) {
        const ig = await loadIgnore(cwd)
        const files: string[] = []
        await walkProjectFiles(abs, abs, files, 0, ig, cwd)
        content = files.slice(0, 100).map((f) => `${rel}/${f}`).join('\n')
        if (!content) content = `(folder '${rel}' kosong)`
      } else {
        content = await getHost().fs.readFile(abs, 'utf8')
        if (content.length > MAX_MENTION_CHARS) {
          content = content.slice(0, MAX_MENTION_CHARS) + '\n... (dipotong 50k char)'
        }
      }
    } catch {
      content = null
    }
    if (content !== null) {
      const start = m.index ?? 0
      result += text.slice(last, start)
      result += `\n<file path="${rel}">\n${content}\n</file>\n`
      last = start + m[0].length
    }
  }
  result += text.slice(last)
  return result
}

// ── Lampiran (/add, /add-doc) ────────────────────────────────────

export interface AttachedFile {
  path: string
  content: string
  added_at: string
}

export interface AttachedDoc {
  url: string
  title: string
  content: string
  added_at: string
}

const MAX_ATTACH_CHARS = 20_000
const MAX_ATTACH_BYTES = 1_000_000
const MAX_DIR_FILES = 20
const MAX_CONTEXT_TOTAL = 60_000

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif', '.tiff', '.heic'])

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
}

const MAX_IMAGE_BYTES = 5_000_000

/** Path punya ekstensi gambar yang dikenal? */
export function isImagePath(rel: string): boolean {
  return IMAGE_EXTS.has(extname(rel).toLowerCase())
}

/**
 * Baca file gambar → ContentPart vision (base64 data-URL).
 * Return null bila file tidak terbaca atau >5MB.
 */
export async function encodeImagePart(abs: string): Promise<ContentPart | null> {
  try {
    const mime = MIME_BY_EXT[extname(abs).toLowerCase()]
    if (!mime) return null
    const stat = await getHost().fs.stat(abs)
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null
    const b64 = await getHost().fs.readFile(abs, 'base64')
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
  } catch {
    return null
  }
}

export interface AttachResult {
  ok: boolean
  message: string
  added: number
  /** Sinyal gambar (/add <gambar>) — UI membuat user message vision one-shot. */
  image?: { path: string; abs: string; bytes: number; part: ContentPart }
}

/** Normalisasi target user → path relatif cwd (slash, tanpa ./). */
export function normRel(cwd: string, target: string): string {
  return relative(cwd, resolve(cwd, target)).split(sep).join('/')
}

async function readCapped(abs: string): Promise<{ content: string; skipped: string } | null> {
  try {
    const stat = await getHost().fs.stat(abs)
    if (!stat.isFile()) return null
    if (stat.size > MAX_ATTACH_BYTES) {
      return { content: '', skipped: 'too-big' }
    }
    let content = await getHost().fs.readFile(abs, 'utf8')
    if (content.length > MAX_ATTACH_CHARS) {
      content = content.slice(0, MAX_ATTACH_CHARS) + '\n... (dipotong 20k char)'
    }
    return { content, skipped: '' }
  } catch {
    return null
  }
}

/**
 * /add: lampirkan file langsung atau folder (expand via listProjectFiles —
 * hormati .gitignore, cap 20 file). Gambar ditolak, file >1MB dilewati.
 */
export async function attachPath(session: AgentSession, cwd: string, target: string): Promise<AttachResult> {
  const rel = normRel(cwd, target)
  const abs = resolve(cwd, rel)
  let stat: HostStats
  try {
    stat = await getHost().fs.stat(abs)
  } catch {
    return { ok: false, message: `Tidak ditemukan: ${target}`, added: 0 }
  }

  if (stat.isFile()) {
    if (isImagePath(rel)) {
      // Gambar → sinyal khusus; UI membuat user message vision one-shot.
      const part = await encodeImagePart(abs)
      if (!part) {
        return { ok: false, message: `Gagal melampirkan ${rel} — gambar tidak terbaca atau >5MB.`, added: 0 }
      }
      return { ok: true, message: '', added: 0, image: { path: rel, abs, bytes: stat.size, part } }
    }
    const r = await readCapped(abs)
    if (!r) return { ok: false, message: `Gagal membaca ${rel}.`, added: 0 }
    if (r.skipped === 'too-big') {
      return { ok: false, message: `Dilewati (>1MB): ${rel}`, added: 0 }
    }
    session.attached = session.attached.filter((a) => a.path !== rel)
    session.attached.push({ path: rel, content: r.content, added_at: new Date().toISOString() })
    await session.save()
    return { ok: true, message: `Dilampirkan: ${rel} (${r.content.length} char)`, added: 1 }
  }

  // Folder → expand via listProjectFiles (hormati .gitignore), cap 20 file.
  const ig = await loadIgnore(cwd)
  const all = (await listProjectFiles(cwd)).filter((f) => f === rel || f.startsWith(rel + '/'))
  if (all.length === 0) {
    return { ok: false, message: `Folder '${rel}' tidak berisi file (atau semua di-ignore).`, added: 0 }
  }
  const picked = all.slice(0, MAX_DIR_FILES)
  let added = 0
  let skipped = 0
  const now = new Date().toISOString()
  for (const f of picked) {
    if (isImagePath(f)) {
      skipped++
      continue
    }
    const r = await readCapped(resolve(cwd, f))
    if (!r || r.skipped === 'too-big') {
      skipped++
      continue
    }
    session.attached = session.attached.filter((a) => a.path !== f)
    session.attached.push({ path: f, content: r.content, added_at: now })
    added++
  }
  const over = all.length - picked.length
  await session.save()
  const notes = [`Folder '${rel}': ${added} file dilampirkan.`]
  if (over > 0) notes.push(`${over} file dilewati (cap ${MAX_DIR_FILES} file per folder).`)
  if (skipped > 0) notes.push(`${skipped} dilewati (gambar / >1MB).`)
  return { ok: added > 0, message: notes.join(' '), added }
}

/** /drop: hapus lampiran per path, atau 'all' (semua file + docs). */
export async function detachPath(session: AgentSession, cwd: string, target: string): Promise<AttachResult> {
  if (target === 'all') {
    const n = session.attached.length + session.docs.length
    session.attached = []
    session.docs = []
    await session.save()
    return { ok: true, message: n ? `Semua lampiran dihapus (${n} item).` : 'Tidak ada lampiran.', added: 0 }
  }
  const rel = normRel(cwd, target)
  const before = session.attached.length
  session.attached = session.attached.filter((a) => a.path !== rel)
  const removed = before - session.attached.length
  if (removed === 0) {
    return { ok: false, message: `Tidak ada lampiran bernama '${rel}'. Lihat /add.`, added: 0 }
  }
  await session.save()
  return { ok: true, message: `Lampiran dihapus: ${rel}`, added: 0 }
}

/** Decode entity HTML dasar (&amp; &#39; &#x27; dst). */
export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
    rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', middot: '·',
  }
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
      try {
        return String.fromCodePoint(parseInt(h, 16))
      } catch {
        return ''
      }
    })
    .replace(/&#(\d+);/g, (_, d: string) => {
      try {
        return String.fromCodePoint(parseInt(d, 10))
      } catch {
        return ''
      }
    })
    .replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m)
}

/** Strip tag HTML naif → teks polos (untuk /add-doc). */
export function stripHtml(html: string): string {
  let t = html
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  t = t.replace(/<!--[\s\S]*?-->/g, ' ')
  t = t.replace(/<(br|hr)\s*\/?>/gi, '\n')
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|pre|blockquote)>/gi, '\n')
  t = t.replace(/<[^>]+>/g, ' ')
  t = decodeEntities(t)
  t = t.replace(/[ \t]+/g, ' ')
  t = t.replace(/\n[ \t]+/g, '\n')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

/** /add-doc: fetch URL (timeout 15s) → strip HTML → teks cap 20k char. */
export async function addDoc(session: AgentSession, url: string): Promise<AttachResult> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' })
  } catch (e) {
    return { ok: false, message: `Gagal fetch ${url}: ${(e as Error).message}`, added: 0 }
  }
  if (!res.ok) {
    return { ok: false, message: `Fetch ${url} gagal: HTTP ${res.status}`, added: 0 }
  }
  const html = await res.text()
  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? url
  const title = decodeEntities(rawTitle).replace(/\s+/g, ' ').trim().slice(0, 200)
  const text = stripHtml(html)
  if (!text) {
    return { ok: false, message: `Konten ${url} kosong setelah strip HTML.`, added: 0 }
  }
  const content =
    text.length > MAX_ATTACH_CHARS ? text.slice(0, MAX_ATTACH_CHARS) + '\n... (dipotong 20k char)' : text
  session.docs = session.docs.filter((d) => d.url !== url)
  session.docs.push({ url, title, content, added_at: new Date().toISOString() })
  await session.save()
  return { ok: true, message: `Doc ditambahkan: ${title} (${content.length} char)`, added: 1 }
}

// ── System message konteks lampiran ─────────────────────────────

export const CONTEXT_MESSAGE_PREFIX = '## KONTEKS LAMPIRAN'

export interface ContextBlock {
  text: string
  /** Item yang terbuang karena total melebihi cap 60k char. */
  dropped: number
}

/** Susun blok konteks dari attached + docs (item terbaru diprioritaskan, total cap 60k). */
export function buildAttachmentContext(attached: AttachedFile[], docs: AttachedDoc[]): ContextBlock | null {
  if (attached.length === 0 && docs.length === 0) return null
  const items = [
    ...attached.map((a) => ({ open: `<file path="${a.path}">`, close: '</file>', content: a.content, at: Date.parse(a.added_at) || 0 })),
    ...docs.map((d) => ({ open: `<doc url="${d.url}" title="${d.title}">`, close: '</doc>', content: d.content, at: Date.parse(d.added_at) || 0 })),
  ].sort((a, b) => b.at - a.at)
  const parts: string[] = []
  let total = 0
  let dropped = 0
  for (const it of items) {
    if (total + it.content.length > MAX_CONTEXT_TOTAL) {
      dropped++
      continue
    }
    total += it.content.length
    parts.push(`${it.open}\n${it.content}\n${it.close}`)
  }
  const text =
    `${CONTEXT_MESSAGE_PREFIX}\n` +
    'Konteks berikut dilampirkan user via /add dan /add-doc (snapshot saat dilampirkan, bisa jadi sudah berubah):\n\n' +
    parts.join('\n\n')
  return { text, dropped }
}

/**
 * Replace/hapus SATU system message konteks (idempotent by prefix) —
 * dipanggil tiap turn agar survive save/load roundtrip & compaction.
 */
export function syncContextMessage(session: AgentSession): number {
  const block = buildAttachmentContext(session.attached, session.docs)
  const idx = session.messages.findIndex(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(CONTEXT_MESSAGE_PREFIX)
  )
  if (!block) {
    if (idx !== -1) session.messages.splice(idx, 1)
    return 0
  }
  if (idx !== -1) {
    session.messages[idx] = { role: 'system', content: block.text }
  } else {
    session.messages.splice(1, 0, { role: 'system', content: block.text })
  }
  return block.dropped
}
