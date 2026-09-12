import { query, queryOne } from '../db.js'
import { sendTelegramAlert } from './telegram.js'

/**
 * Potong credit user (atomic). Return true bila sukses.
 * Kirim alert + maintenance mode bila debit gagal (saldo habis mendadak).
 */
export async function deductUserCredits(userId, credits) {
  const ok = await queryOne('select deduct_user_credits($1, $2) as ok', [
    userId,
    credits,
  ])
  return Boolean(ok?.ok)
}

export async function addCredits(userId, credits) {
  await query('select add_user_credits($1, $2)', [userId, credits])
}

export async function getUserBalance(userId) {
  const row = await queryOne(
    'select balance_credits from users where id = $1',
    [userId]
  )
  return Number(row?.balance_credits ?? 0)
}

/** Alert saldo user menipis (maks 1x per jam per user, in-memory). */
const lowBalanceNotified = new Map()
export async function maybeAlertLowBalance(userId, email, balance) {
  const now = Date.now()
  const last = lowBalanceNotified.get(userId) ?? 0
  if (now - last < 60 * 60 * 1000) return
  if (balance < 1_000_000) {
    lowBalanceNotified.set(userId, now)
    await sendTelegramAlert(
      `⚠️ User <b>${email}</b> saldo menipis: ${balance.toLocaleString('id-ID')} credit`
    )
  }
}
