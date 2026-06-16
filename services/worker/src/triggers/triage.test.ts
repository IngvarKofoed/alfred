import { describe, expect, it } from 'vitest'
import { parseDecision } from './triage.js'

// Offline unit tests for the Tier-1 classifier reply parser. parseDecision is a pure exported
// helper — no live LLM/db. Contract: tolerate code-fence wrapping; default to ESCALATE on any
// malformed/missing decision (fail toward action — never silently swallow a real change), only
// DISMISS on an explicit, valid dismiss.

describe('parseDecision', () => {
  it('parses a bare JSON escalate decision', () => {
    const d = parseDecision('{"decision":"escalate","reason":"new invoice"}')
    expect(d.decision).toBe('escalate')
    expect(d.reason).toBe('new invoice')
    expect(d.hint).toBeUndefined()
  })

  it('parses an explicit dismiss', () => {
    const d = parseDecision('{"decision":"dismiss","reason":"just a newsletter"}')
    expect(d.decision).toBe('dismiss')
    expect(d.reason).toBe('just a newsletter')
  })

  it('strips a ```json code fence', () => {
    const d = parseDecision('```json\n{"decision":"dismiss","reason":"spam"}\n```')
    expect(d.decision).toBe('dismiss')
    expect(d.reason).toBe('spam')
  })

  it('strips a bare ``` code fence', () => {
    const d = parseDecision('```\n{"decision":"escalate","reason":"x"}\n```')
    expect(d.decision).toBe('escalate')
  })

  it('captures an advisory hint when present and trimmed', () => {
    const d = parseDecision('{"decision":"escalate","reason":"r","hint":"  reply to the client  "}')
    expect(d.hint).toBe('reply to the client')
  })

  it('omits a blank/whitespace hint', () => {
    const d = parseDecision('{"decision":"escalate","reason":"r","hint":"   "}')
    expect(d.hint).toBeUndefined()
  })

  it('defaults to escalate on malformed (non-JSON) output', () => {
    const d = parseDecision('I think you should escalate this.')
    expect(d.decision).toBe('escalate')
    expect(d.reason).toMatch(/not valid JSON/i)
  })

  it('defaults to escalate on empty output', () => {
    expect(parseDecision('').decision).toBe('escalate')
    expect(parseDecision('   ').decision).toBe('escalate')
  })

  it('defaults to escalate when the decision field is missing or unrecognized (never silently dismiss)', () => {
    expect(parseDecision('{"reason":"no decision field"}').decision).toBe('escalate')
    expect(parseDecision('{"decision":"maybe","reason":"r"}').decision).toBe('escalate')
    expect(parseDecision('{"decision":42}').decision).toBe('escalate')
  })

  it('only DISMISS on the exact literal — anything else escalates', () => {
    // A malformed value that isn't exactly "dismiss" must fail toward action.
    expect(parseDecision('{"decision":"DISMISS"}').decision).toBe('escalate')
    expect(parseDecision('{"decision":"dismiss "}').decision).toBe('escalate')
  })

  it('tolerates a non-string reason (defaults to empty)', () => {
    const d = parseDecision('{"decision":"dismiss","reason":123}')
    expect(d.decision).toBe('dismiss')
    expect(d.reason).toBe('')
  })
})
