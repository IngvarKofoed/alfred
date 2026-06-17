import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { OWNER_USER_ID } from './constants.js'
import { pgNotify, type Db } from './client.js'
import {
  agentRuns,
  conversations,
  llmCalls,
  memoryFacts,
  messages,
  notifications,
  pushSubscriptions,
  toolCalls,
  triggers,
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

// Resolve a conversation by its ingress-natural key, returning the (generated) PK. ensureConversation
// is keyed BY the PK — it can't help an ingress whose natural identifier isn't the conversation uuid.
// Discord's natural key is the channel id, so the bot maps a DM/guild channel to one long-lived
// conversation via the unique(ingress, channel_key) index: a channel is a continuous thread across
// days, not a new conversation per message. Seed the owner (like ensureConversation), then insert the
// row letting the schema mint a fresh uuidv7 PK; .onConflictDoNothing().returning() yields the new id
// on first sight and nothing on a re-visit, so on the empty case we SELECT the existing id by the
// natural key. Returns the conversation id either way.
export async function getOrCreateConversationByChannel(
  db: DbOrTx,
  params: { ingress: string; channelKey: string; title?: string },
): Promise<string> {
  await db.insert(users).values({ id: OWNER_USER_ID, displayName: 'Owner' }).onConflictDoNothing()
  // `title` is set on INSERT only (the creation case); the onConflictDoNothing path never touches it,
  // so a re-visit keeps the existing title (and a later /rename or auto-title isn't clobbered). The
  // Discord ingress passes the forum post's own name so a post-backed conversation is named by the
  // owner's post title — and the worker's auto-title is skipped (title is already non-null).
  const [inserted] = await db
    .insert(conversations)
    .values({
      userId: OWNER_USER_ID,
      ingress: params.ingress,
      channelKey: params.channelKey,
      ...(params.title ? { title: params.title } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: conversations.id })
  if (inserted) return inserted.id
  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.ingress, params.ingress), eq(conversations.channelKey, params.channelKey)))
  return existing!.id
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

// ---- Triggers (autonomous watchers, spec 2026-06-16) ----

// Insert a watcher row (used by the `schedule_self` tool in the worker). `notifyPolicy` defaults
// 'on_change' (any escalation pushes). Returns the new id so the agent can reference it.
export async function insertTrigger(
  db: DbOrTx,
  params: {
    userId: string
    name: string
    kind: 'schedule' | 'inbox' | 'webhook' | 'self'
    conversationId?: string | null
    schedule?: string | null
    gate?: unknown
    triage?: unknown
    objective: string
    notifyPolicy?: string
    nextFireAt?: Date | null
    sourceRunId?: string | null
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(triggers)
    .values({
      userId: params.userId,
      name: params.name,
      kind: params.kind,
      conversationId: params.conversationId ?? null,
      schedule: params.schedule ?? null,
      gate: params.gate ?? null,
      triage: params.triage ?? null,
      objective: params.objective,
      notifyPolicy: params.notifyPolicy ?? 'on_change',
      nextFireAt: params.nextFireAt ?? null,
      sourceRunId: params.sourceRunId ?? null,
    })
    .returning({ id: triggers.id })
  return { id: row!.id }
}

// All enabled rows for a user — read by the triggers scheduler at boot to register schedules.
// Full rows so the scheduler has kind / schedule / nextFireAt.
export function listEnabledTriggers(db: DbOrTx, userId: string): Promise<(typeof triggers.$inferSelect)[]> {
  return db.select().from(triggers).where(and(eq(triggers.userId, userId), eq(triggers.enabled, true)))
}

// Fetch one trigger by id — used by the worker's trigger-detect handler (the job payload carries
// triggerId) and the webserver's webhook route.
export async function getTrigger(
  db: DbOrTx,
  id: string,
): Promise<(typeof triggers.$inferSelect) | undefined> {
  const [row] = await db.select().from(triggers).where(eq(triggers.id, id)).limit(1)
  return row
}

// All of a user's triggers (incl. disabled) newest-first — backs the `list_triggers` tool so the
// agent can report what's scheduled and find the ids to disable/delete.
export function listTriggers(db: DbOrTx, userId: string): Promise<(typeof triggers.$inferSelect)[]> {
  return db.select().from(triggers).where(eq(triggers.userId, userId)).orderBy(desc(triggers.createdAt))
}

// Resolve a watcher by its persistent conversation (Discord-conversation-model spec, the
// load-bearing seam): run.ts looks the trigger up by the run's conversation id rather than the
// conversation's channelKey, so a recurring watcher whose conversation moved to a Discord forum
// post still finds its scratchpad. UUID-guarded (a non-UUID conversationId is a clean miss, not a
// thrown uuid cast — mirrors deleteMemoryFact). Returns the trigger row (or undefined).
//
// Invariant: one conversation ⇒ one trigger (each watcher owns its own post conversation; a 'self'
// trigger owns its originating one). There's no DB-level uniqueness on triggers.conversation_id, so
// order by created_at asc — first-created wins — to make resolution deterministic if that invariant
// is ever violated (run.ts keys the scratchpad scope off this). A partial unique index on
// conversation_id is the stronger guarantee if it ever needs enforcing.
export async function getTriggerByConversation(
  db: DbOrTx,
  conversationId: string,
): Promise<(typeof triggers.$inferSelect) | undefined> {
  if (!UUID_RE.test(conversationId)) return undefined
  const [row] = await db
    .select()
    .from(triggers)
    .where(eq(triggers.conversationId, conversationId))
    .orderBy(asc(triggers.createdAt))
    .limit(1)
  return row
}

// Repoint a watcher's persistent conversation (Discord-conversation-model spec): the bot sets
// triggers.conversation_id to the Discord forum-post conversation it created, so the NEXT
// escalation's run (and run.ts's scratchpad lookup) routes through that post. Owner-agnostic — the
// bot acts as the owner on the single-user box. Bumps updatedAt like the other trigger mutators.
//
// `ifNull` adds `WHERE conversation_id IS NULL` so the UPDATE never overwrites an already-set
// conversation. detect.ts's legacy backfill passes it: during the one-time migration the bot's
// reconcile may have already repointed conversation_id at a Discord post, and detect must NOT clobber
// that (which would transiently drop a fire's Discord delivery + leak a duplicate post). The bot's
// repoint must win, so detect only backfills when nothing has claimed the slot yet.
export async function setTriggerConversation(
  db: DbOrTx,
  params: { id: string; conversationId: string; ifNull?: boolean },
): Promise<void> {
  await db
    .update(triggers)
    .set({ conversationId: params.conversationId, updatedAt: new Date() })
    .where(
      params.ifNull
        ? and(eq(triggers.id, params.id), isNull(triggers.conversationId))
        : eq(triggers.id, params.id),
    )
}

// Enable/disable a trigger, owner-scoped (a model-supplied id can't touch another user's row) and
// UUID-guarded (a hallucinated non-UUID is a clean miss, not a thrown uuid cast — mirrors
// deleteMemoryFact). Returns whether a row matched. Disabling stops it firing + frees the
// schedule_self cap; the scheduler unregisters it on its next reconcile. Backs `disable_trigger`.
export async function setTriggerEnabled(
  db: DbOrTx,
  params: { userId: string; id: string; enabled: boolean },
): Promise<{ updated: boolean }> {
  if (!UUID_RE.test(params.id)) return { updated: false }
  const updated = await db
    .update(triggers)
    .set({ enabled: params.enabled, updatedAt: new Date() })
    .where(and(eq(triggers.id, params.id), eq(triggers.userId, params.userId)))
    .returning({ id: triggers.id })
  return { updated: updated.length > 0 }
}

// Permanently delete a trigger, owner-scoped + UUID-guarded (mirrors deleteMemoryFact). Returns
// whether a row was removed. Backs the `delete_trigger` tool.
export async function deleteTrigger(
  db: DbOrTx,
  params: { userId: string; id: string },
): Promise<{ deleted: boolean }> {
  if (!UUID_RE.test(params.id)) return { deleted: false }
  const deleted = await db
    .delete(triggers)
    .where(and(eq(triggers.id, params.id), eq(triggers.userId, params.userId)))
    .returning({ id: triggers.id })
  return { deleted: deleted.length > 0 }
}

// Persist the new Tier-0 gate signal after a change is detected (gate.ts).
export async function updateTriggerSignal(db: DbOrTx, id: string, lastSeenSignal: unknown): Promise<void> {
  await db
    .update(triggers)
    .set({ lastSeenSignal: lastSeenSignal ?? null, updatedAt: new Date() })
    .where(eq(triggers.id, id))
}

// Increment triggers.detection_cost_usd by a dismissed Tier-1 call's cost (triage.ts, on dismiss).
// The add is done in SQL so concurrent ticks don't read-modify-write stomp each other; the
// numeric column accepts the text-cast addend.
export async function bumpDetectionCost(db: DbOrTx, id: string, costUsd: number): Promise<void> {
  await db
    .update(triggers)
    .set({ detectionCostUsd: sql`${triggers.detectionCostUsd} + ${costUsd.toFixed(6)}`, updatedAt: new Date() })
    .where(eq(triggers.id, id))
}

// Set last_fired_at=now() and optionally update next_fire_at (a one-shot 'self' trigger sets
// next_fire_at=null after firing). Called by the worker's detect handler on each tick.
export async function markTriggerFired(
  db: DbOrTx,
  id: string,
  opts: { nextFireAt?: Date | null } = {},
): Promise<void> {
  await db
    .update(triggers)
    .set({
      lastFiredAt: sql`now()`,
      ...(Object.prototype.hasOwnProperty.call(opts, 'nextFireAt') ? { nextFireAt: opts.nextFireAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(triggers.id, id))
}

// The autonomous sibling of createUserMessageRun: resolve (touching recency) the trigger's
// persistent conversation, persist the objective as a user message, and create its pending run
// with human_in_loop=false. Runs inside the caller's transaction so the one-active-run unique
// index violation surfaces to the caller (the detect handler catches it → skip/coalesce per
// spec §78). Returns the new run id. The conversation's ingress/channelKey are caller-controlled
// (the detect handler resolves a recurring watcher via ensureConversation('trigger', '<id>')
// before calling this with the same conversationId); here we only touch recency.
export async function createTriggerRun(
  db: DbOrTx,
  params: { conversationId: string; objective: string },
): Promise<string> {
  await ensureConversation(db, params.conversationId, { touch: true })
  const [msg] = await db
    .insert(messages)
    .values({ conversationId: params.conversationId, role: 'user', content: [{ type: 'text', text: params.objective }] })
    .returning()
  const [run] = await db
    .insert(agentRuns)
    .values({
      conversationId: params.conversationId,
      triggerMessageId: msg!.id,
      status: 'pending',
      humanInLoop: false,
    })
    .returning()
  return run!.id
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
