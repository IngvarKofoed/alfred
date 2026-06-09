# Chat commands (slash commands) + conversation rename

A slash-command system for the web chat: typing a `/`-prefixed line in the
chat input runs a command instead of sending a message to Alfred. The client
only *detects* the prefix and forwards the raw line to a central command
endpoint; the **command registry and execution live on the backend** — one
implementation, reusable by future clients/ingresses, with parsing and
(eventually dynamic) argument handling centralized rather than reimplemented
per client. The first command is `/rename` (alias `/name`), which sets the
current conversation's title with no agent run or LLM call; `/help` is
registry-derived. The title is surfaced in the chat header so naming is
visible.

## Key decisions

- **Registry + execution live on the backend** (new). A `commands.ts` module in
  the webserver owns the command descriptors and executes each against the DB.
  The web client only detects a leading `/` and forwards the raw line — so
  command definitions, authoritative parsing, and future dynamic-argument
  handling sit in one place, reusable by later ingresses instead of duplicated
  per client. *(Revised from an initial client-owned design per review.)*
- **One central command endpoint** (new). `POST
  /api/conversations/:id/commands { input }` parses, dispatches, and executes,
  returning a structured `{ note? | error?, conversation? }`. Commands never
  become a `messages` row and never create an `agent_run` — they short-circuit
  the normal message path. No LLM cost, no approval gate.
- **Rename writes `conversations.title` directly** (extends). The `rename`
  command's `run` updates the same column the agent's `set_conversation_title`
  tool writes (`worker/src/tools.ts`), upserting the conversation row first so a
  never-messaged chat can still be named; the response echoes the new title so
  the client updates the header. Two writers, one column — fine.
- **Command feedback is ephemeral, inline** (reuses). The client renders the
  returned `note`/`error` as a transient, centered system line — reusing the
  local-only `history.push` pattern that surfaces `⚠️` errors (`Chat.tsx`). Not
  persisted; gone on reload. Commands are meta-actions, not conversation
  content.
- **Title is shown in the header** (extends). `App` holds a `title` state beside
  `conversationId`, fetched from a new `GET /api/conversations/:id`, and a
  successful `/rename` updates it from the command response (no refetch).
- **Discovery is registry-derived** (new, seam). `/help` lists the registry
  server-side. A `GET /api/commands` catalog (name/aliases/description/usage)
  for client autocomplete is reserved for when a client needs it — not built
  now.
- **The command module is extractable** (seam). It lives in the webserver for
  MVP; when Discord/voice need commands they import it as a shared Node package
  (or call the endpoint, §9). Not built now.
- **`set_conversation_title` tool stays** (reuses). Alfred can still rename
  itself; the command is an *additional* user-driven path, not a replacement.

## Goals

- Let the owner name/rename the current conversation directly, instantly, with
  no LLM cost and no approval prompt.
- Make the conversation title visible (header), so naming is meaningful.
- Establish a general command system — backend-owned, one implementation — that
  the next command (`/help` ships now; `/new`, `/stop`, etc. later) slots into
  by adding one registry entry.

## Non-goals

- A `/`-triggered autocomplete/command menu — `/help` covers discovery for now.
- Actually wiring cross-ingress reuse — the registry lives in the webserver;
  extraction to a shared package (or other ingresses calling the endpoint) is a
  reserved seam, not built here.
- Persisting command results into conversation history.
- Commands that interact with run state (e.g. `/stop` to cancel a live run) —
  the input is disabled while busy today; revisit when such a command lands.
- A conversation *list/switcher* UI (still post-MVP, §11) — rename names the
  one open conversation.

## Design

**Client — detect & forward (`Chat.send()`).** Before the existing
empty/`busy` guard, branch on the command form. The client does *no*
authoritative parsing — it only detects the prefix and forwards the raw line;
the backend tokenizes.

```ts
const text = input.trim()
if (text.startsWith('/')) {
  setInput('')
  const res = await fetch(`/api/conversations/${conversationId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: text }),
  })
  const r = (await res.json()) as {
    note?: string; error?: string; conversation?: { title: string }
  }
  if (r.conversation?.title) onTitleChange(r.conversation.title)
  pushSystemNote(r.note ?? r.error ?? 'Command failed')  // ephemeral, centered
  return                                                 // no message / run
}
```

`pushSystemNote` appends a transient, centered system line into `history` (a
new lightweight render path — *not* an Alfred bubble, since it isn't Alfred
talking).

**Backend — command module (`services/webserver/src/commands.ts`).** A flat
registry plus a single `executeCommand` that strips the leading `/`, splits the
first whitespace-delimited token as the (lowercased) command name, treats the
remainder as the `args` string, and looks the name up by `name` or `aliases`.
Unknown → `{ error: 'Unknown command "/foo". Try /help.' }`.

```ts
type CommandContext = { conversationId: string; db: Database }
type CommandResult = {
  note?: string
  error?: string
  conversation?: { title: string }   // effects the client should apply
}
type Command = {
  name: string
  aliases?: string[]
  description: string                 // shown by /help
  usage?: string                      // e.g. '/rename <new title>'
  run: (args: string, ctx: CommandContext) => Promise<CommandResult>
}

const rename: Command = {
  name: 'rename',
  aliases: ['name'],
  description: 'Rename the current conversation.',
  usage: '/rename <new title>',
  async run(args, ctx) {
    const title = args.trim()
    if (!title) return { error: 'Usage: /rename <new title>' }
    if (title.length > 200) return { error: 'Title is too long (max 200).' }
    // Upsert users + conversation (same onConflictDoNothing shape as the
    // message POST), then set the title — so a never-messaged chat can be named.
    await ctx.db /* upsert owner + conversation */ .update(/* title */)
    return { note: `Renamed conversation to "${title}".`, conversation: { title } }
  },
}
```

`/help` is a registry-derived command listing each `name`/`usage`/`description`
as a `note`. The exported `COMMANDS` array is the single source of truth.

**Endpoints (`webserver/src/app.ts`).** `POST /api/conversations/:id/commands`
validates the id against `UUID_RE`, reads `{ input }`, and calls
`executeCommand`. Command-level outcomes (unknown command, usage error) return
**200** with `{ error }` (the client renders them as a note); only malformed
requests (bad id, missing `input`) are 4xx. Also add `GET
/api/conversations/:id` returning `{ id, title }` for the header.

**Title display (`App.tsx` / `Header`).** `App` gains `title` state, fetched
via `GET /api/conversations/:id` whenever `conversationId` changes (reset to
`null` on `+ New conversation`). The header renders the title inline after the
nav on the chat route, muted and truncated (nothing / a muted "New
conversation" when null). `onTitleChange` is passed into `Chat` and called from
the command response so a successful rename updates the header without a
refetch.

A leading `/` the owner actually wants to *send* to Alfred (rare) needs no
escape: an unknown `/word` yields the inline "unknown command" note and the
owner rephrases. (A `//` → literal-slash escape can be added later if it ever
bites.)

**No new tables, no migration.** Everything writes the existing
`conversations.title`; the registry is in-process module state.

## Alternatives considered

- **Pure client-owned registry (the initial draft).** Commands defined *and*
  executed in the web client, rename via a thin `PATCH /api/conversations/:id`.
  Simplest and zero round-trip, but the registry would be reimplemented per
  client and dynamic/complex argument handling would live in the browser.
  Rejected in review in favor of a backend-owned registry reusable across
  clients.
- **Drive the existing `set_conversation_title` tool.** Single rename
  implementation, but that tool is approval-gated and run-scoped; a user rename
  shouldn't need approval or a fabricated run. Rejected.
