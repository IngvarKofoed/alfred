import { sql } from 'drizzle-orm'
import {
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
// model lives in docs/DATABASE.md; agent_runs / tool_calls / user_interactions /
// memory_facts arrive with the worker (step 3). IDs are UUIDv7 generated in app so
// they are time-ordered regardless of the Postgres version.

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
    model: text('model').notNull(),
    request: jsonb('request').notNull(), // the Message[] sent to the provider
    responseText: text('response_text').notNull().default(''),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    finishReason: text('finish_reason'),
    latencyMs: integer('latency_ms').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('llm_calls_run_created_idx').on(t.agentRunId, t.createdAt)],
)
