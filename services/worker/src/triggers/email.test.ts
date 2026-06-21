import { describe, expect, it } from 'vitest'
import {
  detectEmail,
  emailCriteria,
  type EmailFetcher,
  type EmailTriggerCursor,
  type EmailTriggerParams,
} from './email.js'
import { type MessageRow } from '../email/tools.js'

// Offline unit tests for the email Trigger's pure delta-detection (detectEmail) with a fake
// fetcher — no live IMAP/DB. Contract (spec docs/specs/2026-06-19-trigger-abstraction.md):
//   - first detect (cursor == null) BASELINES silently: events [], nextCursor = current max uid
//   - subsequent detects report messages with uid > cursor.lastUid as events, advancing the cursor
//   - no new mail keeps the cursor exactly where it was (never lowers a high-water mark)

function row(uid: number, from = `s${uid}@x`, subject = `subj ${uid}`): MessageRow {
  return { uid, mailbox: 'INBOX', from, to: 'me@x', subject, date: '', snippet: '', unseen: true }
}

// A fake fetcher backed by an in-memory mailbox. Records its calls so tests can assert the seam
// is exercised correctly (e.g. baseline never pulls bodies via since()).
function fakeFetcher(mailbox: MessageRow[]): EmailFetcher & {
  calls: { maxUid: number; since: { sinceUid: number }[] }
} {
  const calls = { maxUid: 0, since: [] as { sinceUid: number }[] }
  return {
    calls,
    async maxUid() {
      calls.maxUid++
      if (mailbox.length === 0) return null
      return mailbox.reduce((m, r) => (r.uid > m ? r.uid : m), 0)
    },
    async since(_box, sinceUid, _criteria, limit) {
      calls.since.push({ sinceUid })
      return mailbox
        .filter((r) => r.uid > sinceUid)
        .sort((a, b) => b.uid - a.uid)
        .slice(0, limit)
    },
  }
}

const params: EmailTriggerParams = {}

describe('detectEmail', () => {
  it('baselines silently on the first detect (cursor == null) — no events, cursor = max uid', async () => {
    const f = fakeFetcher([row(10), row(12), row(11)])
    const res = await detectEmail(params, null, f)
    expect(res.events).toEqual([])
    expect((res.nextCursor as EmailTriggerCursor).lastUid).toBe(12)
    // Baseline must not pull message bodies (no since() call) — it only reads the high-water mark.
    expect(f.calls.maxUid).toBe(1)
    expect(f.calls.since).toHaveLength(0)
  })

  it('baselines to 0 on an empty mailbox so the first real arrival later fires', async () => {
    const f = fakeFetcher([])
    const res = await detectEmail(params, null, f)
    expect(res.events).toEqual([])
    expect((res.nextCursor as EmailTriggerCursor).lastUid).toBe(0)
  })

  it('reports messages with uid > cursor as events and advances the cursor to max', async () => {
    const f = fakeFetcher([row(10), row(11, 'alice@x', 'hi'), row(12)])
    const res = await detectEmail(params, { lastUid: 10 }, f)
    expect(res.events.map((e) => e.id)).toEqual(['12', '11'])
    expect(res.events[1]).toMatchObject({
      id: '11',
      summary: 'alice@x — hi',
      data: { uid: 11, from: 'alice@x', subject: 'hi' },
    })
    expect((res.nextCursor as EmailTriggerCursor).lastUid).toBe(12)
    expect(f.calls.since[0]).toEqual({ sinceUid: 10 })
  })

  it('keeps the cursor unchanged when there is no new mail', async () => {
    const f = fakeFetcher([row(10), row(11)])
    const res = await detectEmail(params, { lastUid: 11 }, f)
    expect(res.events).toEqual([])
    expect((res.nextCursor as EmailTriggerCursor).lastUid).toBe(11)
  })

  it('uses readable fallbacks in the summary for blank from/subject', async () => {
    const f = fakeFetcher([row(5, '', '')])
    const res = await detectEmail(params, { lastUid: 4 }, f)
    expect(res.events[0].summary).toBe('(unknown sender) — (no subject)')
  })
})

describe('emailCriteria', () => {
  it('is empty when no filtering params are given', () => {
    expect(emailCriteria({})).toEqual({})
  })

  it('maps from/subject to IMAP SEARCH criteria (no read/seen filter — that was removed)', () => {
    expect(emailCriteria({ from: 'alice@x', subject: 'invoice' })).toEqual({
      from: 'alice@x',
      subject: 'invoice',
    })
  })
})
