import fp from 'fastify-plugin'
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

  // ── Session JWT (dashboard) ──
  app.decorate('authenticateSession', async (request, reply) => {
    try {
      await request.jwtVerify(getSessionToken(request))
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
  })

  app.decorate('requireAdmin', async (request, reply) => {
    if (request.userRow?.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin only' })
    }
  })
})
