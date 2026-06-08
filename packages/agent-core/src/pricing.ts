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
  // Flat charge per output image (USD). Set only for models that bill per image and report
  // no output tokens (Imagen); when set, computeCostUsd prices output as images * this rate
  // instead of completionTokens * outputPerMTok.
  perImageOutput?: number
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  'gemini-2.5-flash': { inputPerMTok: 0.3, cachedInputPerMTok: 0.03, outputPerMTok: 2.5 },
  // Gemini-native image models ("Nano Banana"). These bill image output per TOKEN — the
  // generateContent response reports the image's token count in candidatesTokenCount (~1290
  // tokens per 1K image on 2.5; more at higher resolution, so cost scales for free), so the
  // standard token formula prices them correctly with these rates.
  'gemini-2.5-flash-image': { inputPerMTok: 0.3, cachedInputPerMTok: 0.03, outputPerMTok: 30.0 },
  // cached rates below are best-effort ~10% of input (not separately confirmed).
  'gemini-3.1-flash-image': { inputPerMTok: 0.5, cachedInputPerMTok: 0.05, outputPerMTok: 60.0 },
  'gemini-3-pro-image': { inputPerMTok: 2.0, cachedInputPerMTok: 0.2, outputPerMTok: 120.0 },
  // Imagen 4 models bill a FLAT charge per image and report no token usage, hence zero token
  // rates and a perImageOutput charge that computeCostUsd uses via its images argument.
  'imagen-4.0-fast-generate-001': { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0, perImageOutput: 0.02 },
  'imagen-4.0-generate-001': { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0, perImageOutput: 0.04 },
  'imagen-4.0-ultra-generate-001': { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0, perImageOutput: 0.06 },
}

// Cost in USD for one call. `cachedTokens` is the subset of `promptTokens` served from
// context cache (billed at the cheaper cached rate); the rest bill at full input rate.
// `images` is the output-image count, used only for flat-per-image models (perImageOutput
// set); for everything else output bills via completionTokens. Unknown model → 0, so a
// missing price surfaces as a visible gap (cost reads 0) rather than a confidently wrong number.
export function computeCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
  images = 0,
): number {
  const price = MODEL_PRICING[model]
  if (!price) return 0
  const cached = Math.min(cachedTokens, promptTokens) // guard against bad inputs
  const fullInput = promptTokens - cached
  const inputCost = (fullInput / 1e6) * price.inputPerMTok + (cached / 1e6) * price.cachedInputPerMTok
  // Flat per-image output for models that report no tokens (Imagen); token-based otherwise.
  const outputCost =
    price.perImageOutput !== undefined
      ? images * price.perImageOutput
      : (completionTokens / 1e6) * price.outputPerMTok
  return inputCost + outputCost
}
