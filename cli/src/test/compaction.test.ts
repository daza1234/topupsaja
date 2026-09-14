import '../bootstrap.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, messagesTokens, cheapestModel, contextWindowFor } from '@topupsaja/core/session/compaction.js'
import type { ModelInfo } from '@topupsaja/core/api.js'
import type { ChatMessage } from '@topupsaja/core/api.js'

test('estimateTokens: chars/4 dibulatkan ke atas', () => {
  assert.equal(estimateTokens(0), 0)
  assert.equal(estimateTokens(1), 1)
  assert.equal(estimateTokens(8), 2)
  assert.equal(estimateTokens(9), 3)
})

test('messagesTokens: menghitung konten + tool_calls + overhead', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'abcd' }, // 4 + overhead 7+8 = 19 → 5 tok
    { role: 'user', content: '12345678' }, // 8 + 8+8 = 24 → 6 tok
  ]
  const withTools: ChatMessage[] = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
  ]
  assert.ok(messagesTokens(msgs) > 0)
  assert.ok(messagesTokens(withTools) >= estimateTokens(JSON.stringify(withTools[0].tool_calls).length))
})

test('cheapestModel: sort by pricing.output, fallback ke fallback', () => {
  const models = [
    { id: 'a', pricing: { input: 1, output: 5, cache: 0, unit: 'x' } },
    { id: 'b', pricing: { input: 1, output: 2, cache: 0, unit: 'x' } },
  ] as unknown as ModelInfo[]
  assert.equal(cheapestModel(models, 'fb'), 'b')
  assert.equal(cheapestModel([], 'fb'), 'fb')
})

test('contextWindowFor: null bila model tidak ditemukan', () => {
  assert.equal(contextWindowFor([], 'x'), null)
})
