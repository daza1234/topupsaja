import { config } from '../config.js'
import { query, queryOne } from '../db.js'
import {
  computeMultipliers,
  assignTier,
  getKurs,
  effectiveMarkupPerCredit,
} from '../lib/pricing.js'
import { sendTelegramAlert } from '../lib/telegram.js'

// Model kurasi — otomatis aktif saat pertama kali masuk DB. Kurasi mengikuti
// roster "Provider yang Didukung" di landing page (web/app/page.jsx).
// Model lain dari katalog OpenRouter ikut disinkronkan tapi nonaktif
// (admin aktifkan manual).
// ponytail: roster menampilkan "grok-2" tapi katalog OpenRouter hanya punya
// grok-4.x — dipakai x-ai/grok-4.5 sebagai wakil xAI. Upgrade path: ganti id
// di sini kalau roster/grok-2 kembali tersedia.
export const DEFAULT_ACTIVE_MODELS = new Set([
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
  'meta-llama/llama-3.3-70b-instruct',
  'qwen/qwen-2.5-72b-instruct',
  'mistralai/mistral-large',
  'x-ai/grok-4.5',
  'moonshotai/kimi-k2',
  'z-ai/glm-4.6',
])

// Kurasi manual label use-case per exact or_model_id (roster DEFAULT_ACTIVE_MODELS).
// ponytail: heuristik kata kunci kasar bisa salah label model niche — kalau
// salah arah, tambah override di sini, jangan perumit regex.
const TAG_OVERRIDES = {
  'deepseek/deepseek-chat': ['coding', 'analisis'],
  'deepseek/deepseek-r1': ['coding', 'reasoning'],
  'openai/gpt-4o-mini': ['coding', 'vision', 'ringkasan'],
  'openai/gpt-4o': ['coding', 'vision', 'analisis'],
  'openai/gpt-4.1': ['coding', 'analisis', 'reasoning'],
  'openai/gpt-4.1-mini': ['coding', 'ringkasan'],
  'openai/gpt-4.1-nano': ['ringkasan'],
  'anthropic/claude-3.5-sonnet': ['coding', 'analisis', 'vision'],
  'anthropic/claude-3-haiku': ['ringkasan', 'vision'],
  'google/gemini-2.0-flash-001': ['coding', 'vision', 'terjemahan'],
  'google/gemini-1.5-pro': ['coding', 'vision', 'analisis'],
  'meta-llama/llama-3.1-70b-instruct': ['coding', 'terjemahan'],
  'meta-llama/llama-3.3-70b-instruct': ['coding', 'terjemahan'],
  'qwen/qwen-2.5-72b-instruct': ['coding', 'terjemahan'],
  'mistralai/mistral-large': ['coding', 'terjemahan'],
  'x-ai/grok-4.5': ['coding', 'analisis', 'reasoning'],
  'moonshotai/kimi-k2': ['coding', 'analisis'],
  'z-ai/glm-4.6': ['coding', 'reasoning'],
}

// Heuristik label dari nama + deskripsi katalog (lowercase includes).
function tagModel(m, inputModalities) {
  const hay = `${m.name ?? ''} ${m.description ?? ''}`.toLowerCase()
  const tags = new Set(TAG_OVERRIDES[m.id] ?? [])
  if (/code|programming|software|developer/.test(hay)) tags.add('coding')
  if (/financ|analy|data|business|report/.test(hay)) tags.add('analisis')
  if (/reason|logic|math|chain-of-thought|thinking/.test(hay)) tags.add('reasoning')
  if (/translat|multilingual|bahasa/.test(hay)) tags.add('terjemahan')
  if (inputModalities.includes('image')) tags.add('vision')
  return [...(tags.size ? tags : ['ringkasan'])]
}

const aliasOf = (orId) => `ts/${orId.split('/')[1].replace(/[:/].*$/, '')}`
const familyOf = (orId) => orId.split('/')[0].split('-')[0].replace(/^\w/, (c) => c.toUpperCase())

// alias unik per or_model_id: kalau tabrakan (mis. `:free` vs berbayar),
// tambahkan sufiks dari sisa segment varian (`ts/deepseek-chat-free`).
// ponytail: varian ketiga dengan nama sama masih bisa tabrakan (alias UNIQUE
// akan menolak upsert) — kalau terjadi, tinggal append counter di sini.
function buildAliases(orIds) {
  const used = new Map()
  const aliases = new Map()
  for (const orId of orIds) {
    const [seg1, seg2] = orId.split('/')
    let alias = aliasOf(orId)
    if (used.get(alias) ?? false) {
      const variant = (seg2 ?? '').replace(/^[^:/]*[:/]*/, '') || seg1
      alias = `${alias}-${variant.replace(/[^a-z0-9.-]/gi, '-')}`
    }
    used.set(alias, true)
    aliases.set(orId, alias)
  }
  return aliases
}

export async function syncRates() {
  if (!config.openrouter.apiKey) {
    console.warn('[syncRates] OPENROUTER_API_KEY kosong — skip')
    return 0
  }

  const res = await fetch(`${config.openrouter.base}/models`)
  if (!res.ok) throw new Error(`OR /models HTTP ${res.status}`)
  const { data: models } = await res.json()

  const kurs = await getKurs()
  const aliases = buildAliases(models.map((m) => m.id))
  let synced = 0

  for (const m of models) {
    const orId = m.id
    const p = m.pricing ?? {}
    const costIn = Number(p.prompt ?? '0')
    const costOut = Number(p.completion ?? '0')
    // OR: input_cache_read (USD/token). Fallback: 50% cost input (konservatif).
    const costCache = Number(p.input_cache_read ?? '') || costIn * 0.5

    const tier = assignTier(costIn)
    const { mIn, mOut, mCache } = computeMultipliers(costIn, costOut, costCache, tier)

    const inputModalities = m.architecture?.input_modalities
    const outputModalities = m.architecture?.output_modalities
    const supportsVision = Array.isArray(inputModalities)
      ? inputModalities.includes('image')
      : false
    const tags = tagModel(m, Array.isArray(inputModalities) ? inputModalities : ['text'])

    await query(
      `insert into model_pricing
         (or_model_id, alias, display_name, family, context_window, max_output,
          cost_in_usd, cost_out_usd, m_in, m_out, m_cache, tier, supports_vision,
          input_modalities, output_modalities, tags, is_active, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
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
         input_modalities = excluded.input_modalities,
         output_modalities = excluded.output_modalities,
         tags = excluded.tags,
         synced_at = now()`,
      [
        orId, aliases.get(orId), m.name, familyOf(orId),
        m.context_length ?? null, m.top_provider?.max_completion_tokens ?? null,
        costIn, costOut, mIn, mOut, mCache, tier, supportsVision,
        Array.isArray(inputModalities) ? inputModalities : ['text'],
        Array.isArray(outputModalities) ? outputModalities : ['text'],
        tags,
        DEFAULT_ACTIVE_MODELS.has(orId),
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
