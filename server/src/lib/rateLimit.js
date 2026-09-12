/**
 * Lightweight in-memory fixed-window rate limiter, keyed by API key id.
 * Module scope is fine: this server runs single-process.
 */

const WINDOW_MS = 60_000

/** keyId → { windowStart, count } */
const buckets = new Map()

/** Buang bucket kedaluwarsa agar Map tidak tumbuh tanpa batas. */
function prune(now) {
  for (const [id, b] of buckets) {
    if (now - b.windowStart >= WINDOW_MS) buckets.delete(id)
  }
}

/**
 * @param {number|string} keyId
 * @param {number|null} limitPerMin - null/0/undefined = unlimited
 * @returns {{ allowed: boolean, retryAfterSec: number }}
 */
export function checkRateLimit(keyId, limitPerMin) {
  const limit = Number(limitPerMin) || 0
  if (!limit || limit <= 0) return { allowed: true, retryAfterSec: 0 }

  const now = Date.now()
  if (buckets.size > 10_000) prune(now)

  let b = buckets.get(keyId)
  if (!b || now - b.windowStart >= WINDOW_MS) {
    b = { windowStart: now, count: 0 }
    buckets.set(keyId, b)
  }

  b.count += 1
  if (b.count <= limit) return { allowed: true, retryAfterSec: 0 }

  const retryAfterSec = Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - now) / 1000))
  return { allowed: false, retryAfterSec }
}
