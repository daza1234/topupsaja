import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { McpConnection, loadMcpConfig, parseMcpToolName } from '../mcp/client.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-mcp-'))

// Server MCP dummy: implement initialize / tools/list / tools/call (echo).
const serverScript = path.join(tmp, 'echo-mcp.mjs')
fs.writeFileSync(
  serverScript,
  `let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id === undefined) continue;
    let result = {};
    if (msg.method === 'initialize') result = { serverInfo: { name: 'echo' } };
    else if (msg.method === 'tools/list')
      result = { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
    else if (msg.method === 'tools/call')
      result = { content: [{ type: 'text', text: 'ECHO:' + (msg.params.arguments?.text ?? '') }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`
)

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('parseMcpToolName: mcp__<server>__<tool>', () => {
  assert.deepEqual(parseMcpToolName('mcp__srv__tool'), { server: 'srv', tool: 'tool' })
  assert.deepEqual(parseMcpToolName('mcp__my__srv__tool'), { server: 'my__srv', tool: 'tool' })
  assert.equal(parseMcpToolName('read_file'), null)
  assert.equal(parseMcpToolName('mcp__onlyserver'), null)
})

test('loadMcpConfig: project config terbaca, spec tidak valid di-skip', () => {
  fs.mkdirSync(path.join(tmp, '.tsa'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, '.tsa', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        echo: { command: 'node', args: [serverScript] },
        bad: { args: [] } as unknown as { command: string },
      },
    })
  )
  const cfg = loadMcpConfig(tmp)
  assert.ok(cfg.echo, 'server echo harus ada')
  assert.equal(cfg.echo.command, 'node')
  assert.equal(cfg.bad, undefined)
})

test('McpConnection: initialize + tools/list + callTool end-to-end', async () => {
  const conn = new McpConnection('echo', { command: process.execPath, args: [serverScript] })
  await conn.connect(tmp)
  assert.equal(conn.status, 'connected', `error: ${conn.error}`)
  assert.equal(conn.tools.length, 1)
  assert.equal(conn.tools[0].name, 'echo')

  const out = await conn.callTool('echo', { text: 'halo dunia' })
  assert.equal(out, 'ECHO:halo dunia')

  conn.stop()
})
