import { join } from 'pathe'
/**
 * Pecah diff baris (output simpleDiff) menjadi hunk kontigu + rekonstruksi
 * hasil merge per-hunk. HARUS memakai algoritma walk yang sama dengan
 * simpleDiff (greedy per-baris, bukan LCS) agar preview & hasil konsisten.
 */

export interface Hunk {
  /** Nomor urut hunk (1..n). */
  startLine: number
  /** Baris diff berawalan `- ` / `+ `. */
  lines: string[]
}

/** simpleDiff lokal (greedy baris-per-baris) — algoritma sama dengan preview. */
function simpleDiff(oldStr: string, newStr: string): string {
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

/**
 * Pecah diff (baris `- x` / `+ y`) menjadi hunk. simpleDiff tidak memuat
 * baris konteks, jadi batas hunk = transisi `+` → `-` (lokasi edit baru):
 * run `-` diikuti `+` adalah satu site; `-` setelah `+` memulai hunk baru.
 */
export function splitHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  let prevPlus = false
  for (const line of diff.split('\n')) {
    if (!line.startsWith('-') && !line.startsWith('+')) continue
    const startsNew = line.startsWith('-') && prevPlus
    if (!hunks.length || startsNew) {
      hunks.push({ startLine: 1, lines: [line] })
    } else {
      hunks[hunks.length - 1].lines.push(line)
    }
    prevPlus = line.startsWith('+')
  }
  return hunks
}

/**
 * Walk baris old→new dengan algoritma yang sama persis dengan simpleDiff.
 * Hunk terpilih → baris new dipakai; tidak dipilih → baris old dipertahankan.
 * Return null bila hasil == oldStr (tidak ada perubahan efektif).
 */
export function applyHunks(oldStr: string, newStr: string, selected: number[]): string | null {
  const diff = simpleDiff(oldStr, newStr)
  if (!diff) return null
  const hunks = splitHunks(diff)
  const diffLines = diff.split('\n')
  // Index hunk (0-based) per baris diff — baris diff ke-p milik hunkOf[p].
  const hunkOf: number[] = []
  hunks.forEach((hk, idx) => {
    for (let k = 0; k < hk.lines.length; k++) hunkOf.push(idx)
  })
  const sel = new Set(selected)
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  const out: string[] = []
  let i = 0
  let j = 0
  let p = 0
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      out.push(oldLines[i])
      i++
      j++
      continue
    }
    while (i < oldLines.length && !newLines.includes(oldLines[i])) {
      if (p < diffLines.length && diffLines[p] === `- ${oldLines[i]}`) {
        if (!sel.has(hunkOf[p] + 1)) out.push(oldLines[i])
        p++
      } else {
        out.push(oldLines[i])
      }
      i++
    }
    while (j < newLines.length && !oldLines.includes(newLines[j])) {
      if (p < diffLines.length && diffLines[p] === `+ ${newLines[j]}`) {
        if (sel.has(hunkOf[p] + 1)) out.push(newLines[j])
        p++
      } else {
        out.push(newLines[j])
      }
      j++
    }
  }
  const merged = out.join('\n')
  return merged === oldStr ? null : merged
}
