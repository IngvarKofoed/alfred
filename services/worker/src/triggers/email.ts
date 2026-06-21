import { type DetectCtx, type DetectResult, type Trigger, type TriggerEvent } from '@alfred/agent-core'
import { buildSearchCriteria, fetchSinceUid, type MessageRow, withImap } from '../email/tools.js'

// The `email` Trigger (spec docs/specs/2026-06-19-trigger-abstraction.md, "The Triggers"). A
// MONOTONIC-feed Trigger: IMAP UIDs only rise, so a single scalar high-water mark cursor
// ({ lastUid }) is sufficient to report each new message exactly once (modulo at-least-once on
// crash, handled by the framework's pending_cursor → cursor commit). Detection is read-only and
// deterministic — it bypasses the agent Tool layer entirely, running a UID-floor IMAP search via
// the email module's connect-per-call withImap (list_emails has no UID floor, so it can't tell
// "new since I last looked" from "newest N").

export interface EmailTriggerParams {
  mailbox?: string
  from?: string
  subject?: string
}

export interface EmailTriggerCursor {
  lastUid: number
}

const DEFAULT_MAILBOX = 'INBOX'
// Cap on the delta a single tick pulls (mirrors fetchSinceUid's own cap). A long-disconnected
// mailbox could have a huge backlog above the cursor; bound the work per fire.
const DETECT_LIMIT = 200

// The IMAP work detect() needs, factored behind a seam so the pure delta logic (detectEmail) is
// unit-testable with a fake (no live IMAP/DB). `criteria` is the param-derived IMAP SEARCH map.
export interface EmailFetcher {
  // The highest UID currently in the mailbox matching `criteria`, or null when the mailbox is
  // empty / nothing matches. Used to establish the baseline silently on the first detect.
  maxUid(mailbox: string, criteria: Record<string, unknown> | undefined): Promise<number | null>
  // Messages with UID strictly greater than `sinceUid` matching `criteria`, newest-first, capped.
  since(
    mailbox: string,
    sinceUid: number,
    criteria: Record<string, unknown> | undefined,
    limit: number,
  ): Promise<MessageRow[]>
}

// Translate the typed Trigger params into the email module's IMAP SEARCH criteria. `from` reuses
// the tools' substring-on-From mapping; `subject` adds a SUBJECT criterion. `mailbox` is NOT a
// criterion (it selects the folder, passed separately). Filters are STABLE message attributes only
// — there is deliberately no unread/seen filter: dedup is the UID cursor, and read state is volatile
// human-mutated state that would couple detection to reading activity (a racy skip-window). See
// CHANGELOG: unreadOnly removed.
export function emailCriteria(params: EmailTriggerParams): Record<string, unknown> {
  const criteria = buildSearchCriteria({ from: params.from })
  if (params.subject) criteria.subject = params.subject
  return criteria
}

function eventFor(m: MessageRow): TriggerEvent {
  const fromLabel = m.from || '(unknown sender)'
  const subjectLabel = m.subject || '(no subject)'
  return {
    id: String(m.uid),
    summary: `${fromLabel} — ${subjectLabel}`,
    data: { uid: m.uid, from: m.from, subject: m.subject },
  }
}

// The pure delta-detection fold (params, cursor) → (events, nextCursor), with IMAP behind the
// injected fetcher. Two cases:
//   - cursor == null  ⇒ BASELINE silently: no events, nextCursor = current max uid (so the
//     pre-existing backlog never fires). A baseline lastUid of 0 means "empty/no match" — the
//     next tick then reports everything above 0, i.e. the first real arrival.
//   - cursor set       ⇒ fetch messages with uid > cursor.lastUid; events = those messages,
//     nextCursor.lastUid = max(uid) over them, falling back to the prior cursor when none are new
//     (so a no-new-mail tick keeps the cursor exactly where it was).
export async function detectEmail(
  params: EmailTriggerParams,
  cursor: EmailTriggerCursor | null,
  fetcher: EmailFetcher,
): Promise<DetectResult<EmailTriggerCursor>> {
  const mailbox = params.mailbox || DEFAULT_MAILBOX
  const criteria = emailCriteria(params)

  if (cursor == null) {
    const max = await fetcher.maxUid(mailbox, criteria)
    return { events: [], nextCursor: { lastUid: max ?? 0 } }
  }

  const messages = await fetcher.since(mailbox, cursor.lastUid, criteria, DETECT_LIMIT)
  if (messages.length === 0) {
    // No new mail: keep the cursor exactly where it was (never lower a high-water mark).
    return { events: [], nextCursor: { lastUid: cursor.lastUid } }
  }
  const maxUid = messages.reduce((m, r) => (r.uid > m ? r.uid : m), cursor.lastUid)
  return {
    events: messages.map(eventFor),
    nextCursor: { lastUid: maxUid },
  }
}

// The live fetcher wired to the email module's connect-per-call withImap. maxUid does a UID-only
// search (no body fetch — cheap) and takes the highest; `since` delegates to fetchSinceUid.
const liveFetcher: EmailFetcher = {
  async maxUid(mailbox, criteria) {
    return withImap(async (c) => {
      const lock = await c.getMailboxLock(mailbox)
      try {
        const search = criteria && Object.keys(criteria).length > 0 ? criteria : { all: true }
        const uids = await c.search(search, { uid: true })
        if (!uids || uids.length === 0) return null
        return uids.reduce((m, u) => (u > m ? u : m), 0)
      } finally {
        lock.release()
      }
    })
  },
  async since(mailbox, sinceUid, criteria, limit) {
    return withImap((c) => fetchSinceUid(c, mailbox, sinceUid, criteria, limit))
  },
}

export const emailTrigger: Trigger<EmailTriggerParams, EmailTriggerCursor> = {
  name: 'email',
  mode: 'poll',
  paramsSchema: {
    type: 'object',
    description:
      'Fires once per NEW message. Dedup is automatic via an internal per-automation UID high-water ' +
      'mark — an email is reported exactly once and reading it (or marking it read/unread) does NOT ' +
      'affect retriggering. The inbox that already exists when the automation is created never fires ' +
      '(silent baseline). The fields below only narrow which new mail counts.',
    properties: {
      mailbox: { type: 'string', description: 'Mailbox to watch (default "INBOX")' },
      from: { type: 'string', description: 'Only fire on mail whose From matches this (substring)' },
      subject: { type: 'string', description: 'Only fire on mail whose Subject matches this' },
    },
  },
  detect(ctx: DetectCtx<EmailTriggerParams, EmailTriggerCursor>): Promise<DetectResult<EmailTriggerCursor>> {
    return detectEmail(ctx.params ?? {}, ctx.cursor, liveFetcher)
  },
}
