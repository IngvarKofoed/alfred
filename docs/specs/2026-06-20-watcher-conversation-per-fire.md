# Per-fire automation conversations (Alfred-initiated + notified)

Today an automation (watcher) reuses **one persistent conversation** (`automations.conversation_id`)
and every Tier-2 escalation *appends* to it: a seed user-message (objective + fenced delta) then
Alfred's reply, forever. The owner expects the opposite — each escalation that reaches the generation
phase should land in a **new conversation whose first message is Alfred's report**, which they can
reply to and continue, plus an **actual notification** when it happens. This spec moves the autonomous
output model from "one persistent thread per watcher" (spec `2026-06-17-discord-conversation-model.md`)
to "one fresh, Alfred-initiated conversation per fire," with the existing notifications outbox as the
cross-surface fan-out.

## Key decisions

- **One new conversation per escalation** (diverges). `escalate()` (`services/worker/src/triggers/detect.ts`)
  creates a fresh conversation per fire instead of resolving `automations.conversation_id`. Diverges
  from the persistent-thread model (spec 2026-06-17). Applies to every escalation — recurring watcher,
  one-shot `timer`, and forced `run_automation` — so "reaches generation ⇒ its own thread" is uniform.
- **`conversations.automation_id`** (new, breaking DB). The per-fire conversation belongs to its
  automation. `run.ts` resolves the automation from the conversation for the scratchpad scope
  (`automation:<id>`) — so BOTH the escalation run AND any follow-up reply in that conversation get the
  watcher's scratchpad (owner choice). Replaces the old `getAutomationByConversation(automations.conversation_id)`
  lookup, which can't work once a watcher has many conversations. The cursor commit
  (`commitAutomationCursorIfStaged` on `done`) is gated on the run being the autonomous escalation
  (`human_in_loop=false`) with a staged `pending_cursor`; a follow-up (`human_in_loop=true`) never
  commits, so replies are side-effect-free on detection state.
- **Alfred speaks first via a fully-hidden seed** (extends; supersedes part of CHANGELOG 115). The seed
  message stores the objective + fenced delta as `trigger_context` content part(s) only — **no visible
  `text` part** — so the renderers show nothing and Alfred's reply is the first visible message. The
  worker still normalizes `trigger_context` → text for the model (`rowsToMessages`), so the model gets
  the same instruction + fenced delta it does today. (115 made the objective a *visible* part; per-fire
  Alfred-first hides it again.)
- **Notifications outbox is the cross-surface fan-out** (reuses). The watcher run already writes a
  `notifications` row on `done` (`maybeNotifyResult` → `notifyOutbox` → NOTIFY `notifications`). Web
  Push (the existing `notifications/dispatcher.ts`) deep-links to the new conversation; the Discord bot
  becomes a second consumer of the same channel.
- **Discord: a post per notification** (breaking, within `services/discord`). Retire the
  persistent-watcher-post reconcile + standing LISTEN + lazy-render (`reconciledTriggers`,
  `standingListens`, `openWatcherTarget`). Instead the bot LISTENs `notifications`; on a watcher result
  it **creates a new Watchers-forum post** (a new thread = a real Discord ping), posts the report read
  from the conversation's final assistant message, and repoints the conversation to
  `(ingress='discord', channel_key=<post id>)` so a reply continues it.
- **Cursor at-least-once unchanged** (reuses). Staging at escalation (`stageAutomationCursor`, keyed on
  the automation id) and commit-on-`done` are unchanged; only the commit's *automation lookup* moves
  from the conversation to `run.automation_id`.
- **Follow-up replies are interactive runs with the watcher's scratchpad** (extends). A reply in a
  per-fire conversation (web or Discord) goes through the normal message→run path
  (`human_in_loop=true`): streams, all tools, no cursor side effects — but because the conversation
  carries `automation_id`, it also recalls (and can write) the `automation:<id>` scratchpad, so
  "continue the conversation" stays aware of what the watcher knows.

## Goals

- Each escalation that reaches generation gets its own conversation, Alfred's report as the first
  (and only initial) message, repliable to continue.
- A real notification per fire: Discord native ping (new forum post) + Web Push (if subscribed).
- Preserve exactly-once detection (the per-Trigger cursor) and cross-fire continuity (the scratchpad).

## Non-goals

- **Live token streaming of watcher reports into Discord.** The report is posted once, on `done`
  (watchers are async; the new post is the alert). Interactive follow-ups still stream normally.
- **Digest batching / proliferation control.** The `notify_policy='digest'` path stays as-is; taming a
  high-frequency watcher's thread count is a future follow-up, not this spec.
- **Migrating existing watcher threads.** The current persistent posts/conversations stay as historical
  data; the new model applies to new fires.
- **Re-pointing when the bot is down.** A fire while `alfred-discord` is offline notifies via Web Push
  only (the conversation stays `ingress='trigger'`); no catch-up post is created later.

## Design

### The escalation (worker)

`escalate()` creates, in one transaction: a **new conversation** (`ingress='trigger'`,
`channel_key=<the new conversation id>`, `automation_id` set, title = the automation name), the hidden
seed message (`trigger_context` part(s) carrying the objective + `composeTriggerContext(events, hint)` —
no visible text), and the `agent_runs` row (`human_in_loop=false`). `createAutomationRun` takes the
automation id and the (now fully hidden) seed and creates the conversation; it no longer receives a
pre-existing `conversationId`. `automations.conversation_id` stops being the routing key — it's kept
(nullable) but repurposed to point at the *most recent* fire's conversation (a "jump to latest"
convenience), updated on each escalation. The one-active-run unique index is now per *fresh* conversation, so the coalesce-on-active
case (a prior run still busy) effectively can't collide; a slow run no longer blocks the next fire (a
behavior change worth noting — two fires of the same watcher can now run concurrently in separate
conversations).

### The run (worker, `run.ts`)

The automation is resolved from `conversations.automation_id` (not `getAutomationByConversation` on the
old persistent pointer):

- Conversation has an `automation_id` ⇒ load the automation. Scratchpad scope = `automation:<id>` for a
  recurring watcher (one-shot/`self` gets none, as today) — applied to EVERY run in the conversation, so
  a follow-up recalls/writes the same scratchpad. The system block carries the isTrigger framing (for the
  autonomous run) + the scratchpad; the hidden seed carries the objective + fenced delta (model input
  unchanged).
- Cursor commit on terminal `done` happens ONLY for the autonomous escalation run (`human_in_loop=false`)
  with a staged `pending_cursor`: `commitAutomationCursorIfStaged(conversation.automation_id, …)`, same
  staged-value guard. A follow-up (`human_in_loop=true`) skips it. (One autonomous run per per-fire
  conversation — the escalation — so this is unambiguous; all later runs there are owner replies.)
- `maybeNotifyResult` (autonomous run only) reads the automation's `notify_policy` and writes the outbox
  row with `deep_link=/conversation/<new id>`.
- No `automation_id` on the conversation ⇒ a normal run; none of the above applies.

### Notification fan-out

The `notifications` row + NOTIFY `notifications` is unchanged. Two consumers now LISTEN it:

1. **Web Push dispatcher** (`services/worker/src/notifications/dispatcher.ts`) — unchanged; pushes to
   every `push_subscriptions` row, deep-linking to the conversation.
2. **Discord bot** (`services/discord`) — new consumer. On a watcher-result notification (kind
   `result`/`error` with a watcher conversation), it creates a Watchers-forum post, reads the
   conversation's assistant message(s) for the run (text + workspace images, as the current renderer
   does), posts them, and repoints the conversation to the post. Approvals/questions raised mid-run
   (kind `approval`/`question`) still surface as their interactive components in that post.

Both firing is intended: each surface delivers if it can (Web Push only if subscribed; the Discord post
always when the guild is configured). The owner sees the report wherever they look, and either surface's
reply continues the same conversation.

### Discord follow-ups

After repoint, the post is an ordinary `(ingress='discord')` conversation. A reply *in the post* is
handled by the existing guild-forum `onMessageCreate` path (resolve conversation by channel id → create
a run → stream) — no standing LISTEN needed, because the owner's message is the trigger. This is why the
reconcile/standing-LISTEN machinery can be removed: it only existed to stream a run that had *no*
preceding owner message, which is now handled by posting the final report from the notification.

## Resolved decisions

These were the open forks; all settled with the owner:

- **Discord render: post the final report on `done`** (not live streaming) — simplest, removes the
  standing-LISTEN machinery, and the new post is itself the ping.
- **`automations.conversation_id`: keep, repurposed** to the most-recent fire's conversation (not dropped).
- **Proliferation: accepted for now** — Discord auto-archives idle posts; a `digest` policy is the deferred
  real mitigation.
- **Follow-up scratchpad: yes** — a reply in a per-fire conversation gets the `automation:<id>` scratchpad
  (this is why the automation link lives on the conversation, not the run).

## Alternatives considered

- **Approach C — keep one persistent thread, just fix Alfred-first + force a ping.** Much smaller (no new
  conversations, no `automation_id`, no Discord rework) but doesn't meet the ask: still one growing thread,
  and "continue" means replying in the shared thread rather than a fresh per-event conversation. Rejected
  by the owner.
- **Bot owns conversation creation from run-start (to keep live streaming).** Adds a chicken-and-egg between
  the surface-agnostic worker and the bot for no real gain — watcher reports are async, so post-final on
  `done` is simpler and still pings. Folded into the streaming open question above.
