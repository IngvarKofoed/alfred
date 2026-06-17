# Discord bot — second ingress

Alfred's second interactive ingress (build-order step 6, the end of MVP): a `discord.js`
bot the owner can DM (or @-mention) to reach the *same* Alfred — one identity, one memory,
one growing tool set — from Discord. The bot is a **direct-to-Postgres peer ingress** (§9):
it creates runs and resolves approvals against the database itself and `LISTEN`s the
conversation channel for streamed output, exactly as the webserver ingress does — no
dependency on `alfred-webserver` being up. Replies stream into a Discord message edited
~1×/sec; `write`/`destructive` tool calls surface as Approve/Reject buttons; images flow both
ways; `ask_user` questions render as native Discord components; and the chat-command registry
surfaces as Discord slash commands — all by reusing existing seams (the conversation workspace,
content parts, `user_interactions`, the command registry), with **no new agent-core surface area**.

## Key decisions

- **New `services/discord` process** (new). A standalone pm2 app `alfred-discord` (flipping
  the reserved row in `ecosystem.config.cjs` to built), modelled on `services/triggers`:
  `@alfred/discord`, deps `discord.js` + `@alfred/db` + `@alfred/shared`. Holds the persistent
  gateway WebSocket; no HTTP server.
- **Direct-to-Postgres, mirroring the webserver ingress** (reuses). The bot calls
  `createUserMessageRun` + `enqueueAgentRun` directly and opens its own `pg.Client` `LISTEN`
  on `conversation:<id>` — the same pattern the SSE route and `watchForCancel` already use.
  Routing through the webserver API (Approach B) was rejected: it couples Discord's liveness
  to the webserver and re-implements SSE consumption for no gain.
- **One persistent conversation per Discord channel** (extends). A DM or guild channel maps
  to one long-lived `conversations` row via `unique(ingress, channel_key)` with
  `channel_key = <discord channel id>`, so a DM thread is continuous across days. Needs a new
  `@alfred/db` helper `getOrCreateConversationByChannel(db, { ingress, channelKey })` —
  `ensureConversation` is keyed by the PK and can't look up by channel key.
- **Shared interaction-resolve writer** (extends). The first-writer-wins resolve
  (conditional `UPDATE … WHERE status='pending'` + the `interaction_resolved` NOTIFY),
  currently inline in the webserver's `writeResolution`, moves into `@alfred/db` as
  `resolveInteraction(db, id, { response, resolvedVia })`. The webserver becomes a thin caller
  (`resolvedVia: 'web'`); the bot calls it with `resolvedVia: 'discord'`. Kind-agnostic — it
  writes whatever `response` jsonb, so it serves both approvals (`{ approved }`) and questions
  (`{ selected_labels, freeform_text }`). One writer, no drift.
- **Images reuse the workspace + content parts** (reuses). Inbound: download the Discord
  attachment, write it under the conversation workspace via `resolveInWorkspace`, and pass
  `{ type:'image', path, mimeType }` parts to `createUserMessageRun` — the exact shape
  `POST /messages` builds, so the worker inlines them for the model unchanged. Outbound: on
  `done`, read the run's persisted image parts (reference form) off disk and upload them as
  Discord attachments. No image bytes ride NOTIFY; no agent-core change.
- **Owner-only, by user id** (reuses). Every gateway event is dropped unless
  `author.id === ALLOWED_DISCORD_USER_ID` (single-user, §12 — being the owner *is* the auth).
  Button clicks are re-checked the same way.
- **Subscribe before enqueue** (new). The bot `LISTEN`s the conversation channel *before*
  `enqueueAgentRun`, so a fast first `token` can't be missed (NOTIFY is fire-and-forget).
- **New config keys, inert when unset** (extends). `DISCORD_BOT_TOKEN` +
  `ALLOWED_DISCORD_USER_ID` added to the zod schema (optional, already in `.env.example`).
  Unconfigured, the process logs and idles (stays alive, connects nothing) rather than
  crash-looping under pm2 — mirrors the updater's inert-unless-enabled shape.
- **Continuity is free** (reuses). `GET /api/conversations` is already all-ingress
  (CHANGELOG 92, web Sidebar badges `discord`) and `maybeAutoTitle` is ingress-agnostic — so a
  Discord thread appears, titled, in the web history with no extra work.
- **Commands are native Discord slash commands over a shared registry package** (new). The
  existing backend command registry (`commands.ts` — `rename`, `help`) is extracted into a new
  `@alfred/commands` package (depending on `@alfred/db`) so the bot can register Discord
  *application (slash) commands* from it and dispatch them to the same `executeCommand` the web
  client uses — one registry, no drift. The webserver imports from `@alfred/commands` instead of
  its local file. Discord's `/` command UX *is* the chat-command surface here; there's no
  message-prefix parsing.

## Goals

- DM (or @-mention) Alfred on Discord and get a streamed reply from the same agent/memory.
- `write`/`destructive` actions pause for an in-Discord Approve/Reject decision; `ask_user`
  questions are answerable with native Discord components.
- Images work both ways — owner-attached images reach the model, Alfred's images come back.
- The Discord thread is one continuous conversation, visible in the unified web history.
- No agent-core changes — only ingress wiring, two shared `@alfred/db` helpers, and a new
  `@alfred/commands` package.

## Non-goals (v1)

- **In-Discord cancellation** — no Cancel button; a stuck conversation is freed from the web
  Stop button, which is conversation-scoped and works on the Discord run.
- **"Don't ask again"** from an approval (the `remember` flag) — Discord approvals only write
  the verdict; silence the tool from the web Tools page.
- **Non-image attachments** (PDFs, audio, arbitrary files) — only image attachments are
  ingested in v1; other attachment types are ignored with a one-line note.
- Guild/multi-channel management, reactions-as-UI (buttons supersede them). (Slash commands
  are now *in* — see *Slash commands*.)

## Design

### Process, config, gateway

`services/discord/src/index.ts` loads config, and if `DISCORD_BOT_TOKEN` or
`ALLOWED_DISCORD_USER_ID` is unset, logs `discord not configured; idling` and keeps the event
loop alive (no connect). Otherwise it logs in a `discord.js` `Client` with intents
`Guilds, GuildMessages, DirectMessages, MessageContent` (MessageContent is privileged — enable
it in the Discord developer portal). SIGINT/SIGTERM `client.destroy()` + exit.

### Inbound message flow (`messageCreate`)

1. Drop the event unless `author.id === ALLOWED_DISCORD_USER_ID`, it isn't the bot's own
   message, and it's a DM **or** mentions the bot. Strip the leading mention from the text.
2. `conversationId = getOrCreateConversationByChannel(db, { ingress:'discord', channelKey: message.channelId })`.
3. **Ingest image attachments** (see *Images — inbound*): each becomes a workspace file +
   `{ type:'image', path, mimeType }` part. The turn needs text **or** ≥1 image (else ignored).
4. Open the conversation's `LISTEN` (see *Streaming*), then
   `createUserMessageRun(tx, conversationId, [ ...(text?[{type:'text',text}]:[]), ...imageParts ])`
   + `enqueueAgentRun(runId)`. A unique-violation (23505, the one-active-run index) → reply
   "I'm still working on your last message" and stop (no duplicate run); the listener opened in
   this case is torn down.
5. Send a placeholder reply ("…") and hold its handle as the render target.

### Streaming & message length

The bot keeps **one shared `pg.Client`** that `LISTEN`s `conversation:<id>` per active run and
dispatches NOTIFY payloads by channel name to a per-conversation render state
`{ messages, buffer, editTimer }`. Events:

- `token` → append to `buffer`; a trailing-edge throttle edits the target message at most
  ~1×/1.5s (well under Discord's ~5-edits/5s/channel limit), always flushing the final state.
- `done` → final flush, then **upload any of the run's images** (see *Images — outbound*),
  then `UNLISTEN` + drop the render state.
- `error` → edit the message to the error text; teardown.
- `cancelled` → edit to "Cancelled."; teardown.
- `interaction_required` → render an approval or a question (below).
  `interaction_resolved` → disable the components. `title` / `usage` / `tool_call_*` /
  `tts_audio` → ignored (no Discord surface; `tool_call_*` may drive a transient typing
  indicator).

**>2000 chars:** when appending the next delta would exceed ~1900, the current message is
"sealed" and a new continuation message becomes the edit target; the final flush likewise
splits the buffer into ≤2000-char messages. (This complexity is the cost of streaming edits,
the trade we accepted by choosing live streaming over final-only.)

### Approvals

On `interaction_required` (kind `approval`) the bot `SELECT`s the `user_interactions` row and
posts a message rendering `prompt.summary`, `prompt.tool`, a compact `prompt.args`, and — for
`prompt.scope === 'group'` — a note that approving covers the whole task. Two buttons carry
`customId` `approve:<interactionId>` / `reject:<interactionId>`.

A single `interactionCreate` dispatcher handles every component (approval buttons, question
selects/buttons, freeform modal — §*Questions*), keyed by the `interactionId` embedded in the
`customId`. It first verifies `interaction.user.id === ALLOWED_DISCORD_USER_ID` (else an
ephemeral "not for you"). For an approval it calls
`resolveInteraction(db, interactionId, { response: { approved }, resolvedVia: 'discord' })`. That
shared helper does the conditional UPDATE + the `interaction_resolved` NOTIFY, so the parked
worker wakes and the group-scoped auto-approve (handled in the worker) just works — the bot only
supplies `approved`. The buttons are then replaced with a disabled, resolved state. A lost race
(already resolved on web, or timed out) → the UPDATE matches nothing → an ephemeral "already
resolved".

### Images

**Inbound** (`messageCreate`, step 3): for each `message.attachments` entry whose `contentType`
is a supported image type (reuse `imageMimeForExt`/`extForImageMime`) and size ≤10 MB (the
`POST /files` cap), `fetch(attachment.url)` → `Buffer`, write under
`resolveInWorkspace(conversationId, 'discord-<ts>-<stem>.<ext>')` (mkdir + writeFile, ext from the
validated mime — never the client filename), and collect a `{ type:'image', path, mimeType }`
part. These join the message content in step 4; the worker's existing history-inlining
(`rowsToMessages`) feeds them to the model. Non-image / oversized attachments are skipped with a
one-line note.

**Outbound** (on `done`): the run appended its assistant/tool turns to `messages` with image
parts stored in **reference form** (`{ type:'image', path, mimeType }`, blob-free). The bot
captured the latest `messages.id` before enqueue (step 4); on `done` it selects this
conversation's newer `assistant`/`tool` messages, collects their image parts, reads each from the
workspace (`resolveInWorkspace`), and uploads them as Discord attachments in a follow-up message.
(One active run per conversation, so no other run's images interleave.)

### Questions (`ask_user`)

On `interaction_required` (kind `question`) the bot `SELECT`s the row and renders
`prompt.question` plus components derived from its shape (`{ question, options[], multi_select,
allow_freeform }`):

- options present → a **StringSelectMenu** (`min_values 1`, `max_values` = option count when
  `multi_select`, else 1); each Discord option carries the prompt option's `label`/`description`.
- `allow_freeform` → an **"Other…" button** that opens a **Modal** with a single text input
  (mirrors the web client's "Other" choice, CHANGELOG 60). A pure-freeform question (no options)
  is just the modal button.

The shared `interactionCreate` dispatcher resolves on submit:
`resolveInteraction(db, id, { response: { selected_labels, freeform_text }, resolvedVia:'discord' })`
— `selected_labels` from the select, `freeform_text` from the modal. `resolveInteraction` is
kind-agnostic, so this is the same writer the approval path uses. Components are disabled once
resolved (or on an `interaction_resolved` from another surface).

### Slash commands

The backend command registry moves out of the webserver into a new `@alfred/commands` package
(depending on `@alfred/db`); the webserver imports from it instead of its local `commands.ts`. At
boot the bot registers Discord **application commands** from `listCommands()` — `/rename <title>`,
`/help` — as *global* commands so they work in DMs (accepting the ~up-to-an-hour propagation delay
on first registration).

A `ChatInputCommandInteraction` (owner-checked like every other event) resolves its channel to a
conversation (`getOrCreateConversationByChannel`), assembles the options into the registry's raw
`args` string, and calls `executeCommand`; the returned `note`/`error` is the ephemeral reply
(the `conversation.title` echo is web-only and ignored here). One registry, dispatched from both
the web `POST /commands` route and the Discord gateway. New `self`-style or destructive commands
are out of scope — the registry is `rename` + `help` today and grows on its own.

### Crash behaviour

Fail-and-restart (§7.6): the bot holds no durable state. If it restarts mid-run, the in-flight
listener and buffer are lost; the run still completes and persists server-side (visible in the
web app), but that Discord placeholder is never updated. Accepted for v1 — no reconciliation on
boot. A worker restart sweeps the run to `failed` as usual.

## Alternatives considered

- **Approach B — HTTP/SSE client of the webserver.** Bot calls existing routes + consumes the
  SSE endpoint; holds no DB access. Less new logic, but couples Discord to the webserver,
  re-implements SSE in Node, and still needs a channel→conversation mapping. Rejected — it
  diverges from §9's "ingresses talk directly to Postgres".
- **Approach C — final-reply-only (no streaming).** Same seam as A, but ignore `token` and post
  the full reply on `done` (splitting >2000). Simpler (no edit throttle, no mid-stream split),
  but loses the "watch it type" feel. Rejected in favour of streaming; it remains the obvious
  fallback if Discord's edit rate limits prove annoying.
