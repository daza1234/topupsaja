import { join } from 'pathe'
import { getHost } from '../host.js'
import { parseFrontmatter } from '../frontmatter.js'
import { loadAgentsMd, loadGlobalAgentsMd } from '../session/context.js'

export type Mode = 'code' | 'architect' | 'ask' | 'test'

/** Mode kustom dari .tsa/modes/*.md / ~/.topupsaja/modes/*.md (frontmatter + body). */
export interface CustomMode {
  name: string
  description: string
  /** Body markdown — jadi section tambahan system prompt. */
  body: string
  readOnly: boolean
}

async function detectProjectContext(cwd: string): Promise<string> {
  const parts: string[] = []
  try {
    const entries = (await getHost().fs.readdir(cwd, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith('.'))
      .slice(0, 30)
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
    parts.push(`Isi root project:\n${entries.join('\n')}`)
  } catch {
    parts.push('(tidak bisa membaca root project)')
  }

  const markers: [string, string][] = [
    ['package.json', 'Node.js/JavaScript'],
    ['tsconfig.json', 'TypeScript'],
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['go.mod', 'Go'],
    ['Cargo.toml', 'Rust'],
    ['composer.json', 'PHP'],
    ['Gemfile', 'Ruby'],
    ['pom.xml', 'Java'],
  ]
  const langs: string[] = []
  for (const [f, l] of markers) {
    if (await getHost().fs.exists(join(cwd, f))) langs.push(l)
  }
  if (langs.length) parts.push(`Deteksi bahasa/framework: ${[...new Set(langs)].join(', ')}`)

  return parts.join('\n')
}

/** Alias kompatibel untuk mode lama (/plan, /act) dan nama pendek. */
export const MODE_ALIASES: Record<string, Mode> = {
  plan: 'architect',
  act: 'code',
  code: 'code',
  architect: 'architect',
  ask: 'ask',
  test: 'test',
}

export const ALL_MODES: Mode[] = ['code', 'architect', 'ask', 'test']

/**
 * Discovery custom modes:
 *   <cwd>/.tsa/modes/*.md  (project, menang saat nama bentrok)
 *   ~/.topupsaja/modes/*.md (global)
 * Nama file (tanpa .md, lowercase) = mode id. Frontmatter: description, read_only (bool).
 */
export async function discoverCustomModes(cwd: string): Promise<CustomMode[]> {
  const dirs = [
    join(cwd, '.tsa', 'modes'),
    join(getHost().homedir(), '.topupsaja', 'modes'),
  ]
  const map = new Map<string, CustomMode>()
  for (const dir of dirs) {
    let files: string[]
    try {
      files = await getHost().fs.readdir(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const name = f.slice(0, -3).trim().toLowerCase()
      if (!name) continue
      try {
        const raw = await getHost().fs.readFile(join(dir, f), 'utf8')
        const { meta, body } = parseFrontmatter(raw)
        if (!map.has(name)) {
          map.set(name, {
            name,
            description: meta.description ?? '',
            body,
            readOnly: /^(true|1|yes|ya)$/i.test(meta.read_only ?? ''),
          })
        }
      } catch {
        /* file korup — skip */
      }
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve argumen mode (alias plan/act, builtin, atau nama custom) → id mode, null bila tak dikenal. */
export function resolveModeArg(arg: string, custom: CustomMode[] = []): Mode | string | null {
  const a = arg.trim().toLowerCase()
  return MODE_ALIASES[a] ?? custom.find((c) => c.name === a)?.name ?? null
}

export function isReadOnlyMode(m: string, custom: CustomMode[] = []): boolean {
  if (m === 'architect' || m === 'ask') return true
  return custom.some((c) => c.name === m && c.readOnly)
}

/** Deskripsi 1 baris per mode (picker, help, notice). */
export const MODE_INFO: Record<Mode, string> = {
  code: 'eksekusi penuh — tulis & jalankan kode',
  architect: 'read-only — analisa & susun rencana implementasi',
  ask: 'read-only — tanya-jawab & jelaskan kode',
  test: 'fokus menulis & menjalankan unit test',
}

/** Notice saat switch mode (dipakai TUI & plain agar paritas). */
export const MODE_NOTICE: Record<Mode, string> = {
  code: 'Mode CODE — eksekusi penuh.',
  architect: 'Mode ARCHITECT — read-only, susun rencana. /code untuk eksekusi.',
  ask: 'Mode ASK — read-only, tanya-jawab & jelaskan kode.',
  test: 'Mode TEST — fokus menulis & menjalankan unit test.',
}

async function detectTestRunner(cwd: string): Promise<string> {
  try {
    const pkg = JSON.parse(await getHost().fs.readFile(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
      devDependencies?: Record<string, string>
      dependencies?: Record<string, string>
    }
    const scripts = pkg.scripts ?? {}
    if (scripts.test) {
      const t = scripts.test
      if (/vitest/.test(t)) return 'vitest (`npx vitest run`)'
      if (/jest/.test(t)) return 'jest (`npm test`)'
      if (/mocha/.test(t)) return 'mocha'
      if (/node --test|node:test/.test(t)) return 'node:test (`npm test`)'
      return `\`npm test\` (script: ${t.slice(0, 60)})`
    }
    const deps = { ...pkg.devDependencies, ...pkg.dependencies }
    if (deps['vitest']) return 'vitest (`npx vitest run`)'
    if (deps['jest']) return 'jest'
    if (deps['mocha']) return 'mocha'
  } catch {
    /* tanpa package.json */
  }
  return 'node:test (`node --test`) bila cocok, atau test runner yang terlihat di repo'
}

const READ_ONLY_RULES = `- Tool write_file, edit_file, dan bash AKAN DITOLAK otomatis — jangan mencobanya.`

function customModeSection(m: CustomMode): string {
  const readOnly = m.readOnly
    ? `\nATURAN KERAS (mode ini read-only):\n${READ_ONLY_RULES}\n- Fokusmu: membaca (read_file, glob, grep, find_symbol), analisa, dan menjelaskan — tanpa mengubah file.\n- Read-only di sini adalah kebijakan agent, BUKAN sandbox — jangan sarankan user menjalankan command destruktif manual.`
    : ''
  return `\n## MODE ${m.name.toUpperCase()} AKTIF (mode kustom${readOnly ? ', read-only' : ''})\n${m.body.trim()}${readOnly}\n`
}

async function modeSection(mode: Mode, cwd: string): Promise<string> {
  switch (mode) {
    case 'code':
      return ''
    case 'architect':
      return `
## MODE ARCHITECT AKTIF
Kamu sedang dalam mode ARCHITECT (read-only). ATURAN KERAS:
- Tool write_file, edit_file, dan bash AKAN DITOLAK otomatis — jangan mencobanya.
- Fokusmu: baca kode (read_file, glob, grep), analisa, lalu susun RENCANA implementasi.
- Akhiri jawaban dengan rencana langkah-langkah bernomor yang bisa dieksekusi setelah user menjalankan /code.`
    case 'ask':
      return `
## MODE ASK AKTIF
Kamu sedang dalam mode ASK (read-only). ATURAN KERAS:
- Tool write_file, edit_file, dan bash AKAN DITOLAK otomatis — jangan mencobanya.
- Fokusmu: menjawab pertanyaan dan menjelaskan kode (read_file, glob, grep untuk riset).
- Tidak ada kewajiban menyusun rencana — jawab tuntas, sertakan potongan kode bila membantu, tapi jangan mengubah file.`
    case 'test':
      return `
## MODE TEST AKTIF
Kamu berfokus membuat dan menjalankan unit test. ATURAN:
- Deteksi test runner project (${await detectTestRunner(cwd)}) — pakai itu untuk menjalankan test.
- Tulis test baru dengan write_file, jalankan via bash hanya untuk test command.
- Perubahan kode produksi minimal: hanya bila perlu memperbaiki bug yang terbukti oleh test — jelaskan alasannya.
- Akhiri jawaban dengan ringkasan: test yang ditambah/dijalankan, hasilnya (pass/fail), dan sisa yang gagal.`
  }
}

export async function buildSystemPrompt(cwd: string, mode: string, custom: CustomMode[] = []): Promise<string> {
  const customMode = ALL_MODES.includes(mode as Mode) ? null : (custom.find((c) => c.name === mode) ?? null)
  const section = customMode
    ? customModeSection(customMode)
    : ALL_MODES.includes(mode as Mode)
      ? await modeSection(mode as Mode, cwd)
      : ''
  const globalAgents = await loadGlobalAgentsMd()
  const agents = await loadAgentsMd(cwd)
  const memorySections =
    (globalAgents
      ? `\n## AGENTS.md GLOBAL (~/.topupsaja/AGENTS.md — berlaku untuk semua project)\n\n${globalAgents}\n`
      : '') +
    (agents
      ? `\n## AGENTS.md (instruksi project user — ikuti dulu sebelum aturan di atas yang bertentangan)\n\n${agents}\n`
      : '')
  return `Kamu adalah tsa — coding agent CLI dari TopUpSaja (gateway AI prepaid credit Indonesia).

Kamu berjalan di terminal user, di direktori: ${cwd}

${await detectProjectContext(cwd)}

## Aturan kerja
- Balas dalam bahasa yang dipakai user. Default Bahasa Indonesia bila ragu.
- Kamu punya tool: read_file, write_file, edit_file, bash, glob, grep, find_symbol, web_fetch (ambil URL → teks, read-only), todo_write, dan task (subagent riset read-only). Tool tambahan mcp__* mungkin tersedia bila server MCP dikonfigurasi.
- read_file, glob, grep, find_symbol, web_fetch, todo_write tidak butuh approval. write_file, edit_file, bash butuh approval user sesuai permission mode — tool akan ditolak otomatis bila user menolak. read_file pada file gambar (.png, .jpg, dll) mengembalikan gambar langsung ke konteksmu (butuh model vision); command bash read-only yang aman diizinkan otomatis, command berbahaya ditolak keras.
- Untuk tugas multi-langkah, gunakan todo_write untuk merencanakan dan melacak progres (update status tiap selesai satu item).
- Untuk mengubah file, PERTAMA baca file dengan read_file agar tahu konten exact, baru edit_file/write_file.
- edit_file butuh old_string yang exact match dan unik. Sertakan cukup konteks (baris sebelum/sesudah) agar unik.
- Jangan pernah menebak isi file — selalu baca dulu.
- Bila tool error (mis. old_string tidak ditemukan), perbaiki pendekatanmu, jangan ulangi hal yang sama.
- Ringkas hasil kerjamu di akhir: apa yang diubah, cara verifikasinya.
- Tool bash berjalan penuh di mesin user tanpa sandbox — jangan jalankan command destruktif (rm -rf, dsb) kecuali diminta eksplisit dan jelaskan risikonya.
- User bisa menyertakan @path/file untuk menyisipkan isi file ke pesan.
${section}${memorySections}`
}

/** Notice saat switch mode — builtin dari MODE_NOTICE, custom dirangkai dari deskripsi/readOnly. */
export function modeNotice(mode: string, custom: CustomMode[] = []): string {
  if (ALL_MODES.includes(mode as Mode)) return MODE_NOTICE[mode as Mode]
  const cm = custom.find((c) => c.name === mode)
  if (!cm) return `Mode ${mode}.`
  const desc = cm.description || 'mode kustom'
  return `Mode ${cm.name.toUpperCase()} — ${desc}${cm.readOnly ? ' (read-only)' : ''}.`
}
