# Email tools (IMAP/SMTP)

Give Alfred a built-in email tool family so it can triage and act on the owner's
mailbox: list and search messages, read a message, save a draft, and send mail.
Provider-agnostic over **IMAP** (reading) + **SMTP** (sending) with one set of
credentials in `.env`. The tools are ordinary built-in `Tool`s in the worker —
the same shape as the Python and file families — with **connect-per-call**
connections (no pool), read-tier reads, and write-tier draft/send gated through
the existing approval flow under one `email` group. This is the first concrete
piece of the post-MVP "Gmail/Calendar integrations" line (§15 step 7), done as
built-in tools rather than the still-unbuilt MCP seam.

## Key decisions

- **Built-in tools, not MCP** (extends). A `services/worker/src/email/` family
  built and wired exactly like `services/worker/src/python/` (`makeEmailTools()`
  → `buildRunTools` in `catalog.ts`). The MCP client seam (§7.3) stays unbuilt;
  nothing here depends on it.
- **IMAP + SMTP, provider-agnostic** (new). Works with any mailbox that speaks
  IMAP/SMTP (Gmail with an app password, Fastmail, etc.). No OAuth, no
  Gmail-specific API, no Google Cloud project.
- **`imapflow` + `nodemailer` + `mailparser`** (new deps). IMAP client, SMTP
  sender, and MIME parser respectively — all maintained by the Nodemailer
  author, promise-based, no native build. `nodemailer`'s `MailComposer` also
  builds the raw MIME that `save_draft` APPENDs.
- **Connect-per-call, stateless** (reuses). Each invoke opens a fresh IMAP/SMTP
  connection and closes it in `finally` — no shared connection, matching the
  stateless-tool, fail-and-restart worker model (§7.6). SMTP is connect-per-send
  regardless.
- **Trust tiers + `email` group** (reuses). `list_emails` / `search_emails` /
  `read_email` are `read`-tier; `save_draft` / `send_email` are `write`-tier.
  All carry `group: 'email'`, so the first write prompts task-scoped and the
  rest of the run's email writes auto-approve (the §16 / Python-group pattern).
- **Credentials in `.env`, lazy-validated** (reuses). New optional
  `IMAP_*` / `SMTP_*` / `EMAIL_FROM` keys in the zod schema (optional like
  `GEMINI_API_KEY`, so non-email processes still boot). The tools are always
  published to the catalog; an invoke with missing/incomplete config returns a
  clear "email not configured" error rather than failing at boot.
- **Messages referenced by `(mailbox, uid)`** (new). `list_emails`/`search_emails`
  return `uid` + `mailbox`; `read_email`/`save_draft` reply-threading take them
  back. UID stability within a mailbox is assumed for the life of a task (the
  UIDVALIDITY edge is an accepted simplification, see Open questions).

## Goals

- Inbox triage from chat: "what's unread from X", "summarize today's inbox",
  "find the invoice from last week".
- The draft-and-approve loop: Alfred composes a reply, the owner sees the full
  to/subject/body in the approval card, approves → it sends.
- Save a real draft to the mailbox's Drafts folder (visible in the owner's
  normal mail client), distinct from sending.

## Non-goals

- **OAuth / Gmail API.** Provider-agnostic IMAP/SMTP only (the mailbox fork was
  settled). Gmail uses an app password like any other IMAP host.
- **Mailbox mutation beyond draft/send** — no label/archive/move/delete/mark-read.
  Reading does **not** mark a message `\Seen` (Open questions).
- **Multiple accounts.** One mailbox, one credential set. Multi-account is a
  later config shape, not this spec.
- **Push / IDLE inbox watching.** That's autonomous-trigger territory (§9.4),
  not an interactive tool.
- **HTML composition.** Outgoing mail is plain text in v1; incoming HTML is
  converted to text on read.
- **Outbound attachments.** `read_email` surfaces attachment *metadata* only;
  attaching workspace files to outgoing mail is revisited when there's a need.

## Design

### Tools

A flat family from `makeEmailTools(): Tool[]` (no conversation binding — email
acts on the mailbox, not the per-conversation workspace), built once at module
load like `BROWSER_TOOLS` and spread into `buildRunTools`.

| Tool | Tier | Args | Returns |
|------|------|------|---------|
| `list_emails` | read | `mailbox?` (default `INBOX`), `limit?` (default 20) | `{ messages: [{ uid, mailbox, from, to, subject, date, snippet, unseen }] }` |
| `search_emails` | read | `query` (free text), `from?`, `since?`, `unseen?`, `mailbox?`, `limit?` | same `messages` shape |
| `read_email` | read | `mailbox`, `uid` | `{ from, to, cc, subject, date, messageId, references, text, attachments: [{ filename, size, contentType }] }` |
| `save_draft` | write | `to`, `subject`, `body`, `cc?`, `bcc?`, `inReplyTo?`, `references?` | `{ ok, mailbox, uid }` |
| `send_email` | write | `to`, `subject`, `body`, `cc?`, `bcc?`, `inReplyTo?`, `references?` | `{ ok, messageId }` |

Results are objects with named arrays (never a bare array — the Gemini
function-response Struct requires an object, CHANGELOG 34). Text bodies and any
large structured result go through the shared `capResult` (100k chars).

### Connection model (Approach A)

```ts
async function withImap<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host, port, secure, auth: { user, pass }, logger: false })
  await c.connect()
  try { return await fn(c) } finally { await c.logout().catch(() => {}) }
}
```

Sends use a fresh `nodemailer.createTransport({...}).sendMail(...)` per call.
No module-level connection, no idle timer, no reconnect logic — a worker crash
drops nothing that needs reclaiming.

### Reading & parsing

- `list_emails` / `search_emails` fetch envelope + flags + a short body snippet
  via `imapflow` `fetch()` with `{ envelope: true, flags: true, bodyStructure }`,
  newest-first, capped at `limit`. `search_emails` maps its args to IMAP
  `SEARCH` criteria (`FROM`, `SINCE`, `UNSEEN`, `TEXT <query>`); server-side
  search quality is provider-dependent and accepted as-is for v1.
- `read_email` fetches the full source and runs it through `mailparser`
  (`simpleParser`) → prefer `.text`, fall back to HTML-stripped-to-text;
  `messageId` + `references` are returned so a reply can thread. Fetch is done
  **without** setting `\Seen` (peek), so agent reads don't silently mark mail
  read.

### Sending & drafts

- `send_email` builds and sends via `nodemailer`; `From` is `EMAIL_FROM`
  (default: `SMTP_USER`). `inReplyTo`/`references` set the threading headers
  when replying.
- `save_draft` builds the identical MIME with `nodemailer`'s `MailComposer`,
  discovers the Drafts mailbox (special-use `\Drafts` via `LIST`, falling back
  to the literal `"Drafts"`), and `imap.append(draftsBox, raw, ['\\Draft'])`.
  Returns the new `uid`; if the APPEND fails (no usable Drafts folder), it
  returns a clear error rather than guessing other folder names.

### Config

New optional keys in `packages/shared/src/config.ts` (documented in
`.env.example`):

```
IMAP_HOST, IMAP_PORT=993, IMAP_USER, IMAP_PASSWORD, IMAP_SECURE=true
SMTP_HOST, SMTP_PORT=465, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE=true
EMAIL_FROM           # default: SMTP_USER
```

An `emailConfig()` helper in the email module reads these and throws a friendly
`"email is not configured — set IMAP_*/SMTP_* in .env"` if the required subset
is missing, so a tool invoke fails loudly into the tool-result (§10.7) rather
than the process failing at boot.

### Wiring

`catalog.ts`: `const EMAIL_TOOLS = makeEmailTools()` at module load, spread into
`buildRunTools` alongside `BROWSER_TOOLS`. They publish to the `tools` table at
boot automatically (catalog derives from the real instances), so they appear on
the Tools page with their tiers and the `email` group. `SYSTEM_PROMPT` gains a
one-line note that the email tools exist.

### Security note (prompt injection)

Email bodies are untrusted input — an injected instruction in a message Alfred
reads could try to steer it into sending mail. This is the same unsolved
structural-containment problem as the browser (§16): the mitigation today is
that **every outbound action (`send_email`, `save_draft`) is `write`-tier and
approval-gated**, so the owner sees the actual recipient/subject/body before
anything leaves the mailbox. Reads are `read`-tier (owner can force approval per
tool from the Tools page). No auto-send, ever.

## Alternatives considered

- **Pooled/persistent IMAP connection** (Approach B). Faster on bursts but adds
  connection lifecycle, idle-timeout/reconnect, and teardown the fail-and-restart
  model otherwise avoids — not worth it for one low-volume user. Localized swap
  later if email ever becomes high-frequency.
- **First MCP integration** (point the unbuilt MCP client at a Gmail MCP server).
  Strategic — the seam would be reused for Calendar — but a much larger lift, and
  Gmail-specific OAuth still sits underneath. Deferred; built-in tools deliver the
  capability now.
- **Browser-driven Gmail UI** (no new tools). Already possible but slow, brittle,
  and per-click approval fatigue; not a real email capability.
