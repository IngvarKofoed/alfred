# Alfred — Database Schema

Column-level data model for Alfred's Postgres database. This is the authoritative reference for table shapes; the surrounding data-layer rationale (why Postgres-only, pg-boss, LISTEN/NOTIFY, pgvector) lives in `ARCHITECTURE.md` §6, and the **state machines / invariants** that govern the `status` columns live in `ARCHITECTURE.md` §10.9.

Two logical schemas in the same Postgres database:

- `public` — application tables (owned by us, defined in Drizzle).
- `pgboss` — pg-boss's internal tables (auto-managed, we don't touch).

UUIDs everywhere (UUIDv7 for time-ordered IDs).

```
users
  id              uuid pk
  display_name    text
  created_at      timestamptz default now()
  -- A single row for now; schema is multi-user-ready so we don't have to
  -- refactor later.

conversations                -- the CANONICAL conversation (multi-surface spec 2026-06-21). One
                             -- logical thread the owner can start on any surface and continue on any
                             -- other; its id never changes, so web deep-links + the all-ingress
                             -- sidebar are stable across surface hops.
  id              uuid pk
  user_id         uuid fk → users.id
  ingress         text       -- 'web' | 'discord' | 'voice' | 'trigger' — ORIGIN METADATA ONLY now
                             -- (multi-surface spec 2026-06-21): records where the conversation was
                             -- BORN, and still derives human_in_loop ('trigger' ⇒ false). It is NO
                             -- LONGER the routing key — a conversation can gain a Discord presence
                             -- (a conversation_surfaces row) without its ingress changing.
  channel_key     text       -- the ORIGIN's key (multi-surface spec 2026-06-21: no longer unique /
                             -- a routing key — Discord post→conversation resolution moved to
                             -- conversation_surfaces). web/voice/trigger: <this conversation's own
                             -- uuid> (self-ref). discord-born: the originating <channel_id> (DM, or
                             -- a forum-post/thread id). Discord routing now reads conversation_surfaces,
                             -- not this column.
  title           text       -- nullable, auto-generated from first message
  automation_id   uuid fk → automations.id, nullable  -- per-fire watcher conversations (spec 2026-06-20,
                             -- migration 0012). NULL ⇒ a normal conversation. Set ⇒ created by an
                             -- automation escalation (createAutomationRun); run.ts resolves the
                             -- automation here (getAutomationForConversation) for the scratchpad scope
                             -- automation:<id> + the cursor-commit gate, for EVERY run in the
                             -- conversation (escalation + follow-up replies). The routing key for a
                             -- watcher's runs moved HERE from automations.conversation_id, because a
                             -- watcher now has many conversations (one per fire). FK ↔ automations.conversation_id
                             -- is circular; migration 0012 ADDs the column + constraint after both tables exist.
  created_at      timestamptz default now()
  last_active_at  timestamptz default now()
  -- unique(ingress, channel_key) was DROPPED (multi-surface spec 2026-06-21, migration 0013):
  -- a conversation may now be materialized on >1 surface, and Discord routing moved to
  -- conversation_surfaces. Neither ingress nor channel_key is a uniqueness/routing key any more.
  index (user_id, last_active_at desc)
  index (automation_id)      -- recurring watcher runs resolve their automation by this column per run

conversation_surfaces                -- BUILT (migration 0013) — the surface-binding index
                                     -- (multi-surface spec 2026-06-21). The Discord-post →
                                     -- conversation routing key that REPLACES the dropped
                                     -- unique(ingress, channel_key). One row binds a surface's
                                     -- external key to the canonical conversation it's materialized on.
  id              uuid pk
  conversation_id uuid fk → conversations.id
  surface         text not null      -- 'discord' (v1); future 'web'/'voice' if they ever need a binding
  external_key    text not null      -- the surface's external id (Discord: forum-post/thread channel id)
  created_at      timestamptz default now()
  unique (surface, external_key)     -- the routing index: a Discord post id → its conversation, 1:1
  index (conversation_id)            -- reverse lookup: the surface(s) a conversation is bound to (bot boot)

messages
  id                uuid pk
  conversation_id   uuid fk → conversations.id
  role              text     -- 'user' | 'assistant' | 'tool' | 'system'
  content           jsonb    -- structured: text parts, attachments, tool_use, tool_result
  created_at        timestamptz default now()
  index (conversation_id, created_at)

message_surface_refs                 -- BUILT (migration 0013) — the mirror-idempotency ledger
                                     -- (multi-surface spec 2026-06-21). Records which messages have
                                     -- already been rendered to which surface, so the Discord bot
                                     -- never re-posts a message already present in a bound post (its
                                     -- own live renders, or a Discord-originated turn). No bridge
                                     -- process — the bot writes these as it mirrors.
  id              uuid pk
  message_id      uuid fk → messages.id
  surface         text not null      -- 'discord'
  external_id     text               -- nullable; the rendered artifact's id on the surface (Discord
                                     -- message id) when there's a single one — null when a turn spans
                                     -- many Discord messages (the row's job is the has-it-been-rendered
                                     -- check, not edit targeting)
  created_at      timestamptz default now()
  unique (message_id, surface)       -- at-most-once mirroring per (message, surface)
  index (message_id)

agent_runs
  id                  uuid pk
  conversation_id     uuid fk → conversations.id
  trigger_message_id  uuid fk → messages.id, nullable
                              -- nullable because trigger ingresses have no user message
  status              text   -- 'pending' | 'running' | 'awaiting_approval'
                             -- | 'done' | 'failed' | 'cancelled'
  model               text   -- model id actually used
  prompt_tokens       int    default 0
  completion_tokens   int    default 0
  cost_usd            numeric(10, 6) default 0
  speak               boolean not null default false  -- run should synthesize TTS (set only by the /audio route)
  human_in_loop       boolean not null default true  -- derived from ingress (trigger ⇒ false); selects overflow + approval-timeout behaviour
  started_at          timestamptz
  finished_at         timestamptz
  error               text   -- nullable; set on failure
  index (conversation_id, started_at desc)
  index (status) where status in ('pending', 'running', 'awaiting_approval')
  -- one active run per conversation (the concurrency "actor", ARCHITECTURE §7.6):
  unique (conversation_id) where status in ('pending', 'running', 'awaiting_approval')

llm_calls                               -- one row per LLM provider call (observability)
  id                  uuid pk
  agent_run_id        uuid fk → agent_runs.id
  tool_call_id        uuid fk → tool_calls.id   -- nullable; set ⇒ call made by a tool outside the loop, null ⇒ an agent-loop call
  model               text
  request             jsonb         -- the Message[] sent to the provider (incl. the system message)
  tools               jsonb         -- nullable; function declarations offered this call (name/description/parameters)
  response_text       text
  response_tool_calls jsonb         -- nullable; tool_use calls the model returned this call (id/name/args)
  prompt_tokens       int default 0
  completion_tokens   int default 0
  cost_usd            numeric(10, 6) default 0   -- tokens × model price map (agent-core/pricing.ts)
  finish_reason       text          -- nullable
  latency_ms          int
  error               text          -- nullable
  created_at          timestamptz default now()
  index (agent_run_id, created_at)

tool_calls
  id                  uuid pk
  agent_run_id        uuid fk → agent_runs.id
  tool_name           text
  args                jsonb
  result              jsonb         -- nullable until completion
  trust_tier          text          -- 'read' | 'write' | 'destructive'
  status              text          -- 'pending' | 'awaiting_user' | 'running'
                                    -- | 'done' | 'rejected' | 'failed'
  started_at          timestamptz
  finished_at         timestamptz
  error               text
  index (agent_run_id, started_at)

user_interactions     -- any moment the run pauses for user input
  id                  uuid pk
  agent_run_id        uuid fk → agent_runs.id
  tool_call_id        uuid fk → tool_calls.id   -- the call that triggered this
  kind                text     -- 'approval' | 'question'
  prompt              jsonb    -- structured; shape depends on kind (see below)
  response            jsonb    -- structured; nullable until resolved
  status              text     -- 'pending' | 'resolved' | 'cancelled' | 'timed_out'
  resolved_via        text     -- nullable: 'web' | 'discord' | 'voice'
  created_at          timestamptz default now()
  resolved_at         timestamptz
  index (agent_run_id)
  index (status) where status = 'pending'
  -- partial index → fast "pending interactions" inbox lookup

tools                                 -- the worker-published tool catalog + owner approval setting
  name              text pk             -- tool name, e.g. 'navigate'
  tool_group        text                -- nullable; e.g. 'browser'
  trust_tier        text                -- 'read' | 'write' | 'destructive' (worker-published)
  description       text default ''
  require_approval  boolean             -- nullable tri-state: null = use trust_tier default,
                                        --   true = force approval, false = skip approval
  last_seen_at      timestamptz default now()  -- refreshed each boot publish
  updated_at        timestamptz         -- when the owner last changed require_approval
  created_at        timestamptz default now()
  index (tool_group)

memory_facts                          -- BUILT (migration 0009) as plain rows — the long-term
                                      -- memory v1 (ARCHITECTURE §6.4). No `embedding` column
                                      -- yet: a real vector column needs the pgvector extension,
                                      -- which phase 2 adds alongside the column + index in one
                                      -- migration. The `vector(1536)` is DEFERRED, not omitted.
  id              uuid pk
  user_id         uuid fk → users.id
  scope           text not null default 'global'  -- 'global' | future 'project:<name>'/scratchpad scopes; v1 reads only 'global'
  text            text not null
  source_run_id   uuid fk → agent_runs.id, nullable  -- the run that saved the fact (provenance)
  created_at      timestamptz default now()
  updated_at      timestamptz default now()
  index (user_id, scope)             -- recall reads by (user_id, scope); the pgvector index lands with the embedding column (phase 2)

automations                          -- BUILT (migration 0011, was `triggers`) — the configured
                                     -- watcher instances, one row per automation (ARCHITECTURE §9.4 /
                                     -- RUNTIME §7.7; trigger-abstraction spec
                                     -- docs/specs/2026-06-19-trigger-abstraction.md). An automation =
                                     -- a chosen Trigger (the pluggable firing mechanism) + its params
                                     -- + the action (objective) + notify policy + cursor state.
  id                 uuid pk
  user_id            uuid fk → users.id
  name               text                  -- human label
  trigger            text not null         -- the Trigger name: 'email' | 'timer' | 'webhook' (was `kind`)
  enabled            boolean not null default true
  conversation_id    uuid fk → conversations.id, nullable  -- per-fire spec (2026-06-20) repurposed this from "the persistent watcher conversation / routing key" to a "jump to latest" pointer at the MOST RECENT fire's conversation, updated by createAutomationRun on each escalation. NO LONGER the routing key — a watcher now has many conversations (one per fire), and run.ts resolves the automation from conversations.automation_id (getAutomationForConversation), not from here. Still nullable (null until a watcher has fired / for a one-shot).
  schedule           text                  -- nullable; cron expr / poll cadence; null for webhook / one-shot timer
  params             jsonb                 -- nullable; the Trigger's params, validated against its paramsSchema at create time (replaces `gate`)
  triage             jsonb                 -- nullable; Tier-1 triage { enabled, model?, prompt? }; null ⇒ skip to action
  objective          text not null         -- Tier-2 seed prompt (the action)
  notify_policy      text not null         -- 'always' | 'on_change' | 'on_threshold' | 'digest'
  cursor             jsonb                 -- nullable; opaque per-Trigger detection cursor (replaces last_seen_signal); the framework never interprets it — committed only after a run succeeds
  pending_cursor     jsonb                 -- nullable; cursor staged at escalation; run.ts commits cursor ← pending_cursor on terminal `done` (at-least-once)
  next_fire_at       timestamptz           -- nullable
  last_fired_at      timestamptz           -- nullable
  detection_cost_usd numeric(10, 6) default 0  -- cumulative dismissed-detection cost
  source_run_id      uuid fk → agent_runs.id, nullable  -- provenance for agent-scheduled automations
  created_at         timestamptz default now()
  updated_at         timestamptz default now()
  index (enabled, next_fire_at)

notifications                        -- BUILT (migration 0010) — the durable push outbox
                                     -- (autonomous triggers; spec as above)
  id                 uuid pk
  user_id            uuid fk → users.id
  conversation_id    uuid fk → conversations.id, nullable  -- deep-link target
  agent_run_id       uuid fk → agent_runs.id, nullable
  interaction_id     uuid fk → user_interactions.id, nullable  -- set for approval/question notifications
  kind               text not null         -- 'result' | 'approval' | 'question' | 'error'
  title              text not null
  body               text not null default ''  -- thin; the full content lives in the conversation
  deep_link          text not null         -- e.g. '/conversation/<id>'
  status             text not null         -- 'pending' | 'sent' | 'failed' | 'read'
  created_at         timestamptz default now()
  sent_at            timestamptz           -- nullable
  index (status) where status = 'pending'  -- fast "to-send" outbox lookup

push_subscriptions                   -- BUILT (migration 0010) — Web Push registrations, one row
                                     -- per device/browser (autonomous triggers; spec as above)
  id                 uuid pk
  user_id            uuid fk → users.id
  endpoint           text unique           -- the push service endpoint URL
  keys               jsonb                 -- { p256dh, auth }
  user_agent         text                  -- nullable
  created_at         timestamptz default now()
  unique (endpoint)
```

## Design notes

- **`tools` is worker-published catalog + owner setting in one row.** The worker upserts the catalog columns (`tool_group`, `trust_tier`, `description`, `last_seen_at`) at boot from its live `Tool` instances — so the catalog can't drift from what actually runs, and runtime-discovered MCP tools (§7.3) publish the same way. `require_approval` is owner-owned (set from the web Tools page) and the boot upsert never touches it. It's a tri-state: `null` ⇒ use the trust-tier default (write/destructive ask, read runs free); `true`/`false` ⇒ explicit override. The worker reads these per run to build its approval predicate (§16). A tool removed from code leaves a stale row (its setting persists harmlessly); rows are not pruned.
- **`user_interactions` is a generic pause-for-user table** that handles two kinds today (`approval`, `question`) and can absorb new kinds later (clarification, multi-step wizard) without schema churn. Both kinds share the same machinery: create row, surface through ingresses, wait for resolution, resume the run.
- **Approvals and questions split because the trigger differs**:
  - *Approval* is **runtime-injected**: the worker, about to invoke a `write`/`destructive` tool, creates an approval interaction *before* the tool runs. If rejected, the tool never runs.
  - *Question* is **agent-initiated**: the agent calls a built-in `ask_user` tool whose `invoke()` creates a question interaction and waits for the response, then returns the structured answer as the tool result.
- **`tool_calls.status`** carries `awaiting_user` while an interaction is open. The `tool_calls ← user_interactions` link gives the full context of *why* the run is paused.
- **`messages.content` as JSONB**, not plain text. Lets a single message carry text, attachments, tool-use blocks, tool-result blocks — matches the structure the LLM API returns and avoids fan-out tables for every variant.
- **Token + cost accounting on `agent_runs`** (rolled up from `llm_calls`) so cost views don't have to walk per-call rows.
- **`agent_runs.speak`** is set `true` only by the `POST /api/conversations/:id/audio` route (iOS voice, ARCHITECTURE §7.2/§9.1) — a second run-creating path alongside the `/messages` POST. The worker reads it at pickup to decide whether to synthesize TTS for the streamed reply; typed `/messages` runs leave it `false`, so text chat is unchanged.
- **`conversation_surfaces` is the surface-binding index** (multi-surface conversations, ARCHITECTURE §6/§9.2; spec `docs/specs/2026-06-21-multi-surface-conversations.md`). It replaces the dropped `unique(ingress, channel_key)` as the Discord-post → conversation routing key, so a *canonical* conversation can be materialized on more than one surface without flipping its `ingress`. A `(surface, external_key)` row (v1: `surface='discord'`, `external_key=<forum-post/thread channel id>`) binds a Discord post to its conversation, `unique(surface, external_key)` keeping that mapping 1:1. Web/iOS/voice resolve by `conversation_id` directly (no binding row), so v1 is effectively "the Discord materialization index," not yet a general N-surface registry. Two writers, both explicit: **pull-to-Discord** (the bot creates a `Conversations`-forum post and binds it — `bindConversationSurface`, behind the web `POST /api/conversations/:id/surfaces/discord` button + the Discord `/pull` command) and **watcher per-fire materialization** (the per-fire conversation stays `ingress='trigger'` and gains a binding instead of having its channel repointed — `bindConversationSurface` replaces the old `repointConversationChannel`). The bot reads `getConversationBySurface` (post→conversation), `getConversationSurfaceKey` (conversation→post, surviving a restart), and `listBoundConversations` (re-establish a standing LISTEN per bound conversation at boot); `listUnboundConversations` backs the `/pull` picker. The conversation id never changes, so web deep-links + the sidebar are unaffected.
- **`message_surface_refs` is the mirror-idempotency ledger** (multi-surface conversations; spec as above). A bound conversation's runs stream live into its Discord post via the bot's standing LISTEN, and its owner web/iOS user turn is mirrored in as a quoted "🧑 …" line — so the bot must never re-post a message already in the post (its own renders, or a Discord-originated turn). A `(message_id, surface)` row records that a message was rendered to a surface (`external_id` = the Discord message id when a turn maps to one, else null); `unique(message_id, surface)` keeps mirroring at-most-once per surface. `insertMessageSurfaceRef`/`hasMessageSurfaceRef` are the write/read halves; the bot writes refs as it mirrors history on pull, the owner's user turns, and each run's assistant/tool turns — no separate bridge process.
- **`memory_facts` is Alfred's one cross-conversation memory** (long-term memory v1, ARCHITECTURE §6.4; spec `docs/specs/2026-06-15-long-term-memory.md`). The table is the contract; v1 has one writer and one reader. **Write** = the agent-called `memory` tool family (`remember`/`forget`/`list_memories`, group `memory`) — every save is a `tool_calls` audit row, with `source_run_id` recording the run that wrote it. **Read** = `readMemoryFacts(db, userId, scope)` (`packages/db/queries.ts`), a plain `SELECT` the worker folds into the system prompt before the loop runs — recall is automatic, not a tool. v1 reads all `scope='global'` facts (`OWNER_USER_ID`, single-user); `readMemoryFacts` is the single seam phase-2 pgvector swaps (all facts → top-K by `embedding` distance), nothing else moving. `list_memories` reads via a deliberately-separate `listMemoryFacts` (management must keep seeing every fact when recall becomes top-K). A second writer (background auto-extraction) could land later into the same table with the read path untouched.
- **`automations` are the configured watcher instances** (autonomous triggers, ARCHITECTURE §9.4 / RUNTIME §7.7; trigger-abstraction spec `docs/specs/2026-06-19-trigger-abstraction.md`, was `triggers`) — one row per automation = **a chosen Trigger** (`trigger`, the pluggable firing mechanism — `email`|`timer`|`webhook`, a sibling abstraction to `Tool`, INGRESSES §9.4) + its `params` + the action (`objective`) + notify policy + cursor state. The thin `alfred-triggers` scheduler reads enabled rows and fires due ones via a pg-boss `trigger-detect` job (job/queue/`triggerId`-payload names kept operational; `triggerId` carries the `automations.id`); the worker's detect handler runs the **tiered detection ladder** (Tier 0 = the Trigger's `detect()`, replacing the old gate+reducer → Tier 1 cheap-model triage → Tier 2 full action run). `detect()` folds `(params, cursor) → (events, nextCursor)`: an empty `events` list is the free idle path. Detection writes **no `agent_runs` row** — only an *escalation* (Tier 2) creates the run + `boss.send('agent-run')`, so idle polls never litter the run log; dismissed-detection cost accrues on `detection_cost_usd`. `params`/`triage` drive the ladder; `objective` seeds the Tier-2 prompt; `notify_policy` decides whether a finished detection writes a notification. **Cursor lifecycle (replaces the old scalar `last_seen_signal`):** the framework never interprets the opaque `cursor` — all delta semantics live in `detect()`. On Tier-1 dismiss, `detect.ts` commits `cursor ← nextCursor` immediately (the events were evaluated and rejected). On escalation it **stages** `pending_cursor = nextCursor` and leaves `cursor` untouched; `run.ts` commits `cursor ← pending_cursor` (clearing `pending_cursor`) only when the escalated run reaches terminal `done` (via `commitAutomationCursorIfStaged`), gated on the run being the autonomous escalation (`human_in_loop=false`) — a follow-up reply never commits. A crashed/failed/cancelled run leaves both untouched, so the next detect tick re-reads the same `cursor`, recomputes the same delta, and re-escalates — **at-least-once** (this fixes email re-reporting/dropping: the old `gate` advanced the signal at detection time, dropping mail on crash). **Per-fire conversations (spec 2026-06-20):** each Tier-2 escalation now gets its OWN fresh conversation rather than appending to one persistent thread — `createAutomationRun` mints a new `conversations` row (`ingress='trigger'`, `channel_key=<its own id>`, `automation_id=<this automation>`, a fully-hidden `trigger_context`-only seed so Alfred speaks first) and points `automations.conversation_id` at it as a "jump to latest" convenience. The routing key is now **`conversations.automation_id`**, not `automations.conversation_id`: `run.ts` resolves the automation by `getAutomationForConversation(db, conv.id)` for every run in the conversation (the escalation AND any follow-up reply), so a reply recalls the same scratchpad. The Discord bot **binds** a per-fire conversation to its forum post via `bindConversationSurface` (a `conversation_surfaces(discord, post id)` row — multi-surface spec 2026-06-21, replacing the old `repointConversationChannel`, so the conversation keeps `ingress='trigger'` as origin and merely gains a Discord presence) so the report + approvals land natively. The **objective scratchpad** — `memory_facts` with `scope='automation:<id>'`, loaded into the run's `[system]` block instead of replaying history (RUNTIME §7.7) — stays keyed on the automation id, so continuity survives across the per-fire conversations. `source_run_id` records the run that called `create_automation` (was `schedule_self`).
- **`notifications` is a durable push outbox** (autonomous triggers; spec as above). `LISTEN/NOTIFY` + SSE is fire-and-forget live streaming — dropped when no client is connected, which is exactly when a watcher fires. A worker run writes an outbox row (a notify-worthy result, or an `approval`/`question`/`error` while `human_in_loop=false`) and NOTIFYs the separate `notifications` channel (not a conversation `RunEvent` — ARCHITECTURE §6.2); a worker-side dispatcher LISTENs, loads the row, and delivers it via Web Push to every `push_subscriptions` row for the user, marking it `sent`/`failed`. The payload is thin (title + `deep_link` into `/conversation/:id`) because tapping opens the full result + approval card over the normal chat UI.
- **`push_subscriptions` are Web Push registrations** (autonomous triggers; spec as above) — one row per device/browser, registered by the PWA after the owner enables notifications. The dispatcher prunes a row when the push service returns `410 Gone` (dead subscription).
- **`llm_calls` is the observability trace** — one row per provider call capturing the full exchange: the request `Message[]`, the `tools` (function declarations) offered, the response text **and** any `response_tool_calls` the model returned, plus tokens, **cost**, latency, errors. Rolled up onto `agent_runs` and surfaced on the web `/debug` page (which also joins the run's `tool_calls` to show executed-tool results + approval outcomes). Per-call `cost_usd` is computed at insert from `tokens × model price` (the price map lives in `packages/agent-core/pricing.ts`, not the DB — see DEPLOYMENT.md §13); the run's `cost_usd` is the sum of its calls'. A non-NULL `tool_call_id` marks an LLM call made by a tool outside the agent loop (NULL = an agent-loop call), which powers the per-tool cost breakdown on `/debug`. The same synthetic-`tool_call` + non-NULL-`tool_call_id` attribution covers `generate_image`, `auto_title`, **and the voice STT/TTS speech legs** (a `'stt'`/`'tts'` synthetic `tool_calls` row + a linked `llm_calls` row, written by the shared `recordOutOfLoopLlmCall` helper) — so each speech-leg's cost rolls into the run via the usual all-calls sum while `agent_runs.model` (derived from `tool_call_id IS NULL` rows only) stays the chat model, never a speech model. It's the in-Postgres alternative to Langfuse (ARCHITECTURE §17).
- **No `audit_log` table** — `agent_runs` + `tool_calls` + `user_interactions` form the audit log. Every action the agent took is a row with args, result, and (if applicable) the owner's response.
- **No `attachments` table yet** — file references go inline in `messages.content` as `{type: 'attachment', path: '...'}`. Promote to a real table the first time multiple messages need to share a file.
- **Status columns are governed by explicit state machines** — the legal transitions and cross-entity invariants for `agent_runs`, `tool_calls`, and `user_interactions` are specified in `ARCHITECTURE.md` §10.9, not left implicit in the runtime-flow prose of §10.

## Interaction prompt/response shapes

```ts
// Approval
prompt:   { summary: string; tool: string; args: object;
            trust_tier: 'read' | 'write' | 'destructive'; scope?: 'group' | 'call' }
            // trust_tier is usually write|destructive, but can be 'read' when the owner
            // forces approval on a read tool from the Tools page (the `tools` table, §16).
            // scope='group' ⇒ a task-scoped approval: granting it covers every call in the
            // tool's group (e.g. 'browser') for the rest of the run, not just this call
            // (ARCHITECTURE §16). Absent / 'call' ⇒ a single-call approval.
response: { approved: boolean; note?: string }
            // The resolving ingress (web) may also accept a `remember` flag on the POST body
            // (not stored on `response`): when approving, it persists the decision into
            // tools.require_approval=false — the same store the Tools page writes — so the
            // grant survives future runs/restarts. scope='group' remembers the whole group
            // (§16). Not part of the persisted response shape; it's a side effect at resolve.

// Question (mirrors AskUserQuestion-style structured prompts)
prompt:   {
  question: string
  options: { label: string; description?: string }[]
  multi_select: boolean
  allow_freeform: boolean
}
response: {
  selected_labels: string[]     -- empty if freeform only
  freeform_text?: string
}
```
