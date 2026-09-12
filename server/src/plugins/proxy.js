import fp from 'fastify-plugin'
import { query, queryOne } from '../db.js'
import { config } from '../config.js'
import {
  calculateCredits,
  calculateCostUsd,
  getSetting,
} from '../lib/pricing.js'
import {
  deductUserCredits,
  getUserBalance,
  maybeAlertLowBalance,
} from '../lib/billing.js'
import { sendTelegramAlert } from '../lib/telegram.js'
import { logUsage } from '../lib/usage.js'
import { checkRateLimit } from '../lib/rateLimit.js'

const OR = config.openrouter.base

async function orHeaders() {
  const title = 'TopUpSaja'
  return {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.BASE_URL ?? 'https://topupsaja.com',
    'X-Title': title,
  }
}

function estimateTokens(body) {
  // Fallback char-based: ~4 char per token (rough)
  let inputChars = 0
  for (const m of body.messages ?? []) {
    inputChars += typeof m.content === 'string' ? m.content.length : 8
  }
  const input = Math.ceil(inputChars / 4) || 64
  const output = Math.min(Number(body.max_tokens) || 1024, 4096)
  return { input, output }
}

async function resolveModel(alias) {
  return queryOne(
    `select * from model_pricing
     where alias = $1 and is_active = true`,
    [alias]
  )
}

const AUTO_DISABLE_THRESHOLD = 3

/** Catat kegagalan upstream beruntun; auto-disable saat threshold tercapai. */
export async function recordUpstreamFailure(alias) {
  const row = await queryOne(
    `update model_pricing set fail_count = fail_count + 1
     where alias = $1 and is_active = true
     returning fail_count`,
    [alias]
  )
  if (!row) return
  if (row.fail_count >= AUTO_DISABLE_THRESHOLD) {
    await query(
      `update model_pricing set
         is_active = false,
         upstream_status = 'outage',
         auto_disabled_at = now()
       where alias = $1 and auto_disabled_at is null`,
      [alias]
    )
    await sendTelegramAlert(
      `⛔ Model ${alias} auto-disabled (upstream outage, ${row.fail_count} gagal beruntun). Probe job akan mencoba recovery.`
    )
  }
}

/** Reset fail streak setelah request sukses. */
export async function recordUpstreamSuccess(alias) {
  await query(
    `update model_pricing
     set fail_count = 0,
         upstream_status = 'operational'
     where alias = $1
       and (fail_count > 0 or upstream_status <> 'operational')`,
    [alias]
  )
}

/** Settle billing setelah response upstream selesai. */
async function settle({ request, pricing, usage, latency, statusCode, estimated }) {
  const promptTokens = usage.prompt_tokens ?? 0
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
  const completionTokens = usage.completion_tokens ?? 0

  let credits = estimated
    ? Math.ceil(
        usage.input_tokens_est * Number(pricing.m_in) +
          usage.output_tokens_est * Number(pricing.m_out)
      )
    : calculateCredits(pricing, { promptTokens, cachedTokens, completionTokens })

  // Guard: NaN tidak boleh pernah sampai ke DB.
  if (!Number.isFinite(credits)) {
    request.log.error({ estimated, usage }, 'settle produced non-finite credits, clamping to 0')
    credits = 0
  }

  const costUsd = estimated
    ? 0
    : calculateCostUsd(pricing, { promptTokens, cachedTokens, completionTokens })

  let deducted = false
  if (credits > 0) {
    deducted = await deductUserCredits(request.authInfo.userId, credits)
    if (!deducted) {
      await sendTelegramAlert(
        `🚨 Gagal deduct credit user ${request.authInfo.email} (-${credits}). Saldo tidak cukup saat settle.`
      )
    }
  }

  await logUsage({
    userId: request.authInfo.userId,
    apiKeyId: request.authInfo.apiKeyId,
    orModelId: pricing.or_model_id,
    alias: pricing.alias,
    promptTokens,
    cachedTokens,
    completionTokens,
    creditsUsed: credits,
    costUsd,
    latencyMs: latency,
    statusCode,
    estimated,
  })

  const balance = await getUserBalance(request.authInfo.userId)
  await maybeAlertLowBalance(request.authInfo.userId, request.authInfo.email, balance)
  return { credits, balance }
}

export default fp(async (app) => {
  /**
   * POST /v1/chat/completions — OpenAI-compatible.
   * Streaming dan non-streaming, settle credit setelah response selesai.
   */
  app.post('/v1/chat/completions', {
    preHandler: [app.authenticateApiKey],
    config: { rateLimit: false },
  }, async (request, reply) => {
    // Per-API-key rate limit (rate_limit_per_min null/0 = unlimited)
    const rl = checkRateLimit(request.authInfo.apiKeyId, request.authInfo.rateLimitPerMin)
    if (!rl.allowed) {
      return reply
        .header('Retry-After', String(rl.retryAfterSec))
        .code(429)
        .send({
          error: {
            message: `Rate limit exceeded for this API key (${request.authInfo.rateLimitPerMin} req/min). Try again in ${rl.retryAfterSec}s.`,
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
          },
        })
    }

    const maintenance = await getSetting('maintenance_mode', false)
    if (maintenance === true || maintenance === 'true') {
      return reply.code(503).send({
        error: { message: 'Sedang maintenance. Cek status.topupsaja.com', type: 'server_error' },
      })
    }

    const body = request.body ?? {}
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.code(400).send({
        error: { message: 'messages wajib diisi', type: 'invalid_request_error' },
      })
    }

    // Resolve alias publik → model upstream
    const rawModel = String(body.model ?? '')
    const alias = rawModel.startsWith('ts/') ? rawModel : `ts/${rawModel}`
    const pricing = await resolveModel(alias)
    if (!pricing) {
      return reply.code(404).send({
        error: { message: `Model '${rawModel}' tidak tersedia. Lihat GET /v1/models`, type: 'invalid_request_error' },
      })
    }

    // Safety caps
    const cap = Number(await getSetting('max_tokens_cap', 16384))
    body.model = pricing.or_model_id
    body.max_tokens = Math.min(Number(body.max_tokens) || 4096, cap)
    body.usage = { include: true } // WAJIB: minta usage dari OpenRouter
    body.stream = body.stream === true

    // Pre-flight: estimasi cost jangan > saldo
    const est = estimateTokens(body)
    const estCredits = Math.ceil(
      est.input * Number(pricing.m_in) + est.output * Number(pricing.m_out)
    )
    if (estCredits > request.authInfo.balance) {
      return reply.code(402).send({
        error: {
          message: `Saldo kredit Anda habis. Silakan top-up di: ${config.webUrl}/dashboard`,
          detail: `Estimasi ${estCredits.toLocaleString('id-ID')} credit, tersedia ${request.authInfo.balance.toLocaleString('id-ID')}.`,
          type: 'insufficient_credits',
        },
      })
    }

    const start = Date.now()
    let upstream
    try {
      upstream = await fetch(`${OR}/chat/completions`, {
        method: 'POST',
        headers: await orHeaders(),
        body: JSON.stringify(body),
      })
    } catch (err) {
      request.log.error({ err: err.message }, 'upstream fetch failed')
      // Network error tanpa response = gangguan infrastruktur (bisa kena SEMUA
      // model sekaligus + di-amplifikasi retry klien) — TIDAK dihitung per-model.
      // Kegagalan model-spesifik dihitung di branch !upstream.ok di bawah.
      return reply.code(502).send({
        error: { message: 'Upstream unavailable', type: 'server_error' },
      })
    }

    // ── Upstream error → log & forward ──
    if (!upstream.ok) {
      const errBody = await upstream.json().catch(() => ({}))
      // Klasifikasi outage upstream: 502/503/504 atau body khas OpenRouter.
      // Error klien/akun (400/401/402/403/404, dll) tidak dihitung sebagai fail.
      const errText = JSON.stringify(errBody ?? {}).toLowerCase()
      const isOutage =
        [502, 503, 504].includes(upstream.status) ||
        errText.includes('no endpoints found') ||
        errText.includes('upstream unavailable')
      if (isOutage) {
        await recordUpstreamFailure(alias).catch(() => {})
      }
      // Zero usage, estimated: true — user tidak dibebani biaya saat upstream error.
      await settle({
        request, pricing,
        usage: { input_tokens_est: 0, output_tokens_est: 0 },
        latency: Date.now() - start,
        statusCode: upstream.status,
        estimated: true,
      }).catch(() => {})
      return reply.code(upstream.status).send(errBody)
    }

    // Upstream OK → reset fail streak.
    await recordUpstreamSuccess(alias).catch(() => {})

    // ── Streaming: pipe SSE, parse usage dari chunk terakhir ──
    if (body.stream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      let usage = null
      let streamOk = false
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            reply.raw.write(line + '\n')
            if (line.startsWith('data: ')) {
              const payload = line.slice(6).trim()
              if (payload === '[DONE]') continue
              try {
                const chunk = JSON.parse(payload)
                if (chunk.usage) usage = chunk.usage
              } catch { /* ignore partial */ }
            }
          }
        }
        streamOk = true
      } catch (err) {
        request.log.warn({ err: err.message }, 'stream interrupted')
      }

      const latency = Date.now() - start
      const result = usage
        ? await settle({ request, pricing, usage, latency, statusCode: 200, estimated: false })
        : await settle({
            request, pricing,
            usage: { input_tokens_est: est.input, output_tokens_est: est.output },
            latency, statusCode: 200, estimated: true,
          })

      // Event credit WAJIB ditulis SEBELUM end() — write setelah end hilang.
      if (streamOk) {
        reply.raw.write(
          `event: topupsaja\n data: ${JSON.stringify({ credits_used: result.credits, balance: result.balance })}\n\n`
        )
      }
      reply.raw.end()
      return reply
    }

    // ── Non-streaming ──
    const data = await upstream.json()
    const latency = Date.now() - start
    const result = await settle({
      request, pricing, usage: data.usage ?? {}, latency, statusCode: 200, estimated: false,
    })

    reply.header('X-Credits-Used', String(result.credits))
    reply.header('X-Credits-Remaining', String(result.balance))
    return reply.code(200).send(data)
  })

  /** GET /v1/credits — saldo + usage ringkas hari ini (auth API key, dipakai CLI). */
  app.get('/v1/credits', { preHandler: [app.authenticateApiKey] }, async (request) => {
    const usage = await queryOne(
      `select count(*)::int as requests,
              coalesce(sum(credits_used), 0)::bigint as credits_used,
              coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
              coalesce(sum(completion_tokens), 0)::bigint as completion_tokens
       from usage_logs
       where api_key_id = $1 and created_at >= date_trunc('day', now())`,
      [request.authInfo.apiKeyId]
    )
    return {
      object: 'credit_balance',
      balance: request.authInfo.balance,
      api_key_id: request.authInfo.apiKeyId,
      usage_today: {
        requests: Number(usage?.requests ?? 0),
        credits_used: Number(usage?.credits_used ?? 0),
        prompt_tokens: Number(usage?.prompt_tokens ?? 0),
        completion_tokens: Number(usage?.completion_tokens ?? 0),
      },
    }
  })

  /** GET /v1/models — daftar model aktif (OpenAI-compatible format). */
  app.get('/v1/models', { preHandler: [app.authenticateApiKey] }, async () => {
    const models = await query(
      `select alias, display_name, family, context_window, m_in, m_out, m_cache, tier, supports_vision
       from model_pricing where is_active = true order by tier, alias`
    )
    return {
      object: 'list',
      data: models.map((m) => ({
        id: m.alias,
        object: 'model',
        owned_by: m.family ?? 'topupsaja',
        context_window: m.context_window,
        pricing: { input: Number(m.m_in), output: Number(m.m_out), cache: Number(m.m_cache), unit: 'credits/token' },
        tier: m.tier,
        supports_vision: m.supports_vision === true,
      })),
    }
  })
})
