import { query } from '../db.js'

export async function logUsage({
  userId, apiKeyId, orModelId, alias,
  promptTokens, cachedTokens, completionTokens,
  creditsUsed, costUsd, latencyMs, statusCode, estimated, errorMessage,
}) {
  await query(
    `insert into usage_logs
       (user_id, api_key_id, or_model_id, alias, prompt_tokens, cached_tokens,
        completion_tokens, credits_used, cost_usd, latency_ms, status_code, estimated, error_message)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      userId, apiKeyId, orModelId, alias,
      promptTokens ?? 0, cachedTokens ?? 0, completionTokens ?? 0,
      creditsUsed ?? 0, costUsd ?? 0, latencyMs ?? 0,
      statusCode ?? 200, estimated ?? false, errorMessage ?? null,
    ]
  )
}
