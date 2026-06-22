import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { uuidv7 } from 'uuidv7'

// First slice of the schema (build-order step 2). The authoritative, full column
// model lives in docs/DATABASE.md; agent_runs / tool_calls / user_interactions
// arrive with the worker (step 3), memory_facts with long-term memory (step 10).
// IDs are UUIDv7 generated in app so they are time-ordered regardless of the
// Postgres version.

export const users = pgTable('users', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    ingress: text('ingress').notNull(), // 'web' | 'discord' | 'voice' | 'trigger'
    channelKey: text('channel_key').notNull(),
    title: text('title'),
    // The automation this conversation belongs to (per-fire watcher conversations, spec
    // 2026-06-20). Nullable: NULL ⇒ a normal conversation (web/discord/voice/legacy trigger).
    // Set ⇒ this conversation was created by an automation escalation; run.ts resolves the
    // automation from here for the scratchpad scope (automation:<id>) and the cursor-commit
    // gate — for EVERY run in the conversation, so a follow-up reply recalls the same
    // scratchpad. A watcher now has MANY conversations (one per fire), so the automation link
    // lives here, not on automations.conversation_id (which becomes a jump-to-latest pointer).
    // FK → automations.id is a circular table dependency with automations.conversation_id; the
    // migration ADDs the column + constraint after both tables exist (Drizzle's () => thunk
    // tolerates the forward ref at the type level).
    automationId: uuid('automation_id').references((): AnyPgColumn => automations.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // unique(ingress, channel_key) was DROPPED (multi-surface spec 2026-06-21, migration 0013):
    // Discord post→conversation routing moved from conversations.channel_key to the
    // conversation_surfaces binding table. `ingress` now records only where a conversation was
    // BORN (origin metadata; still drives human_in_loop) and `channel_key` is just that origin's
    // key (web: =id self-ref; discord-born: the channel id; trigger: =id self-ref) — neither is
    // a uniqueness/routing key any more, so a conversation can have a Discord presence (a
    // conversation_surfaces row) without changing its ingress.
    index('conversations_user_last_active_idx').on(t.userId, t.lastActiveAt.desc()),
    // Recurring watcher runs resolve their automation by this column per run, so index it.
    index('conversations_automation_idx').on(t.automationId),
  ],
)

// conversation_surfaces: the Discord-post → conversation routing index (multi-surface spec
// 2026-06-21). Replaces unique(ingress, channel_key) as the resolution key for Discord. A row
// binds a surface's external key (a Discord forum-post/thread channel id) to its canonical
// conversation; `unique(surface, external_key)` makes that mapping 1:1 so a reply in a post
// resolves to exactly one conversation. v1 holds only surface='discord' rows — web/iOS/voice
// resolve by conversation_id directly (no binding row), so this is effectively "the Discord
// materialization index," not yet a general N-surface registry. Written explicitly: on pull-to-
// Discord (bot creates the post) and at watcher per-fire materialization (replacing the old
// repointConversationChannel). The conversation's own id never changes, so web deep-links + the
// all-ingress sidebar are unaffected.
export const conversationSurfaces = pgTable(
  'conversation_surfaces',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    surface: text('surface').notNull(), // 'discord' (v1); future 'web'/'voice' if they ever need a binding
    externalKey: text('external_key').notNull(), // the surface's external id (Discord: post/thread channel id)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The routing index: a Discord post id → its conversation, 1:1.
    unique('conversation_surfaces_surface_external_key_unique').on(t.surface, t.externalKey),
    // Reverse lookup: every surface bound to a conversation (bot boot standing-LISTEN re-establish).
    index('conversation_surfaces_conversation_idx').on(t.conversationId),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    role: text('role').notNull(), // 'user' | 'assistant' | 'tool' | 'system'
    content: jsonb('content').notNull(), // structured: text, attachments, tool_use, tool_result
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_created_idx').on(t.conversationId, t.createdAt)],
)

// message_surface_refs: mirror-idempotency ledger (multi-surface spec 2026-06-21). Records which
// messages have already been rendered to which surface (and the surface's id for the rendered
// artifact — e.g. the Discord message id, so an edit can target it), so the bot never re-posts a
// message already present in a bound Discord post (its own renders, or Discord-originated turns).
// `unique(message_id, surface)` keeps one ref per (message, surface) — at-most-once mirroring per
// surface. No bridge process: the bot writes these as it mirrors. external_id is nullable for
// surfaces that don't return an addressable artifact id (kept open; v1 Discord always has one).
export const messageSurfaceRefs = pgTable(
  'message_surface_refs',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id),
    surface: text('surface').notNull(), // 'discord'
    externalId: text('external_id'), // the rendered artifact's id on the surface (Discord message id); nullable
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('message_surface_refs_message_surface_unique').on(t.messageId, t.surface),
    index('message_surface_refs_message_idx').on(t.messageId),
  ],
)

// agent_runs: one row per job. Full columns per docs/DATABASE.md, but this step only
// uses statuses pending -> running -> done | failed (awaiting_* arrive with tools).
// The partial unique index enforces one active run per conversation (ARCHITECTURE §7.6).
const ACTIVE = sql`status in ('pending', 'running', 'awaiting_approval')`

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    triggerMessageId: uuid('trigger_message_id').references(() => messages.id),
    status: text('status').notNull(), // 'pending' | 'running' | 'done' | 'failed' (| 'awaiting_approval' | 'cancelled' later)
    model: text('model'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    speak: boolean('speak').notNull().default(false), // voice runs (POST .../audio) set this true; the worker reads it to gate TTS (spec 2026-06-14)
    // Whether a human is watching this run (ARCHITECTURE §7.7, autonomous-watchers spec).
    // Derived from ingress: interactive ingresses (web/voice) → true; 'trigger' → false. The
    // worker reads it to select overflow + approval-timeout behaviour at the edges. Defaults
    // true so every existing interactive run is unchanged; only createAutomationRun sets it false.
    humanInLoop: boolean('human_in_loop').notNull().default(true),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    index('agent_runs_conversation_started_idx').on(t.conversationId, t.startedAt.desc()),
    index('agent_runs_active_status_idx').on(t.status).where(ACTIVE),
    uniqueIndex('agent_runs_one_active_per_conversation').on(t.conversationId).where(ACTIVE),
  ],
)

// llm_calls: one row per provider stream() call, for observability (see the
// observability spec). The detail a trace needs, kept out of agent_runs itself.
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRuns.id),
    toolCallId: uuid('tool_call_id').references(() => toolCalls.id), // set ⇒ call made by this tool outside the loop; null ⇒ an agent-loop call
    model: text('model').notNull(),
    request: jsonb('request').notNull(), // the Message[] sent to the provider
    tools: jsonb('tools'), // the function declarations offered to the model this call (name/description/parameters)
    responseText: text('response_text').notNull().default(''),
    responseToolCalls: jsonb('response_tool_calls'), // the tool_use calls the model returned this call (id/name/args)
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    finishReason: text('finish_reason'),
    latencyMs: integer('latency_ms').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('llm_calls_run_created_idx').on(t.agentRunId, t.createdAt)],
)

// tool_calls: one row per tool invocation, the audit trail (ARCHITECTURE §16).
// status: pending -> running -> done | failed (read), or pending -> awaiting_user ->
// running -> done | failed | rejected (write/destructive). trust_tier is declared in
// code for built-ins, never server-declared (§7.3).
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRuns.id),
    toolName: text('tool_name').notNull(),
    args: jsonb('args').notNull(),
    result: jsonb('result'), // nullable until completion
    trustTier: text('trust_tier').notNull(), // 'read' | 'write' | 'destructive'
    status: text('status').notNull(), // 'pending' | 'awaiting_user' | 'running' | 'done' | 'rejected' | 'failed'
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [index('tool_calls_run_started_idx').on(t.agentRunId, t.startedAt)],
)

// tools: the worker-published tool catalog + the owner's per-tool approval setting
// (ARCHITECTURE §16 + the tools-page spec). The worker upserts the catalog columns at boot,
// derived from its live Tool instances (no drift); require_approval is owner-owned and a
// tri-state: null = use the trust-tier default, true = force approval, false = skip approval.
export const tools = pgTable(
  'tools',
  {
    name: text('name').primaryKey(), // tool name, e.g. 'navigate'
    toolGroup: text('tool_group'), // nullable; e.g. 'browser' ('group' is awkward in SQL)
    trustTier: text('trust_tier').notNull(), // 'read' | 'write' | 'destructive'
    description: text('description').notNull().default(''),
    requireApproval: boolean('require_approval'), // tri-state; null = trust-tier default
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }), // when the owner last changed the setting
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tools_group_idx').on(t.toolGroup)],
)

// user_interactions: any moment the run pauses for user input (approval | question).
// status: pending -> resolved | timed_out | cancelled (single exit, conditional UPDATE).
// The partial pending index powers the "pending interactions" inbox lookup.
export const userInteractions = pgTable(
  'user_interactions',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRuns.id),
    toolCallId: uuid('tool_call_id').references(() => toolCalls.id), // the call that triggered this
    kind: text('kind').notNull(), // 'approval' | 'question'
    prompt: jsonb('prompt').notNull(), // structured; shape depends on kind
    response: jsonb('response'), // structured; nullable until resolved
    status: text('status').notNull(), // 'pending' | 'resolved' | 'cancelled' | 'timed_out'
    resolvedVia: text('resolved_via'), // nullable: 'web' | 'discord' | 'voice'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('user_interactions_run_idx').on(t.agentRunId),
    index('user_interactions_pending_idx')
      .on(t.status)
      .where(sql`status = 'pending'`),
  ],
)

// memory_facts: durable owner facts that span conversations — the "one Alfred, one
// memory" pillar (long-term memory spec, build-order step 10). v1 is plain rows: the
// agent writes via the `remember`/`forget` tools, recall is an automatic SELECT folded
// into the system prompt. `scope` defaults to 'global' (the only scope v1 reads), kept
// for future project / objective-scratchpad scopes (§7.7). The DATABASE.md `embedding`
// column is deliberately deferred — a real vector column needs the pgvector extension,
// which phase 2 adds alongside the column + index in one migration (ARCHITECTURE §6.4).
export const memoryFacts = pgTable(
  'memory_facts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    scope: text('scope').notNull().default('global'),
    text: text('text').notNull(),
    sourceRunId: uuid('source_run_id').references(() => agentRuns.id), // nullable; the run that saved it (provenance)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memory_facts_user_scope_idx').on(t.userId, t.scope)],
)

// automations: the configured watcher instances, one row per automation (trigger-abstraction
// spec 2026-06-19; was `triggers`). An automation = a chosen Trigger (`trigger`, the pluggable
// firing mechanism: 'email'|'timer'|'webhook') + its `params` + the action (`objective`) +
// notify policy + cursor state. The thin `alfred-triggers` scheduler reads enabled rows at boot
// and registers schedules; the worker's trigger-detect handler runs the Trigger's detect() and
// the Tier-1/Tier-2 ladder. A recurring watcher resolves to one persistent conversation
// (`conversationId`); a one-shot 'timer'/'self' automation carries the originating conversation.
//
// The old scalar `last_seen_signal` (a maxUid/count/hash reduction) is replaced by the opaque
// per-Trigger `cursor`: the framework stores it as jsonb and stages/commits it, but never
// interprets it — all cursor semantics live in the Trigger's detect(). `pending_cursor` is the
// cursor staged at escalation; run.ts commits `cursor ← pending_cursor` only when the escalated
// run reaches `done` (at-least-once: a crashed run re-delivers the same delta next tick). The old
// `gate` jsonb is dropped — Tier-0 detection moved into the worker triggerRegistry's detect().
export const automations = pgTable(
  'automations',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(), // human label
    trigger: text('trigger').notNull(), // the Trigger name: 'email' | 'timer' | 'webhook'
    enabled: boolean('enabled').notNull().default(true),
    // Was the persistent watcher conversation; per-fire spec (2026-06-20) repurposes it to a
    // "jump to latest" pointer at the MOST RECENT fire's conversation, updated on each escalation.
    // No longer the routing key — that moved to conversations.automation_id (a watcher now has many
    // conversations, one per fire). Still nullable (null until a watcher has fired / for a one-shot).
    conversationId: uuid('conversation_id').references(() => conversations.id),
    schedule: text('schedule'), // cron expr / poll cadence; null for webhook / one-shot timer
    params: jsonb('params'), // the Trigger's params, validated against its paramsSchema at create time
    triage: jsonb('triage'), // Tier-1: { enabled, model?, prompt? }; null ⇒ skip to action
    objective: text('objective').notNull(), // Tier-2 seed prompt (the action)
    notifyPolicy: text('notify_policy').notNull(), // 'always' | 'on_change' | 'on_threshold' | 'digest'
    cursor: jsonb('cursor'), // opaque per-Trigger detection cursor (replaces last_seen_signal); committed after a run succeeds
    pendingCursor: jsonb('pending_cursor'), // cursor staged at escalation; run.ts commits it to `cursor` on terminal done
    nextFireAt: timestamp('next_fire_at', { withTimezone: true }),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    detectionCostUsd: numeric('detection_cost_usd', { precision: 10, scale: 6 }).notNull().default('0'), // cumulative dismissed-detection cost
    sourceRunId: uuid('source_run_id').references(() => agentRuns.id), // nullable; provenance for agent-scheduled automations
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('automations_enabled_next_fire_idx').on(t.enabled, t.nextFireAt)],
)

// notifications: the durable push outbox (autonomous-watchers spec). SSE is fire-and-forget and
// dropped when no client is connected — exactly when a watcher fires — so a notify-worthy event
// (a finished trigger result, or an approval/question raised in an unattended run) writes a row
// here and NOTIFYs the 'notifications' channel; the worker's dispatcher loads it and pushes via
// Web Push. The payload is thin (title + body + deep_link); the full content lives in the
// conversation behind the deep link.
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    conversationId: uuid('conversation_id').references(() => conversations.id), // deep-link target (nullable)
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id), // nullable
    interactionId: uuid('interaction_id').references(() => userInteractions.id), // nullable (approval/question notifications)
    kind: text('kind').notNull(), // 'result' | 'approval' | 'question' | 'error'
    title: text('title').notNull(),
    body: text('body').notNull().default(''), // thin; the full content lives in the conversation
    deepLink: text('deep_link').notNull(), // e.g. '/conversation/<id>'
    status: text('status').notNull(), // 'pending' | 'sent' | 'failed' | 'read'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    index('notifications_pending_idx')
      .on(t.status)
      .where(sql`status = 'pending'`),
  ],
)

// push_subscriptions: Web Push registrations, one row per device/browser (autonomous-watchers
// spec). The webserver inserts on /api/push/subscribe (keyed on endpoint); the dispatcher reads
// all rows for a user to fan a notification out to every device, and prunes a row on a 410 Gone.
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    endpoint: text('endpoint').notNull(),
    keys: jsonb('keys').notNull(), // { p256dh, auth }
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('push_subscriptions_endpoint_unique').on(t.endpoint)],
)
