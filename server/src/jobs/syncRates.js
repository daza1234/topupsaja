import { config } from '../config.js'
import { query, queryOne } from '../db.js'
import {
  computeMultipliers,
  assignTier,
  getKurs,
  effectiveMarkupPerCredit,
} from '../lib/pricing.js'
import { sendTelegramAlert } from '../lib/telegram.js'

// Model yang dijual — kurasi. Tambah/hapus di sini.
export const ALLOWED_MODELS = [
  'deepseek/deepseek-chat',
  'deepseek/deepseek-r1',
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'openai/gpt-4.1-nano',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3-haiku',
  'google/gemini-2.0-flash-001',
  'google/gemini-1.5-pro',
  'meta-llama/llama-3.1-70b-instruct',
  'qwen/qwen-2.5-72b-instruct',
  'mistralai/mistral-large',
]

const aliasOf = (orId) => `ts/${orId.split('/')[1].replace(/[:/].*$/, '')}`
const familyOf = (orId) => orId.split('/')[0].split('-')[0].replace(/^\w/, (c) => c.toUpperCase())

export async function syncRates() {
  if (!config.openrouter.apiKey) {
    console.warn('[syncRates] OPENROUTER_API_KEY kosong — skip')
    return 0
  }

  const res = await fetch(`${config.openrouter.base}/models`)
  if (!res.ok) throw new Error(`OR /models HTTP ${res.status}`)
  const { data: models } = await res.json()
  const byId = new Map(models.map((m) => [m.id, m]))

  const kurs = await getKurs()
  let synced = 0

  for (const orId of ALLOWED_MODELS) {
    const m = byId.get(orId)
    if (!m) continue

    const p = m.pricing ?? {}
    const costIn = Number(p.prompt ?? '0')
    const costOut = Number(p.completion ?? '0')
    // OR: input_cache_read (USD/token). Fallback: 50% cost input (konservatif).
    const costCache = Number(p.input_cache_read ?? '') || costIn * 0.5

    const tier = assignTier(costIn)
    const { mIn, mOut, mCache } = computeMultipliers(costIn, costOut, costCache, tier)

    const modalities = m.architecture?.input_modalities
    const supportsVision = Array.isArray(modalities)
      ? modalities.includes('image')
      : false

    await query(
      `insert into model_pricing
         (or_model_id, alias, display_name, family, context_window, max_output,
          cost_in_usd, cost_out_usd, m_in, m_out, m_cache, tier, supports_vision,
          is_active, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,now())
       on conflict (or_model_id) do update set
         alias = excluded.alias,
         display_name = excluded.display_name,
         family = excluded.family,
         context_window = excluded.context_window,
         max_output = excluded.max_output,
         cost_in_usd = excluded.cost_in_usd,
         cost_out_usd = excluded.cost_out_usd,
         m_in = excluded.m_in,
         m_out = excluded.m_out,
         m_cache = excluded.m_cache,
         tier = excluded.tier,
         supports_vision = excluded.supports_vision,
         synced_at = now()`,
      [
        orId, aliasOf(orId), m.name, familyOf(orId),
        m.context_length ?? null, m.top_provider?.max_completion_tokens ?? null,
        costIn, costOut, mIn, mOut, mCache, tier, supportsVision,
      ]
    )
    synced += 1
  }

  // Margin guard: rate jual efektif termurah vs cost serve (worst case = fee premium).
  const floorRate = await queryOne(
    "select value from settings where key = 'floor_rate_per_m_credit'"
  )
  const floor = Number(floorRate?.value ?? 350)
  const cheapest = await queryOne(
    `select min(price_idr / (credits / 1e6::numeric)) as rate
       from credit_packages where is_active`
  )
  const sellRate = Number(cheapest?.rate ?? floor)
  const markup = effectiveMarkupPerCredit(Math.max(sellRate, floor), kurs)
  if (markup < 1.15) {
    await sendTelegramAlert(
      `🚨 MARGIN GUARD: markup efektif ${markup.toFixed(2)}× < 1.15× ` +
        `(rate jual termurah Rp ${sellRate.toFixed(0)}/M, kurs ${kurs}). ` +
        `Turunkan biaya / naikkan harga paket!`
    )
  }

  console.log(
    `[syncRates] ${synced} model tersinkronisasi (kurs Rp ${kurs}, ` +
      `rate jual termurah Rp ${sellRate.toFixed(0)}/M, markup ${markup.toFixed(2)}×)`
  )
  return synced
}
