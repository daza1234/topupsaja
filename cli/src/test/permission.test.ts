import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PermissionManager, simpleDiff } from '../agent/permission.js'
import {
  loadPermissionRules,
  decideRule,
  rulesSummary,
  derivePatternFromCommand,
  savePatternRule,
  type PermissionRule,
} from '../agent/rules.js'

test('permission ask: write/edit/bash tanya, read-only bebas', () => {
  const pm = new PermissionManager('ask')
  assert.equal(pm.needsAsk('read_file'), false)
  assert.equal(pm.needsAsk('glob'), false)
  assert.equal(pm.needsAsk('grep'), false)
  assert.equal(pm.needsAsk('todo_write'), false)
  assert.equal(pm.needsAsk('write_file'), true)
  assert.equal(pm.needsAsk('edit_file'), true)
  assert.equal(pm.needsAsk('bash'), true)
  assert.equal(pm.needsAsk('task'), false) // subagent read-only
})

test('permission auto-edit: write/edit otomatis, bash tanya', () => {
  const pm = new PermissionManager('auto-edit')
  assert.equal(pm.needsAsk('write_file'), false)
  assert.equal(pm.needsAsk('edit_file'), false)
  assert.equal(pm.needsAsk('bash'), true)
})

test('permission yolo: semua otomatis', () => {
  const pm = new PermissionManager('yolo')
  for (const t of ['bash', 'write_file', 'edit_file', 'read_file']) {
    assert.equal(pm.needsAsk(t), false)
  }
})

test('allowlist menang atas mode', () => {
  const pm = new PermissionManager('ask', ['bash'])
  assert.equal(pm.needsAsk('bash'), false)
  assert.equal(pm.needsAsk('write_file'), true)
})

test('tool MCP diklasifikasi seperti bash (approval + bisa allowlist)', () => {
  const pm = new PermissionManager('ask')
  assert.equal(pm.needsAsk('mcp__srv__tool'), true)
  const pmAuto = new PermissionManager('auto-edit')
  assert.equal(pmAuto.needsAsk('mcp__srv__tool'), true)
  const pmYolo = new PermissionManager('yolo')
  assert.equal(pmYolo.needsAsk('mcp__srv__tool'), false)
  const pmAllow = new PermissionManager('ask', ['mcp__srv__tool'])
  assert.equal(pmAllow.needsAsk('mcp__srv__tool'), false)
})

test('simpleDiff: menandai baris - dan +', () => {
  const d = simpleDiff('a\nb\nc', 'a\nx\nc')
  assert.ok(d.split('\n').some((l) => l.startsWith('- b')))
  assert.ok(d.split('\n').some((l) => l.startsWith('+ x')))
})

test('simpleDiff: identik → kosong', () => {
  assert.equal(simpleDiff('sama', 'sama'), '')
})

// ── decide() — matriks keputusan granular ──

function pm(mode: ConstructorParameters<typeof PermissionManager>[0], rules: PermissionRule[] = []) {
  return new PermissionManager(mode, [], rules, '/proj')
}

test('decide: precedence deny > ask > allow', () => {
  const rules: PermissionRule[] = [
    { tool: 'bash', pattern: 'npm *', action: 'allow', origin: 'project' },
    { tool: 'bash', pattern: 'npm *', action: 'ask', origin: 'project' },
    { tool: 'bash', pattern: 'npm *', action: 'deny', origin: 'project' },
  ]
  const d = pm('ask', rules).decide('bash', { command: 'npm install' }, { readOnlyMode: false })
  assert.equal(d, 'deny')

  const d2 = pm('ask', rules.slice(0, 2)).decide('bash', { command: 'npm install' }, { readOnlyMode: false })
  assert.equal(d2, 'ask')
})

test('decide: rule allow bypass approval untuk command risky (mode ask)', () => {
  const rules: PermissionRule[] = [
    { tool: 'bash', pattern: 'npm *', action: 'allow', origin: 'project' },
  ]
  // `npm install` klasifikasi risky (bukan safe list) — rule allow tetap melewati approval.
  assert.equal(pm('ask', rules).decide('bash', { command: 'npm install' }, { readOnlyMode: false }), 'allow')
})

test('decide: rule allow TIDAK membuka classifyBash deny', () => {
  const rules: PermissionRule[] = [
    { tool: 'bash', pattern: '*', action: 'allow', origin: 'project' },
  ]
  assert.equal(pm('yolo', rules).decide('bash', { command: 'sudo echo hi' }, { readOnlyMode: false }), 'deny')
})

test('decide: rule ask memaksa approval walau mode yolo', () => {
  const rules: PermissionRule[] = [
    { tool: 'bash', pattern: 'curl *', action: 'ask', origin: 'project' },
  ]
  assert.equal(pm('yolo', rules).decide('bash', { command: 'curl example.com' }, { readOnlyMode: false }), 'ask')
  // tanpa rule match → yolo tetap allow
  assert.equal(pm('yolo', rules).decide('bash', { command: 'make build' }, { readOnlyMode: false }), 'allow')
})

test('decide: rule TIDAK menimpa gate read-only mode', () => {
  const rules: PermissionRule[] = [
    { tool: 'write_file', pattern: '*', action: 'allow', origin: 'project' },
    { tool: 'bash', pattern: '*', action: 'allow', origin: 'project' },
  ]
  const manager = pm('yolo', rules)
  assert.equal(manager.decide('write_file', { path: 'a.ts' }, { readOnlyMode: true }), 'deny')
  assert.equal(manager.decide('bash', { command: 'ls' }, { readOnlyMode: true }), 'deny')
  // tool komunikasi tetap boleh di read-only
  assert.equal(manager.decide('ask_user', {}, { readOnlyMode: true }), 'allow')
})

test('decide: deny rule pada write_file path glob', () => {
  const rules: PermissionRule[] = [
    { tool: 'write_file', pattern: '*.env*', action: 'deny', origin: 'project' },
  ]
  const manager = pm('yolo', rules)
  assert.equal(manager.decide('write_file', { path: '.env' }, { readOnlyMode: false }), 'deny')
  assert.equal(manager.decide('write_file', { path: 'app.env.local' }, { readOnlyMode: false }), 'deny')
  // `*` tidak melewati slash → nested tidak kena rule ini
  assert.equal(manager.decide('write_file', { path: 'config/app.env' }, { readOnlyMode: false }), 'allow')
  assert.equal(manager.decide('write_file', { path: 'src/a.ts' }, { readOnlyMode: false }), 'allow')

  // `**` untuk path nested
  const nested: PermissionRule[] = [
    { tool: 'write_file', pattern: '**/*.env*', action: 'deny', origin: 'project' },
  ]
  const n = pm('yolo', nested)
  assert.equal(n.decide('write_file', { path: 'config/app.env' }, { readOnlyMode: false }), 'deny')
  assert.equal(n.decide('write_file', { path: 'src/a.ts' }, { readOnlyMode: false }), 'allow')
})

test('decide: perilaku mode lama tanpa rule tetap sama', () => {
  const askPm = pm('ask')
  assert.equal(askPm.decide('write_file', { path: 'a.ts' }, { readOnlyMode: false }), 'ask')
  assert.equal(askPm.decide('bash', { command: 'npm install' }, { readOnlyMode: false }), 'ask')
  assert.equal(askPm.decide('bash', { command: 'ls -la' }, { readOnlyMode: false }), 'allow')
  assert.equal(askPm.decide('read_file', { path: 'a.ts' }, { readOnlyMode: false }), 'allow')
  assert.equal(askPm.decide('mcp__srv__tool', {}, { readOnlyMode: false }), 'ask')

  const auto = pm('auto-edit')
  assert.equal(auto.decide('edit_file', { path: 'a.ts' }, { readOnlyMode: false }), 'allow')
  assert.equal(auto.decide('bash', { command: 'make x' }, { readOnlyMode: false }), 'ask')
})

test('decide: allowlist per-tool masih jalan, deny rule menang atas allowlist', () => {
  const rules: PermissionRule[] = [
    { tool: 'bash', pattern: 'rm *', action: 'deny', origin: 'project' },
  ]
  const manager = new PermissionManager('ask', ['bash'], rules, '/proj')
  assert.equal(manager.decide('bash', { command: 'make x' }, { readOnlyMode: false }), 'allow')
  assert.equal(manager.decide('bash', { command: 'rm -rf build' }, { readOnlyMode: false }), 'deny')
})

// ── loadPermissionRules: merge global + project, tie → project menang, invalid di-skip ──

function writeSettings(home: string, proj: string, globalPerms: unknown, projectPerms: unknown): void {
  fs.mkdirSync(path.join(home, '.topupsaja'), { recursive: true })
  fs.mkdirSync(path.join(proj, '.tsa'), { recursive: true })
  fs.writeFileSync(path.join(home, '.topupsaja', 'settings.json'), JSON.stringify({ permissions: globalPerms }))
  fs.writeFileSync(path.join(proj, '.tsa', 'settings.json'), JSON.stringify({ permissions: projectPerms }))
}

test('loadPermissionRules: global + project termuat, project setelah global (tie → project)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-rules-'))
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-rules-p-'))
  const oldHome = process.env.HOME
  process.env.HOME = home
  try {
    writeSettings(
      home,
      proj,
      [{ tool: 'bash', pattern: 'npm *', action: 'allow' }],
      [{ tool: 'bash', pattern: 'npm *', action: 'ask' }]
    )
    const { rules, errors } = loadPermissionRules(proj)
    assert.deepEqual(errors, [])
    assert.equal(rules.length, 2)
    assert.equal(rules[0].origin, 'global')
    assert.equal(rules[1].origin, 'project')
    // tie-break/precedence: ask(project) > allow(global) → ask
    const d = decideRule(rules, 'bash', { command: 'npm install' }, proj)
    assert.equal(d, 'ask')

    // deny(global) tidak bisa diluberkan allow(project)
    writeSettings(
      home,
      proj,
      [{ tool: 'write_file', pattern: '*.env*', action: 'deny' }],
      [{ tool: 'write_file', pattern: '*', action: 'allow' }]
    )
    const again = loadPermissionRules(proj)
    assert.equal(again.errors.length, 0)
    assert.equal(decideRule(again.rules, 'write_file', { path: '.env' }, proj), 'deny')
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(proj, { recursive: true, force: true })
  }
})

test('loadPermissionRules: rule invalid di-skip + error dikumpulkan, file hilang → kosong', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-rules-bad-'))
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-rules-bad-p-'))
  const oldHome = process.env.HOME
  process.env.HOME = home
  try {
    writeSettings(
      home,
      proj,
      'bukan array',
      [
        { tool: 'bash', pattern: 'npm *', action: 'allow' }, // valid
        { pattern: 'x', action: 'allow' }, // tanpa tool
        { tool: 'bash', action: 'maybe' }, // action invalid
        { tool: 'bash', pattern: 42, action: 'allow' }, // pattern bukan string
        'bukan object',
      ]
    )
    const { rules, errors } = loadPermissionRules(proj)
    assert.equal(rules.length, 1)
    assert.equal(rules[0].action, 'allow')
    assert.equal(errors.length, 5)
    // JSON rusak → hanya error, tanpa rule, tanpa throw
    fs.writeFileSync(path.join(proj, '.tsa', 'settings.json'), '{belum selesai')
    const broken = loadPermissionRules(proj)
    assert.equal(broken.rules.length, 0)
    assert.ok(broken.errors.length >= 1)

    // tanpa file sama sekali → kosong tanpa error
    fs.rmSync(path.join(home, '.topupsaja'), { recursive: true, force: true })
    fs.rmSync(path.join(proj, '.tsa'), { recursive: true, force: true })
    const empty = loadPermissionRules(proj)
    assert.deepEqual(empty, { rules: [], errors: [] })
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(proj, { recursive: true, force: true })
  }
})

test('rulesSummary: kosong & berisi count + contoh', () => {
  assert.equal(rulesSummary([]), 'tanpa aturan granular')
  const s = rulesSummary([
    { tool: 'bash', pattern: 'npm *', action: 'ask', origin: 'project' },
    { tool: 'write_file', pattern: '*.env*', action: 'deny', origin: 'project' },
    { tool: 'mcp__x__*', pattern: '*', action: 'allow', origin: 'global' },
  ])
  assert.ok(s.includes('3 aturan'))
  assert.ok(s.includes('deny 1'))
  assert.ok(s.includes('ask 1'))
  assert.ok(s.includes('allow 1'))
  assert.ok(s.includes('ask bash npm *'))
  assert.ok(s.includes('allow mcp__x__*'))
})

// ── Precedence v2: deny absolut > spesifisitas > ask > allow; tie → project ──

test('precedence v2: allow spesifik menimpa ask luas', () => {
  const rules: PermissionRule[] = [
    { tool: 'bash', pattern: '*', action: 'ask', origin: 'project' },
    { tool: 'bash', pattern: 'npm install*', action: 'allow', origin: 'project' },
  ]
  const d = decideRule(rules, 'bash', { command: 'npm install foo' }, '/proj')
  assert.equal(d, 'allow')
  // command lain tetap kena ask luas
  assert.equal(decideRule(rules, 'bash', { command: 'make x' }, '/proj'), 'ask')
})

test('precedence v2: ask spesifik menimpa allow luas', () => {
  const rules: PermissionRule[] = [
    { tool: 'bash', pattern: 'npm *', action: 'allow', origin: 'project' },
    { tool: 'bash', pattern: 'npm publish*', action: 'ask', origin: 'project' },
  ]
  assert.equal(decideRule(rules, 'bash', { command: 'npm publish' }, '/proj'), 'ask')
  assert.equal(decideRule(rules, 'bash', { command: 'npm install' }, '/proj'), 'allow')
})

test('precedence v2: deny absolut menang dari rule spesifik mana pun', () => {
  const rules: PermissionRule[] = [
    { tool: 'bash', pattern: 'npm install *very*specific*', action: 'allow', origin: 'project' },
    { tool: 'bash', pattern: '*', action: 'deny', origin: 'project' },
  ]
  assert.equal(decideRule(rules, 'bash', { command: 'npm install very specific thing' }, '/proj'), 'deny')
})

test('precedence v2: tie (pattern identik) → ask > allow', () => {
  const rules: PermissionRule[] = [
    { tool: 'bash', pattern: 'npm *', action: 'allow', origin: 'project' },
    { tool: 'bash', pattern: 'npm *', action: 'ask', origin: 'project' },
  ]
  assert.equal(decideRule(rules, 'bash', { command: 'npm x' }, '/proj'), 'ask')
})

test('precedence v2: tie penuh → project > global', () => {
  const rules: PermissionRule[] = [
    { tool: 'bash', pattern: 'npm *', action: 'allow', origin: 'global' },
    { tool: 'bash', pattern: 'npm *', action: 'deny', origin: 'project' },
  ]
  assert.equal(decideRule(rules, 'bash', { command: 'npm x' }, '/proj'), 'deny')
})

test('precedence v2: spesifisitas dihitung dari tool + pattern', () => {
  // tool 'mcp__srv__tool' (14 literal) + pattern '*' vs tool '*' + pattern panjang
  const rules: PermissionRule[] = [
    { tool: 'mcp__srv__tool', pattern: '*', action: 'allow', origin: 'project' },
    { tool: '*', pattern: 'mcp__srv__tool_x', action: 'ask', origin: 'project' },
  ]
  // keduanya 14 literal literal → tie → ask menang
  assert.equal(decideRule(rules, 'mcp__srv__tool_x', {}, '/proj'), 'ask')
})

// ── derivePatternFromCommand & savePatternRule ──

test('derivePatternFromCommand: prefix tanpa spasi sebelum *', () => {
  assert.equal(derivePatternFromCommand('npm install'), 'npm install*')
  assert.equal(derivePatternFromCommand('npm install foo'), 'npm install*')
  assert.equal(derivePatternFromCommand('npm run build --x'), 'npm run*')
  assert.equal(derivePatternFromCommand('ls -la'), 'ls*')
  assert.equal(derivePatternFromCommand('FOO=1 npm install'), 'npm install*')
  assert.equal(derivePatternFromCommand('make'), 'make*')
  assert.equal(derivePatternFromCommand('   '), null)
})

test('savePatternRule: tulis project settings.json, dedup exact, fallback global', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-pattern-h-'))
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-pattern-p-'))
  const oldHome = process.env.HOME
  process.env.HOME = home
  try {
    const file = savePatternRule(proj, 'bash', 'npm install*')
    assert.ok(file)
    const saved = JSON.parse(fs.readFileSync(file!, 'utf8'))
    assert.deepEqual(saved.permissions, [{ tool: 'bash', pattern: 'npm install*', action: 'allow' }])
    // dedup: simpan lagi → tidak bertambah
    savePatternRule(proj, 'bash', 'npm install*')
    const again = JSON.parse(fs.readFileSync(file!, 'utf8'))
    assert.equal(again.permissions.length, 1)
    // project tidak bisa ditulis (settings.json jadi direktori) → fallback global
    fs.rmSync(path.join(proj, '.tsa'), { recursive: true, force: true })
    fs.mkdirSync(path.join(proj, '.tsa', 'settings.json'), { recursive: true })
    const fallback = savePatternRule(proj, 'bash', 'yarn add*')
    assert.ok(fallback)
    assert.ok(fallback!.includes('.topupsaja'))
    const globalSaved = JSON.parse(fs.readFileSync(fallback!, 'utf8'))
    assert.ok(globalSaved.permissions.some((r: { pattern: string }) => r.pattern === 'yarn add*'))
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(proj, { recursive: true, force: true })
  }
})

// ── answer(): warning always ter-bayangi rule + alwaysPattern ──

test('answer(): always di-bayangi rule ask → warning, allowlist tidak ditulis', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-ans-h-'))
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-ans-p-'))
  const oldHome = process.env.HOME
  process.env.HOME = home
  try {
    const rules: PermissionRule[] = [
      { tool: 'bash', pattern: 'npm publish*', action: 'ask', origin: 'project' },
    ]
    const pm = new PermissionManager('ask', [], rules, proj)
    const id = pm.newRequestId()
    void pm.awaitAnswer(id)
    const warning = pm.answer(id, { approved: true, always: true }, 'bash', { command: 'npm publish' })
    assert.ok(warning)
    assert.match(warning!, /tidak disimpan/)
    assert.equal(pm.allowlist.has('bash'), false)
    // rule allow match → simpan seperti biasa, return null
    const rules2: PermissionRule[] = [{ tool: 'bash', pattern: 'npm install*', action: 'allow', origin: 'project' }]
    const pm2 = new PermissionManager('ask', [], rules2, proj)
    const id2 = pm2.newRequestId()
    void pm2.awaitAnswer(id2)
    const ok = pm2.answer(id2, { approved: true, always: true }, 'bash', { command: 'npm install' })
    assert.equal(ok, null)
    assert.equal(pm2.allowlist.has('bash'), true)
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(proj, { recursive: true, force: true })
  }
})

test('answer(): alwaysPattern bash → rule allow tersimpan di project settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-ap-h-'))
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-ap-p-'))
  const oldHome = process.env.HOME
  process.env.HOME = home
  try {
    const pm = new PermissionManager('ask', [], [], proj)
    const id = pm.newRequestId()
    void pm.awaitAnswer(id)
    const msg = pm.answer(id, { approved: true, alwaysPattern: true }, 'bash', { command: 'npm run build' })
    assert.ok(msg)
    assert.match(msg!, /Rule allow dibuat/)
    assert.match(msg!, /npm run\*/)
    const saved = JSON.parse(fs.readFileSync(path.join(proj, '.tsa', 'settings.json'), 'utf8'))
    assert.deepEqual(saved.permissions, [{ tool: 'bash', pattern: 'npm run*', action: 'allow' }])
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(proj, { recursive: true, force: true })
  }
})

test('decide: deny rule pada read_file path .env (tool baca) → deny', () => {
  const rules: PermissionRule[] = [
    { tool: 'read_file', pattern: '*.env*', action: 'deny', origin: 'project' },
  ]
  const m = pm('ask', rules)
  assert.equal(m.decide('read_file', { path: '.env' }, { readOnlyMode: false }), 'deny')
  assert.equal(m.decide('read_file', { path: 'app.env.local' }, { readOnlyMode: false }), 'deny')
  assert.equal(m.decide('read_file', { path: 'a.ts' }, { readOnlyMode: false }), 'allow')
})

test('decide: deny rule web_fetch URL (block localhost)', () => {
  const rules: PermissionRule[] = [
    { tool: 'web_fetch', pattern: '**localhost**', action: 'deny', origin: 'project' },
  ]
  const m = pm('ask', rules)
  assert.equal(m.decide('web_fetch', { url: 'http://localhost:3000/api' }, { readOnlyMode: false }), 'deny')
  assert.equal(m.decide('web_fetch', { url: 'https://example.com/docs' }, { readOnlyMode: false }), 'allow')
})

