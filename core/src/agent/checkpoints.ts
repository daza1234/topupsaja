import { dirname, join, relative, resolve, sep } from 'pathe'
import { getHost } from '../host.js'
import { simpleDiff, truncateForPreview } from './permission.js'
import type { AgentRuntime } from './runtime.js'

/** Cap snapshot per file — file lebih besar dilewati (notice). */
const MAX_SNAPSHOT_BYTES = 1_000_000
/** Cap total ukuran snapshot per turn — lebih dari ini, /undo fallback ke baseline. */
const MAX_TURN_SNAPSHOT_BYTES = 4_000_000

/** Path absolut → relatif-normalisasi terhadap cwd. */
export function relPath(cwd: string, absOrRel: string): string {
  return relative(cwd, resolve(cwd, absOrRel)).split(sep).join('/')
}

/**
 * Panggil SEBELUM mutasi file:
 * - baseline pertama per path disimpan persist (session.checkpoints) untuk /diff kumulatif,
 * - snapshot pre-mutasi per turn (in-memory) untuk /undo yang akurat.
 * Return skipped path bila file terlalu besar untuk di-snapshot.
 */
export async function stagePreState(rt: AgentRuntime, rel: string): Promise<string | undefined> {
  const abs = resolve(rt.cwd, rel)
  let content: string | null = null
  let tooBig = false
  try {
    const stat = await getHost().fs.stat(abs)
    if (stat.isFile()) {
      if (stat.size > MAX_SNAPSHOT_BYTES) {
        tooBig = true
      } else {
        content = await getHost().fs.readFile(abs, 'utf8')
      }
    }
  } catch {
    content = null // file belum ada
  }

  // Baseline persist (pertama per path sepanjang sesi).
  if (!tooBig && !rt.session.checkpoints[rel]) {
    rt.session.checkpoints[rel] = { content, at: new Date().toISOString() }
  }

  // Snapshot per-turn (untuk /undo).
  const snap = rt.turnSnapshots[rt.turnSnapshots.length - 1]
  if (snap && !snap.has(rel) && !tooBig) {
    let total = 0
    for (const v of snap.values()) total += v?.length ?? 0
    if (total + (content?.length ?? 0) <= MAX_TURN_SNAPSHOT_BYTES) snap.set(rel, content)
  }

  if (tooBig) return rel
  return undefined
}

/** Tandai file berhasil dimutasi pada turn aktif. */
export function markTouched(rt: AgentRuntime, rel: string): void {
  const current = rt.checkpointTurns[rt.checkpointTurns.length - 1]
  if (current && !current.includes(rel)) current.push(rel)
}

async function restoreContent(abs: string, content: string | null): Promise<void> {
  if (content === null) {
    try {
      await getHost().fs.unlink(abs)
    } catch {
      /* sudah tidak ada */
    }
  } else {
    await getHost().fs.mkdir(dirname(abs), { recursive: true })
    await getHost().fs.writeFile(abs, content, 'utf8')
  }
}

/**
 * /undo: kembalikan file yang tersentuh di turn terakhir ke state
 * sebelum turn itu (snapshot in-memory; fallback = baseline persist).
 * Return daftar path yang dipulihkan.
 */
export async function undoLastTurn(rt: AgentRuntime): Promise<string[]> {
  const touched = rt.checkpointTurns.pop()
  const snaps = rt.turnSnapshots.pop()
  if (!touched || touched.length === 0) return []
  const restored: string[] = []
  for (const rel of touched) {
    let pre = snaps?.get(rel)
    if (pre === undefined) {
      // Fallback (mis. setelah restart): pakai baseline persist lalu hapus.
      const cp = rt.session.checkpoints[rel]
      if (!cp) continue
      pre = cp.content
      delete rt.session.checkpoints[rel]
    }
    try {
      await restoreContent(resolve(rt.cwd, rel), pre)
      restored.push(rel)
    } catch {
      /* gagal restore satu file — lanjut */
    }
  }
  await rt.session.save()
  return restored
}

/**
 * /diff: diff kumulatif baseline→kini untuk semua file yang punya checkpoint.
 * Return teks siap tampil (sudah di-truncate per file).
 */
export async function diffCheckpoints(rt: AgentRuntime): Promise<string> {
  const entries = Object.entries(rt.session.checkpoints)
  if (entries.length === 0) return 'Belum ada file yang dimutasi sejak sesi dimulai.'
  const out: string[] = []
  for (const [rel, cp] of entries) {
    const abs = resolve(rt.cwd, rel)
    let now: string | null = null
    try {
      now = await getHost().fs.readFile(abs, 'utf8')
    } catch {
      now = null
    }
    let body: string
    if (cp.content === null && now !== null) {
      body = truncateForPreview(
        now
          .split('\n')
          .map((l) => `+ ${l}`)
          .join('\n')
      )
    } else if (cp.content !== null && now === null) {
      body = '(file dihapus)'
    } else if (cp.content === now) {
      body = '(tidak berubah)'
    } else {
      body = truncateForPreview(simpleDiff(cp.content ?? '', now ?? ''))
    }
    out.push(`── ${rel} ──\n${body}`)
  }
  return out.join('\n')
}