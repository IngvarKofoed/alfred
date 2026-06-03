// Model pricing — public reference data (USD per 1M tokens), keyed by model id.
// Lives in code, not .env: it's not a secret and not per-deployment (every Alfred
// install pays Google's list price), it's structured, and price changes want a
// reviewable diff + changelog entry. See ARCHITECTURE §13 (defaults-in-code layer);
// a post-MVP runtime_config table is the path to overriding without a redeploy.
//
// Sources: https://ai.google.dev/gemini-api/docs/pricing (paid tier, text).
// Output price covers thinking tokens for 2.5 models. `cachedInputPerMTok` is the
// context-cache hit rate — Gemini 2.5 caches implicitly, so cached input tokens are
// billed cheaper even without us creating an explicit cache.
//
// Deferred dimensions (not modelled until a feature needs them, per ARCHITECTURE §13's
// no-speculative-infra stance): audio input ($1.00/1M) — only with the post-MVP voice
// ingress; cache storage ($1.00/1M/hr) — only with explicit caching, which we don't use;
// image/video input share the text input rate, so no separate entry is needed.
export interface ModelPrice {
  inputPerMTok: number
  cachedInputPerMTok: number
  outputPerMTok: number
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  'gemini-2.5-flash': { inputPerMTok: 0.3, cachedInputPerMTok: 0.03, outputPerMTok: 2.5 },
}

// Cost in USD for one call. `cachedTokens` is the subset of `promptTokens` served from
// context cache (billed at the cheaper cached rate); the rest bill at full input rate.
// Unknown model → 0, so a missing price surfaces as a visible gap (cost reads 0) rather
// than a confidently wrong number.
export function computeCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
): number {
  const price = MODEL_PRICING[model]
  if (!price) return 0
  const cached = Math.min(cachedTokens, promptTokens) // guard against bad inputs
  const fullInput = promptTokens - cached
  return (
    (fullInput / 1e6) * price.inputPerMTok +
    (cached / 1e6) * price.cachedInputPerMTok +
    (completionTokens / 1e6) * price.outputPerMTok
  )
}
