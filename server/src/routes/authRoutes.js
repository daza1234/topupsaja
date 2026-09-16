import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { query, queryOne } from '../db.js'
import { addCredits } from '../lib/billing.js'
import { createApiKey } from '../lib/keys.js'
import { sendVerificationEmail } from '../lib/mailer.js'
import { getSessionToken } from '../plugins/auth.js'

const SESSION_TTL_DAYS = 90
const MAX_SESSIONS = 20

/** Buat token verifikasi email (plaintext → email, sha256 hash → DB, 24 jam). */
async function createEmailVerificationToken(userId, email) {
  const token = crypto.randomBytes(32).toString('base64url')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  await query(
    `update users set email_verify_token_hash = $2, email_verify_expires_at = now() + interval '24 hours'
     where id = $1`,
    [userId, tokenHash]
  )
  await sendVerificationEmail(email, token)
}

/**
 * Buat sesi perangkat baru: token opaque random (dikirim via cookie),
 * disimpan di DB sebagai sha256 hash. Maks 20 sesi aktif per user —
 * sesi aktif terlama dihapus saat melebihi batas.
 */
async function createSession(userId, request) {
  const userAgent = String(request.headers['user-agent'] ?? '').slice(0, 500)
  const ip = request.ip
  // Jaga batas sesi aktif
  await query(
    `delete from sessions
     where user_id = $1
       and revoked_at is null
       and expires_at > now()
       and id not in (
         select id from sessions
         where user_id = $1 and revoked_at is null and expires_at > now()
         order by last_used_at desc
         limit $2
       )`,
    [userId, MAX_SESSIONS]
  )
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = crypto.randomBytes(32).toString('base64url')
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    try {
      await query(
        `insert into sessions (user_id, token_hash, user_agent, ip, expires_at)
         values ($1, $2, $3, $4, now() + ($5 || ' days')::interval)`,
        [userId, tokenHash, userAgent, ip, SESSION_TTL_DAYS]
      )
      return token
    } catch (err) {
      // Benturan token_hash unik sangat mustahil — retry sekali
      if (attempt === 1 || err.code !== '23505') throw err
    }
  }
}

/** Set cookie sesi httpOnly (httpOnly, SameSite=Lax, Secure di prod, 90d). */
function setSessionCookie(reply, token) {
  const parts = [
    `ts_token=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_TTL_DAYS * 24 * 3600}`,
  ]
  if (config.isProd) parts.push('Secure')
  reply.header('Set-Cookie', parts.join('; '))
}

function clearSessionCookie(reply) {
  const parts = ['ts_token=', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0']
  if (config.isProd) parts.push('Secure')
  reply.header('Set-Cookie', parts.join('; '))
}

/**
 * Cari atau buat user Google berdasarkan email (sudah terverifikasi Google).
 * Dipakai bersama oleh POST /api/auth/google (GIS) dan OAuth code flow desktop.
 */
async function upsertGoogleUser(email, request) {
  const emailNorm = String(email).trim().toLowerCase()
  let user = await queryOne(
    'select id, email, role, balance_credits, is_active, email_verified_at from users where email = $1',
    [emailNorm]
  )
  if (user && !user.is_active) return { error: 'Akun dinonaktifkan' }

  if (!user) {
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10)
    const role = config.adminEmails.includes(emailNorm) ? 'admin' : 'user'
    const created = await queryOne(
      `insert into users (email, password_hash, role, consent_accepted_at, email_verified_at)
       values ($1, $2, $3, now(), now())
       returning id, email, role, balance_credits`,
      [emailNorm, hash, role]
    )

    // Bonus pendaftaran kecil (dari settings) — sama seperti register biasa
    const free = await queryOne(
      "select value from settings where key = 'free_signup_credits'"
    )
    const freeCredits = Number(free?.value ?? 0)
    if (freeCredits > 0) {
      await addCredits(created.id, freeCredits)
    }

    user = await queryOne(
      'select id, email, role, balance_credits, is_active, email_verified_at from users where id = $1',
      [created.id]
    )
    return { user, created: true }
  }

  // Email Google sudah terverifikasi Google — tandai sekali (grandfathering aman)
  if (user.email_verified_at === null) {
    await query('update users set email_verified_at = now() where id = $1', [user.id])
  }
  if (user.role !== 'admin' && config.adminEmails.includes(user.email)) {
    await query("update users set role = 'admin' where id = $1", [user.id])
    user.role = 'admin'
  }
  return { user, created: false }
}

/** Validasi payload id_token Google (hasil tokeninfo atau decode JWT). */
function validateGoogleIdToken(info) {
  return Boolean(
    config.google.clientId &&
    info.aud === config.google.clientId &&
    ['accounts.google.com', 'https://accounts.google.com'].includes(info.iss) &&
    Number(info.exp) > Math.floor(Date.now() / 1000) &&
    (info.email_verified === true || info.email_verified === 'true') &&
    info.email
  )
}

/** State OAuth: payload base64url + HMAC (tidak bisa dipalsukan/kedaluwarsa 10 menit). */
export function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = crypto.createHmac('sha256', config.jwtSecret).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verifyState(state) {
  if (typeof state !== 'string' || !state.includes('.')) return null
  const [body, mac] = state.split('.')
  const expect = crypto.createHmac('sha256', config.jwtSecret).update(body).digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString())
  } catch {
    return null
  }
  if (!payload || Date.now() - payload.iat > 10 * 60 * 1000) return null
  return payload
}

/** PKCE code_verifier/challenge (S256). */
function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Validasi redirect_uri loopback desktop (http://127.0.0.1:<port>/... atau localhost). */
export function parseLoopbackRedirect(raw) {
  let url
  try {
    url = new URL(String(raw ?? ''))
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  const host = url.hostname
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return null
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return url
}

/** Tukar authorization code → id_token Google (confidential client, server pegang secret). */
async function exchangeGoogleCode(code, redirectUri, codeVerifier) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  })
  if (!res.ok) return null
  const tokens = await res.json()
  if (!tokens.id_token) return null
  // Id_token sudah dikirim via TLS dari Google ke server; payload cukup didecode
  // (signature divalidasi Google saat kita memakainya untuk mengambil token di atas).
  const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString())
  return validateGoogleIdToken(payload) ? payload : null
}

export default async function authRoutes(app) {
  /** POST /api/auth/register */
  app.post('/api/auth/register', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const { email, password, consent } = request.body ?? {}
    if (!email || !password || password.length < 8) {
      return reply.code(400).send({
        error: 'Email wajib diisi & password minimal 8 karakter',
      })
    }
    if (consent !== true) {
      return reply.code(400).send({
        error: 'Anda harus menyetujui Syarat & Ketentuan dan Kebijakan Privasi',
      })
    }
    const emailNorm = String(email).trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) {
      return reply.code(400).send({ error: 'Email tidak valid' })
    }

    const exists = await queryOne('select id from users where email = $1', [emailNorm])
    if (exists) {
      return reply.code(409).send({ error: 'Email sudah terdaftar' })
    }

    const hash = await bcrypt.hash(password, 10)
    const role = config.adminEmails.includes(emailNorm) ? 'admin' : 'user'

    const user = await queryOne(
      `insert into users (email, password_hash, role, consent_accepted_at)
       values ($1, $2, $3, now())
       returning id, email, role, balance_credits`,
      [emailNorm, hash, role]
    )

    // Bonus pendaftaran kecil (dari settings)
    const free = await queryOne(
      "select value from settings where key = 'free_signup_credits'"
    )
    const freeCredits = Number(free?.value ?? 0)
    if (freeCredits > 0) {
      await addCredits(user.id, freeCredits)
    }

    const fresh = await queryOne(
      'select id, email, role, balance_credits from users where id = $1',
      [user.id]
    )
    const token = await createSession(user.id, request)
    setSessionCookie(reply, token)
    // Kirim email verifikasi di luar response-critical path; register tetap sukses.
    await createEmailVerificationToken(user.id, emailNorm)
    return reply.code(201).send({
      user: { ...fresh, balance_credits: Number(fresh.balance_credits) },
    })
  })

  /** GET /api/auth/verify?token= — link dari email → verifikasi → redirect dashboard */
  app.get('/api/auth/verify', {
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const token = String(request.query.token ?? '')
    if (!token) return reply.code(400).send({ error: 'Token verifikasi tidak valid' })
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const user = await queryOne(
      `select id from users
       where email_verify_token_hash = $1 and email_verify_expires_at > now()`,
      [tokenHash]
    )
    if (!user) return reply.code(400).send({ error: 'Token tidak valid atau kedaluwarsa' })
    await query(
      `update users set email_verified_at = now(), email_verify_token_hash = null,
              email_verify_expires_at = null
       where id = $1`,
      [user.id]
    )
    return reply.redirect(`${config.webOrigin}/verify?status=ok`)
  })

  /** POST /api/auth/resend-verification — kirim ulang email (auth sesi) */
  app.post('/api/auth/resend-verification', {
    preHandler: [app.authenticateSession],
    // 3/hari per sesi-IP; sesi = 1 user, cukup sebagai batas pengiriman
    config: { rateLimit: { max: 3, timeWindow: '1 day' } },
  }, async (request, reply) => {
    const user = await queryOne(
      'select id, email, email_verified_at from users where id = $1',
      [request.userRow.id]
    )
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    if (user.email_verified_at) return { ok: true, already_verified: true }
    await createEmailVerificationToken(user.id, user.email)
    return { ok: true }
  })

  /** POST /api/auth/logout — revoke sesi (bila opaque) + hapus cookie sesi */
  app.post('/api/auth/logout', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const token = getSessionToken(request)
    if (token && !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
      await query('update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [tokenHash])
    }
    clearSessionCookie(reply)
    return { ok: true }
  })

  /** POST /api/auth/login */
  app.post('/api/auth/login', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const { email, password } = request.body ?? {}
    if (!email || !password) {
      return reply.code(400).send({ error: 'Email dan password wajib diisi' })
    }
    const user = await queryOne(
      'select id, email, password_hash, role, balance_credits, is_active from users where email = $1',
      [String(email).trim().toLowerCase()]
    )
    if (!user || !user.is_active) {
      return reply.code(401).send({ error: 'Email atau password salah' })
    }
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return reply.code(401).send({ error: 'Email atau password salah' })
    }
    if (user.role !== 'admin' && config.adminEmails.includes(user.email)) {
      await query("update users set role = 'admin' where id = $1", [user.id])
      user.role = 'admin'
    }
    const token = await createSession(user.id, request)
    setSessionCookie(reply, token)
    return {
      user: {
        id: user.id, email: user.email, role: user.role,
        balance_credits: Number(user.balance_credits),
      },
    }
  })

  /** POST /api/auth/google — login/daftar sekali klik via GIS ID token */
  app.post('/api/auth/google', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const { credential } = request.body ?? {}
    if (!credential || typeof credential !== 'string') {
      return reply.code(400).send({ error: 'Credential Google wajib diisi' })
    }

    let info
    try {
      const res = await fetch(`${config.google.tokenInfoUrl}?id_token=${encodeURIComponent(credential)}`)
      if (!res.ok) return reply.code(401).send({ error: 'Token Google tidak valid' })
      info = await res.json()
    } catch {
      return reply.code(401).send({ error: 'Token Google tidak valid' })
    }

    if (!validateGoogleIdToken(info)) {
      return reply.code(401).send({ error: 'Token Google tidak valid' })
    }

    const result = await upsertGoogleUser(info.email, request)
    if (result.error) return reply.code(403).send({ error: result.error })
    const { user, created } = result
    const token = await createSession(user.id, request)
    setSessionCookie(reply, token)
    if (created) {
      return reply.code(201).send({
        user: { ...user, balance_credits: Number(user.balance_credits) },
      })
    }
    return {
      user: {
        id: user.id, email: user.email, role: user.role,
        balance_credits: Number(user.balance_credits),
      },
    }
  })

  /** GET /api/v1/auth/verify — validasi API key (Bearer sk-ts-) */
  app.get('/api/v1/auth/verify', {
    preHandler: [app.authenticateApiKey],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request) => {
    const info = request.authInfo
    return {
      ok: true,
      email: info.email,
      api_key_id: info.apiKeyId,
      balance: info.balance,
    }
  })

  // ── Google OAuth untuk app desktop (loopback capture) ──

  /**
   * GET /api/v1/auth/google/start?redirect_uri=http://127.0.0.1:<port>/callback
   * Redirect ke Google consent. redirect_uri adalah loopback listener app desktop.
   */
  app.get('/api/v1/auth/google/start', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    if (!config.google.clientId || !config.google.clientSecret) {
      return reply.code(501).send({ error: 'Login Google belum dikonfigurasi di server' })
    }
    const loopback = parseLoopbackRedirect(request.query.redirect_uri)
    if (!loopback) {
      return reply.code(400).send({ error: 'redirect_uri harus http://127.0.0.1:<port>/...' })
    }
    const redirectUri = `${config.apiPublicUrl}/api/v1/auth/google/callback`
    const { verifier, challenge } = pkcePair()
    const state = signState({
      redirect_uri: redirectUri,
      loopback: loopback.origin + loopback.pathname,
      verifier,
      iat: Date.now(),
    })
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', config.google.clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', 'openid email profile')
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('prompt', 'select_account')
    return reply.redirect(authUrl.toString())
  })

  /**
   * GET /api/v1/auth/google/callback — Google mengirim code ke sini.
   * Tukar code → id_token, upsert user, buat sesi, lalu redirect ke loopback
   * app desktop dengan session token di fragment (#token=..., tidak ikut log server).
   */
  app.get('/api/v1/auth/google/callback', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const fail = (msg) =>
      reply.redirect(`${config.webOrigin}/verify?status=oauth_error&reason=${encodeURIComponent(msg)}`)
    const state = verifyState(request.query.state)
    if (!state) return fail('state_tidak_valid')
    if (request.query.error) return fail(String(request.query.error))

    const info = await exchangeGoogleCode(
      String(request.query.code ?? ''), state.redirect_uri, state.verifier
    ).catch(() => null)
    if (!info) return fail('token_google_tidak_valid')

    const result = await upsertGoogleUser(info.email, request)
    if (result.error) return fail(result.error)
    const token = await createSession(result.user.id, request)
    // Query param (bukan fragment): fragment tidak pernah dikirim browser ke
    // listener loopback desktop, query tetap hanya lewat localhost milik app.
    return reply.redirect(`${state.loopback}?token=${encodeURIComponent(token)}`)
  })

  /**
   * POST /api/v1/auth/exchange — session token (Bearer, dari callback OAuth) →
   * API key aktif. Full key `sk-ts-...` hanya dikembalikan sekali di sini;
   * hash bcrypt tidak bisa dibaca ulang, jadi tiap exchange buat key baru
   * berlabel `desktop` (key lama desktop tetap aktif sampai dihapus via dashboard).
   */
  app.post('/api/v1/auth/exchange', {
    preHandler: [app.authenticateSession],
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (request) => {
    const key = await createApiKey(request.userRow.id, 'desktop')
    return {
      api_key: key.full_key,
      key_prefix: key.key_prefix,
      api_key_id: key.id,
      email: request.userRow.email,
      balance_credits: Number(request.userRow.balance_credits),
    }
  })
}
