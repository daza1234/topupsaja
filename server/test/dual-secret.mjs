// Self-check: dual-secret JWT verifikasi (jalankan: node test/dual-secret.mjs)
import assert from 'node:assert'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { verifySessionToken } from '../src/plugins/auth.js'

process.env.JWT_SECRET = 'new-secret'
process.env.JWT_SECRET_OLD = 'old-secret'
const { config } = await import('../src/config.js')

const app = Fastify()
await app.register(jwt, { secret: config.jwtSecret })
await app.ready()

// Token lama (secret lama) masih diterima
const oldToken = app.jwt.sign({ sub: 'u1' }, { sign: { key: 'old-secret' } })
assert.equal(verifySessionToken(app.jwt, oldToken).sub, 'u1')

// Token baru (secret baru) diterima
const newToken = app.jwt.sign({ sub: 'u2' })
assert.equal(verifySessionToken(app.jwt, newToken).sub, 'u2')

// Token sampah ditolak
assert.throws(() => verifySessionToken(app.jwt, 'a.b.c'))

console.log('dual-secret: OK')
