import { describe, expect, it } from 'vitest'
import { decideSignalChange, isDegenerateSignal, reduceSignal, stableStringify } from './gate.js'

// Offline unit tests for the Tier-0 gate's pure reducers + the monotonic no-clobber guard. No
// live tool/db: the reducers are exported so we exercise them directly on tool-result shapes.

describe('reduceSignal: maxUid', () => {
  it('finds the highest numeric uid across a named-array result (tolerant of the wrapper key)', () => {
    // CHANGELOG 34: tool results are named objects, never bare arrays — the reducer must walk
    // whatever the wrapper key is (here `messages`).
    expect(reduceSignal('maxUid', { messages: [{ uid: 3 }, { uid: 7 }, { uid: 5 }] })).toBe(7)
    expect(reduceSignal('maxUid', { emails: [{ uid: 42 }] })).toBe(42)
  })

  it('ignores non-numeric / missing uids', () => {
    expect(reduceSignal('maxUid', { messages: [{ uid: '12' }, { uid: 4 }, { id: 99 }] })).toBe(4)
    expect(reduceSignal('maxUid', { messages: [{ uid: Number.NaN }, { uid: 9 }] })).toBe(9)
  })

  it('returns null when no numeric uid exists (degenerate / empty result)', () => {
    expect(reduceSignal('maxUid', { messages: [] })).toBeNull()
    expect(reduceSignal('maxUid', { messages: [{ subject: 'x' }] })).toBeNull()
    expect(reduceSignal('maxUid', { error: 'imap not configured' })).toBeNull()
  })
})

describe('reduceSignal: count', () => {
  it('counts items across the named array(s)', () => {
    expect(reduceSignal('count', { messages: [{ uid: 1 }, { uid: 2 }] })).toBe(2)
    expect(reduceSignal('count', { messages: [] })).toBe(0)
  })

  it('counts across multiple arrays in the result object', () => {
    expect(reduceSignal('count', { a: [1, 2], b: [3] })).toBe(3)
  })
})

describe('reduceSignal: hash', () => {
  it('is order-insensitive to object key ordering (equal data ⇒ equal hash)', () => {
    const a = reduceSignal('hash', { items: [{ subject: 'hi', uid: 1 }] })
    const b = reduceSignal('hash', { items: [{ uid: 1, subject: 'hi' }] })
    expect(a).toBe(b)
  })

  it('differs when the data differs', () => {
    const a = reduceSignal('hash', { items: [{ uid: 1 }] })
    const b = reduceSignal('hash', { items: [{ uid: 2 }] })
    expect(a).not.toBe(b)
  })

  it('is a stable hex string', () => {
    expect(typeof reduceSignal('hash', { x: 1 })).toBe('string')
    expect(reduceSignal('hash', { x: 1 })).toMatch(/^[0-9a-f]+$/)
  })
})

describe('stableStringify', () => {
  it('sorts keys recursively so equal data canonicalizes identically', () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 4 }, b: 1 }))
  })

  it('diffs structurally for the signal equality compare', () => {
    expect(stableStringify(7) === stableStringify(7)).toBe(true)
    expect(stableStringify(7) === stableStringify(8)).toBe(false)
    expect(stableStringify(null) === stableStringify(null)).toBe(true)
  })

  it('handles arrays and primitives', () => {
    expect(stableStringify([1, 2, 3])).toBe('[1,2,3]')
    expect(stableStringify('x')).toBe('"x"')
  })
})

describe('isDegenerateSignal (monotonic no-clobber guard)', () => {
  it('treats maxUid=null as degenerate (no uid observed)', () => {
    expect(isDegenerateSignal('maxUid', null)).toBe(true)
    expect(isDegenerateSignal('maxUid', 0)).toBe(false)
    expect(isDegenerateSignal('maxUid', 7)).toBe(false)
  })

  it('treats count=0 as degenerate (empty/absent), any positive count is real', () => {
    expect(isDegenerateSignal('count', 0)).toBe(true)
    expect(isDegenerateSignal('count', 1)).toBe(false)
  })

  it('never treats a hash as degenerate (hash always yields a string)', () => {
    expect(isDegenerateSignal('hash', 'deadbeef')).toBe(false)
    expect(isDegenerateSignal('hash', '0')).toBe(false)
  })

  it('a degenerate reduction would NOT clobber a prior good high-water mark', () => {
    // Scenario: a gate tool that returns an error-shaped/empty result (no uid) instead of
    // throwing. maxUid → null is degenerate, so the gate must short-circuit { changed:false }
    // WITHOUT persisting — leaving the last good signal intact for the next poll's diff.
    const prevGood = reduceSignal('maxUid', { messages: [{ uid: 100 }] })
    const degenerate = reduceSignal('maxUid', { error: 'imap timeout' })
    expect(prevGood).toBe(100)
    expect(degenerate).toBeNull()
    expect(isDegenerateSignal('maxUid', degenerate)).toBe(true)
    // The degenerate signal differs from the good one by stableStringify, so WITHOUT the guard
    // it would diff as a change and overwrite 100 with null — exactly the spurious-escalation bug.
    expect(stableStringify(degenerate) === stableStringify(prevGood)).toBe(false)
  })
})

describe('decideSignalChange (silent baseline + diff)', () => {
  it('first observation (no baseline) establishes the baseline SILENTLY — persist, do not escalate', () => {
    // The flaw this fixes: a fresh watcher must NOT fire on the pre-existing backlog. last_seen_signal
    // is null at creation, so the first poll baselines instead of treating the whole backlog as "new".
    expect(decideSignalChange(7, null)).toEqual({ changed: false, persist: true })
    expect(decideSignalChange(0, null)).toEqual({ changed: false, persist: true })
    expect(decideSignalChange('deadbeef', null)).toEqual({ changed: false, persist: true })
  })

  it('an unchanged signal after baseline does not escalate and does not re-persist', () => {
    expect(decideSignalChange(7, 7)).toEqual({ changed: false, persist: false })
    expect(decideSignalChange('abc', 'abc')).toEqual({ changed: false, persist: false })
  })

  it('a changed signal after baseline escalates and persists', () => {
    expect(decideSignalChange(8, 7)).toEqual({ changed: true, persist: true })
    expect(decideSignalChange('def', 'abc')).toEqual({ changed: true, persist: true })
  })

  it('maxUid is monotonic — a NEW arrival (higher uid) fires, but the count-style drop never reaches it', () => {
    // After baselining at 100, a new mail (uid 130) fires; reading mail never lowers maxUid so it
    // never re-fires (the #1 footgun that `count` has and `maxUid` avoids).
    expect(decideSignalChange(130, 100)).toEqual({ changed: true, persist: true })
    expect(decideSignalChange(130, 130)).toEqual({ changed: false, persist: false })
  })
})
