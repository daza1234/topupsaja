import { config } from '../config.js'
import { query, queryOne } from '../db.js'
import { sendTelegramAlert } from '../lib/telegram.js'

// Alert Telegram hanya sekali per model per proses (hindari spam tiap 15 menit).
const alerted = new Set()

/**
 * Probe model yang auto-disabled oleh fail streak.
 * Hanya menyentuh baris dengan auto_disabled_at IS NOT NULL —
 * manual disable admin tidak pernah di-re-activate otomatis.
 */
export async function probeDisabled() {
  if (!config.openrouter.apiKey) return

  const rows = await query(
    `select alias, or_model_id from model_pricing
     where is_active = false and auto_disabled_at is not null`
  )
  if (rows.length === 0) return

  for (const row of rows) {
    let ok = false
    let reason = ''
    try {
      const res = await fetch(`${config.openrouter.base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openrouter.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': config.baseUrl ?? 'https://topupsaja.com',
          'X-Title': 'TopUpSaja',
        },
        body: JSON.stringify({
          model: row.or_model_id,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      if (res.ok) {
        ok = true
      } else {
        const body = await res.json().catch(() => ({}))
        reason = `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`
      }
    } catch (err) {
      reason = err.message
    }

    if (ok) {
      await query(
        `update model_pricing set
           is_active = true,
           fail_count = 0,
           upstream_status = 'operational',
           auto_disabled_at = null
         where alias = $1`,
        [row.alias]
      )
      alerted.delete(row.alias)
      await sendTelegramAlert(`✅ Model ${row.alias} kembali operasional — auto re-activated.`)
      console.log(`[probeDisabled] ${row.alias} re-activated`)
    } else {
      if (!alerted.has(row.alias)) {
        alerted.add(row.alias)
        await sendTelegramAlert(
          `⛔ Model ${row.alias} masih down saat probe: ${reason}`
        )
      }
      console.log(`[probeDisabled] ${row.alias} masih gagal: ${reason}`)
    }
  }
}
