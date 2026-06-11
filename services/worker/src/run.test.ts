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
import { and, asc, eq, inArray } from 'drizzle-orm'
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

      // Two llm_calls now: the agent-loop call (tool_call_id IS NULL) plus the out-of-loop
      // auto-title call (linked to a synthetic 'auto_title' tool_calls row, so rollupUsage's
      // model derivation excludes it — §7.5 auto-name).
      const trace = await db.select().from(llmCalls).where(eq(llmCalls.agentRunId, run!.id))
      expect(trace).toHaveLength(2)
      const loopCall = trace.find((t) => t.toolCallId === null)
      expect(loopCall!.responseText).toBe('hello world')
      // The title call is attributed to a tool_calls row, never null — that's what keeps it
      // out of agent_runs.model (the cost still rolls into agent_runs.cost_usd).
      const titleCall = trace.find((t) => t.toolCallId !== null)
      expect(titleCall).toBeTruthy()
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

  it('does not resurrect a cancelled run', async () => {
    const db = getDb()
    const convId = crypto.randomUUID()

    await db.insert(users).values({ id: OWNER_USER_ID, displayName: 'Owner' }).onConflictDoNothing()
    await db
      .insert(conversations)
      .values({ id: convId, userId: OWNER_USER_ID, ingress: 'web', channelKey: convId })
    // A pre-pickup cancel (§10.6): the route already wrote the terminal status before the
    // pg-boss job was delivered. The delivered job must no-op against it.
    const [run] = await db
      .insert(agentRuns)
      .values({ conversationId: convId, status: 'cancelled', finishedAt: new Date() })
      .returning()

    let streamCalled = false
    const provider: LlmProvider = {
      async *stream() {
        streamCalled = true
        yield { type: 'text', text: 'must never stream' }
      },
    }

    try {
      await runJob(run!.id, { provider })

      // Terminal states are absorbing (§10.9): still cancelled, never flipped to running.
      const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id))
      expect(after!.status).toBe('cancelled')
      expect(after!.startedAt).toBeNull()
      expect(streamCalled).toBe(false)

      const rows = await db.select().from(messages).where(eq(messages.conversationId, convId))
      expect(rows.some((r) => r.role === 'assistant')).toBe(false)
    } finally {
      await db.delete(llmCalls).where(eq(llmCalls.agentRunId, run!.id))
      await db.delete(agentRuns).where(eq(agentRuns.conversationId, convId))
      await db.delete(messages).where(eq(messages.conversationId, convId))
      await db.delete(conversations).where(eq(conversations.id, convId))
    }
  })

  it(
    'cancel mid-stream: route writes cancelled, worker aborts, persists nothing, status stands',
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
        .values({ conversationId: convId, role: 'user', content: [{ type: 'text', text: 'go' }] })
        .returning()
      const [run] = await db
        .insert(agentRuns)
        .values({ conversationId: convId, triggerMessageId: userMsg!.id, status: 'pending' })
        .returning()

      // A provider that, mid-stream, performs the cancel ROUTE's effect — the guarded
      // terminal write + the {type:'cancelled'} NOTIFY (the cascade is a no-op here: no
      // tool_calls or interactions exist mid-text-stream) — then, like the real SDK, dies
      // with a rejection once the worker's watcher has aborted the run's signal.
      const provider: LlmProvider = {
        async *stream(_messages, _tools, opts) {
          yield { type: 'text', text: 'partial ' }
          await db
            .update(agentRuns)
            .set({ status: 'cancelled', error: null, finishedAt: new Date() })
            .where(
              and(
                eq(agentRuns.id, run!.id),
                inArray(agentRuns.status, ['pending', 'running', 'awaiting_approval']),
              ),
            )
          await pgNotify(`conversation:${convId}`, JSON.stringify({ type: 'cancelled' }))
          // Wait for the NOTIFY -> watcher -> abort round-trip; fail loudly (not flakily)
          // if it never lands rather than hanging the suite.
          for (let i = 0; i < 200 && !opts?.signal?.aborted; i++) {
            await new Promise((r) => setTimeout(r, 50))
          }
          if (!opts?.signal?.aborted) throw new Error('cancel NOTIFY never aborted the run signal')
          throw new Error('stream aborted')
        },
      }

      try {
        await runJob(run!.id, { provider })

        // The route's terminal write stands. Not 'done' ⇒ the guarded done UPDATE lost ⇒ no
        // done NOTIFY (it is gated on that UPDATE winning); error stays null ⇒ the guarded
        // failed UPDATE lost ⇒ no error NOTIFY (gated the same way).
        const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id))
        expect(after!.status).toBe('cancelled')
        expect(after!.error).toBeNull()

        // The cancelled path persists nothing — the streamed 'partial ' text is discarded.
        const rows = await db.select().from(messages).where(eq(messages.conversationId, convId))
        expect(rows.some((r) => r.role === 'assistant')).toBe(false)

        // Exactly one llm_calls row: the aborted loop call (traced via finally). No
        // auto-title call ⇒ the cancelled finalization skipped it.
        const trace = await db.select().from(llmCalls).where(eq(llmCalls.agentRunId, run!.id))
        expect(trace).toHaveLength(1)
      } finally {
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
