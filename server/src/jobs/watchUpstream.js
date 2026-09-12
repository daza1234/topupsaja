import { config } from '../config.js'
import { queryOne, query } from '../db.js'
import { getSetting } from '../lib/pricing.js'
import { sendTelegramAlert } from '../lib/telegram.js'

export async function watchUpstream() {
  if (!config.openrouter.apiKey) return

  let data
  try {
    const res = await fetch(`${config.openrouter.base}/credits`, {
      headers: { Authorization: `Bearer ${config.openrouter.apiKey}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    ;({ data } = await res.json())
  } catch (err) {
    console.error('[watchUpstream] gagal cek saldo:', err.message)
    return
  }

  const remainingUsd = Number(data.total_credits) - Number(data.total_usage)
  const threshold = Number(
    (await getSetting('upstream_balance_alert_usd', 20)) ?? 20
  )

  if (remainingUsd <= 0) {
    const current = await getSetting('maintenance_mode', false)
    if (current !== true && current !== 'true') {
      await query(
        `insert into settings (key, value) values ('maintenance_mode', 'true'::jsonb)
         on conflict (key) do update set value = 'true'::jsonb`
      )
      await sendTelegramAlert(
        '🔴 CRITICAL: Saldo OpenRouter habis. MAINTENANCE MODE ON — semua request ditolak. SEGERA TOP UP!'
      )
    }
  } else if (remainingUsd < threshold) {
    await sendTelegramAlert(
      `⚠️ Saldo OpenRouter menipis: $${remainingUsd.toFixed(2)}. Segera top up.`
    )
  }

  console.log(
    `[watchUpstream] remaining=$${remainingUsd.toFixed(2)} of $${Number(data.total_credits).toFixed(2)}`
  )
  return remainingUsd
}
