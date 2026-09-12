import { query } from '../db.js'
import { sendTelegramAlert } from '../lib/telegram.js'

/**
 * Expire top up pending >24 jam.
 * (Expiry credit paket ditegakkan di level topup; credit yang sudah
 *  masuk saldo tidak dihapus — kebijakan 90 hari dievaluasi via audit.)
 */
export async function expireTopups() {
  const res = await query(
    `update topups set status = 'expired'
     where status = 'pending' and expires_at < now()
     returning id, provider_ref`
  )
  if (res.length > 0) {
    console.log(`[expireTopups] ${res.length} order expired`)
  }
  return res.length
}
