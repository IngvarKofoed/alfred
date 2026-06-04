import {
  agentRuns,
  conversations,
  enqueueAgentRun,
  getDb,
  llmCalls,
  messages,
  OWNER_USER_ID,
  pgNotify,
  toolCalls,
  tools as toolsTable,
  userInteractions,
  users,
} from '@alfred/db'
import { loadConfig } from '@alfred/shared'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import pg from 'pg'

export const app = new Hono()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

app.get('/api/health', (c) => c.json({ ok: true }))

// Post a user message: persist it + a pending run in one transaction, then enqueue the
// job. The one-active-run index makes a concurrent send fail -> 409 ("busy").
app.post('/api/conversations/:id/messages', async (c) => {
  const conversationId = c.req.param('id')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)

  const body = (await c.req.json().catch(() => ({}))) as { text?: string }
  const text = body.text?.trim()
  if (!text) return c.json({ error: 'text is required' }, 400)

  const db = getDb()
  let runId: string
  try {
    runId = await db.transaction(async (tx) => {
      await tx
        .insert(users)
        .values({ id: OWNER_USER_ID, displayName: 'Owner' })
        .onConflictDoNothing()
      await tx
        .insert(conversations)
        .values({ id: conversationId, userId: OWNER_USER_ID, ingress: 'web', channelKey: conversationId })
        .onConflictDoNothing()
      const [msg] = await tx
        .insert(messages)
        .values({ conversationId, role: 'user', content: [{ type: 'text', text }] })
        .returning()
      const [run] = await tx
        .insert(agentRuns)
        .values({ conversationId, triggerMessageId: msg!.id, status: 'pending' })
        .returning()
      return run!.id
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'Alfred is already working on this conversation' }, 409)
    }
    throw err
  }

  await enqueueAgentRun(runId)
  return c.json({ runId })
})

// Conversation history, so a page refresh restores the thread.
app.get('/api/conversations/:id/messages', async (c) => {
  const conversationId = c.req.param('id')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)
  const rows = await getDb()
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
  return c.json({ messages: rows })
})

// SSE token stream: LISTEN on the conversation channel and forward NOTIFYs to the client.
app.get('/api/conversations/:id/stream', (c) => {
  const conversationId = c.req.param('id')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)
  const channel = `conversation:${conversationId}`

  return streamSSE(c, async (stream) => {
    const { POSTGRES_URL } = loadConfig()
    if (!POSTGRES_URL) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: 'no database' }) })
      return
    }
    const client = new pg.Client({ connectionString: POSTGRES_URL })
    await client.connect()
    client.on('notification', (msg) => {
      if (msg.payload) void stream.writeSSE({ data: msg.payload })
    })
    // The channel name is quoted; conversationId is validated as a uuid above (no injection).
    await client.query(`LISTEN "${channel}"`)

    let open = true
    stream.onAbort(() => {
      open = false
    })
    while (open) {
      await stream.sleep(30_000) // keep the connection alive
      if (open) await stream.writeSSE({ event: 'ping', data: '' })
    }
    await client.query(`UNLISTEN "${channel}"`).catch(() => {})
    await client.end().catch(() => {})
  })
})

// Fetch an interaction (e.g. an approval prompt) so the client can render its card.
app.get('/api/interactions/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid interaction id' }, 400)
  const [row] = await getDb().select().from(userInteractions).where(eq(userInteractions.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json({ interaction: row })
})

// Resolve an interaction (first-writer-wins): the conditional UPDATE only matches a
// still-pending row, so a second resolver (or a timeout) loses -> 409.
app.post('/api/interactions/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid interaction id' }, 400)

  const body = (await c.req.json().catch(() => ({}))) as { approved?: boolean; note?: string }
  const { approved, note } = body
  if (typeof approved !== 'boolean') return c.json({ error: 'approved is required' }, 400)

  const db = getDb()
  const [row] = await db
    .update(userInteractions)
    .set({
      response: { approved, note },
      status: 'resolved',
      resolvedVia: 'web',
      resolvedAt: new Date(),
    })
    .where(and(eq(userInteractions.id, id), eq(userInteractions.status, 'pending')))
    .returning()
  if (!row) return c.json({ error: 'already resolved' }, 409)

  const [run] = await db
    .select({ conversationId: agentRuns.conversationId })
    .from(agentRuns)
    .where(eq(agentRuns.id, row.agentRunId))
  await pgNotify(
    `conversation:${run!.conversationId}`,
    JSON.stringify({ type: 'interaction_resolved', interactionId: id }),
  )
  return c.json({ ok: true })
})

// --- Tools (catalog + per-tool approval settings) ---

// The tool catalog the worker published at boot, plus the owner's approval setting. The
// client groups by tool_group. require_approval is a tri-state (null = trust-tier default).
app.get('/api/tools', async (c) => {
  const rows = await getDb()
    .select({
      name: toolsTable.name,
      toolGroup: toolsTable.toolGroup,
      trustTier: toolsTable.trustTier,
      description: toolsTable.description,
      requireApproval: toolsTable.requireApproval,
    })
    .from(toolsTable)
    .orderBy(asc(toolsTable.toolGroup), asc(toolsTable.name))
  return c.json({ tools: rows })
})

// Set the approval requirement for one tool or a whole group (the client sends every name
// in the group). require_approval is a tri-state: true (force), false (skip), null (default).
// No trust-tier restriction — destructive is owner-overridable (a deliberate §16 divergence).
app.patch('/api/tools', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    names?: unknown
    requireApproval?: unknown
  }
  const names = Array.isArray(body.names)
    ? body.names.filter((n): n is string => typeof n === 'string')
    : []
  if (names.length === 0) return c.json({ error: 'names is required' }, 400)
  const { requireApproval } = body
  if (requireApproval !== true && requireApproval !== false && requireApproval !== null) {
    return c.json({ error: 'requireApproval must be true, false, or null' }, 400)
  }

  const updated = await getDb()
    .update(toolsTable)
    .set({ requireApproval, updatedAt: new Date() })
    .where(inArray(toolsTable.name, names))
    .returning({ name: toolsTable.name })
  return c.json({ updated: updated.map((r) => r.name) })
})

// --- Debug / observability (read-only) ---

app.get('/api/debug/runs', async (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
  const runs = await getDb()
    .select({
      id: agentRuns.id,
      conversationId: agentRuns.conversationId,
      status: agentRuns.status,
      model: agentRuns.model,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
      promptTokens: agentRuns.promptTokens,
      completionTokens: agentRuns.completionTokens,
      costUsd: agentRuns.costUsd,
      error: agentRuns.error,
    })
    .from(agentRuns)
    .orderBy(desc(agentRuns.id)) // uuidv7 ids are time-ordered → newest first
    .limit(limit)
  return c.json({ runs })
})

app.get('/api/debug/runs/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid run id' }, 400)
  const db = getDb()
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id))
  if (!run) return c.json({ error: 'not found' }, 404)
  const calls = await db
    .select()
    .from(llmCalls)
    .where(eq(llmCalls.agentRunId, id))
    .orderBy(asc(llmCalls.createdAt))
  // The executed-tool view: name/args/result + trust tier and approval outcome (status).
  const tools = await db
    .select()
    .from(toolCalls)
    .where(eq(toolCalls.agentRunId, id))
    .orderBy(asc(toolCalls.startedAt))
  return c.json({ run, calls, toolCalls: tools })
})

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

export default app
