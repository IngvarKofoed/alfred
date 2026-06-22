# Multi-surface conversations (hop between web, iOS, and Discord mid-thread)

One logical conversation the owner can start on any surface (voice on iOS, typing on web) and continue
on any other — including seeing + continuing it in Discord — without it being trapped on the surface it
started on. Today a conversation is bound to exactly one ingress (`unique(ingress, channel_key)`); the
web/iOS client already aggregates all ingresses (full history), but Discord only shows conversations
that *are* Discord forum posts. This makes a conversation's **Discord presence** a separate, explicit,
lazily-created materialization — so any conversation can be pulled into Discord and continued there,
while ephemeral web chats never clutter it. Chosen from a brainstorm panel (Claude+Codex): "canonical
conversation + surface binding + lazy explicit materialization."

## Key decisions

- **`conversation_surfaces` binding table** (new). `(conversation_id FK, surface, external_key, created_at)`,
  unique on `(surface, external_key)`. It's the index from a Discord post → its conversation. v1 holds
  only `surface='discord'` rows; web/iOS/voice resolve by `conversation_id` directly (no binding row),
  so this is effectively "the Discord materialization index," not a general N-surface registry yet.
- **`conversations.ingress` becomes origin metadata; `unique(ingress, channel_key)` is dropped** (breaking).
  Discord post→conversation resolution moves from `conversations.channel_key` to `conversation_surfaces`.
  `ingress` stays (records where a conversation was born; still drives `human_in_loop`), but is no longer
  the routing key. (`channel_key` disposition is a migration detail — see Open questions.)
- **"Continue in Discord" is explicit + lazy** (new). A conversation gets a Discord post only on an
  owner action — a web button (`POST /api/conversations/:id/surfaces/discord`) and a Discord `/pull`
  command listing recent conversations. Never automatic. This is the clutter answer.
- **Reuse the per-fire watcher Discord machinery** (extends). Creating the post + rendering a run into it
  is exactly what the per-fire notifications-consumer + `createForumPost` already do (spec
  2026-06-20). "Pull to Discord" creates the post and writes a `conversation_surfaces` row instead of
  the watcher path's `repointConversationChannel`.
- **A bound conversation gets a standing LISTEN** (extends, reverses part of per-fire). The bot
  re-subscribes to every bound conversation's channel on boot (from `conversation_surfaces`) and renders
  its runs live into the post — reusing the existing interactive `renderByChannel` streaming. (The
  per-fire change removed standing LISTENs for watchers; this re-adds them, but only for the small,
  curated set of *explicitly bound* conversations.)
- **`message_surface_refs` for mirror idempotency** (new). `(message_id, surface, external_id)` records
  which messages have been rendered to which surface, so mirroring a web-originated message/run into a
  bound post is dedup'd and edits/ordering stay idempotent — without a separate bridge process.
- **Active-run invariant + approvals unchanged** (reuses). The partial unique index still enforces one
  active run per `conversation_id`; a second surface's input while busy is rejected as today
  ("Alfred is working"). Approvals/questions already broadcast via `user_interactions` + NOTIFY, so web
  cards and Discord buttons both go live and first-responder wins — it just works once bound.
- **Watcher per-fire conversations fold into this model** (extends). A watcher conversation becomes
  "a conversation auto-bound to Discord" (a `conversation_surfaces` row, written at materialization
  instead of the repoint); its post-final notifications render is the autonomous variant of the same
  path. `conversations.automation_id` stays as-is.

## Goals

- Pull any web/iOS conversation into Discord on demand and continue it there; replies on either surface
  append to the one conversation.
- Web/iOS keep showing full history with no change (they already aggregate all ingresses).
- Don't clutter Discord — only explicitly-pulled (and watcher) conversations get posts.

## Non-goals

- **General N-surface abstraction.** v1 is web-family + Discord. iOS/voice already ride the web API, so
  Discord is the only surface needing a binding. A surface registry/`SurfaceProjector` is deferred.
- **Eager mirroring of every conversation into Discord.** Materialization is explicit.
- **A separate bridge daemon.** Mirroring stays in the existing bot process (rejected in the panel).
- **Pushing web/iOS to render Discord-only content** — they read the DB; no change needed.

## Design

### Binding & resolution

`conversation_surfaces` replaces `unique(ingress, channel_key)` as the Discord routing key.
`getOrCreateConversationByChannel(discord, postId)` (used by the bot's `onMessageCreate`) resolves via
`conversation_surfaces WHERE surface='discord' AND external_key=postId`. A web/iOS conversation has no
row until pulled; once pulled, a row points its post at the conversation. The conversation's `id` never
changes, so web deep-links and the sidebar are unaffected.

### Pull-to-Discord

On the explicit action: create a `Conversations`-forum post (reuse `createForumPost`), insert a
`conversation_surfaces(discord, postId)` row, mirror the **last ~20 messages** into the post (with an
"earlier on web →" note, so it reads as a real thread without a huge backfill or Discord rate-limit
risk), and open a standing LISTEN on the conversation channel. From then on it's an ordinary bound
conversation.

### Mirroring (bidirectional)

- **Discord → everywhere:** already works — a reply in the post is an `onMessageCreate` run; web/iOS show
  it from the DB.
- **Web/iOS → Discord:** for a bound conversation, the bot's standing LISTEN renders the run live into
  the post via the existing `renderByChannel` path; the owner's web/iOS *user* message is mirrored in as
  a quoted line ("🧑 …") before the reply streams. `message_surface_refs` ensures the bot never
  re-posts a message already present in the post (its own renders, or Discord-originated turns).

### Invariants

One active run per `conversation_id` is unchanged; concurrent input from a second surface hits the
existing busy-reject. Approvals/questions: the worker's `interaction_required` NOTIFY already reaches
every subscriber, so a bound Discord post shows the buttons and the web shows the card simultaneously;
the first-responder conditional UPDATE resolves it and the other surface tears down — no new work.

### Migration

Add `conversation_surfaces` + `message_surface_refs`; backfill one `conversation_surfaces(discord,
channel_key)` row for every existing `ingress='discord'` conversation (incl. the per-fire watcher posts);
drop `unique(ingress, channel_key)`. Repoint the bot's discord resolution + the notifications-consumer
to the binding table. Existing web/voice/trigger conversations need no binding row (resolved by id).

## Resolved decisions

The open forks, all settled with the owner (each at the recommended default):

- **Data model: the binding table** — not the lighter repoint-reuse. The clean canonical-conversation +
  `conversation_surfaces` model, accepting the larger migration over the most central table. (The
  repoint-reuse is recorded under Alternatives as the smaller path not taken.)
- **Render: live streaming** into a pulled conversation's post via a standing LISTEN (reusing the
  interactive render); watcher conversations stay post-final.
- **History backfill: last ~20 messages + an "earlier on web →" note** (not the full thread).
- **Triggers: a web button + a Discord `/pull` command** for v1 (iOS deferred — it shares the web
  endpoint, so the button covers it).

## Alternatives considered

- **Generalize the repoint (no binding table).** The minimal v1 — see the lead open question. Same UX,
  far less work, slight `ingress`-overwrite wart; rated lower in the panel for not being a clean general
  model but genuinely viable for web-family + Discord.
- **Discord as a pure projection (drop `ingress` identity entirely).** Panel idea; rejected because
  `ingress` still carries signal (`human_in_loop`, origin) we don't want to lose.
- **Room + memberships / bridge daemon.** Most general / most robust sync, but too many moving parts for
  a single-user Postgres-only system (panel-rejected: daemon scored lowest).
