import type { LlmProvider } from '@alfred/agent-core'
import { agentRuns, conversations, getDb, llmCalls, messages, OWNER_USER_ID, users } from '@alfred/db'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { textOf } from './messages.js'
import { runJob } from './run.js'

// A fake provider that streams a fixed reply — no network, no API key.
const fakeProvider: LlmProvider = {
  async *stream() {
    yield { type: 'text', text: 'hello ' }
    yield { type: 'text', text: 'world' }
  },
}

// Integration: requires a running Postgres with migrations applied. Skipped without
// POSTGRES_URL, so `pnpm test` stays green elsewhere. Cleans up after itself.
describe.skipIf(!process.env.POSTGRES_URL)('worker runJob', () => {
  it('runs a text turn, persists the assistant message, marks the run done', async () => {
    const db = getDb()
    const convId = crypto.randomUUID()

    await db.insert(users).values({ id: OWNER_USER_ID, displayName: 'Owner' }).onConflictDoNothing()
    await db
      .insert(conversations)
      .values({ id: convId, userId: OWNER_USER_ID, ingress: 'web', channelKey: convId })
    const [userMsg] = await db
      .insert(messages)
      .values({ conversationId: convId, role: 'user', content: [{ type: 'text', text: 'hi' }] })
      .returning()
    const [run] = await db
      .insert(agentRuns)
      .values({ conversationId: convId, triggerMessageId: userMsg!.id, status: 'pending' })
      .returning()

    try {
      await runJob(run!.id, { provider: fakeProvider })

      const [updated] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id))
      expect(updated!.status).toBe('done')

      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, convId))
        .orderBy(asc(messages.createdAt))
      const assistant = rows.find((r) => r.role === 'assistant')
      expect(assistant).toBeTruthy()
      expect(textOf(assistant!.content as never)).toBe('hello world')

      const trace = await db.select().from(llmCalls).where(eq(llmCalls.agentRunId, run!.id))
      expect(trace).toHaveLength(1)
      expect(trace[0]!.responseText).toBe('hello world')
    } finally {
      // FK order: llm_calls -> agent_runs -> messages -> conversations
      await db.delete(llmCalls).where(eq(llmCalls.agentRunId, run!.id))
      await db.delete(agentRuns).where(eq(agentRuns.conversationId, convId))
      await db.delete(messages).where(eq(messages.conversationId, convId))
      await db.delete(conversations).where(eq(conversations.id, convId))
    }
  })
})
