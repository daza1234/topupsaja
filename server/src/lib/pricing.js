import { queryOne } from '../db.js'
import { config } from '../config.js'

// Nilai 1 credit dalam USD. 1M credit = $0.10 nilai cost OpenRouter.
export const CREDIT_USD = config.creditUsdValue

const round2 = (n) => Math.round(n * 100) / 100

/** Markup fee per-tier atas cost upstream (lihat config.openrouter.fees). */
export function feeForTier(tier) {
  const fees = config.openrouter.fees
  return fees[tier] ?? fees.standar
}

/**
 * Hitung multiplier credit per token dari harga OpenRouter (USD per token).
 * Fee per-tier — model murah markup lebih tinggi, model mahal lebih rendah.
 */
export function computeMultipliers(costIn, costOut, costCache, tier = 'standar') {
  const fee = feeForTier(tier)
  const mIn = Math.max(1, round2((costIn * fee) / CREDIT_USD))
  const mOut = Math.max(1, round2((costOut * fee) / CREDIT_USD))
  const mCache = round2((costCache * fee) / CREDIT_USD)
  return { mIn, mOut, mCache }
}

/**
 * Tier display berdasarkan effective cost input per 1M token.
 */
export function assignTier(costInPerToken) {
  const perMillion = costInPerToken * 1_000_000
  if (perMillion <= 0.3) return 'hemat'
  if (perMillion <= 3.0) return 'standar'
  return 'premium'
}

/**
 * Formula konsumsi credit (dari plan §3.1):
 * credits = ceil(fresh_in × m_in + cached × m_cache + out × m_out)
 */
export function calculateCredits(pricing, { promptTokens, cachedTokens, completionTokens }) {
  const fresh = Math.max(0, promptTokens - cachedTokens)
  return Math.ceil(
    fresh * Number(pricing.m_in) +
      cachedTokens * Number(pricing.m_cache) +
      completionTokens * Number(pricing.m_out)
  )
}

/** Cost aktual ke OpenRouter (USD), untuk audit internal. */
export function calculateCostUsd(pricing, { promptTokens, cachedTokens, completionTokens }) {
  const fresh = Math.max(0, promptTokens - cachedTokens)
  return (
    fresh * Number(pricing.cost_in_usd) +
    completionTokens * Number(pricing.cost_out_usd)
  )
}

/**
 * Margin efektif: rate jual credit vs cost untuk melayani 1M credit.
 * 1 credit mengonsumsi cost = CREDIT_USD / fee (karena m = cost×fee/CREDIT_USD),
 * sehingga cost serve 1M credit = (1M × CREDIT_USD / fee) × kurs.
 * Fee terendah (premium) = worst case cost tertinggi.
 */
export function effectiveMarkupPerCredit(rateIdrPerMillionCredit, idrPerUsd, fee) {
  const worstFee = fee ?? feeForTier('premium')
  const costPerMillionCredit = ((1_000_000 * CREDIT_USD) / worstFee) * idrPerUsd
  if (costPerMillionCredit <= 0) return 0
  return rateIdrPerMillionCredit / costPerMillionCredit
}

export async function getSetting(key, fallback = null) {
  try {
    const row = await queryOne('select value from settings where key = $1', [key])
    return row ? row.value : fallback
  } catch {
    return fallback
  }
}

export async function getKurs() {
  const v = await getSetting('idr_per_usd', config.idrPerUsdFallback)
  // JSONB bisa tersimpan sebagai objek (mis. {"value": 16000}) atau angka langsung.
  const raw = typeof v === 'object' && v !== null ? v.value : v
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : config.idrPerUsdFallback
}
