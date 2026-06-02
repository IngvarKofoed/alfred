import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
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
