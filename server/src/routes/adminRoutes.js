import { query, queryOne } from '../db.js'
import { addCredits } from '../lib/billing.js'
import { sendTelegramAlert } from '../lib/telegram.js'

export default async function adminRoutes(app) {
  // Semua route admin butuh session + role admin
  app.addHook('preHandler', async (request, reply) => {
    await app.authenticateSession(request, reply)
    if (reply.sent) return
    await app.requireAdmin(request, reply)
  })

  /** GET /api/admin/stats */
  app.get('/api/admin/stats', async () => {
    const totals = await queryOne(`
      select
        (select count(*)::int from users) as users,
        (select coalesce(sum(balance_credits),0)::numeric from users) as total_balance_credits,
        (select count(*)::int from topups where status = 'paid') as paid_topups,
        (select coalesce(sum(price_idr),0)::numeric from topups where status = 'paid') as revenue_idr,
        (select coalesce(sum(credits_used),0)::bigint from usage_logs
          where created_at >= now() - interval '30 days') as credits_used_30d,
        (select coalesce(sum(cost_usd),0)::numeric from usage_logs
          where created_at >= now() - interval '30 days') as cost_usd_30d
    `)
    return totals
  })

  /** GET /api/admin/users?q= */
  app.get('/api/admin/users', async (request) => {
    const q = `%${String(request.query.q ?? '').trim().toLowerCase()}%`
    return query(
      `select id, email, role, balance_credits, is_active, created_at
       from users
       where ($1 = '%%' or lower(email) like $1)
       order by created_at desc limit 100`,
      [q]
    )
  })

  /** POST /api/admin/credit — tambah/kurangi credit user manual */
  app.post('/api/admin/credit', async (request, reply) => {
    const { email, credits, note } = request.body ?? {}
    const amount = Number(credits)
    if (!email || !Number.isFinite(amount) || amount === 0) {
      return reply.code(400).send({ error: 'email dan credits (≠0) wajib diisi' })
    }
    const user = await queryOne('select id, email from users where email = $1', [
      String(email).trim().toLowerCase(),
    ])
    if (!user) return reply.code(404).send({ error: 'User tidak ditemukan' })

    if (amount > 0) {
      await addCredits(user.id, Math.round(amount))
    } else {
      // negative adjustment via deduct (safe)
      await query('select deduct_user_credits($1, $2)', [
        user.id, Math.abs(Math.round(amount)),
      ])
    }
    await sendTelegramAlert(
      `🛠️ Admin adjustment: ${user.email} ${amount > 0 ? '+' : ''}${amount} credit (${note ?? 'no note'})`
    )
    return { ok: true }
  })

  /** GET /api/admin/topups?status= */
  app.get('/api/admin/topups', async (request) => {
    const status = String(request.query.status ?? 'pending')
    return query(
      `select t.*, u.email
       from topups t join users u on u.id = t.user_id
       where ($1 = 'all' or t.status = $1)
       order by t.created_at desc limit 100`,
      [status]
    )
  })

  /** POST /api/admin/topups/:id/approve — approve manual top up */
  app.post('/api/admin/topups/:id/approve', async (request, reply) => {
    const ok = await queryOne('select process_topup_success($1) as ok', [
      request.params.id,
    ])
    if (!ok?.ok) {
      return reply.code(400).send({ error: 'Top up tidak pending / sudah diproses' })
    }
    await sendTelegramAlert(`✅ Manual top up approved: ${request.params.id}`)
    return { ok: true }
  })

  /** PATCH /api/admin/settings */
  app.patch('/api/admin/settings', async (request, reply) => {
    const entries = Object.entries(request.body ?? {})
    if (entries.length === 0) {
      return reply.code(400).send({ error: 'body berisi objek {key: value}' })
    }
    for (const [key, value] of entries) {
      await query(
        `insert into settings (key, value, updated_at) values ($1, $2::jsonb, now())
         on conflict (key) do update set value = $2::jsonb, updated_at = now()`,
        [key, JSON.stringify(value)]
      )
    }
    return { ok: true }
  })

  /** GET /api/admin/models — katalog + cost internal */
  app.get('/api/admin/models', async () => {
    return query(
      `select or_model_id, alias, tier, m_in, m_out, m_cache,
              cost_in_usd, cost_out_usd, context_window, is_active,
              fail_count, auto_disabled_at, synced_at
       from model_pricing order by tier, alias`
    )
  })

  /** PATCH /api/admin/models/:alias — override aktif/nonaktif */
  app.patch('/api/admin/models/:alias', async (request, reply) => {
    const { is_active, upstream_status } = request.body ?? {}
    const row = await queryOne(
      `update model_pricing set
         is_active = coalesce($2, is_active),
         upstream_status = coalesce($3, upstream_status),
         fail_count = case when $2 = true then 0 else fail_count end,
         auto_disabled_at = case when $2 = true then null else auto_disabled_at end
       where alias = $1
       returning alias, is_active, upstream_status, fail_count, auto_disabled_at`,
      [`ts/${request.params.alias.replace(/^ts\//, '')}`, is_active ?? null, upstream_status ?? null]
    )
    if (!row) return reply.code(404).send({ error: 'Model tidak ditemukan' })
    return row
  })
}
