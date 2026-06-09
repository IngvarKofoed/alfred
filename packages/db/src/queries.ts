import { OWNER_USER_ID } from './constants.js'
import { type Db } from './client.js'
import { conversations, users } from './schema.js'

// A Db handle or a transaction handle — so helpers can run standalone or inside a caller's
// transaction (e.g. the message ingress, which seeds the conversation in the same tx as the
// message + run).
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

// Seed the owner user + the conversation row (idempotent), the one place that shape lives —
// shared by the message ingress and the /rename command so they can't drift. When `title` is
// given, it's folded into the same upsert (set on conflict), so naming a brand-new or an
// existing conversation is a single atomic statement. ingress/channelKey default to the web
// shape (channelKey = conversationId); a future ingress passes its own.
export async function ensureConversation(
  db: DbOrTx,
  conversationId: string,
  opts: { ingress?: string; channelKey?: string; title?: string } = {},
): Promise<void> {
  const { ingress = 'web', channelKey = conversationId, title } = opts
  await db.insert(users).values({ id: OWNER_USER_ID, displayName: 'Owner' }).onConflictDoNothing()
  const insert = db
    .insert(conversations)
    .values({
      id: conversationId,
      userId: OWNER_USER_ID,
      ingress,
      channelKey,
      ...(title !== undefined ? { title } : {}),
    })
  await (title !== undefined
    ? insert.onConflictDoUpdate({ target: conversations.id, set: { title } })
    : insert.onConflictDoNothing())
}
