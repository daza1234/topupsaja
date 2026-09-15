/** Fuzzy subsequence filter untuk autocomplete @file. Tanpa dependensi baru. */

const WORD_BOUNDARY = /[\\/._\-$\s]/

/** Skor match subsequence greedy; null kalau query bukan subsequence text.
 *  Bonus: run berurutan, awal kata, dan match di basename. Penalti: jarak antar match. */
function scan(text: string, q: string): number | null {
  let pos = -2
  let score = 0
  for (const ch of q) {
    const i = text.indexOf(ch, pos + 1)
    if (i === -1) return null
    score += 1
    if (i === pos + 1) score += 3
    if (i === 0 || WORD_BOUNDARY.test(text[i - 1])) score += 4
    if (pos >= 0) score -= i - pos - 2
    pos = i
  }
  return score
}

export function fuzzyScore(path: string, q: string): number | null {
  const t = path.toLowerCase()
  const s = q.toLowerCase()
  const full = scan(t, s)
  if (full === null) return null
  const base = scan(t.slice(t.lastIndexOf('/') + 1), s)
  return full + (base === null ? 0 : base * 2 + 5)
}

/** Filter + ranking; hasil sudah lower-case-insensitive query, maks `limit`.
 *  Urutan stabil: skor desc, lalu path asc. */
export function fuzzyFilterFiles(files: string[], q: string, limit = 8): string[] {
  if (!q) return files.slice(0, limit)
  const scored: { f: string; s: number }[] = []
  for (const f of files) {
    const s = fuzzyScore(f, q)
    if (s !== null) scored.push({ f, s })
  }
  scored.sort((a, b) => b.s - a.s || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0))
  return scored.slice(0, limit).map((x) => x.f)
}
