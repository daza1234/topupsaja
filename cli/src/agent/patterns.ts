/**
 * Util glob kecil (self-contained, tanpa dependensi — gaya simpleDiff).
 * Support: `*` (nol+ karakter, tidak melewati `/`), `**` (nol+ karakter,
 * melewati `/`), `?` (tepat satu karakter, bukan `/`). Case-sensitive.
 * Karakter regex lain di-escape apa adanya.
 */

// Cache regex per pattern (pemanggilan globMatch sangat panas di loop) —
// di-clear bila melebihi batas agar tidak kegondrong.
const cache = new Map<string, RegExp>()
const CACHE_MAX = 500

/** Glob → RegExp sumber. `*`→[^/]*, `**`→.* , `?`→[^/], lainnya escape. */
export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern)
  if (hit) return hit
  const re = compileGlob(pattern)
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(pattern, re)
  return re
}

function compileGlob(pattern: string): RegExp {
  let src = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        src += '.*'
        i += 2
      } else {
        src += '[^/]*'
        i++
      }
      continue
    }
    if (c === '?') {
      src += '[^/]'
      i++
      continue
    }
    src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i++
  }
  return new RegExp(`^${src}$`)
}

/** Match glob pattern terhadap target string (exact, case-sensitive). */
export function globMatch(pattern: string, target: string): boolean {
  if (!pattern) return false
  return globToRegExp(pattern).test(target)
}
