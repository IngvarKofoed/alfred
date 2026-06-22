import { textFromContent } from '@alfred/shared'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { OWNER_USER_ID } from './constants.js'
import { pgNotify, type Db } from './client.js'
import {
  agentRuns,
  automations,
  conversations,
  conversationSurfaces,
  llmCalls,
  memoryFacts,
  messages,
  messageSurfaceRefs,
  notifications,
  pushSubscriptions,
  toolCalls,
  userInteractions,
  users,
} from './schema.js'

// A Db handle or a transaction handle — so helpers can run standalone or inside a caller's
// transaction (e.g. the message ingress, which seeds the conversation in the same tx as the
// message + run).
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

// Seed the owner user + the conversation row (idempotent), the one place that shape lives —
// shared by the message ingress and the /rename command so they can't drift. When `title` is
// given, it's folded into the same upsert (set on conflict), so naming a brand-new or an
// existing conversation is a single atomic statement. When `touch` is set, the conflict path
// also bumps `lastActiveAt` to now() on the existing row (a brand-new insert already defaults
// it to now(), so touch only matters for an existing row) — this is how a posted message keeps
// the conversation's recency current for the history list. title + touch can apply together.
// ingress/channelKey default to the web shape (channelKey = conversationId); a future ingress
// passes its own.
export async function ensureConversation(
  db: DbOrTx,
  conversationId: string,
  opts: { ingress?: string; channelKey?: string; title?: string; touch?: boolean } = {},
): Promise<void> {
  const { ingress = 'web', channelKey = conversationId, title, touch } = opts
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
  const set = {
    ...(title !== undefined ? { title } : {}),
    ...(touch ? { lastActiveAt: sql`now()` } : {}),
  }
  await (Object.keys(set).length > 0
    ? insert.onConflictDoUpdate({ target: conversations.id, set })
    : insert.onConflictDoNothing())
}

// Resolve (or create) the conversation a Discord channel/post is bound to, returning the PK
// (multi-surface spec 2026-06-21). Routing moved OFF conversations.channel_key (its unique index
// was dropped) ONTO the conversation_surfaces binding table: a Discord post→conversation mapping
// is a (surface='discord', external_key=<channelId>) row. The bot's onMessageCreate calls this for
// a message in a guild post / catch-all / DM channel — a channel is a continuous thread across
// days, not a new conversation per message.
//
// Resolution: look up an existing binding by (surface, externalKey). If found, return its
// conversation_id (the canonical conversation, whatever its ingress/origin). If not — a
// genuinely NEW discord-born conversation (a post created directly in Discord, never pulled) —
// create a conversation row (ingress=params.ingress as origin metadata, channel_key=externalKey
// as the origin key) AND its binding row, both in this caller's transaction.
//
// `title` is set on INSERT only (creation case) so a re-visit / later rename / auto-title isn't
// clobbered; the Discord ingress passes the post's own name so a post-backed conversation is named
// by the owner's post title (and the worker's auto-title is skipped, title already non-null).
//
// Concurrency: the create path fires only when the resolve above missed. Under a rare race — Discord
// redelivers a message on a gateway reconnect, or the owner double-sends, so two onMessageCreate run
// for the same brand-new post — both inserters create a conversation, but bindConversationSurface is
// onConflictDoNothing on unique(surface, external_key), so only the FIRST binding wins. We therefore
// re-resolve the binding after writing it and return the actually-bound conversation (the winner), so
// this message lands there rather than in the orphan row the loser just created (a harmless extra
// conversation, never a split thread or a 23505 to the caller). Prefer the explicit
// getConversationBySurface + bindConversationSurface pair for non-onMessageCreate callers.
export async function getOrCreateConversationByChannel(
  db: DbOrTx,
  params: { ingress: string; channelKey: string; title?: string },
): Promise<string> {
  const existing = await getConversationBySurface(db, 'discord', params.channelKey)
  if (existing) return existing
  await db.insert(users).values({ id: OWNER_USER_ID, displayName: 'Owner' }).onConflictDoNothing()
  const [created] = await db
    .insert(conversations)
    .values({
      userId: OWNER_USER_ID,
      ingress: params.ingress,
      channelKey: params.channelKey,
      ...(params.title ? { title: params.title } : {}),
    })
    .returning({ id: conversations.id })
  await bindConversationSurface(db, {
    conversationId: created!.id,
    surface: 'discord',
    externalKey: params.channelKey,
  })
  // Return the conversation the binding actually points at: under a concurrent race our bind was a
  // no-op and the winner owns the post, so resolve again rather than returning our (possibly orphan)
  // created row.
  return (await getConversationBySurface(db, 'discord', params.channelKey)) ?? created!.id
}

// Bind a surface's external key to a conversation (multi-surface spec 2026-06-21) — the explicit
// writer behind both the bot's pull-to-Discord (post created → bind it to the pulled conversation)
// and the watcher per-fire materialization (replacing repointConversationChannel: the per-fire
// conversation stays ingress='trigger' as origin, and gains a discord binding instead of having
// its ingress overwritten). onConflictDoNothing on the unique(surface, external_key) so a re-bind
// of an already-bound post is a harmless no-op (idempotent reconcile). Does NOT touch the
// conversation's ingress/channel_key/title — the binding is purely additive surface presence.
export async function bindConversationSurface(
  db: DbOrTx,
  params: { conversationId: string; surface: string; externalKey: string },
): Promise<void> {
  await db
    .insert(conversationSurfaces)
    .values({
      conversationId: params.conversationId,
      surface: params.surface,
      externalKey: params.externalKey,
    })
    .onConflictDoNothing({ target: [conversationSurfaces.surface, conversationSurfaces.externalKey] })
}

// Resolve a surface's external key to its bound conversation id, or undefined if unbound
// (multi-surface spec 2026-06-21). The read half of the Discord routing index — used by
// getOrCreateConversationByChannel and the bot's interaction dispatch to map a post id → its
// canonical conversation. Returns undefined for an unknown key (a stray channel never bound).
export async function getConversationBySurface(
  db: DbOrTx,
  surface: string,
  externalKey: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ conversationId: conversationSurfaces.conversationId })
    .from(conversationSurfaces)
    .where(
      and(eq(conversationSurfaces.surface, surface), eq(conversationSurfaces.externalKey, externalKey)),
    )
    .limit(1)
  return row?.conversationId
}

// Reverse of getConversationBySurface (multi-surface spec 2026-06-21): the surface external key a
// conversation is bound to on a given surface, or undefined if unbound. Used by the bot's per-fire
// watcher path to find an existing Discord post for a watcher conversation across a restart (the
// conversation no longer flips ingress='discord' — its presence is the binding row, not its ingress),
// replacing the old `ingress === 'discord'` reuse signal. The reverse-lookup index
// conversation_surfaces_conversation_idx covers this.
export async function getConversationSurfaceKey(
  db: DbOrTx,
  conversationId: string,
  surface: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ externalKey: conversationSurfaces.externalKey })
    .from(conversationSurfaces)
    .where(
      and(
        eq(conversationSurfaces.conversationId, conversationId),
        eq(conversationSurfaces.surface, surface),
      ),
    )
    .limit(1)
  return row?.externalKey
}

// Every conversation bound to a surface (multi-surface spec 2026-06-21) — read by the bot at boot
// to re-establish a standing LISTEN per bound conversation (the standing-LISTEN re-establish the
// per-fire change removed, now scoped to the curated set of explicitly-bound conversations). Each
// row pairs the canonical conversation id with its surface external key (the Discord post/channel
// to render into). Ordered newest-binding-first (uuidv7 PK desc) for deterministic iteration.
export function listBoundConversations(
  db: DbOrTx,
  surface: string,
): Promise<{ conversationId: string; externalKey: string }[]> {
  return db
    .select({
      conversationId: conversationSurfaces.conversationId,
      externalKey: conversationSurfaces.externalKey,
    })
    .from(conversationSurfaces)
    .where(eq(conversationSurfaces.surface, surface))
    .orderBy(desc(conversationSurfaces.id))
}

// Recent conversations NOT yet bound to a surface (multi-surface spec 2026-06-21) — backs the
// Discord /pull picker, which lists conversations the owner can still materialize into Discord
// (already-bound ones are filtered out, since pulling them again is a no-op / 409). Newest-active
// first, capped (Discord's StringSelectMenu allows ≤25 options). The NOT EXISTS keeps it a single
// query against the small per-user conversation set.
export function listUnboundConversations(
  db: DbOrTx,
  params: { userId: string; surface: string; limit?: number },
): Promise<{ id: string; title: string | null; ingress: string }[]> {
  return db
    .select({ id: conversations.id, title: conversations.title, ingress: conversations.ingress })
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, params.userId),
        sql`not exists (
          select 1 from ${conversationSurfaces}
          where ${conversationSurfaces.conversationId} = ${conversations.id}
            and ${conversationSurfaces.surface} = ${params.surface}
        )`,
      ),
    )
    .orderBy(desc(conversations.lastActiveAt))
    .limit(params.limit ?? 25)
}

// Seed the conversation (touching recency), persist a user message, and create its pending run —
// the one place this "new user turn" shape lives, shared by the text ingress (POST /messages)
// and the voice ingress (POST /audio, speak=true). Runs inside the caller's transaction so the
// one-active-run unique-index violation surfaces as the caller's 409. Returns the new run id.
export async function createUserMessageRun(
  db: DbOrTx,
  conversationId: string,
  content: (typeof messages.$inferInsert)['content'],
  opts: { speak?: boolean } = {},
): Promise<string> {
  await ensureConversation(db, conversationId, { touch: true })
  const [msg] = await db.insert(messages).values({ conversationId, role: 'user', content }).returning()
  const [run] = await db
    .insert(agentRuns)
    .values({
      conversationId,
      triggerMessageId: msg!.id,
      status: 'pending',
      ...(opts.speak ? { speak: true } : {}),
    })
    .returning()
  return run!.id
}

// First-writer-wins interaction resolve (RUNTIME §10.2/§10.3, invariant 5), shared by every
// ingress that can answer an approval/question. The conditional UPDATE ... WHERE status='pending'
// IS the race guard: a second resolver, the timeout sweeper, or a cancel cascade all lose against
// the first writer, which is exactly what keeps a single exit from a pending interaction. On a win
// it looks up the run's conversation and NOTIFYs `conversation:<id> { interaction_resolved }` so the
// parked worker wakes and every other surface tears down its prompt UI. Kind-agnostic: it writes
// whatever `response` jsonb, serving both approvals ({ approved, note }) and questions
// ({ selected_labels, freeform_text }) — one writer, no drift across ingresses. Returns false (the
// caller's 409 / "already resolved") when the row was already terminal (no match). resolvedVia is
// the answering ingress. The NOTIFY uses pgNotify (process-wide pool, like the webserver did
// inline) — kept after the UPDATE so any woken listener reads the committed terminal row.
export async function resolveInteraction(
  db: DbOrTx,
  id: string,
  params: { response: unknown; resolvedVia: 'web' | 'discord' | 'voice' },
): Promise<boolean> {
  const [row] = await db
    .update(userInteractions)
    .set({
      response: params.response,
      status: 'resolved',
      resolvedVia: params.resolvedVia,
      resolvedAt: new Date(),
    })
    .where(and(eq(userInteractions.id, id), eq(userInteractions.status, 'pending')))
    .returning({ agentRunId: userInteractions.agentRunId })
  if (!row) return false
  const [run] = await db
    .select({ conversationId: agentRuns.conversationId })
    .from(agentRuns)
    .where(eq(agentRuns.id, row.agentRunId))
  await pgNotify(
    `conversation:${run!.conversationId}`,
    JSON.stringify({ type: 'interaction_resolved', interactionId: id }),
  )
  return true
}

// Record an out-of-loop LLM call (one the worker/webserver made outside the agent loop —
// e.g. STT/TTS for voice) against a run, the same way the worker attributes generate_image /
// auto_title: insert a synthetic terminal `tool_calls` row, then an `llm_calls` row linked to
// it by `toolCallId`. The non-null link keeps the call's cost in `rollupUsage`'s all-calls sum
// while excluding its model from the run's model derivation (tool_call_id IS NULL rows only),
// so the speech model never mislabels the run. The call has already completed (unlike
// auto_title, which starts 'running'), so the synthetic row is inserted terminal ('done').
// `costUsd` is a precomputed number; stored via .toFixed(6) for the numeric column (keeping
// @alfred/db free of any pricing/agent-core dependency).
export async function recordOutOfLoopLlmCall(
  db: DbOrTx,
  params: {
    runId: string
    toolName: string // 'stt' | 'tts'
    model: string
    requestSummary: string
    responseSummary: string
    promptTokens: number
    completionTokens: number
    costUsd: number
  },
): Promise<void> {
  const now = new Date()
  const [call] = await db
    .insert(toolCalls)
    .values({
      agentRunId: params.runId,
      toolName: params.toolName,
      args: {},
      trustTier: 'read', // fixed: out-of-loop AI calls are read-tier audit anchors, never owner-gated
      status: 'done', // fixed: recorded post-completion (auto_title starts 'running'; these don't)
      startedAt: now,
      finishedAt: now,
      result: { summary: params.responseSummary },
    })
    .returning({ id: toolCalls.id })
  await db.insert(llmCalls).values({
    agentRunId: params.runId,
    toolCallId: call!.id,
    model: params.model,
    request: { tool: true, summary: params.requestSummary },
    tools: null,
    responseText: params.responseSummary,
    responseToolCalls: null,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    costUsd: params.costUsd.toFixed(6),
    finishReason: null,
    latencyMs: 0,
    error: null,
  })
}

// The thin shared SELECT behind both readMemoryFacts and listMemoryFacts: a fact's
// (id, text) for a (userId, scope), oldest-first (created_at asc) so the order is
// deterministic. The two callers stay separate exported functions on purpose (below).
function selectMemoryFacts(
  db: DbOrTx,
  userId: string,
  scope: string,
): Promise<{ id: string; text: string }[]> {
  return db
    .select({ id: memoryFacts.id, text: memoryFacts.text })
    .from(memoryFacts)
    .where(and(eq(memoryFacts.userId, userId), eq(memoryFacts.scope, scope)))
    .orderBy(asc(memoryFacts.createdAt))
}

// The recall seam folded into the system prompt by the worker (long-term memory spec).
// v1 returns ALL facts for (userId, scope); phase-2 pgvector swaps THIS function's body
// (all facts -> top-K by embedding distance to the latest user turn), and nothing else —
// the tool family, the injection site, and listMemoryFacts are untouched (ARCHITECTURE §6.4).
export function readMemoryFacts(
  db: DbOrTx,
  userId: string,
  scope = 'global',
): Promise<{ id: string; text: string }[]> {
  return selectMemoryFacts(db, userId, scope)
}

// The management read behind the `list_memories` tool — the id source for `forget`.
// Always all facts; deliberately separate from readMemoryFacts (which becomes top-K in
// phase 2), since management must keep seeing every fact regardless of retrieval changes.
export function listMemoryFacts(
  db: DbOrTx,
  userId: string,
  scope = 'global',
): Promise<{ id: string; text: string }[]> {
  return selectMemoryFacts(db, userId, scope)
}

// Save a durable fact (the `remember` tool). Returns the new id so the agent can `forget`
// it later in the same turn if needed; `sourceRunId` records the run that saved it.
export async function insertMemoryFact(
  db: DbOrTx,
  params: { userId: string; scope?: string; text: string; sourceRunId?: string | null },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(memoryFacts)
    .values({
      userId: params.userId,
      scope: params.scope ?? 'global',
      text: params.text,
      sourceRunId: params.sourceRunId ?? null,
    })
    .returning({ id: memoryFacts.id })
  return { id: row!.id }
}

// A fact id is a UUID. The `forget` tool's id comes from the model, which can hallucinate a
// non-UUID (a label, a guessed value); comparing that against the uuid-typed `id` column would
// make Postgres throw `invalid input syntax for type uuid` instead of cleanly "not found". So
// deleteMemoryFact short-circuits a malformed id to a clean miss, keeping the helper total.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Delete a fact (the `forget` tool), scoped to userId so a fact can only be deleted by its
// owner (a stray/forged id from another owner deletes nothing). `deleted` reports whether a
// row matched, so the tool can tell the agent "no such fact" instead of silently succeeding.
export async function deleteMemoryFact(
  db: DbOrTx,
  params: { userId: string; id: string },
): Promise<{ deleted: boolean }> {
  // A non-UUID id can't match any row (and would make the uuid cast throw) — report a clean miss.
  if (!UUID_RE.test(params.id)) return { deleted: false }
  const deleted = await db
    .delete(memoryFacts)
    .where(and(eq(memoryFacts.id, params.id), eq(memoryFacts.userId, params.userId)))
    .returning({ id: memoryFacts.id })
  return { deleted: deleted.length > 0 }
}

// ---- Automations (autonomous watchers; trigger-abstraction spec 2026-06-19) ----
//
// An automation = a chosen Trigger (`trigger`) + its `params` + the action (`objective`) + notify
// policy + cursor state (was the `triggers` table). The `cursor`/`pending_cursor` jsonb columns
// hold the opaque per-Trigger detection cursor: the framework only stages/commits it, all cursor
// semantics live in the worker Trigger's detect().

// Insert an automation row (used by the `create_automation` tool in the worker). `notifyPolicy`
// defaults 'on_change' (any escalation pushes). Returns the new id so the agent can reference it.
export async function insertAutomation(
  db: DbOrTx,
  params: {
    userId: string
    name: string
    trigger: string // the Trigger name: 'email' | 'timer' | 'webhook'
    conversationId?: string | null
    schedule?: string | null
    params?: unknown // the Trigger's params, validated against its paramsSchema before insert
    triage?: unknown
    objective: string
    notifyPolicy?: string
    nextFireAt?: Date | null
    sourceRunId?: string | null
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(automations)
    .values({
      userId: params.userId,
      name: params.name,
      trigger: params.trigger,
      conversationId: params.conversationId ?? null,
      schedule: params.schedule ?? null,
      params: params.params ?? null,
      triage: params.triage ?? null,
      objective: params.objective,
      notifyPolicy: params.notifyPolicy ?? 'on_change',
      nextFireAt: params.nextFireAt ?? null,
      sourceRunId: params.sourceRunId ?? null,
    })
    .returning({ id: automations.id })
  return { id: row!.id }
}

// All enabled rows for a user — read by the triggers scheduler at boot to register schedules.
// Full rows so the scheduler has trigger / schedule / nextFireAt.
export function listEnabledAutomations(
  db: DbOrTx,
  userId: string,
): Promise<(typeof automations.$inferSelect)[]> {
  return db.select().from(automations).where(and(eq(automations.userId, userId), eq(automations.enabled, true)))
}

// Fetch one automation by id — used by the worker's trigger-detect handler (the job payload carries
// triggerId, which holds the automation id) and the webserver's webhook route.
export async function getAutomation(
  db: DbOrTx,
  id: string,
): Promise<(typeof automations.$inferSelect) | undefined> {
  const [row] = await db.select().from(automations).where(eq(automations.id, id)).limit(1)
  return row
}

// All of a user's automations (incl. disabled) newest-first — backs the `list_triggers` tool so the
// agent can report what's scheduled and find the ids to disable/delete.
export function listTriggers(db: DbOrTx, userId: string): Promise<(typeof automations.$inferSelect)[]> {
  return db.select().from(automations).where(eq(automations.userId, userId)).orderBy(desc(automations.createdAt))
}

// Resolve the automation a conversation BELONGS TO, via the per-fire `conversations.automation_id`
// link (per-fire spec 2026-06-20). This is the run-side lookup that replaces
// getAutomationByConversation(automations.conversation_id): a watcher now has many conversations
// (one per fire), so the link lives on the conversation, and run.ts resolves the automation here for
// EVERY run in the conversation (the escalation AND any follow-up reply) — the scratchpad scope
// (automation:<id>) and the cursor-commit gate key off it. A NULL automation_id (a normal
// web/discord/voice/legacy conversation) returns undefined. UUID-guarded (a non-UUID conversationId
// is a clean miss, not a thrown uuid cast — mirrors deleteMemoryFact). Returns the automation row
// (or undefined). One JOIN, no second round-trip.
export async function getAutomationForConversation(
  db: DbOrTx,
  conversationId: string,
): Promise<(typeof automations.$inferSelect) | undefined> {
  if (!UUID_RE.test(conversationId)) return undefined
  const [row] = await db
    .select({ automation: automations })
    .from(conversations)
    .innerJoin(automations, eq(conversations.automationId, automations.id))
    .where(eq(conversations.id, conversationId))
    .limit(1)
  return row?.automation
}

// (Removed: repointConversationChannel — multi-surface spec 2026-06-21. The Discord bot's per-fire
// watcher path used to repoint a per-fire conversation's ingress/channel_key from ('trigger', id) to
// ('discord', <post id>) so a reply resolved back to it; with the binding table that overwrite is
// gone — the conversation keeps ingress='trigger' (origin) and gains a conversation_surfaces(discord,
// postId) row instead, so the bot now calls bindConversationSurface. The per-fire consumer has fully
// migrated, so the function is deleted rather than left as dead code.)

// Enable/disable an automation, owner-scoped (a model-supplied id can't touch another user's row)
// and UUID-guarded (a hallucinated non-UUID is a clean miss, not a thrown uuid cast — mirrors
// deleteMemoryFact). Returns whether a row matched. Disabling stops it firing + frees the
// create_automation cap; the scheduler unregisters it on its next reconcile. Backs `disable_trigger`.
export async function setTriggerEnabled(
  db: DbOrTx,
  params: { userId: string; id: string; enabled: boolean },
): Promise<{ updated: boolean }> {
  if (!UUID_RE.test(params.id)) return { updated: false }
  const updated = await db
    .update(automations)
    .set({ enabled: params.enabled, updatedAt: new Date() })
    .where(and(eq(automations.id, params.id), eq(automations.userId, params.userId)))
    .returning({ id: automations.id })
  return { updated: updated.length > 0 }
}

// Partial, owner-scoped + UUID-guarded update of an automation's mutable definition fields (backs the
// `update_automation` tool). Only the fields PRESENT (value !== undefined) are written — omitted ones
// are left untouched, so this is a partial UPDATE, not a replace. `schedule`/`nextFireAt` are nullable
// on purpose: the tool sets one and nulls the other when `when` re-decides the cadence. `cursor`/
// `pendingCursor` are nullable too: the tool nulls them to RE-BASELINE detection when `params` change
// (a changed detection param can make the prior cursor incomparable — e.g. an email `mailbox` switch,
// since IMAP UIDs are per-mailbox; re-baselining is trigger-agnostic and safe). Always bumps
// updated_at. Returns whether a row matched. The triggers scheduler picks up schedule/enabled changes
// on its next reconcile (no extra wiring). The trigger MECHANISM itself is never changed by an update.
export async function updateAutomation(
  db: DbOrTx,
  params: {
    userId: string
    id: string
    name?: string
    objective?: string
    params?: unknown
    schedule?: string | null
    nextFireAt?: Date | null
    notifyPolicy?: string
    enabled?: boolean
    cursor?: unknown
    pendingCursor?: unknown
  },
): Promise<{ updated: boolean }> {
  if (!UUID_RE.test(params.id)) return { updated: false }
  const set: Partial<typeof automations.$inferInsert> = { updatedAt: new Date() }
  if (params.name !== undefined) set.name = params.name
  if (params.objective !== undefined) set.objective = params.objective
  if (params.params !== undefined) set.params = params.params
  if (params.schedule !== undefined) set.schedule = params.schedule
  if (params.nextFireAt !== undefined) set.nextFireAt = params.nextFireAt
  if (params.notifyPolicy !== undefined) set.notifyPolicy = params.notifyPolicy
  if (params.enabled !== undefined) set.enabled = params.enabled
  if (params.cursor !== undefined) set.cursor = params.cursor
  if (params.pendingCursor !== undefined) set.pendingCursor = params.pendingCursor
  const updated = await db
    .update(automations)
    .set(set)
    .where(and(eq(automations.id, params.id), eq(automations.userId, params.userId)))
    .returning({ id: automations.id })
  return { updated: updated.length > 0 }
}

// Permanently delete an automation, owner-scoped + UUID-guarded (mirrors deleteMemoryFact). Returns
// whether a row was removed. Backs the `delete_trigger` tool.
export async function deleteTrigger(
  db: DbOrTx,
  params: { userId: string; id: string },
): Promise<{ deleted: boolean }> {
  if (!UUID_RE.test(params.id)) return { deleted: false }
  const deleted = await db
    .delete(automations)
    .where(and(eq(automations.id, params.id), eq(automations.userId, params.userId)))
    .returning({ id: automations.id })
  return { deleted: deleted.length > 0 }
}

// Commit a cursor straight to `cursor` (detect.ts, on Tier-1 dismiss / empty-delta baseline): set
// `cursor ← params.cursor` and clear `pending_cursor`. There's no run to wait for — the events were
// either nothing (baseline) or evaluated-and-rejected (dismiss), so advancing now is correct. `cursor`
// is opaque jsonb (the framework never interprets it); detect() owns its shape. Bumps updatedAt.
//
// NOTE on `id` provenance: this and stageAutomationCursor are deliberately NOT owner-scoped (no
// userId in WHERE). The id always comes from a trusted internal row (detect.ts's getAutomation,
// run.ts's getAutomationForConversation), never a model-supplied id — so a userId guard would add no
// safety. A future caller passing an untrusted id must scope it itself.
export async function advanceAutomationCursor(
  db: DbOrTx,
  params: { id: string; cursor: unknown },
): Promise<void> {
  await db
    .update(automations)
    .set({ cursor: params.cursor ?? null, pendingCursor: null, updatedAt: new Date() })
    .where(eq(automations.id, params.id))
}

// Commit a STAGED cursor after the escalated run succeeds (run.ts, on terminal `done`): set
// `cursor ← pending_cursor` and clear `pending_cursor`, but ONLY when the row's current
// `pending_cursor` still equals the value this run staged. This is the at-least-once commit point —
// the delta is only "handled" once its run reached done.
//
// The `pending_cursor = $expected` guard makes the commit idempotent + regression-proof against
// interleaving: run.ts captures `pending_cursor` at run START, but a long-parked run can outlive
// another writer that re-stages (the next escalation) or clears (a Tier-1 dismiss) `pending_cursor`
// while it ran. Committing the stale captured value unconditionally would REGRESS the cursor (a later
// dismiss already advanced past it) and force re-triage of already-handled events. Comparing against
// the current `pending_cursor` means: matches ⇒ this run still owns the staged delta, commit it;
// no match ⇒ someone else already moved it, skip (the safe direction — at most a re-deliver). The
// jsonb equality compares the staged value to the column. Bumps updatedAt only when it commits.
export async function commitAutomationCursorIfStaged(
  db: DbOrTx,
  params: { id: string; expectedPendingCursor: unknown },
): Promise<void> {
  await db
    .update(automations)
    .set({ cursor: params.expectedPendingCursor ?? null, pendingCursor: null, updatedAt: new Date() })
    .where(
      and(
        eq(automations.id, params.id),
        sql`${automations.pendingCursor} = ${JSON.stringify(params.expectedPendingCursor ?? null)}::jsonb`,
      ),
    )
}

// Stage a cursor at escalation (detect.ts): set `pending_cursor` only — `cursor` is left untouched
// until the escalated run commits it via commitAutomationCursorIfStaged on `done`. (On Tier-1 dismiss
// / empty-delta baseline, detect.ts commits straight to `cursor` by folding it into
// markAutomationFired instead, since the events were nothing or evaluated-and-rejected — there's no
// run to wait for.) Bumps updatedAt.
export async function stageAutomationCursor(
  db: DbOrTx,
  params: { id: string; pendingCursor: unknown },
): Promise<void> {
  await db
    .update(automations)
    .set({ pendingCursor: params.pendingCursor ?? null, updatedAt: new Date() })
    .where(eq(automations.id, params.id))
}

// Increment automations.detection_cost_usd by a dismissed Tier-1 call's cost (triage.ts, on
// dismiss). The add is done in SQL so concurrent ticks don't read-modify-write stomp each other;
// the numeric column accepts the text-cast addend.
export async function bumpDetectionCost(db: DbOrTx, id: string, costUsd: number): Promise<void> {
  await db
    .update(automations)
    .set({ detectionCostUsd: sql`${automations.detectionCostUsd} + ${costUsd.toFixed(6)}`, updatedAt: new Date() })
    .where(eq(automations.id, id))
}

// Set last_fired_at=now() and optionally update next_fire_at (a one-shot 'timer' automation sets
// next_fire_at=null after firing). Called by the worker's detect handler on each tick.
// `cursor` (optional) folds a cursor advance into the SAME update as the fire-record, so the
// dismiss / empty-delta paths (detect.ts) advance `cursor` and record `last_fired_at` atomically —
// a crash between two separate statements would otherwise re-detect the delta (re-triage cost) or
// double-charge detection_cost_usd. When `cursor` is present, `pending_cursor` is also cleared
// (mirrors advanceAutomationCursor): a direct commit supersedes any stale stage. Absent ⇒ neither
// `cursor` nor `pending_cursor` is touched (the escalation path stages separately, and a no-advance
// detect failure leaves the cursor untouched for re-delivery).
export async function markAutomationFired(
  db: DbOrTx,
  id: string,
  opts: { nextFireAt?: Date | null; cursor?: unknown } = {},
): Promise<void> {
  const hasCursor = Object.prototype.hasOwnProperty.call(opts, 'cursor')
  await db
    .update(automations)
    .set({
      lastFiredAt: sql`now()`,
      ...(Object.prototype.hasOwnProperty.call(opts, 'nextFireAt') ? { nextFireAt: opts.nextFireAt } : {}),
      ...(hasCursor ? { cursor: opts.cursor ?? null, pendingCursor: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(automations.id, id))
}

// The autonomous sibling of createUserMessageRun: CREATE a fresh per-fire conversation for an
// automation escalation and seed its first run (per-fire spec 2026-06-20). One new conversation
// per fire (was: append forever to one persistent watcher thread), so Alfred's reply is the first
// VISIBLE message and the owner can reply to continue it. In one transaction:
//   1. insert a new conversation — ingress='trigger', channel_key = the new conversation's OWN id
//      (the trigger ingress has no natural external key; mirroring the web shape keeps the
//      unique(ingress, channel_key) index satisfied), automation_id = the escalating automation,
//      title = the automation name (or null) so the per-fire thread is named without an auto-title.
//   2. insert the seed user message as a FULLY-HIDDEN turn: the objective and (if present) the
//      untrusted fenced trigger context (new events + classifier hint) are EACH a `trigger_context`
//      content part — NO visible `text` part. The web/Discord renderers skip non-text parts, so the
//      seed shows nothing and Alfred speaks first; the worker normalizes trigger_context → text for
//      the model (rowsToMessages), so the model still gets the objective + fenced delta (§16 fencing
//      preserved in the model input).
//   3. insert the pending run, human_in_loop=false (the autonomous escalation), trigger_message_id
//      = the seed message.
//   4. UPDATE automations.conversation_id = the new conversation — the repurposed "jump to latest"
//      pointer at the most-recent fire (no longer the routing key; that lives on conversation.automation_id).
// The id is minted here (uuidv7) so channel_key can reference it. Runs inside the caller's
// transaction. Returns { runId, conversationId }.
export async function createAutomationRun(
  db: DbOrTx,
  params: { automationId: string; objective: string; context?: string; title?: string | null },
): Promise<{ runId: string; conversationId: string }> {
  await db.insert(users).values({ id: OWNER_USER_ID, displayName: 'Owner' }).onConflictDoNothing()
  const conversationId = uuidv7()
  await db.insert(conversations).values({
    id: conversationId,
    userId: OWNER_USER_ID,
    ingress: 'trigger',
    channelKey: conversationId,
    automationId: params.automationId,
    title: params.title ?? null,
  })
  const content: { type: string; text: string }[] = [{ type: 'trigger_context', text: params.objective }]
  if (params.context?.trim()) content.push({ type: 'trigger_context', text: params.context })
  const [msg] = await db.insert(messages).values({ conversationId, role: 'user', content }).returning()
  const [run] = await db
    .insert(agentRuns)
    .values({
      conversationId,
      triggerMessageId: msg!.id,
      status: 'pending',
      humanInLoop: false,
    })
    .returning()
  await db
    .update(automations)
    .set({ conversationId, updatedAt: new Date() })
    .where(eq(automations.id, params.automationId))
  return { runId: run!.id, conversationId }
}

// ---- Notifications outbox + push subscriptions (autonomous-watchers spec) ----

// Write a pending outbox row. The worker writes it then NOTIFY 'notifications'; the dispatcher
// loads it and pushes. Returns the new id.
export async function insertNotification(
  db: DbOrTx,
  params: {
    userId: string
    conversationId?: string | null
    agentRunId?: string | null
    interactionId?: string | null
    kind: 'result' | 'approval' | 'question' | 'error'
    title: string
    body?: string
    deepLink: string
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId: params.userId,
      conversationId: params.conversationId ?? null,
      agentRunId: params.agentRunId ?? null,
      interactionId: params.interactionId ?? null,
      kind: params.kind,
      title: params.title,
      body: params.body ?? '',
      deepLink: params.deepLink,
      status: 'pending',
    })
    .returning({ id: notifications.id })
  return { id: row!.id }
}

// All status='pending' rows (uses the partial pending index). The dispatcher loads on each
// 'notifications' NOTIFY and on boot (catch-up for anything written while it was down).
export function listPendingNotifications(db: DbOrTx): Promise<(typeof notifications.$inferSelect)[]> {
  return db.select().from(notifications).where(eq(notifications.status, 'pending'))
}

// Mark a notification delivered (dispatcher, on a successful send).
export async function markNotificationSent(db: DbOrTx, id: string): Promise<void> {
  await db.update(notifications).set({ status: 'sent', sentAt: sql`now()` }).where(eq(notifications.id, id))
}

// Mark a notification undeliverable (dispatcher, when every subscription failed).
export async function markNotificationFailed(db: DbOrTx, id: string): Promise<void> {
  await db.update(notifications).set({ status: 'failed' }).where(eq(notifications.id, id))
}

// All Web Push registrations for a user — the dispatcher fans a notification out to every device.
export function listPushSubscriptions(
  db: DbOrTx,
  userId: string,
): Promise<(typeof pushSubscriptions.$inferSelect)[]> {
  return db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId))
}

// Insert-or-update a registration keyed on endpoint (the same browser re-subscribing refreshes
// its keys/userAgent rather than duplicating). The webserver's POST /api/push/subscribe calls it.
export async function upsertPushSubscription(
  db: DbOrTx,
  params: {
    userId: string
    endpoint: string
    keys: { p256dh: string; auth: string }
    userAgent?: string | null
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      userId: params.userId,
      endpoint: params.endpoint,
      keys: params.keys,
      userAgent: params.userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId: params.userId, keys: params.keys, userAgent: params.userAgent ?? null },
    })
    .returning({ id: pushSubscriptions.id })
  return { id: row!.id }
}

// Remove a registration by endpoint. The dispatcher calls it on a 410 Gone (prune a dead
// subscription); the webserver's POST /api/push/unsubscribe calls it on an explicit opt-out.
export async function deletePushSubscription(db: DbOrTx, endpoint: string): Promise<{ deleted: boolean }> {
  const deleted = await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .returning({ id: pushSubscriptions.id })
  return { deleted: deleted.length > 0 }
}

// The text of the conversation's most recent NON-EMPTY assistant message — the unit the /speak
// command (spec 2026-06-18-read-out-command) re-speaks. messages.content is jsonb ContentPart[]
// (DATABASE.md §6.1); we join the text of its `type:'text'` parts and skip tool-only / empty
// assistant turns (mirroring Chat.tsx's showName, which walks past them). Scans the latest few
// assistant rows (newest first) and returns the first with non-empty text, else null. Ordered by
// (createdAt desc, id desc) so same-timestamp rows are still deterministic by the uuidv7 id.
export async function readLastAssistantText(
  db: DbOrTx,
  conversationId: string,
): Promise<string | null> {
  const rows = await db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'assistant')))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(10)
  for (const row of rows) {
    const text = textFromContent(row.content).trim()
    if (text) return text
  }
  return null
}

// The id of the conversation's most recent agent_run, or null if it has none. agent_runs ids are
// uuidv7 (time-ordered), so `order by id desc` is "newest run" without a started_at join — the
// same trick the /debug endpoint uses. Used by /speak to anchor its out-of-loop TTS cost row on
// the latest run (there's no message -> run FK, so latest-run is the pragmatic anchor).
export async function latestRunIdForConversation(
  db: DbOrTx,
  conversationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.conversationId, conversationId))
    .orderBy(desc(agentRuns.id))
    .limit(1)
  return row?.id ?? null
}

// ---- Multi-surface mirroring (spec 2026-06-21) ----

// Record that a message has been mirrored to a surface (multi-surface spec 2026-06-21) — the
// write half of the mirror-idempotency ledger. The bot calls it as it renders a message into a
// bound Discord post; `externalId` is the rendered artifact's surface id (the Discord message id),
// nullable for surfaces without one. onConflictDoNothing on unique(message_id, surface) so a
// double-render attempt (a re-delivered event, a reconcile re-walking history) is a harmless
// no-op. Pair with hasMessageSurfaceRef to skip already-mirrored messages.
export async function insertMessageSurfaceRef(
  db: DbOrTx,
  params: { messageId: string; surface: string; externalId?: string | null },
): Promise<void> {
  await db
    .insert(messageSurfaceRefs)
    .values({
      messageId: params.messageId,
      surface: params.surface,
      externalId: params.externalId ?? null,
    })
    .onConflictDoNothing({ target: [messageSurfaceRefs.messageId, messageSurfaceRefs.surface] })
}

// Whether a message has already been mirrored to a surface (multi-surface spec 2026-06-21) — the
// read half of the dedup. The bot checks it before mirroring a web/iOS user message (the "🧑 …"
// quoted line) or an assistant turn into a bound post, so it never re-posts content already there
// (its own renders, or a Discord-originated turn the bot itself produced).
export async function hasMessageSurfaceRef(
  db: DbOrTx,
  messageId: string,
  surface: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: messageSurfaceRefs.id })
    .from(messageSurfaceRefs)
    .where(and(eq(messageSurfaceRefs.messageId, messageId), eq(messageSurfaceRefs.surface, surface)))
    .limit(1)
  return Boolean(row)
}

// The cross-process pull-to-Discord seam (multi-surface spec 2026-06-21). Only the Discord bot can
// create a forum post, but the trigger is an owner action on the WEBSERVER (POST
// /api/conversations/:id/surfaces/discord) or the bot itself (/pull). The webserver has no Discord
// client, so it hands the request to the bot over Postgres LISTEN/NOTIFY — the same fire-and-forget
// pattern the bot already uses for the per-conversation render + the notifications doorbell. This
// NOTIFYs the dedicated 'discord-pull' channel with the bare conversation id as the payload; the bot
// LISTENs it, and on receipt materializes the post (createForumPost), writes the
// conversation_surfaces(discord, postId) binding, mirrors the last ~20 messages in, and opens a
// standing LISTEN. Fire-and-forget by design: if the bot is down (or DISCORD_GUILD_ID unset) the
// pull is simply lost and the owner retries — acceptable for an interactive, retryable action (the
// spec accepts the analogous loss for watcher fires). pgNotify uses the process-wide pool, like
// resolveInteraction.
export async function requestDiscordPull(db: DbOrTx, conversationId: string): Promise<void> {
  await pgNotify('discord-pull', conversationId)
}
