import '../bootstrap.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { touchesSecretPath, touchesSecretTool } from '@topupsaja/core/agent/secrets.js'
import { PermissionManager } from '@topupsaja/core/agent/permission.js'

test('touchesSecretPath: .env & variants', () => {
  assert.equal(touchesSecretPath('cat .env'), true)
  assert.equal(touchesSecretPath('cat .env.local'), true)
  assert.equal(touchesSecretPath('cat server/.env.production'), true)
  assert.equal(touchesSecretPath('cat /opt/app/.env'), true)
  assert.equal(touchesSecretPath('grep KEY .env*'), true)
  assert.equal(touchesSecretPath('cat dotenv.md'), false)
  assert.equal(touchesSecretPath('cat env.example'), false)
  assert.equal(touchesSecretPath('cat README.md'), false)
})

test('touchesSecretPath: config CLI & settings', () => {
  assert.equal(touchesSecretPath('cat ~/.topupsaja/config.json'), true)
  assert.equal(touchesSecretPath('cat /home/u/.topupsaja/config.json'), true)
  assert.equal(touchesSecretPath('cat ~/.tsa/settings.json'), true)
  assert.equal(touchesSecretPath('ls ~/.topupsaja'), true)
  assert.equal(touchesSecretPath('cat config.json'), false)
})

test('touchesSecretTool: bash vs read_file', () => {
  assert.equal(touchesSecretTool('bash', { command: 'cat .env' }), true)
  assert.equal(touchesSecretTool('bash', { command: 'ls -la' }), false)
  assert.equal(touchesSecretTool('read_file', { path: '.env' }), true)
  assert.equal(touchesSecretTool('read_file', { path: 'README.md' }), false)
  assert.equal(touchesSecretTool('write_file', { path: '.env.local', content: 'x' }), true)
  assert.equal(touchesSecretTool('edit_file', { path: 'src/a.ts', old_string: '', new_string: '' }), false)
  assert.equal(touchesSecretTool('glob', { pattern: '.env*' }), false)
})

test('decide: secret path selalu ask, bahkan yolo & allowlist', () => {
  const pm = new PermissionManager('yolo', ['bash'], [], '/tmp')
  assert.equal(pm.decide('bash', { command: 'cat .env' }, { readOnlyMode: false }), 'ask')
  assert.equal(pm.decide('bash', { command: 'cat ~/.topupsaja/config.json' }, { readOnlyMode: false }), 'ask')
  assert.equal(pm.decide('read_file', { path: '.env.local' }, { readOnlyMode: false }), 'ask')
  // non-secret tetap jalan normal
  assert.equal(pm.decide('bash', { command: 'ls -la' }, { readOnlyMode: false }), 'allow')
})
