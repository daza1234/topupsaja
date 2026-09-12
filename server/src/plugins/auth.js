import fp from 'fastify-plugin'
import crypto from 'node:crypto'
import { verifyApiKey } from '../lib/keys.js'
import { queryOne } from '../db.js'

/** Baca token sesi dari cookie httpOnly `ts_token` (fallback: Authorization header). */
export function getSessionToken(request) {
  const cookie = request.headers.cookie ?? ''
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === 'ts_token') {
      return decodeURIComponent(part.slice(idx + 1).trim())
    }
  }
  const header = request.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

export default fp(async (app) => {
  // ── API key user (Authorization: Bearer sk-ts-...) ──
  app.decorate('authenticateApiKey', async (request, reply) => {
    const header = request.headers.authorization ?? ''
    const raw = header.startsWith('Bearer ') ? header.slice(7) : ''
    const info = await verifyApiKey(raw)
    if (!info) {
      return reply.code(401).send({
        error: { message: 'Invalid API key', type: 'invalid_request_error' },
      })
    }
    if (!info.userActive || !info.keyActive) {
      return reply.code(403).send({
        error: { message: 'Account or key disabled', type: 'invalid_request_error' },
      })
    }
    request.authInfo = info
  })

  // ── Session (dashboard): opaque token per perangkat, fallback JWT legacy ──
  app.decorate('authenticateSession', async (request, reply) => {
    const token = getSessionToken(request)
    if (!token) return reply.code(401).send({ error: 'Unauthorized' })

    // JWT legacy (3 segmen): verifikasi seperti sebelumnya, tanpa sesi DB
    if ((token.match(/\./g) ?? []).length === 2) {
      try {
        request.user = app.jwt.verify(token)
      } catch {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
      const user = await queryOne(
        'select id, email, role, balance_credits, is_active from users where id = $1',
        [request.user.sub]
      )
      if (!user || !user.is_active) {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
      request.userRow = user
      request.sessionId = null
      return
    }

    // Token sesi opaque: lookup berdasarkan sha256 hash
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const row = await queryOne(
      `select s.id as session_id, s.last_used_at, s.expires_at, s.revoked_at,
              u.id, u.email, u.role, u.balance_credits, u.is_active
       from sessions s
       join users u on u.id = s.user_id
       where s.token_hash = $1`,
      [tokenHash]
    )
    if (!row || !row.is_active || row.expires_at <= new Date() || row.revoked_at !== null) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    // Update last_used_at maksimal sekali per jam (hindari write per request)
    if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 3600_000) {
      await query('update sessions set last_used_at = now() where id = $1', [row.session_id])
    }
    request.user = { sub: row.id }
    request.userRow = { id: row.id, email: row.email, role: row.role, balance_credits: row.balance_credits, is_active: row.is_active }
    request.sessionId = row.session_id
  })

  app.decorate('requireAdmin', async (request, reply) => {
    if (request.userRow?.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin only' })
    }
  })
})
