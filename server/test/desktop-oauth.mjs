// Test helper OAuth desktop: state HMAC, PKCE, validasi loopback.
// Jalankan: node test/desktop-oauth.mjs
import assert from 'node:assert'
import { signState, verifyState, parseLoopbackRedirect } from '../src/routes/authRoutes.js'

process.env.JWT_SECRET ??= 'test-secret'

// State: roundtrip + tamper + expiry
const s = signState({ redirect_uri: 'https://api/callback', loopback: 'http://127.0.0.1:49152/callback', verifier: 'v', iat: Date.now() })
assert.equal(verifyState(s).loopback, 'http://127.0.0.1:49152/callback')
assert.equal(verifyState(s + 'x'), null, 'tampered state harus ditolak')
assert.equal(verifyState(signState({ iat: Date.now() - 11 * 60 * 1000 })), null, 'state kedaluwarsa harus ditolak')
assert.equal(verifyState('bukan.state'), null)

// Loopback: valid & invalid
assert.ok(parseLoopbackRedirect('http://127.0.0.1:49152/callback'))
assert.ok(parseLoopbackRedirect('http://localhost:8080/cb'))
assert.equal(parseLoopbackRedirect('https://evil.com/cb'), null, 'https ditolak')
assert.equal(parseLoopbackRedirect('http://evil.com/cb'), null, 'host non-loopback ditolak')
assert.equal(parseLoopbackRedirect('http://127.0.0.1:0/cb'), null, 'port 0 ditolak')
assert.equal(parseLoopbackRedirect('bukan-url'), null)

console.log('desktop-oauth: semua test lulus')
