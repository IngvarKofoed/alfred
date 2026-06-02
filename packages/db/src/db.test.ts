import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from './client.js'
import { conversations, messages, users } from './schema.js'

const url = process.env.POSTGRES_URL

// Integration test: requires a running Postgres with migrations applied. Skipped when
// POSTGRES_URL is unset, so `pnpm test` stays green in environments with no database.
describe.skipIf(!url)('db integration', () => {
  it('round-trips a user -> conversation -> message', async () => {
    const db = createDb(url!)
    const ROLLBACK = Symbol('rollback')
    let seen: { content: unknown; convId: string } | undefined

    try {
      await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ displayName: 'Owner' }).returning()
        const [conv] = await tx
          .insert(conversations)
          .values({ userId: user!.id, ingress: 'web', channelKey: crypto.randomUUID() })
          .returning()
        const [msg] = await tx
          .insert(messages)
          .values({ conversationId: conv!.id, role: 'user', content: { text: 'hi' } })
          .returning()

        const rows = await tx
          .select()
          .from(messages)
          .innerJoin(conversations, eq(messages.conversationId, conversations.id))
          .where(eq(messages.id, msg!.id))

        seen = { content: rows[0]!.messages.content, convId: rows[0]!.conversations.id }
        throw ROLLBACK // abort the transaction so the DB stays pristine
      })
    } catch (err) {
      if (err !== ROLLBACK) throw err
    }

    expect(seen).toBeDefined()
    expect(seen!.content).toEqual({ text: 'hi' })
    expect(typeof seen!.convId).toBe('string')
  })
})
