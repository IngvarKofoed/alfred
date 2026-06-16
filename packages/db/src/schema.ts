import { sql } from 'drizzle-orm'
import {
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('conversations_ingress_channel_key_unique').on(t.ingress, t.channelKey),
    index('conversations_user_last_active_idx').on(t.userId, t.lastActiveAt.desc()),
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
