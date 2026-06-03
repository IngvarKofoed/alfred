import { describe, expect, it } from 'vitest'
import { computeCostUsd } from './pricing.js'

describe('computeCostUsd', () => {
  it('prices a known model from input + output tokens', () => {
    // gemini-2.5-flash: $0.30/1M in, $2.50/1M out.
    // 1000 in → 0.0003, 500 out → 0.00125, total 0.00155.
    expect(computeCostUsd('gemini-2.5-flash', 1000, 500)).toBeCloseTo(0.00155, 10)
  })

  it('bills cached prompt tokens at the cheaper cached rate', () => {
    // 1000 prompt, 600 of them cached, 500 out.
    // full input 400 → 0.00012, cached 600 → 0.000018, out 500 → 0.00125; total 0.001388.
    expect(computeCostUsd('gemini-2.5-flash', 1000, 500, 600)).toBeCloseTo(0.001388, 10)
  })

  it('clamps cachedTokens to promptTokens (bad input never inflates the discount)', () => {
    // cached > prompt: treat all prompt as cached, none at full rate.
    expect(computeCostUsd('gemini-2.5-flash', 1000, 0, 5000)).toBeCloseTo((1000 / 1e6) * 0.03, 10)
  })

  it('returns 0 for an unknown model rather than guessing', () => {
    expect(computeCostUsd('some-future-model', 1000, 500)).toBe(0)
  })

  it('is 0 when there are no tokens', () => {
    expect(computeCostUsd('gemini-2.5-flash', 0, 0)).toBe(0)
  })
})
