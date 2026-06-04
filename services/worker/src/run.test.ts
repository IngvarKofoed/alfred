import type { LlmProvider, StreamEvent } from '@alfred/agent-core'
import {
  agentRuns,
  conversations,
  getDb,
  llmCalls,
  messages,
  OWNER_USER_ID,
  pgNotify,
  toolCalls,
  userInteractions,
  users,
} from '@alfred/db'
import { and, asc, eq } from 'drizzle-orm'
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

// A fake provider scripted turn-by-turn (each stream() call replays the next batch).
function scriptedProvider(turns: StreamEvent[][]): LlmProvider {
  let turn = 0
  return {
    async *stream() {
      const events = turns[turn] ?? []
      turn++
      for (const ev of events) yield ev
    },
  }
}

// Poll for the pending approval the worker creates while it's blocked on requestApproval.
async function waitForPendingInteraction(
  db: ReturnType<typeof getDb>,
  runId: string,
): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const [row] = await db
      .select({ id: userInteractions.id })
      .from(userInteractions)
      .where(and(eq(userInteractions.agentRunId, runId), eq(userInteractions.status, 'pending')))
    if (row) return row.id
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('no pending interaction appeared')
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
      // FK order: user_interactions -> llm_calls -> tool_calls -> agent_runs ->
      // messages -> conversations
      await db.delete(userInteractions).where(eq(userInteractions.agentRunId, run!.id))
      await db.delete(llmCalls).where(eq(llmCalls.agentRunId, run!.id))
      await db.delete(toolCalls).where(eq(toolCalls.agentRunId, run!.id))
      await db.delete(agentRuns).where(eq(agentRuns.conversationId, convId))
      await db.delete(messages).where(eq(messages.conversationId, convId))
      await db.delete(conversations).where(eq(conversations.id, convId))
    }
  })

  it(
    'gates a write tool on approval: approve -> tool runs, run done',
    async () => {
      const db = getDb()
      const convId = crypto.randomUUID()

      await db
        .insert(users)
        .values({ id: OWNER_USER_ID, displayName: 'Owner' })
        .onConflictDoNothing()
      await db
        .insert(conversations)
        .values({ id: convId, userId: OWNER_USER_ID, ingress: 'web', channelKey: convId })
      const [userMsg] = await db
        .insert(messages)
        .values({ conversationId: convId, role: 'user', content: [{ type: 'text', text: 'rename it' }] })
        .returning()
      const [run] = await db
        .insert(agentRuns)
        .values({ conversationId: convId, triggerMessageId: userMsg!.id, status: 'pending' })
        .returning()

      // turn 1: ask to use the write tool; turn 2 (after approval): final text.
      const provider = scriptedProvider([
        [{ type: 'tool_call', id: 'call-1', name: 'set_conversation_title', args: { title: 'Renamed by test' } }],
        [{ type: 'text', text: 'Done — renamed it.' }],
      ])

      try {
        const runPromise = runJob(run!.id, { provider })

        // The worker blocks awaiting approval; approve it from "outside" (as the webserver would).
        const interactionId = await waitForPendingInteraction(db, run!.id)
        const [paused] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id))
        expect(paused!.status).toBe('awaiting_approval')

        await db
          .update(userInteractions)
          .set({ response: { approved: true }, status: 'resolved', resolvedVia: 'web', resolvedAt: new Date() })
          .where(eq(userInteractions.id, interactionId))
        await pgNotify(
          `conversation:${convId}`,
          JSON.stringify({ type: 'interaction_resolved', interactionId }),
        )

        await runPromise

        const [updated] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id))
        expect(updated!.status).toBe('done')

        const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId))
        expect(conv!.title).toBe('Renamed by test') // the gated tool actually ran

        const [call] = await db.select().from(toolCalls).where(eq(toolCalls.agentRunId, run!.id))
        expect(call!.toolName).toBe('set_conversation_title')
        expect(call!.status).toBe('done')

        // Observability (debug page): the trace captured the tools offered to the model and
        // the tool call it returned — not just the messages.
        const traceCalls = await db
          .select()
          .from(llmCalls)
          .where(eq(llmCalls.agentRunId, run!.id))
          .orderBy(asc(llmCalls.createdAt))
        const offered = traceCalls[0]!.tools as { name: string }[] | null
        expect(offered?.some((t) => t.name === 'set_conversation_title')).toBe(true)
        expect(offered?.some((t) => t.name === 'navigate')).toBe(true) // browser tools are offered too
        const returned = traceCalls[0]!.responseToolCalls as { name: string }[] | null
        expect(returned?.some((t) => t.name === 'set_conversation_title')).toBe(true)
      } finally {
        await db.delete(userInteractions).where(eq(userInteractions.agentRunId, run!.id))
        await db.delete(llmCalls).where(eq(llmCalls.agentRunId, run!.id))
        await db.delete(toolCalls).where(eq(toolCalls.agentRunId, run!.id))
        await db.delete(agentRuns).where(eq(agentRuns.conversationId, convId))
        await db.delete(messages).where(eq(messages.conversationId, convId))
        await db.delete(conversations).where(eq(conversations.id, convId))
      }
    },
    15_000,
  )
})
