import crypto from 'node:crypto'
import { query, queryOne } from '../db.js'
import { makeProvider } from '../lib/qris.js'
import { sendTelegramAlert } from '../lib/telegram.js'

function newRef() {
  return `TS-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
}

export default async function topupRoutes(app) {
  /** GET /api/packages — daftar paket aktif (publik) */
  app.get('/api/packages', async () => {
    return query(
      `select code, display_name, credits, base_credits, bonus_percent,
              price_idr, expiry_days, is_featured
       from credit_packages where is_active = true order by sort_order`
    )
  })

  /** POST /api/topup/create — buat order top up */
  app.post('/api/topup/create', {
    preHandler: [app.authenticateSession],
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    if (!request.userRow.email_verified_at) {
      return reply.code(403).send({ error: 'email_not_verified' })
    }
    const code = String(request.body?.package_code ?? '')
    const pkg = await queryOne(
      'select * from credit_packages where code = $1 and is_active = true',
      [code]
    )
    if (!pkg) return reply.code(404).send({ error: 'Paket tidak ditemukan' })

    const providerRef = newRef()
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000)

    const topup = await queryOne(
      `insert into topups (user_id, package_id, package_code, credits, price_idr,
                           method, provider, provider_ref, expires_at)
       values ($1,$2,$3,$4,$5,'qris',$6,$7,$8)
       returning *`,
      [
        request.userRow.id, pkg.id, pkg.code,
        Number(pkg.credits), Number(pkg.price_idr),
        process.env.QRIS_PROVIDER ?? 'manual', providerRef, expiresAt,
      ]
    )

    try {
      const provider = makeProvider()
      const invoice = await provider.createInvoice({
        ...topup,
        email: request.userRow.email,
        expires_at: expiresAt.toISOString(),
      })
      await query(
        'update topups set payment_url = $2, qr_string = $3 where id = $1',
        [topup.id, invoice.payment_url, invoice.qr_string]
      )
      return reply.code(201).send({
        topup_id: topup.id,
        provider_ref: providerRef,
        amount_idr: Number(pkg.price_idr),
        credits: Number(pkg.credits),
        payment_url: invoice.payment_url,
        qr_string: invoice.qr_string,
        instructions: invoice.instructions ?? null,
        expires_at: expiresAt.toISOString(),
      })
    } catch (err) {
      request.log.error({ err: err.message }, 'createInvoice gagal')
      return reply.code(502).send({
        error: 'Gagal membuat invoice pembayaran. Coba lagi atau hubungi admin.',
      })
    }
  })

  /** GET /api/topup/status/:id */
  app.get('/api/topup/status/:id', { preHandler: [app.authenticateSession] }, async (request, reply) => {
    const row = await queryOne(
      'select id, status, credits, price_idr, paid_at from topups where id = $1 and user_id = $2',
      [request.params.id, request.userRow.id]
    )
    if (!row) return reply.code(404).send({ error: 'Top up tidak ditemukan' })
    return row
  })

  /**
   * POST /api/topup/webhook/generic + /tripay — callback vendor QRIS.
   * Registrasi dalam scope ter-enkapsulasi agar parser JSON raw (string)
   * hanya berlaku untuk route ini — diperlukan untuk verifikasi signature.
   * makeProvider() men-dispatch ke provider aktif (generic/tripay).
   */
  const handleWebhook = async (request, reply) => {
    const raw = request.body // string raw JSON
    const provider = makeProvider()
    const event = await provider.verifyWebhook(request, raw).catch(() => null)

    if (!event) {
      request.log.warn('webhook signature invalid')
      return reply.code(403).send({ error: 'Invalid signature' })
    }
    if (!event.paid) {
      return reply.code(200).send({ ok: true, ignored: true })
    }

    const topup = await queryOne(
      'select id, credits, user_id, price_idr from topups where provider_ref = $1 and status = $2',
      [event.provider_ref, 'pending']
    )
    if (!topup) {
      return reply.code(200).send({ ok: true, ignored: 'already processed or not found' })
    }

    // Jangan pernah kredit bila nominal callback ≠ nominal order (tampering/bug vendor).
    if (event.amount !== undefined) {
      const expected = Number(topup.price_idr)
      if (!Number.isFinite(event.amount) || event.amount !== expected) {
        request.log.warn(
          { ref: event.provider_ref, expected, got: event.amount, provider: event.provider },
          'webhook amount mismatch — dibatalkan'
        )
        return reply.code(400).send({ error: 'Amount mismatch' })
      }
    }

    const ok = await queryOne('select process_topup_success($1) as ok', [topup.id])
    if (ok?.ok) {
      await sendTelegramAlert(
        `💰 Top up PAID: ${event.provider_ref} — ${Number(topup.credits).toLocaleString('id-ID')} credit`
      )
    }
    return reply.code(200).send({ ok: true })
  }

  app.register(async function webhookScope(scope) {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body)
    )
    scope.post('/api/topup/webhook/generic', {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    }, handleWebhook)
    scope.post('/api/topup/webhook/tripay', {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    }, handleWebhook)
  })
}
