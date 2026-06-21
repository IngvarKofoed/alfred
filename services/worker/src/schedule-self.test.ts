import { describe, expect, it } from 'vitest'
import { decideWhen, MAX_SELF_SCHEDULE_TRIGGERS, type WhenDecision } from './tools.js'

// Pure, offline tests for schedule_self's cron-vs-timestamp decision + the cadence/cap bounds
// (autonomous-watchers review fixes). decideWhen makes no db write, so it's unit-testable directly;
// the per-owner cap is enforced inside invoke() (needs a db), so here we only assert the bound exists
// and is sane.

function expectError(d: WhenDecision): string {
  expect('error' in d).toBe(true)
  return (d as { error: string }).error
}

describe('decideWhen — cron vs timestamp', () => {
  it('treats a valid 5-field cron as a recurring schedule', () => {
    const d = decideWhen('0 8 * * *')
    expect(d).toEqual({ kind: 'schedule', cron: '0 8 * * *' })
  })

  it('trims surrounding whitespace before deciding', () => {
    expect(decideWhen('  0 8 * * *  ')).toEqual({ kind: 'schedule', cron: '0 8 * * *' })
  })

  it('parses an absolute ISO-8601 timestamp as a one-shot self trigger', () => {
    const d = decideWhen('2026-06-20T09:00:00Z')
    expect('kind' in d && d.kind === 'self').toBe(true)
    if ('kind' in d && d.kind === 'self') {
      expect(d.nextFireAt.toISOString()).toBe('2026-06-20T09:00:00.000Z')
    }
  })

  it('rejects an empty / whitespace-only when', () => {
    expect(expectError(decideWhen(''))).toMatch(/non-empty when/)
    expect(expectError(decideWhen('   '))).toMatch(/non-empty when/)
  })

  it('rejects an unparseable single token (not cron, not a timestamp)', () => {
    expect(expectError(decideWhen('soon'))).toMatch(/neither a cron expression nor a parseable timestamp/)
  })

  it('accepts standard cron field forms (steps, ranges, lists) on non-minute fields', () => {
    expect(decideWhen('0 */2 * * *')).toEqual({ kind: 'schedule', cron: '0 */2 * * *' })
    expect(decideWhen('30 9-17 * * 1-5')).toEqual({ kind: 'schedule', cron: '30 9-17 * * 1-5' })
    expect(decideWhen('0 8,20 * * *')).toEqual({ kind: 'schedule', cron: '0 8,20 * * *' })
  })
})

describe('decideWhen — cron validation (5-field, pg-boss form)', () => {
  it('rejects a 6-field expression (pg-boss cron is 5-field)', () => {
    // A 6-field string (with seconds) would be silently misinterpreted — refuse it.
    expect(expectError(decideWhen('0 0 8 * * *'))).toMatch(/not a 5-field cron expression/)
  })

  it('rejects a malformed multi-field string with garbage tokens', () => {
    expect(expectError(decideWhen('foo bar baz qux quux'))).toMatch(/invalid cron field/)
  })

  it('rejects an out-of-range minute', () => {
    expect(expectError(decideWhen('99 8 * * *'))).toMatch(/out-of-range minute/)
  })
})

describe('decideWhen — no cadence floor (per-minute allowed; owner decides)', () => {
  it('accepts a wildcard minute (every minute)', () => {
    expect(decideWhen('* * * * *')).toEqual({ kind: 'schedule', cron: '* * * * *' })
  })

  it('accepts a stepped minute (*/5 — every 5 minutes)', () => {
    expect(decideWhen('*/5 * * * *')).toEqual({ kind: 'schedule', cron: '*/5 * * * *' })
  })

  it('accepts a minute list (0,30 — twice an hour)', () => {
    expect(decideWhen('0,30 * * * *')).toEqual({ kind: 'schedule', cron: '0,30 * * * *' })
  })

  it('accepts a minute range (0-30)', () => {
    expect(decideWhen('0-30 * * * *')).toEqual({ kind: 'schedule', cron: '0-30 * * * *' })
  })

  it('accepts a single fixed minute too', () => {
    expect(decideWhen('0 * * * *')).toEqual({ kind: 'schedule', cron: '0 * * * *' })
    expect(decideWhen('15 * * * *')).toEqual({ kind: 'schedule', cron: '15 * * * *' })
  })

  it('still rejects an out-of-range single minute', () => {
    expect(expectError(decideWhen('99 * * * *'))).toMatch(/out-of-range/)
  })

  it('still rejects a 6-field expression', () => {
    expect(expectError(decideWhen('0 0 * * * *'))).toMatch(/5-field/)
  })
})

describe('schedule_self caps', () => {
  it('exposes a sane standing-trigger cap', () => {
    expect(MAX_SELF_SCHEDULE_TRIGGERS).toBeGreaterThan(0)
    expect(MAX_SELF_SCHEDULE_TRIGGERS).toBeLessThanOrEqual(100)
  })
})
