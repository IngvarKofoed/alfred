import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { terminateRuns } from './boss.js'
import { createDb } from './client.js'
import {
  deleteMemoryFact,
  deleteTrigger,
  insertMemoryFact,
  insertTrigger,
  listEnabledTriggers,
  listMemoryFacts,
  listTriggers,
  readMemoryFacts,
  setTriggerEnabled,
} from './queries.js'
import { agentRuns, conversations, messages, toolCalls, userInteractions, users } from './schema.js'

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

// Integration test for the §10.9 invariant-4 cascade (terminateRuns): the active run flips to
// the requested terminal status, its non-terminal tool_call fails with the given error, its
// pending interaction is cancelled — and rows already terminal (a done run / done tool_call)
// are untouched. Same rollback pattern as above, so the DB stays pristine.
describe.skipIf(!url)('terminateRuns', () => {
  it('cascades the active run and leaves terminal rows alone', async () => {
    const db = createDb(url!)
    const ROLLBACK = Symbol('rollback')
    let observed:
      | {
          activeId: string
          terminated: string[]
          second: string[]
          run: { status: string; error: string | null; finishedAt: Date | null }
          doneRun: { status: string; error: string | null }
          call: { status: string; error: string | null; finishedAt: Date | null }
          doneCall: { status: string; error: string | null }
          interaction: { status: string; resolvedAt: Date | null }
        }
      | undefined

    try {
      await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ displayName: 'Owner' }).returning()
        const [conv] = await tx
          .insert(conversations)
          .values({ userId: user!.id, ingress: 'web', channelKey: crypto.randomUUID() })
          .returning()
        // One active run (parked on an approval) and one already-terminal run — the partial
        // unique index allows exactly this shape (at most one active per conversation).
        const [active] = await tx
          .insert(agentRuns)
          .values({ conversationId: conv!.id, status: 'awaiting_approval' })
          .returning()
        const [done] = await tx
          .insert(agentRuns)
          .values({ conversationId: conv!.id, status: 'done' })
          .returning()
        const [pausedCall] = await tx
          .insert(toolCalls)
          .values({
            agentRunId: active!.id,
            toolName: 'send_email',
            args: {},
            trustTier: 'write',
            status: 'awaiting_user',
          })
          .returning()
        const [finishedCall] = await tx
          .insert(toolCalls)
          .values({ agentRunId: done!.id, toolName: 'echo', args: {}, trustTier: 'read', status: 'done' })
          .returning()
        const [pending] = await tx
          .insert(userInteractions)
          .values({
            agentRunId: active!.id,
            toolCallId: pausedCall!.id,
            kind: 'approval',
            prompt: { summary: 'Send the email?' },
            status: 'pending',
          })
          .returning()

        const activeWhere = and(
          eq(agentRuns.conversationId, conv!.id),
          inArray(agentRuns.status, ['pending', 'running', 'awaiting_approval']),
        )!
        const terminated = await terminateRuns(tx, {
          where: activeWhere,
          runStatus: 'cancelled',
          error: null,
          toolCallError: 'run cancelled',
        })
        // Re-running against the same (now terminal) conversation matches nothing → [].
        const second = await terminateRuns(tx, {
          where: activeWhere,
          runStatus: 'cancelled',
          error: null,
          toolCallError: 'run cancelled',
        })

        const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, active!.id))
        const [doneRun] = await tx.select().from(agentRuns).where(eq(agentRuns.id, done!.id))
        const [call] = await tx.select().from(toolCalls).where(eq(toolCalls.id, pausedCall!.id))
        const [doneCall] = await tx.select().from(toolCalls).where(eq(toolCalls.id, finishedCall!.id))
        const [interaction] = await tx
          .select()
          .from(userInteractions)
          .where(eq(userInteractions.id, pending!.id))
        observed = {
          activeId: active!.id,
          terminated,
          second,
          run: run!,
          doneRun: doneRun!,
          call: call!,
          doneCall: doneCall!,
          interaction: interaction!,
        }
        throw ROLLBACK // abort the transaction so the DB stays pristine
      })
    } catch (err) {
      if (err !== ROLLBACK) throw err
    }

    expect(observed).toBeDefined()
    expect(observed!.terminated).toEqual([observed!.activeId])
    expect(observed!.second).toEqual([])
    expect(observed!.run.status).toBe('cancelled')
    expect(observed!.run.error).toBeNull()
    expect(observed!.run.finishedAt).toBeInstanceOf(Date)
    expect(observed!.call.status).toBe('failed')
    expect(observed!.call.error).toBe('run cancelled')
    expect(observed!.call.finishedAt).toBeInstanceOf(Date)
    expect(observed!.interaction.status).toBe('cancelled')
    expect(observed!.interaction.resolvedAt).toBeInstanceOf(Date)
    // Terminal rows are absorbing (§10.9 invariant 1): the done run/call were not touched.
    expect(observed!.doneRun.status).toBe('done')
    expect(observed!.doneRun.error).toBeNull()
    expect(observed!.doneCall.status).toBe('done')
    expect(observed!.doneCall.error).toBeNull()
  })
})

// Integration test for the memory_facts helpers (long-term memory spec): insert a fact,
// read it back via both read paths, then delete it (owner-scoped). Same rollback pattern as
// above, so the DB stays pristine.
describe.skipIf(!url)('memory facts', () => {
  it('round-trips insert -> read/list -> delete', async () => {
    const db = createDb(url!)
    const ROLLBACK = Symbol('rollback')
    let observed:
      | {
          read: { id: string; text: string }[]
          list: { id: string; text: string }[]
          firstDelete: { deleted: boolean }
          secondDelete: { deleted: boolean }
          malformedDelete: { deleted: boolean }
          after: { id: string; text: string }[]
        }
      | undefined

    try {
      await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ displayName: 'Owner' }).returning()
        const { id } = await insertMemoryFact(tx, { userId: user!.id, text: 'Owner prefers tea over coffee' })

        const read = await readMemoryFacts(tx, user!.id, 'global')
        const list = await listMemoryFacts(tx, user!.id) // default scope = 'global'
        const firstDelete = await deleteMemoryFact(tx, { userId: user!.id, id })
        const secondDelete = await deleteMemoryFact(tx, { userId: user!.id, id }) // already gone
        // A model-hallucinated, non-UUID id is a clean miss, not a uuid-cast error.
        const malformedDelete = await deleteMemoryFact(tx, { userId: user!.id, id: 'not-a-uuid' })
        const after = await readMemoryFacts(tx, user!.id, 'global')

        observed = { read, list, firstDelete, secondDelete, malformedDelete, after }
        throw ROLLBACK // abort the transaction so the DB stays pristine
      })
    } catch (err) {
      if (err !== ROLLBACK) throw err
    }

    expect(observed).toBeDefined()
    expect(observed!.read).toEqual([{ id: expect.any(String), text: 'Owner prefers tea over coffee' }])
    expect(observed!.list).toEqual(observed!.read)
    expect(observed!.firstDelete).toEqual({ deleted: true })
    expect(observed!.secondDelete).toEqual({ deleted: false }) // owner-scoped delete is idempotent on a missing row
    expect(observed!.malformedDelete).toEqual({ deleted: false }) // non-UUID id → clean miss, never a uuid-cast throw
    expect(observed!.after).toEqual([])
  })
})

// Integration test for the trigger-management helpers (autonomous-watchers: list_triggers /
// disable_trigger / delete_trigger): insert a trigger, list it, disable it (drops out of the
// enabled list), then delete it — asserting owner-scoping (another user can't touch it) and the
// UUID guard. Same rollback pattern, so the DB stays pristine.
describe.skipIf(!url)('trigger management', () => {
  it('round-trips insert -> list -> disable -> delete (owner-scoped + UUID-guarded)', async () => {
    const db = createDb(url!)
    const ROLLBACK = Symbol('rollback')
    let observed:
      | {
          listed: { id: string; name: string; enabled: boolean }[]
          enabledBefore: { id: string }[]
          foreignDisable: { updated: boolean }
          disabled: { updated: boolean }
          enabledAfter: { id: string }[]
          malformedDelete: { deleted: boolean }
          foreignDelete: { deleted: boolean }
          firstDelete: { deleted: boolean }
          secondDelete: { deleted: boolean }
          after: { id: string }[]
        }
      | undefined

    try {
      await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ displayName: 'Owner' }).returning()
        const [other] = await tx.insert(users).values({ displayName: 'Other' }).returning()
        const { id } = await insertTrigger(tx, {
          userId: user!.id,
          name: 'Inbox watcher',
          kind: 'inbox',
          schedule: '*/10 * * * *',
          objective: 'Check for urgent unread mail',
          notifyPolicy: 'on_change',
        })

        const listed = await listTriggers(tx, user!.id)
        const enabledBefore = await listEnabledTriggers(tx, user!.id)
        // Owner-scoping: another user can neither disable nor delete it.
        const foreignDisable = await setTriggerEnabled(tx, { userId: other!.id, id, enabled: false })
        const disabled = await setTriggerEnabled(tx, { userId: user!.id, id, enabled: false })
        const enabledAfter = await listEnabledTriggers(tx, user!.id)
        // A non-UUID id is a clean miss (never a uuid-cast throw); a foreign owner can't delete.
        const malformedDelete = await deleteTrigger(tx, { userId: user!.id, id: 'not-a-uuid' })
        const foreignDelete = await deleteTrigger(tx, { userId: other!.id, id })
        const firstDelete = await deleteTrigger(tx, { userId: user!.id, id })
        const secondDelete = await deleteTrigger(tx, { userId: user!.id, id }) // already gone
        const after = await listTriggers(tx, user!.id)

        observed = {
          listed,
          enabledBefore,
          foreignDisable,
          disabled,
          enabledAfter,
          malformedDelete,
          foreignDelete,
          firstDelete,
          secondDelete,
          after,
        }
        throw ROLLBACK // abort the transaction so the DB stays pristine
      })
    } catch (err) {
      if (err !== ROLLBACK) throw err
    }

    expect(observed).toBeDefined()
    expect(observed!.listed).toHaveLength(1)
    expect(observed!.listed[0]!.name).toBe('Inbox watcher')
    expect(observed!.enabledBefore).toHaveLength(1)
    expect(observed!.foreignDisable).toEqual({ updated: false }) // owner-scoped
    expect(observed!.disabled).toEqual({ updated: true })
    expect(observed!.enabledAfter).toEqual([]) // disabled ⇒ no longer in the enabled list
    expect(observed!.malformedDelete).toEqual({ deleted: false }) // non-UUID ⇒ clean miss
    expect(observed!.foreignDelete).toEqual({ deleted: false }) // owner-scoped
    expect(observed!.firstDelete).toEqual({ deleted: true })
    expect(observed!.secondDelete).toEqual({ deleted: false }) // idempotent on a missing row
    expect(observed!.after).toEqual([])
  })
})
