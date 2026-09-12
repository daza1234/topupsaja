import crypto from 'node:crypto'
import { config } from '../config.js'

/**
 * Provider QRIS pluggable.
 * - manual  : tanpa vendor. topup status=pending, admin approve via dashboard admin.
 * - generic : gateway QRIS pihak ketiga dengan endpoint create-invoice + webhook.
 *   Sesuaikan path/payload dengan vendor final yang Anda pilih.
 * - tripay  : QRIS2 via tripay.co.id (closed payment), QR + checkout URL otomatis.
 */

export function makeProvider() {
  if (config.qris.provider === 'tripay') {
    return tripayProvider
  }
  if (config.qris.provider === 'generic' && config.qris.generic.baseUrl) {
    return genericProvider
  }
  return manualProvider
}

/**
 * Provider Tripay (QRIS2, closed payment).
 * - Create  : POST {base}/transaction/create, Bearer API key,
 *             signature = HMAC-SHA256(merchantCode + merchantRef + amount, privateKey) hex.
 * - Webhook : header X-Callback-Signature = HMAC-SHA256(raw body JSON, privateKey) hex.
 */
const tripayProvider = {
  name: 'tripay',
  baseUrl() {
    return config.tripay.mode === 'sandbox'
      ? 'https://tripay.co.id/api-sandbox'
      : 'https://tripay.co.id/api'
  },
  async createInvoice(topup) {
    const { merchantCode, apiKey, privateKey, method } = config.tripay
    const amount = Number(topup.price_idr)
    const expiresAtUnix = topup.expires_at
      ? Math.floor(new Date(topup.expires_at).getTime() / 1000)
      : Math.floor(Date.now() / 1000) + 24 * 3600
    const signature = crypto
      .createHmac('sha256', privateKey)
      .update(`${merchantCode}${topup.provider_ref}${amount}`)
      .digest('hex')

    const res = await fetch(`${this.baseUrl()}/transaction/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        method,
        merchant_ref: topup.provider_ref,
        amount,
        customer_name: (topup.email ?? 'customer').split('@')[0],
        customer_email: topup.email ?? 'customer@topupsaja.com',
        order_items: [
          {
            name: `TopUpSaja ${topup.package_code}`,
            price: amount,
            quantity: 1,
          },
        ],
        expired_time: expiresAtUnix,
        callback_url: `${config.apiPublicUrl}/api/topup/webhook/tripay`,
        signature,
      }),
    })
    if (!res.ok) {
      throw new Error(`QRIS invoice gagal: HTTP ${res.status}`)
    }
    const data = await res.json()
    if (data?.success !== true) {
      throw new Error(`QRIS invoice gagal: ${data?.message ?? 'unknown error'}`)
    }
    return {
      payment_url: data.data?.checkout_url ?? null,
      qr_string: data.data?.qr_string || null,
    }
  },

  /**
   * Verifikasi callback Tripay: HMAC-SHA256 raw body dengan privateKey,
   * header x-callback-signature. FAILED/EXPIRED/REFUND → paid=false (diabaikan).
   */
  async verifyWebhook(req, rawBody) {
    const signature = req.headers['x-callback-signature']
    if (!signature || !config.tripay.privateKey) return null
    const expected = crypto
      .createHmac('sha256', config.tripay.privateKey)
      .update(rawBody)
      .digest('hex')
    const a = Buffer.from(String(signature))
    const b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

    const body = JSON.parse(rawBody.toString('utf8'))
    const paid = (body.status ?? '').toUpperCase() === 'PAID'
    return { provider_ref: body.merchant_ref, paid, provider: 'tripay' }
  },
}

const manualProvider = {
  name: 'manual',
  async createInvoice(topup) {
    // Tanpa vendor: user transfer/QRIS statis, lalu admin approve.
    return {
      payment_url: null,
      qr_string: null,
      instructions:
        'Scan QRIS merchant TopUpSaja / transfer sesuai nominal, lalu kirim bukti ke admin. Order Anda akan diproses otomatis setelah dikonfirmasi.',
    }
  },
  async verifyWebhook(req) {
    // Manual approval tidak lewat webhook — return null (diabaikan).
    return null
  },
}

const genericProvider = {
  name: 'generic',
  async createInvoice(topup) {
    const res = await fetch(`${config.qris.generic.baseUrl}/v1/invoices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.qris.generic.apiKey}`,
      },
      body: JSON.stringify({
        external_id: topup.provider_ref,
        amount: Number(topup.price_idr),
        description: `TopUpSaja ${topup.package_code}`,
        callback_url: `${config.apiPublicUrl}/api/topup/webhook/generic`,
        expired_at: topup.expires_at,
      }),
    })
    if (!res.ok) {
      throw new Error(`QRIS invoice gagal: HTTP ${res.status}`)
    }
    const data = await res.json()
    return {
      payment_url: data.payment_url ?? data.invoice_url ?? null,
      qr_string: data.qr_string ?? data.qr ?? null,
    }
  },

  /**
   * Verifikasi webhook generik: HMAC-SHA256 dari raw body dengan secret.
   * Sesuaikan dengan skema signature vendor final.
   */
  async verifyWebhook(req, rawBody) {
    const signature = req.headers['x-callback-signature'] ?? req.headers['x-signature']
    if (!signature || !config.qris.generic.webhookSecret) return null
    const expected = crypto
      .createHmac('sha256', config.qris.generic.webhookSecret)
      .update(rawBody)
      .digest('hex')
    const a = Buffer.from(String(signature))
    const b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

    const body = JSON.parse(rawBody.toString('utf8'))
    const ref = body.external_id ?? body.order_id ?? body.ref
    const status = (body.status ?? body.transaction_status ?? '').toLowerCase()
    const paid = ['paid', 'settlement', 'capture', 'success', 'settled'].includes(status)
    return { provider_ref: ref, paid, provider: 'generic' }
  },
}
