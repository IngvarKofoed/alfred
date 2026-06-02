import {
  agentRuns,
  conversations,
  enqueueAgentRun,
  getDb,
  messages,
  OWNER_USER_ID,
  users,
} from '@alfred/db'
import { loadConfig } from '@alfred/shared'
import { asc, eq } from 'drizzle-orm'
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

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

export default app
