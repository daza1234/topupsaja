import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { query, queryOne } from '../db.js'
import { addCredits } from '../lib/billing.js'
import { getSessionToken } from '../plugins/auth.js'

const SESSION_TTL_DAYS = 90
const MAX_SESSIONS = 20

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
    return reply.code(201).send({
      user: { ...fresh, balance_credits: Number(fresh.balance_credits) },
    })
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

    if (
      !config.google.clientId ||
      info.aud !== config.google.clientId ||
      !['accounts.google.com', 'https://accounts.google.com'].includes(info.iss) ||
      !(Number(info.exp) > Math.floor(Date.now() / 1000)) ||
      info.email_verified !== 'true' ||
      !info.email
    ) {
      return reply.code(401).send({ error: 'Token Google tidak valid' })
    }
    const emailNorm = String(info.email).trim().toLowerCase()

    const user = await queryOne(
      'select id, email, role, balance_credits, is_active from users where email = $1',
      [emailNorm]
    )
    if (user && !user.is_active) {
      return reply.code(403).send({ error: 'Akun dinonaktifkan' })
    }

    if (!user) {
      const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10)
      const role = config.adminEmails.includes(emailNorm) ? 'admin' : 'user'
      const created = await queryOne(
        `insert into users (email, password_hash, role, consent_accepted_at)
         values ($1, $2, $3, now())
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

      const fresh = await queryOne(
        'select id, email, role, balance_credits from users where id = $1',
        [created.id]
      )
      const token = await createSession(created.id, request)
      setSessionCookie(reply, token)
      return reply.code(201).send({
        user: { ...fresh, balance_credits: Number(fresh.balance_credits) },
      })
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
}
