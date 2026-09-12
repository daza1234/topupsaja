import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { query, queryOne } from '../db.js'

const PREFIX = 'sk-ts-'

function randomKey() {
  return crypto.randomBytes(24).toString('base64url') // 32 char, URL-safe
}

export function displayPrefix(fullKey) {
  return fullKey.slice(0, PREFIX.length + 6)
}

/** Generate key baru. Full key HANYA dikembalikan sekali di sini. */
export async function createApiKey(userId, label = 'default') {
  const full = PREFIX + randomKey()
  const hash = await bcrypt.hash(full, 10)
  const prefix = displayPrefix(full)

  const row = await queryOne(
    `insert into api_keys (user_id, key_hash, key_prefix, label)
     values ($1, $2, $3, $4)
     returning id, key_prefix, label, created_at`,
    [userId, hash, prefix, label]
  )

  return { ...row, full_key: full }
}

/** Verifikasi Bearer key → { userId, apiKeyId, rateLimitPerMin }. */
export async function verifyApiKey(rawKey) {
  if (typeof rawKey !== 'string' || !rawKey.startsWith(PREFIX) || rawKey.length < 20) {
    return null
  }
  const prefix = rawKey.slice(0, PREFIX.length + 6)

  const row = await queryOne(
    `select k.id, k.key_hash, k.rate_limit_per_min, k.is_active,
            u.id as user_id, u.email, u.is_active as user_active,
            u.balance_credits
     from api_keys k
     join users u on u.id = k.user_id
     where k.key_prefix = $1
     limit 20`,
    [prefix]
  )
  if (!row) return null

  const valid = await bcrypt.compare(rawKey, row.key_hash)
  if (!valid) return null

  // Fire-and-forget: update last_used_at tanpa pernah memblokir/menggagalkan request.
  query('update api_keys set last_used_at = now() where id = $1', [row.id]).catch(() => {})

  return {
    apiKeyId: row.id,
    keyActive: row.is_active,
    userId: row.user_id,
    email: row.email,
    userActive: row.user_active,
    balance: Number(row.balance_credits),
    rateLimitPerMin: row.rate_limit_per_min,
  }
}

export async function revokeApiKey(userId, keyId) {
  const res = await query(
    'update api_keys set is_active = false where id = $1 and user_id = $2 returning id',
    [keyId, userId]
  )
  return res.length > 0
}

export async function listApiKeys(userId) {
  return query(
    `select id, key_prefix, label, is_active, rate_limit_per_min, last_used_at, created_at
     from api_keys where user_id = $1 order by created_at desc`,
    [userId]
  )
}
