import 'dotenv/config'

function req(name, fallback = undefined) {
  const v = process.env[name] ?? fallback
  if (v === undefined) {
    throw new Error(`Missing required env: ${name}`)
  }
  return v
}

export const config = {
  port: parseInt(req('API_PORT', '3000'), 10),
  baseUrl: req('BASE_URL', 'http://localhost:3000'),
  apiPublicUrl: req('API_PUBLIC_URL', 'http://localhost:3000'),
  webUrl: process.env.WEB_URL ?? req('BASE_URL', 'http://localhost:3000'),
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',

  // Allowlist origin untuk CORS (dashboard web). Kosong di env → default prod+dev.
  corsOrigins: (
    process.env.CORS_ORIGINS ??
    'https://topupsaja.com,https://ai.topupsaja.com,https://api.topupsaja.com,http://localhost:3001,http://localhost:3000'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  databaseUrl: req('DATABASE_URL', ''),

  jwtSecret: req('JWT_SECRET', 'dev-secret-change-me'),

  openrouter: {
    apiKey: req('OPENROUTER_API_KEY', ''),
    base: req('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
    // Markup per-tier (multiplier atas cost upstream OpenRouter).
    // Margin dijual lewat harga credit (Rp per M credit) — lihat pricing.js.
    // Worst case: premium 5.0 → cost serve ≈ Rp 320/M credit (kurs 16rb).
    fees: {
      hemat: parseFloat(process.env.OPENROUTER_FEE_HEMAT ?? '7.0'),
      standar: parseFloat(process.env.OPENROUTER_FEE_STANDAR ?? '6.0'),
      premium: parseFloat(process.env.OPENROUTER_FEE_PREMIUM ?? '5.0'),
    },
    referer: req('BASE_URL', 'https://topupsaja.com'),
    title: 'TopUpSaja',
  },

  creditUsdValue: parseFloat(process.env.CREDIT_USD_VALUE ?? '0.0000001'),
  idrPerUsdFallback: parseFloat(process.env.IDR_PER_USD ?? '16000'),

  adminEmails: (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  },

  qris: {
    provider: process.env.QRIS_PROVIDER ?? 'manual',
    generic: {
      baseUrl: process.env.QRIS_GENERIC_BASE_URL ?? '',
      apiKey: process.env.QRIS_GENERIC_API_KEY ?? '',
      webhookSecret: process.env.QRIS_GENERIC_WEBHOOK_SECRET ?? '',
    },
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    tokenInfoUrl: process.env.GOOGLE_TOKENINFO_URL ?? 'https://oauth2.googleapis.com/tokeninfo',
  },

  tripay: {
    mode: process.env.TRIPAY_MODE ?? 'production',
    merchantCode: process.env.TRIPAY_MERCHANT_CODE ?? '',
    apiKey: process.env.TRIPAY_API_KEY ?? '',
    privateKey: process.env.TRIPAY_PRIVATE_KEY ?? '',
    method: process.env.TRIPAY_METHOD ?? 'QRIS2',
  },
}
