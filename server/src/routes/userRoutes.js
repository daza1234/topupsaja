import { query, queryOne } from '../db.js'
import { createApiKey, listApiKeys, revokeApiKey } from '../lib/keys.js'

export default async function userRoutes(app) {
  /** GET /api/me */
  app.get('/api/me', { preHandler: [app.authenticateSession] }, async (request) => {
    const u = request.userRow
    return {
      id: u.id,
      email: u.email,
      role: u.role,
      balance_credits: Number(u.balance_credits),
    }
  })

  /** GET /api/me/keys */
  app.get('/api/me/keys', { preHandler: [app.authenticateSession] }, async (request) => {
    return listApiKeys(request.userRow.id)
  })

  /** POST /api/me/keys — generate key baru (max 5 aktif) */
  app.post('/api/me/keys', { preHandler: [app.authenticateSession] }, async (request, reply) => {
    const label = String(request.body?.label ?? 'default').slice(0, 40)
    const active = await queryOne(
      'select count(*)::int as n from api_keys where user_id = $1 and is_active = true',
      [request.userRow.id]
    )
    if (active.n >= 5) {
      return reply.code(400).send({ error: 'Maksimal 5 API key aktif. Revoke dulu yang lama.' })
    }
    const key = await createApiKey(request.userRow.id, label)
    return reply.code(201).send(key)
  })

  /** DELETE /api/me/keys/:id */
  app.delete('/api/me/keys/:id', { preHandler: [app.authenticateSession] }, async (request, reply) => {
    const ok = await revokeApiKey(request.userRow.id, request.params.id)
    if (!ok) return reply.code(404).send({ error: 'Key tidak ditemukan' })
    return { ok: true }
  })

  /** GET /api/me/usage?days=7 */
  app.get('/api/me/usage', { preHandler: [app.authenticateSession] }, async (request) => {
    const days = Math.min(Math.max(parseInt(request.query.days ?? '7', 10) || 7, 1), 90)
    const summary = await query(
      'select * from get_usage_summary($1, $2)',
      [request.userRow.id, days]
    )
    const totals = await queryOne(
      `select count(*)::int as requests,
              coalesce(sum(credits_used), 0)::bigint as credits_used,
              coalesce(sum(cost_usd), 0)::numeric as cost_usd
       from usage_logs
       where user_id = $1 and created_at >= now() - ($2 || ' days')::interval`,
      [request.userRow.id, days]
    )
    return { days, totals, by_model: summary }
  })

  /** GET /api/me/topups */
  app.get('/api/me/topups', { preHandler: [app.authenticateSession] }, async (request) => {
    return query(
      `select id, package_code, credits, price_idr, status, provider,
              payment_url, qr_string, expires_at, paid_at, created_at
       from topups where user_id = $1 order by created_at desc limit 50`,
      [request.userRow.id]
    )
  })

  /** GET /api/me/sessions — daftar perangkat aktif */
  app.get('/api/me/sessions', { preHandler: [app.authenticateSession] }, async (request) => {
    return query(
      `select id, user_agent, ip, created_at, last_used_at,
              coalesce(id = $2, false) as is_current
       from sessions
       where user_id = $1 and revoked_at is null and expires_at > now()
       order by last_used_at desc`,
      [request.userRow.id, request.sessionId]
    )
  })

  /** DELETE /api/me/sessions/:id — revoke perangkat milik sendiri */
  app.delete('/api/me/sessions/:id', { preHandler: [app.authenticateSession] }, async (request, reply) => {
    const row = await queryOne(
      'update sessions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null returning id',
      [request.params.id, request.userRow.id]
    )
    if (!row) return reply.code(404).send({ error: 'Sesi tidak ditemukan' })
    return { ok: true }
  })
}
