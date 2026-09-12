import pg from 'pg'

let pool = null

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      ssl: /supabase\.(co|com)|sslmode=require/.test(process.env.DATABASE_URL ?? '')
        ? { rejectUnauthorized: false }
        : undefined,
    })
  }
  return pool
}

export function db() {
  return getPool()
}

export async function query(text, params = []) {
  const res = await getPool().query(text, params)
  return res.rows
}

export async function queryOne(text, params = []) {
  const rows = await query(text, params)
  return rows[0] ?? null
}

export async function closeDb() {
  if (pool) await pool.end()
  pool = null
}
