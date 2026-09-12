import { query } from '../db.js'

/**
 * Purge sesi kedaluwarsa/direvoke lebih dari 7 hari — jaga tabel tetap kecil.
 */
export async function purgeSessions() {
  const res = await query(
    `delete from sessions
     where expires_at < now() - interval '7 days'
        or revoked_at < now() - interval '7 days'
     returning id`
  )
  if (res.length > 0) {
    console.log(`[purgeSessions] ${res.length} sesi dihapus`)
  }
  return res.length
}
