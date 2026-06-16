import { and, asc, eq, sql } from 'drizzle-orm'
import { OWNER_USER_ID } from './constants.js'
import { type Db } from './client.js'
import { agentRuns, conversations, llmCalls, memoryFacts, messages, toolCalls, users } from './schema.js'

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
