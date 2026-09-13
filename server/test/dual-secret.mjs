// Self-check: dual-secret JWT verifikasi (jalankan: node test/dual-secret.mjs)
import assert from 'node:assert'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { createSigner } from 'fast-jwt'

process.env.JWT_SECRET = 'new-secret'
process.env.JWT_SECRET_OLD = 'old-secret'
const { config } = await import('../src/config.js')
const { verifySessionToken } = await import('../src/plugins/auth.js')

const app = Fastify()
await app.register(jwt, { secret: config.jwtSecret })
await app.ready()

// Token lama (sign fast-jwt dengan secret lama) masih diterima
const oldToken = createSigner({ key: 'old-secret' })({ sub: 'u1' })
assert.equal(verifySessionToken(app.jwt, oldToken).sub, 'u1')

// Token baru (secret baru) diterima
assert.equal(verifySessionToken(app.jwt, app.jwt.sign({ sub: 'u2' })).sub, 'u2')

// Token sampah & secret salah ditolak
assert.throws(() => verifySessionToken(app.jwt, 'a.b.c'))
assert.throws(() => verifySessionToken(app.jwt, createSigner({ key: 'wrong' })({ sub: 'x' })))

console.log('dual-secret: OK')
