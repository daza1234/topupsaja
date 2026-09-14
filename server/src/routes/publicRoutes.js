import { query } from '../db.js'
import { getSetting } from '../lib/pricing.js'

export default async function publicRoutes(app) {
  /** GET /api/catalog — katalog model publik (untuk landing & /models) */
  app.get('/api/catalog', async () => {
    const rows = await query(
      `select alias, display_name, family, context_window, max_output,
              m_in, m_out, m_cache, tier, upstream_status,
              supports_vision, input_modalities, output_modalities, tags
       from model_pricing where is_active = true
       order by (alias like '%fable%') desc, tier, alias`
    )
    return { data: rows }
  })

  /** GET /api/status — status publik */
  app.get('/api/status', async () => {
    const maintenance = await getSetting('maintenance_mode', false)
    const models = await query(
      `select alias, upstream_status from model_pricing where is_active = true`
    )
    return {
      maintenance: maintenance === true || maintenance === 'true',
      models,
      checked_at: new Date().toISOString(),
    }
  })

  /** GET /health — probe tanpa DB */
  app.get('/health', async () => ({ ok: true, ts: Date.now() }))
}
