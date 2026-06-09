import {
  agentRuns,
  conversations,
  ensureConversation,
  enqueueAgentRun,
  getDb,
  llmCalls,
  messages,
  pgNotify,
  toolCalls,
  tools as toolsTable,
  userInteractions,
} from '@alfred/db'
import { extForImageMime, imageMimeForExt, loadConfig, resolveInWorkspace } from '@alfred/shared'
import { and, asc, count, desc, eq, inArray, sql, sum, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { executeCommand } from './commands.js'
import { streamSSE } from 'hono/streaming'
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import pg from 'pg'

export const app = new Hono()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB

app.get('/api/health', (c) => c.json({ ok: true }))

// Post a user message: persist it + a pending run in one transaction, then enqueue the
// job. The one-active-run index makes a concurrent send fail -> 409 ("busy").
app.post('/api/conversations/:id/messages', async (c) => {
  const conversationId = c.req.param('id')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)

  const body = (await c.req.json().catch(() => ({}))) as {
    text?: string
    attachments?: unknown
  }
  const text = body.text?.trim()

  // Optional image attachments: each { path, mimeType } references a file already written
  // into this conversation's workspace by POST /files. Stored as reference-form image parts;
  // the worker bridges them to inline base64 when assembling history (spec Design).
  const attachments = Array.isArray(body.attachments) ? body.attachments : []
  const imageParts: { type: 'image'; path: string; mimeType: string }[] = []
  for (const a of attachments) {
    if (typeof a !== 'object' || a === null) {
      return c.json({ error: 'each attachment must be { path, mimeType }' }, 400)
    }
    const { path: p, mimeType } = a as { path?: unknown; mimeType?: unknown }
    if (typeof p !== 'string' || typeof mimeType !== 'string') {
      return c.json({ error: 'each attachment must be { path, mimeType }' }, 400)
    }
    imageParts.push({ type: 'image', path: p, mimeType })
  }

  // A message needs at least a text body or one attachment (the web client enables Send on
  // either). Reject only the genuinely empty submission.
  if (!text && imageParts.length === 0) {
    return c.json({ error: 'text or an attachment is required' }, 400)
  }

  const db = getDb()
  let runId: string
  try {
    runId = await db.transaction(async (tx) => {
      await ensureConversation(tx, conversationId)
      const [msg] = await tx
        .insert(messages)
        .values({
          conversationId,
          role: 'user',
          content: [...(text ? [{ type: 'text', text }] : []), ...imageParts],
        })
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

// Run a slash command (spec 2026-06-09-chat-commands). The client forwards a raw '/'-prefixed
// line; the backend registry parses + executes it (no message row, no agent run). Command-level
// outcomes (unknown command, usage error) come back as 200 with { error } for the client to
// render as an inline note; only malformed requests (bad id, missing input) are 4xx.
app.post('/api/conversations/:id/commands', async (c) => {
  const conversationId = c.req.param('id')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)

  const body = (await c.req.json().catch(() => ({}))) as { input?: unknown }
  if (typeof body.input !== 'string' || body.input.trim() === '') {
    return c.json({ error: 'input is required' }, 400)
  }

  const result = await executeCommand(body.input, { conversationId, db: getDb() })
  return c.json(result)
})

// Upload a single image into the conversation's workspace. Multipart, parsed via Hono's
// c.req.parseBody() (no extra dep). The mime type must be an accepted image type and the
// size ≤10 MB; everything else is rejected here. Returns the workspace-relative path so the
// client can echo it back in the message's `attachments` (spec: Vision input — upload).
app.post('/api/conversations/:id/files', async (c) => {
  const conversationId = c.req.param('id')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)

  const form = await c.req.parseBody().catch(() => null)
  const file = form?.['file']
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400)

  // Extension is derived from the validated mime type, never trusted from the client
  // filename, so the stored file's type is always known.
  const ext = extForImageMime(file.type)
  if (!ext) {
    return c.json({ error: `unsupported type: ${file.type || 'unknown'}` }, 415)
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: 'file too large (max 10 MB)' }, 413)
  }

  // Sanitize the client name to a safe stem (drop its extension; we append the canonical one
  // derived from the validated mime type, so the on-disk type is never client-controlled).
  const rawStem = (file.name || 'image').replace(/\.[^.]+$/, '')
  const safeStem =
    rawStem
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/^_+/, '')
      .slice(0, 64) || 'image'
  const relPath = `upload-${Date.now()}-${safeStem}.${ext}`

  // resolveInWorkspace confines the write under <WORKSPACE_ROOT>/<conversationId>/.
  const abs = resolveInWorkspace(conversationId, relPath)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, Buffer.from(await file.arrayBuffer()))

  return c.json({ path: relPath, mimeType: file.type })
})

// Serve a file from the conversation's workspace (the UI fetches images here after a run).
// Confined to the workspace via resolveInWorkspace, so a traversal filename is rejected —
// unlike the SPA's serveStatic, this never reaches outside the conversation dir.
app.get('/media/:conversationId/:filename', async (c) => {
  const conversationId = c.req.param('conversationId')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)
  const filename = c.req.param('filename')

  let abs: string
  try {
    abs = resolveInWorkspace(conversationId, filename)
  } catch {
    return c.json({ error: 'invalid path' }, 400)
  }

  const info = await stat(abs).catch(() => null)
  if (!info || !info.isFile()) return c.json({ error: 'not found' }, 404)

  c.header('Content-Type', contentTypeFor(filename))
  c.header('Content-Length', String(info.size))
  return c.body(Readable.toWeb(createReadStream(abs)) as ReadableStream)
})

// Conversation metadata (the title), for the chat header. A never-created conversation is fine
// — return a null title rather than 404.
app.get('/api/conversations/:id', async (c) => {
  const conversationId = c.req.param('id')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)
  const [row] = await getDb()
    .select({ id: conversations.id, title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  if (!row) return c.json({ id: conversationId, title: null })
  return c.json(row)
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

  const body = (await c.req.json().catch(() => ({}))) as {
    approved?: boolean
    note?: string
    remember?: boolean
  }
  const { approved, note, remember } = body
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

  // "Don't ask again": persist the decision into the same tools.require_approval store the
  // Tools page writes (§16), so it survives across runs and restarts. Deliberately AFTER the
  // resolve + NOTIFY above and best-effort (try/catch) — this is a convenience, and a failure
  // here must never block waking the parked worker. Only on approve (no "always reject" tier,
  // mirroring the Tools page). A group-scoped card covers the whole tool group; a call-scoped
  // one just the one tool.
  if (approved && remember) {
    const prompt = row.prompt as { tool?: string; scope?: 'group' | 'call' } | null
    const toolName = prompt?.tool
    if (toolName) {
      try {
        const [tool] = await db
          .select({ group: toolsTable.toolGroup })
          .from(toolsTable)
          .where(eq(toolsTable.name, toolName))
        const where =
          prompt?.scope === 'group' && tool?.group
            ? eq(toolsTable.toolGroup, tool.group)
            : eq(toolsTable.name, toolName)
        await setToolsApproval(db, where, false)
      } catch (err) {
        console.error(`[interactions] failed to persist "don't ask again" for ${toolName}:`, err)
      }
    }
  }
  return c.json({ ok: true })
})

// Single writer for the owner's per-tool approval setting (tools.require_approval), shared by
// the Tools page (PATCH) and the chat "don't ask again" resolve path so the two can't drift.
function setToolsApproval(db: ReturnType<typeof getDb>, where: SQL, requireApproval: boolean | null) {
  return db.update(toolsTable).set({ requireApproval, updatedAt: new Date() }).where(where)
}

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

  const updated = await setToolsApproval(
    getDb(),
    inArray(toolsTable.name, names),
    requireApproval,
  ).returning({ name: toolsTable.name })
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

// Conversation-grouped run list for the /debug ledger. Returns recent conversations
// (ranked by their newest run) with their runs embedded as lightweight rows for the
// sparkline/timeline — the heavy per-run detail (llm_calls bodies, tool args/results)
// stays behind /api/debug/runs/:id, fetched lazily when a run is expanded.
//
// Per-conversation aggregates (run count, token + cost totals) are computed by a grouped
// query over ALL of a conversation's runs, NOT derived from the embedded display rows —
// so the headline numbers stay accurate even when a conversation has more runs than the
// display cap shows.
const DISPLAY_RUNS_PER_CONVERSATION = 30
app.get('/api/debug/conversations', async (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
  const db = getDb()

  // Recent conversations ranked by their newest run, with full (uncapped) aggregates.
  // uuidv7 ids are time-ordered and their text form sorts the same way, so max(id::text)
  // is the newest run (Postgres has no max() aggregate for the uuid type itself).
  const agg = await db
    .select({
      conversationId: agentRuns.conversationId,
      runCount: count(),
      promptTokens: sum(agentRuns.promptTokens),
      completionTokens: sum(agentRuns.completionTokens),
      costUsd: sum(agentRuns.costUsd),
    })
    .from(agentRuns)
    .groupBy(agentRuns.conversationId)
    .orderBy(sql`max(${agentRuns.id}::text) desc`)
    .limit(limit)

  const order = agg.map((a) => a.conversationId)
  if (order.length === 0) return c.json({ conversations: [] })

  // Display runs for those conversations (newest first, capped per conversation). The
  // overall fetch is bounded; the per-conversation cap is enforced while grouping.
  const runs = await db
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
    .where(inArray(agentRuns.conversationId, order))
    .orderBy(desc(agentRuns.id))
    .limit(order.length * DISPLAY_RUNS_PER_CONVERSATION)

  const byConversation = new Map<string, typeof runs>()
  for (const r of runs) {
    const bucket = byConversation.get(r.conversationId) ?? []
    if (bucket.length < DISPLAY_RUNS_PER_CONVERSATION) bucket.push(r)
    byConversation.set(r.conversationId, bucket)
  }

  const convRows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      ingress: conversations.ingress,
      lastActiveAt: conversations.lastActiveAt,
    })
    .from(conversations)
    .where(inArray(conversations.id, order))
  const meta = new Map(convRows.map((cv) => [cv.id, cv]))

  const result = agg.map((a) => {
    const cv = meta.get(a.conversationId)
    return {
      id: a.conversationId,
      title: cv?.title ?? null,
      ingress: cv?.ingress ?? null,
      lastActiveAt: cv?.lastActiveAt ?? null,
      runCount: a.runCount,
      promptTokens: Number(a.promptTokens ?? 0),
      completionTokens: Number(a.completionTokens ?? 0),
      costUsd: a.costUsd ?? '0',
      runs: byConversation.get(a.conversationId) ?? [],
    }
  })
  return c.json({ conversations: result })
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

// Map a stored filename's extension to a content type. Uploads are written with an
// extension derived from their (validated) mime type, so this round-trips correctly; an
// unknown extension falls back to a generic binary type.
function contentTypeFor(filename: string): string {
  return imageMimeForExt(path.extname(filename)) ?? 'application/octet-stream'
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

export default app
