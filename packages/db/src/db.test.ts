import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { terminateRuns } from './boss.js'
import { createDb } from './client.js'
import {
  advanceAutomationCursor,
  commitAutomationCursorIfStaged,
  deleteMemoryFact,
  deleteTrigger,
  getAutomation,
  insertAutomation,
  insertMemoryFact,
  latestRunIdForConversation,
  listEnabledAutomations,
  listMemoryFacts,
  listTriggers,
  markAutomationFired,
  readLastAssistantText,
  readMemoryFacts,
  setTriggerEnabled,
  stageAutomationCursor,
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
        const { id } = await insertAutomation(tx, {
          userId: user!.id,
          name: 'Inbox watcher',
          trigger: 'email',
          schedule: '*/10 * * * *',
          objective: 'Check for urgent unread mail',
          notifyPolicy: 'on_change',
        })

        const listed = await listTriggers(tx, user!.id)
        const enabledBefore = await listEnabledAutomations(tx, user!.id)
        // Owner-scoping: another user can neither disable nor delete it.
        const foreignDisable = await setTriggerEnabled(tx, { userId: other!.id, id, enabled: false })
        const disabled = await setTriggerEnabled(tx, { userId: user!.id, id, enabled: false })
        const enabledAfter = await listEnabledAutomations(tx, user!.id)
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

// Integration test for the at-least-once cursor lifecycle (spec 2026-06-19-trigger-abstraction,
// "Cursor commit"). Reproduces the cursor-regression scenario the adversarial review flagged:
// a long-parked run captures pending_cursor at start, a later Tier-1 dismiss advances `cursor`
// (clearing pending_cursor), and the parked run must NOT regress `cursor` when it finally commits a
// now-stale staged value. commitAutomationCursorIfStaged guards on the staged value still being
// current; the dismiss path (markAutomationFired with cursor) only advances when no stage is in
// flight. Same rollback pattern, so the DB stays pristine.
describe.skipIf(!url)('automation cursor lifecycle', () => {
  it('stages, commits-if-current, and never regresses on a stale commit', async () => {
    const db = createDb(url!)
    const ROLLBACK = Symbol('rollback')
    let observed:
      | {
          afterStage: { cursor: unknown; pendingCursor: unknown }
          afterFreshCommit: { cursor: unknown; pendingCursor: unknown }
          afterDismissAdvance: { cursor: unknown; pendingCursor: unknown }
          afterStaleCommit: { cursor: unknown; pendingCursor: unknown }
        }
      | undefined

    try {
      await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ displayName: 'Owner' }).returning()
        const { id } = await insertAutomation(tx, {
          userId: user!.id,
          name: 'Inbox watcher',
          trigger: 'email',
          schedule: '*/10 * * * *',
          objective: 'Check for urgent unread mail',
          notifyPolicy: 'on_change',
        })
        const snap = async () => {
          const a = await getAutomation(tx, id)
          return { cursor: a!.cursor, pendingCursor: a!.pendingCursor }
        }

        // Escalation stages pending_cursor only; cursor stays null.
        await stageAutomationCursor(tx, { id, pendingCursor: { lastUid: 103 } })
        const afterStage = await snap()

        // The run reaches `done` with the current staged value ⇒ commit advances cursor, clears stage.
        await commitAutomationCursorIfStaged(tx, { id, expectedPendingCursor: { lastUid: 103 } })
        const afterFreshCommit = await snap()

        // A new escalation re-stages (a later run), then a NON-deterministic dismiss of the same
        // unadvanced delta would advance `cursor` directly (markAutomationFired w/ cursor) — but the
        // detect guard only does so when pending_cursor is null. Here we simulate the in-flight case:
        // pending is staged, so dismiss records the fire WITHOUT a cursor (no advance). Then a later
        // out-of-order writer advances cursor to 105 and clears the stage (e.g. the next escalation's
        // own done-commit). We model the net post-condition: cursor=105, pending cleared.
        await stageAutomationCursor(tx, { id, pendingCursor: { lastUid: 105 } })
        await advanceAutomationCursor(tx, { id, cursor: { lastUid: 105 } })
        const afterDismissAdvance = await snap()

        // The ORIGINAL parked run finally commits its stale captured value (103). The guard must make
        // this a NO-OP — pending_cursor no longer equals 103 (it's null) — so cursor stays 105.
        await commitAutomationCursorIfStaged(tx, { id, expectedPendingCursor: { lastUid: 103 } })
        const afterStaleCommit = await snap()

        observed = { afterStage, afterFreshCommit, afterDismissAdvance, afterStaleCommit }
        throw ROLLBACK
      })
    } catch (err) {
      if (err !== ROLLBACK) throw err
    }

    expect(observed).toBeDefined()
    expect(observed!.afterStage).toEqual({ cursor: null, pendingCursor: { lastUid: 103 } })
    expect(observed!.afterFreshCommit).toEqual({ cursor: { lastUid: 103 }, pendingCursor: null })
    expect(observed!.afterDismissAdvance).toEqual({ cursor: { lastUid: 105 }, pendingCursor: null })
    // The stale commit must NOT regress cursor 105 → 103.
    expect(observed!.afterStaleCommit).toEqual({ cursor: { lastUid: 105 }, pendingCursor: null })
  })

  it('markAutomationFired atomically advances the cursor when given one', async () => {
    const db = createDb(url!)
    const ROLLBACK = Symbol('rollback')
    let observed: { withCursor: { cursor: unknown; pendingCursor: unknown }; withoutCursor: { cursor: unknown } } | undefined

    try {
      await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ displayName: 'Owner' }).returning()
        const { id } = await insertAutomation(tx, {
          userId: user!.id,
          name: 'Inbox watcher',
          trigger: 'email',
          schedule: '*/10 * * * *',
          objective: 'Check for urgent unread mail',
          notifyPolicy: 'on_change',
        })
        // A stale stage from a prior in-flight run; a direct cursor-commit clears it (a dismiss/empty
        // tick with no stage in flight supersedes).
        await stageAutomationCursor(tx, { id, pendingCursor: { lastUid: 7 } })
        await markAutomationFired(tx, id, { cursor: { lastUid: 42 } })
        const a1 = await getAutomation(tx, id)
        const withCursor = { cursor: a1!.cursor, pendingCursor: a1!.pendingCursor }

        // Without a cursor opt, neither cursor nor pending_cursor is touched.
        await stageAutomationCursor(tx, { id, pendingCursor: { lastUid: 99 } })
        await markAutomationFired(tx, id, {})
        const a2 = await getAutomation(tx, id)
        const withoutCursor = { cursor: a2!.cursor }

        observed = { withCursor, withoutCursor }
        throw ROLLBACK
      })
    } catch (err) {
      if (err !== ROLLBACK) throw err
    }

    expect(observed).toBeDefined()
    expect(observed!.withCursor).toEqual({ cursor: { lastUid: 42 }, pendingCursor: null })
    expect(observed!.withoutCursor).toEqual({ cursor: { lastUid: 42 } }) // untouched by the no-cursor fire
  })
})

// Integration test for the /speak read-out helpers (spec 2026-06-18-read-out-command):
// readLastAssistantText returns the newest assistant turn's text (skipping a later tool-only /
// empty assistant turn) and null when there's none; latestRunIdForConversation returns the
// newest run id (uuidv7-ordered) or null. Same rollback pattern, so the DB stays pristine.
describe.skipIf(!url)('read-out helpers', () => {
  it('reads the last non-empty assistant text and the latest run id', async () => {
    const db = createDb(url!)
    const ROLLBACK = Symbol('rollback')
    let observed:
      | {
          emptyConvText: string | null
          emptyConvRun: string | null
          text: string | null
          latestRun: string | null
          secondRunId: string
        }
      | undefined

    try {
      await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ displayName: 'Owner' }).returning()
        const [conv] = await tx
          .insert(conversations)
          .values({ userId: user!.id, ingress: 'web', channelKey: crypto.randomUUID() })
          .returning()

        // A fresh conversation: no assistant text, no run yet.
        const emptyConvText = await readLastAssistantText(tx, conv!.id)
        const emptyConvRun = await latestRunIdForConversation(tx, conv!.id)

        // user -> assistant(text) -> assistant(tool-only, no text). The newest assistant turn has
        // no text part, so readLastAssistantText must skip it and return the earlier reply.
        await tx
          .insert(messages)
          .values({ conversationId: conv!.id, role: 'user', content: [{ type: 'text', text: 'hi' }] })
        await tx.insert(messages).values({
          conversationId: conv!.id,
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello there, friend.' }],
        })
        await tx.insert(messages).values({
          conversationId: conv!.id,
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'echo', args: {} }],
        })

        // Two runs; the second (uuidv7, inserted later) is the "latest".
        await tx.insert(agentRuns).values({ conversationId: conv!.id, status: 'done' })
        const [second] = await tx
          .insert(agentRuns)
          .values({ conversationId: conv!.id, status: 'done' })
          .returning()

        const text = await readLastAssistantText(tx, conv!.id)
        const latestRun = await latestRunIdForConversation(tx, conv!.id)

        observed = { emptyConvText, emptyConvRun, text, latestRun, secondRunId: second!.id }
        throw ROLLBACK // abort the transaction so the DB stays pristine
      })
    } catch (err) {
      if (err !== ROLLBACK) throw err
    }

    expect(observed).toBeDefined()
    expect(observed!.emptyConvText).toBeNull()
    expect(observed!.emptyConvRun).toBeNull()
    expect(observed!.text).toBe('Hello there, friend.') // skipped the tool-only newest turn
    expect(observed!.latestRun).toBe(observed!.secondRunId)
  })
})
