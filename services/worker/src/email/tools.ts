import { type Tool } from '@alfred/agent-core'
import { type Config, loadConfig } from '@alfred/shared'
import { ImapFlow } from 'imapflow'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { createTransport } from 'nodemailer'
import { simpleParser } from 'mailparser'
import { capResult } from '../cap.js'

const DEFAULT_LIST_LIMIT = 20
// Upper bound on a single list/search: each row now decodes its body part (a parse per
// message, below), so an unbounded limit from the model (or an injected "list 99999 emails")
// would do real work. The owner's mailbox, capped to something sane for triage.
const MAX_LIST_LIMIT = 50
// A short, single-line preview of each message in list/search results — enough to triage
// without fetching the body. Bounded well under capResult so a list of N stays small.
const SNIPPET_CHARS = 200

// Email config comes from the validated loadConfig() object — the IMAP_*/SMTP_* keys live in
// the shared zod schema (ports coerced+validated, *_SECURE transformed to booleans), so this
// module reads typed values rather than re-parsing process.env. `cfg` is injectable (default
// loadConfig()) purely so tests can pass a config without mutating the env around loadConfig's
// boot-time cache. Read LAZILY inside invoke (never at module load / makeEmailTools, neither of
// which calls this), so the catalog can publish the email tools on a box with no mail
// credentials; this throws a friendly error only when a tool actually runs unconfigured (§10.7),
// never at boot.
interface ImapConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
}
interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
}

export function emailConfig(need: 'imap', cfg?: Config): { imap: ImapConfig }
export function emailConfig(need: 'smtp', cfg?: Config): { smtp: SmtpConfig }
export function emailConfig(need: 'imap' | 'smtp', cfg: Config = loadConfig()): { imap?: ImapConfig; smtp?: SmtpConfig } {
  if (need === 'imap') {
    if (!cfg.IMAP_HOST || !cfg.IMAP_USER || !cfg.IMAP_PASSWORD) {
      throw new Error('email is not configured — set IMAP_*/SMTP_* in .env')
    }
    return {
      imap: {
        host: cfg.IMAP_HOST,
        port: cfg.IMAP_PORT,
        secure: cfg.IMAP_SECURE,
        user: cfg.IMAP_USER,
        pass: cfg.IMAP_PASSWORD,
      },
    }
  }
  if (!cfg.SMTP_HOST || !cfg.SMTP_USER || !cfg.SMTP_PASSWORD) {
    throw new Error('email is not configured — set IMAP_*/SMTP_* in .env')
  }
  return {
    smtp: {
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_SECURE,
      user: cfg.SMTP_USER,
      pass: cfg.SMTP_PASSWORD,
      from: cfg.EMAIL_FROM || cfg.SMTP_USER,
    },
  }
}

// Connect-per-call (Approach A): a fresh IMAP connection per invoke, always logged out in
// finally — no module-level/pooled connection, so a worker crash drops nothing to reclaim.
// Exported so the email Trigger's detect() (services/worker/src/triggers/) can run its
// deterministic UID-floor poll over the same connect-per-call path the tools use.
export async function withImap<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const { imap } = emailConfig('imap')
  const c = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
  })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.logout().catch(() => {})
  }
}

// IMAP SEARCH criteria built from the search_emails args. There is deliberately NO raw-query
// arg — free text maps to TEXT (whole-message search), the rest to their typed criteria.
// Returns {} (match all) when no criteria are given, so search degrades to a plain listing.
export interface SearchArgs {
  query?: string
  from?: string
  since?: string
  unseen?: boolean
}
export function buildSearchCriteria(args: SearchArgs): Record<string, unknown> {
  const criteria: Record<string, unknown> = {}
  if (args.from) criteria.from = args.from
  if (args.query) criteria.text = args.query
  if (args.unseen) criteria.seen = false
  if (args.since) {
    const d = new Date(args.since)
    if (!Number.isNaN(d.getTime())) criteria.since = d
  }
  return criteria
}

// imapflow envelope address arrays → a single "Name <addr>, …" string for the model. Returns
// '' (not undefined) so the result shape is stable.
interface EnvelopeAddress {
  name?: string
  address?: string
}
export function formatAddresses(addrs: EnvelopeAddress[] | undefined): string {
  if (!addrs || addrs.length === 0) return ''
  return addrs
    .map((a) => {
      const addr = a.address ?? ''
      return a.name ? `${a.name} <${addr}>` : addr
    })
    .join(', ')
}

// A crude HTML→text fallback for messages with no text/plain part: strip tags and collapse
// whitespace. mailparser's .text is preferred; this only runs when it's absent.
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// A one-line snippet from a body string: collapse whitespace, trim to SNIPPET_CHARS.
export function snippet(text: string | undefined): string {
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SNIPPET_CHARS ? flat.slice(0, SNIPPET_CHARS) : flat
}

// Normalize a recipient/threading value for nodemailer + MailComposer: an array is mapped to
// strings; a string is passed through unchanged (nodemailer accepts a comma-separated list, so
// it is NOT split here). null/empty → undefined, so the header is simply omitted.
function toAddressList(value: unknown): string | string[] | undefined {
  if (value == null) return undefined
  if (Array.isArray(value)) return value.map((v) => String(v))
  const s = String(value)
  return s ? s : undefined
}

export interface MessageRow {
  uid: number
  mailbox: string
  from: string
  to: string
  subject: string
  date: string
  snippet: string
  unseen: boolean
}

// Upper bound on a single UID-floor poll (the email Trigger's detect()). A watcher should never
// pull an unbounded delta — a long-disconnected mailbox could have thousands of new UIDs; cap so
// one tick stays bounded work. Newest-first within the cap, like fetchMessages.
const MAX_SINCE_UID_LIMIT = 200

// Turn a fetched BODY[1] section into readable text for the snippet. A bodyParts fetch returns
// the section STILL transfer-encoded (imapflow only decodes Content-Transfer-Encoding on its
// download() path, not here) — so a base64 / quoted-printable body would otherwise snippet as
// gibberish. Reconstruct a parseable MIME entity from the part's header + body and let
// mailparser decode it (transfer-encoding + charset), reusing the same parser read_email uses
// rather than hand-rolling base64/QP/charset handling. `header` is BODY[1.MIME] for a multipart
// message; for a single-part message that section doesn't exist, so we fall back to the
// message's own headers (which carry its Content-Type + Content-Transfer-Encoding).
async function decodeBodyPart(body: Buffer | undefined, header: Buffer | undefined): Promise<string> {
  if (!body || body.length === 0) return ''
  if (!header || header.length === 0) return body.toString('utf8') // no headers to decode with — best effort
  const parsed = await simpleParser(Buffer.concat([header, Buffer.from('\r\n'), body]))
  return parsed.text ?? (parsed.html ? htmlToText(parsed.html) : '')
}

// Fetch the newest `limit` messages in `mailbox` matching `criteria` (omit for a plain
// listing), returning the list/search row shape. Shared by list_emails and search_emails.
async function fetchMessages(
  c: ImapFlow,
  mailbox: string,
  criteria: Record<string, unknown> | undefined,
  limit: number,
): Promise<MessageRow[]> {
  const lock = await c.getMailboxLock(mailbox)
  try {
    // imapflow search returns matching UIDs; with no criteria we list all. Newest-first, capped.
    const uids = await c.search(criteria && Object.keys(criteria).length > 0 ? criteria : { all: true }, {
      uid: true,
    })
    // search() returns false (not []) when it can't run; treat it as no matches.
    const chosen = (uids || []).slice(-limit).reverse()
    if (chosen.length === 0) return []

    // imapflow's fetch() yields messages in the order the IMAP server emits untagged FETCH
    // responses (ascending UID), not the order of the requested set — so collect into a map
    // keyed by uid and then walk `chosen` (already newest-first) to impose the documented order.
    const byUid = new Map<number, MessageRow>()
    // bodyParts ['1','1.mime'] pulls the first body section + its MIME header so the snippet is
    // a decoded body preview (see decodeBodyPart), not an echo of the subject; headers:true gives
    // the message header used as the decode fallback for single-part messages.
    for await (const msg of c.fetch(
      chosen,
      { uid: true, envelope: true, flags: true, bodyParts: ['1', '1.mime'], headers: true },
      { uid: true },
    )) {
      const env = msg.envelope
      const bodyText = await decodeBodyPart(msg.bodyParts?.get('1'), msg.bodyParts?.get('1.mime') ?? msg.headers)
      byUid.set(msg.uid, {
        uid: msg.uid,
        mailbox,
        from: formatAddresses(env?.from),
        to: formatAddresses(env?.to),
        subject: env?.subject ?? '',
        date: env?.date ? new Date(env.date).toISOString() : '',
        snippet: snippet(bodyText),
        unseen: !(msg.flags?.has('\\Seen') ?? false),
      })
    }
    return chosen.map((u) => byUid.get(u)).filter((r): r is MessageRow => r != null)
  } finally {
    lock.release()
  }
}

// Fetch messages in `mailbox` with UID strictly greater than `sinceUid`, matching `criteria`
// (merged onto the UID-floor range), newest-first, capped at `limit` (≤ MAX_SINCE_UID_LIMIT).
// This is the email Trigger's deterministic delta source — list_emails only returns newest-N with
// no UID floor, so it can't tell "new since I last looked" from "the newest N". An IMAP UID range
// `${sinceUid + 1}:*` selects everything above the floor; the `*` (highest UID) means a server can
// still return the single highest message even when none truly exceed the floor, so we filter
// `uid > sinceUid` defensively rather than trusting the server-side range alone. Reuses the same
// search/fetch/decode/format path as fetchMessages.
export async function fetchSinceUid(
  c: ImapFlow,
  mailbox: string,
  sinceUid: number,
  criteria: Record<string, unknown> | undefined,
  limit: number,
): Promise<MessageRow[]> {
  const max = Math.min(Math.max(1, Math.floor(limit)), MAX_SINCE_UID_LIMIT)
  const lock = await c.getMailboxLock(mailbox)
  try {
    const floor = Math.max(0, Math.floor(sinceUid))
    // Merge the UID-floor range with the param criteria. The `uid` key is the search range; the
    // rest (from/subject/seen) AND with it server-side.
    const searchCriteria: Record<string, unknown> = { ...(criteria ?? {}), uid: `${floor + 1}:*` }
    const uids = await c.search(searchCriteria, { uid: true })
    // search() returns false (not []) when it can't run; treat it as no matches. Defensively keep
    // only UIDs strictly above the floor (see the `*` caveat above), newest-first, capped.
    const chosen = (uids || [])
      .filter((u) => u > floor)
      .sort((a, b) => b - a)
      .slice(0, max)
    if (chosen.length === 0) return []

    const byUid = new Map<number, MessageRow>()
    for await (const msg of c.fetch(
      chosen,
      { uid: true, envelope: true, flags: true, bodyParts: ['1', '1.mime'], headers: true },
      { uid: true },
    )) {
      const env = msg.envelope
      const bodyText = await decodeBodyPart(msg.bodyParts?.get('1'), msg.bodyParts?.get('1.mime') ?? msg.headers)
      byUid.set(msg.uid, {
        uid: msg.uid,
        mailbox,
        from: formatAddresses(env?.from),
        to: formatAddresses(env?.to),
        subject: env?.subject ?? '',
        date: env?.date ? new Date(env.date).toISOString() : '',
        snippet: snippet(bodyText),
        unseen: !(msg.flags?.has('\\Seen') ?? false),
      })
    }
    return chosen.map((u) => byUid.get(u)).filter((r): r is MessageRow => r != null)
  } finally {
    lock.release()
  }
}

// The email tool family (spec docs/specs/2026-06-10-email-tools.md). Provider-agnostic over
// IMAP (reading) + SMTP (sending), connect-per-call, group 'email' — list/search/read are
// read-tier, save_draft/send_email are write-tier (approval-gated, §16). No conversation
// binding: email acts on the mailbox, not the per-conversation workspace.
export function makeEmailTools(): Tool[] {
  return [
    {
      name: 'list_emails',
      description:
        'List recent emails in a mailbox (newest first). Returns sender, subject, date, a short ' +
        'snippet, and an unseen flag for each. Use read_email with the mailbox + uid for the full body.',
      inputSchema: {
        type: 'object',
        properties: {
          mailbox: { type: 'string', description: 'Mailbox to list (default "INBOX")' },
          limit: { type: 'number', description: `Max messages to return (default ${DEFAULT_LIST_LIMIT}, capped at ${MAX_LIST_LIMIT})` },
        },
      },
      trustTier: 'read',
      group: 'email',
      async invoke(args: unknown): Promise<unknown> {
        const { mailbox, limit } = (args ?? {}) as { mailbox?: unknown; limit?: unknown }
        const box = typeof mailbox === 'string' && mailbox ? mailbox : 'INBOX'
        const max = typeof limit === 'number' && Number.isFinite(limit)
          ? Math.min(Math.max(1, Math.floor(limit)), MAX_LIST_LIMIT)
          : DEFAULT_LIST_LIMIT
        const messages = await withImap((c) => fetchMessages(c, box, undefined, max))
        return capResult({ messages })
      },
    },
    {
      name: 'search_emails',
      description:
        'Search a mailbox by free text and/or sender, since-date, and unseen flag. Maps to an ' +
        'IMAP server-side search; results match the list_emails shape (uid + mailbox for read_email).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free text to match anywhere in the message' },
          from: { type: 'string', description: 'Match the sender (substring of the From header)' },
          since: { type: 'string', description: 'Only messages on/after this date (e.g. "2026-06-01")' },
          unseen: { type: 'boolean', description: 'Only unread messages' },
          mailbox: { type: 'string', description: 'Mailbox to search (default "INBOX")' },
          limit: { type: 'number', description: `Max messages to return (default ${DEFAULT_LIST_LIMIT}, capped at ${MAX_LIST_LIMIT})` },
        },
      },
      trustTier: 'read',
      group: 'email',
      async invoke(args: unknown): Promise<unknown> {
        const { query, from, since, unseen, mailbox, limit } = (args ?? {}) as {
          query?: unknown
          from?: unknown
          since?: unknown
          unseen?: unknown
          mailbox?: unknown
          limit?: unknown
        }
        const box = typeof mailbox === 'string' && mailbox ? mailbox : 'INBOX'
        const max = typeof limit === 'number' && Number.isFinite(limit)
          ? Math.min(Math.max(1, Math.floor(limit)), MAX_LIST_LIMIT)
          : DEFAULT_LIST_LIMIT
        const criteria = buildSearchCriteria({
          query: typeof query === 'string' ? query : undefined,
          from: typeof from === 'string' ? from : undefined,
          since: typeof since === 'string' ? since : undefined,
          unseen: unseen === true,
        })
        const messages = await withImap((c) => fetchMessages(c, box, criteria, max))
        return capResult({ messages })
      },
    },
    {
      name: 'read_email',
      description:
        'Read one email by mailbox + uid: full parsed headers and body text (HTML converted to ' +
        'text), plus attachment metadata. Does NOT mark the message read (peek).',
      inputSchema: {
        type: 'object',
        properties: {
          mailbox: { type: 'string', description: 'Mailbox the message is in' },
          uid: { type: 'number', description: 'UID of the message (from list_emails/search_emails)' },
        },
        required: ['mailbox', 'uid'],
      },
      trustTier: 'read',
      group: 'email',
      async invoke(args: unknown): Promise<unknown> {
        const { mailbox, uid } = (args ?? {}) as { mailbox?: unknown; uid?: unknown }
        const box = String(mailbox ?? '')
        const id = Number(uid)
        if (!box) throw new Error('read_email requires a mailbox')
        if (!Number.isInteger(id) || id <= 0) throw new Error('read_email requires a positive integer uid')

        return await withImap(async (c) => {
          const lock = await c.getMailboxLock(box)
          try {
            // Peek the full source: source is fetched without the \Seen side effect, so an
            // agent read never silently marks the owner's mail read (spec non-goal).
            const msg = await c.fetchOne(String(id), { uid: true, source: true }, { uid: true })
            if (!msg || !msg.source) throw new Error(`no message with uid ${id} in ${box}`)

            const parsed = await simpleParser(msg.source)
            const text = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : '')
            const attachments = (parsed.attachments ?? []).map((a) => ({
              filename: a.filename ?? '',
              size: a.size ?? 0,
              contentType: a.contentType ?? '',
            }))
            // Only `text` is unbounded, so cap just that and return the structured object —
            // don't re-cap the whole object (capResult would degrade a large result into a
            // truncated, possibly-invalid JSON string and lose the shape).
            return {
              from: parsed.from?.text ?? '',
              to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(', ') : parsed.to.text) : '',
              cc: parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc.map((t) => t.text).join(', ') : parsed.cc.text) : '',
              subject: parsed.subject ?? '',
              date: parsed.date ? parsed.date.toISOString() : '',
              messageId: parsed.messageId ?? '',
              references: parsed.references
                ? Array.isArray(parsed.references)
                  ? parsed.references
                  : [parsed.references]
                : [],
              text: capResult(text),
              attachments,
            }
          } finally {
            lock.release()
          }
        })
      },
    },
    {
      name: 'save_draft',
      description:
        'Save a plain-text email as a draft in the mailbox’s Drafts folder (visible in the ' +
        'owner’s mail client). Does not send. Pass inReplyTo/references to thread a reply.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient address(es), comma-separated' },
          subject: { type: 'string', description: 'Subject line' },
          body: { type: 'string', description: 'Plain-text body' },
          cc: { type: 'string', description: 'CC address(es), comma-separated' },
          bcc: { type: 'string', description: 'BCC address(es), comma-separated' },
          inReplyTo: { type: 'string', description: 'Message-ID this is a reply to (threading)' },
          references: { type: 'string', description: 'References header (threading)' },
        },
        required: ['to', 'subject', 'body'],
      },
      trustTier: 'write',
      group: 'email',
      async invoke(args: unknown): Promise<unknown> {
        const a = (args ?? {}) as Record<string, unknown>
        const to = toAddressList(a.to)
        if (!to) throw new Error('save_draft requires a recipient (to)')
        const { smtp } = emailConfig('smtp')

        const raw = await new MailComposer({
          from: smtp.from,
          to,
          cc: toAddressList(a.cc),
          bcc: toAddressList(a.bcc),
          subject: String(a.subject ?? ''),
          text: String(a.body ?? ''),
          inReplyTo: a.inReplyTo != null ? String(a.inReplyTo) : undefined,
          references: toAddressList(a.references),
        })
          .compile()
          .build()

        return await withImap(async (c) => {
          // Discover the Drafts folder by its \Drafts special-use flag, falling back to the
          // literal name; if APPEND fails we return a clear error rather than guessing others.
          const list = await c.list()
          const draftsBox =
            list.find((m) => m.specialUse === '\\Drafts')?.path ??
            list.find((m) => m.path.toLowerCase() === 'drafts')?.path ??
            'Drafts'
          let appended: { uid?: number } | false
          try {
            appended = await c.append(draftsBox, raw, ['\\Draft'])
          } catch (err) {
            throw new Error(
              `could not save draft to "${draftsBox}": ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          if (!appended) throw new Error(`could not save draft to "${draftsBox}" (APPEND failed)`)
          return { ok: true, mailbox: draftsBox, uid: appended.uid ?? null }
        })
      },
    },
    {
      name: 'send_email',
      description:
        'Send a plain-text email. From is EMAIL_FROM (or SMTP_USER). Pass inReplyTo/references ' +
        'to thread a reply. Write-tier — the owner approves the recipient/subject/body before it sends.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient address(es), comma-separated' },
          subject: { type: 'string', description: 'Subject line' },
          body: { type: 'string', description: 'Plain-text body' },
          cc: { type: 'string', description: 'CC address(es), comma-separated' },
          bcc: { type: 'string', description: 'BCC address(es), comma-separated' },
          inReplyTo: { type: 'string', description: 'Message-ID this is a reply to (threading)' },
          references: { type: 'string', description: 'References header (threading)' },
        },
        required: ['to', 'subject', 'body'],
      },
      trustTier: 'write',
      group: 'email',
      async invoke(args: unknown): Promise<unknown> {
        const a = (args ?? {}) as Record<string, unknown>
        const to = toAddressList(a.to)
        if (!to) throw new Error('send_email requires a recipient (to)')
        const { smtp } = emailConfig('smtp')

        // A FRESH transport per call (connect-per-send) — no shared/pooled SMTP connection,
        // matching the IMAP connect-per-call model.
        const transport = createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: { user: smtp.user, pass: smtp.pass },
        })
        try {
          const info = await transport.sendMail({
            from: smtp.from,
            to,
            cc: toAddressList(a.cc),
            bcc: toAddressList(a.bcc),
            subject: String(a.subject ?? ''),
            text: String(a.body ?? ''),
            inReplyTo: a.inReplyTo != null ? String(a.inReplyTo) : undefined,
            references: toAddressList(a.references),
          })
          return { ok: true, messageId: info.messageId }
        } finally {
          transport.close()
        }
      },
    },
  ]
}
