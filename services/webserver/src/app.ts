import {
  agentRuns,
  conversations,
  conversationSurfaces,
  createUserMessageRun,
  deletePushSubscription,
  enqueueAgentRun,
  enqueueTriggerDetect,
  getDb,
  getAutomation,
  requestDiscordPull,
  latestRunIdForConversation,
  listTriggers,
  llmCalls,
  messages,
  OWNER_USER_ID,
  pgNotify,
  readLastAssistantText,
  recordOutOfLoopLlmCall,
  resolveInteraction,
  terminateRuns,
  toolCalls,
  tools as toolsTable,
  upsertPushSubscription,
  userInteractions,
} from '@alfred/db'
import {
  makeSttProvider,
  speechLlmCallFields,
  splitIntoSpeechChunks,
  synthesizeToClip,
  type SpeechUsage,
} from '@alfred/agent-core'
import {
  APP_VERSION,
  audioMimeForExt,
  extForAudioMime,
  extForImageMime,
  imageMimeForExt,
  loadConfig,
  resolveInWorkspace,
} from '@alfred/shared'
import { executeCommand, listCommands } from '@alfred/commands'
import { and, asc, count, desc, eq, inArray, sql, sum, type SQL } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { streamSSE, streamText } from 'hono/streaming'
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import pg from 'pg'

export const app = new Hono()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB

app.get('/api/health', (c) => c.json({ ok: true, version: APP_VERSION }))

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
    runId = await db.transaction((tx) =>
      createUserMessageRun(tx, conversationId, [
        ...(text ? [{ type: 'text', text }] : []),
        ...imageParts,
      ]),
    )
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'Alfred is already working on this conversation' }, 409)
    }
    throw err
  }

  await enqueueAgentRun(runId)
  return c.json({ runId })
})

// Cancel the conversation's active run (§10.6). The route — not the worker — owns the
// `cancelled` transition plus the §10.9 invariant-4 cascade, all in one transaction, so
// cancel still frees the conversation when the worker is hung or dead (the case that most
// needs it: the one-active-run index otherwise blocks new messages forever). The worker
// reacts to the NOTIFY by aborting; it never writes `cancelled` itself. The partial unique
// index guarantees at most one active run, so the RETURNING ids carry at most one entry.
app.post('/api/conversations/:id/cancel', async (c) => {
  const conversationId = c.req.param('id')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)

  const cancelled = await getDb().transaction((tx) =>
    terminateRuns(tx, {
      where: and(
        eq(agentRuns.conversationId, conversationId),
        inArray(agentRuns.status, ['pending', 'running', 'awaiting_approval']),
      )!,
      runStatus: 'cancelled',
      error: null,
      toolCallError: 'run cancelled',
    }),
  )
  if (cancelled.length === 0) return c.json({ error: 'nothing to cancel' }, 409)

  // NOTIFY only after the transaction committed, so anyone woken by the event (the parked
  // worker, other ingresses) reads the terminal rows, never a pre-commit snapshot.
  await pgNotify(`conversation:${conversationId}`, JSON.stringify({ type: 'cancelled' }))
  return c.json({ cancelledRunId: cancelled[0] })
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

// The slash-command catalog (name/aliases/description/usage) for the web client's autocomplete.
// Static and conversation-independent — derived from the backend command registry so the
// suggestions match what POST /commands will actually dispatch.
app.get('/api/commands', (c) => c.json({ commands: listCommands() }))

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

// Voice input (spec 2026-06-14-voice-stt-tts). Upload a recorded utterance: STT-transcribe it,
// then create the user message + a `speak` run in the SAME transaction shape as POST /messages
// (so the rest of the pipeline — NOTIFY/SSE, the worker — is unchanged). Multipart like /files
// (file field "file"); the worker reads run.speak to synthesize TTS for the reply. Returns the
// transcript so the app can show what it heard. An empty transcript (silence/noise) → 422 so the
// app resumes listening without a ghost message; a concurrent active run → 409 ("busy"), exactly
// like /messages.
app.post('/api/conversations/:id/audio', async (c) => {
  const conversationId = c.req.param('id')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)

  const form = await c.req.parseBody().catch(() => null)
  const file = form?.['file']
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400)

  // A missing content-type is a malformed request (400); a present-but-unsupported one is 415.
  if (!file.type) return c.json({ error: 'audio content-type is required' }, 400)
  if (!extForAudioMime(file.type)) {
    return c.json({ error: `unsupported type: ${file.type}` }, 415)
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: 'file too large (max 10 MB)' }, 413)
  }

  // STT outside the transaction (it's a slow network call to the speech provider; a missing
  // provider key surfaces here as a thrown error, not a boot failure — mirrors GEMINI_API_KEY).
  // Wrap the call: a provider error (incl. ElevenLabs' message that embeds the upstream response
  // body) is logged server-side but returned to the client as a clean 503 — never leak the
  // provider's raw error text to the caller.
  const audio = Buffer.from(await file.arrayBuffer())
  let text: string
  let sttUsage: SpeechUsage | undefined
  try {
    ;({ text, usage: sttUsage } = await makeSttProvider().transcribe(audio, { mimeType: file.type }))
  } catch (err) {
    console.error('STT transcription failed:', err)
    return c.json({ error: 'speech recognition failed' }, 503)
  }
  const transcript = text.trim()
  if (!transcript) return c.json({ error: 'no speech detected' }, 422)

  const db = getDb()
  let runId: string
  try {
    runId = await db.transaction((tx) =>
      createUserMessageRun(tx, conversationId, [{ type: 'text', text: transcript }], { speak: true }),
    )
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'Alfred is already working on this conversation' }, 409)
    }
    throw err
  }

  // Record the STT speech-leg call against the run (best-effort, like maybeAutoTitle): a
  // synthetic tool_calls row + a linked llm_calls row so its tokens/cost roll into the run
  // without mislabeling the run's model. rollupUsage runs at the run's END (worker), long
  // after this row is written, so the timing is safe. A failure here must never fail the turn.
  if (sttUsage) {
    try {
      await recordOutOfLoopLlmCall(db, {
        runId,
        ...speechLlmCallFields(sttUsage, 'stt', {
          detail: `${audio.length} bytes`,
          responseSummary: transcript.slice(0, 120),
        }),
      })
    } catch (err) {
      console.error('[audio] STT cost record failed:', err)
    }
  }

  await enqueueAgentRun(runId)
  return c.json({ runId, transcript })
})

// Read out the last assistant reply on demand (spec 2026-06-18). The `/speak` command dispatches
// here after readLastAssistantText confirms there's something to read. This is a RUN-FREE path: no
// pg-boss job, no agent loop, no one-active-run conflict — the webserver synthesizes the reply's
// sentences itself (it already depends on @alfred/agent-core for STT) and streams clip refs back as
// each is ready, so the client can start playing clip 0 while later clips synthesize.
//
// Response is a stream of newline-delimited JSON: { seq, path, mimeType } per clip in order, or an
// { error } line if synthesis fails (then the stream ends). The null check is BEFORE the stream so
// "nothing to read out" is a clean 422, not a stream that opens then immediately errors.
app.post('/api/conversations/:id/speak', async (c) => {
  const conversationId = c.req.param('id')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)

  const text = await readLastAssistantText(getDb(), conversationId)
  if (!text) return c.json({ error: 'Nothing to read out yet.' }, 422)

  const chunks = splitIntoSpeechChunks(text)
  // The request's AbortSignal: when the client supersedes this read-out (a fresh /speak bumps the
  // epoch and cancels the reader), switches conversation, or unmounts, stop synthesizing so we
  // don't keep making billed TTS calls + workspace writes for audio nobody will play.
  const signal = c.req.raw.signal
  return streamText(c, async (stream) => {
    let aggUsage: SpeechUsage | undefined
    for (let seq = 0; seq < chunks.length; seq++) {
      if (signal.aborted) break
      try {
        const clip = await synthesizeToClip(conversationId, chunks[seq]!, { signal })
        // Null = the chunk stripped to nothing (markdown-only); skip it, no clip line.
        if (!clip) continue
        if (clip.usage) {
          aggUsage = aggUsage
            ? {
                model: aggUsage.model,
                promptTokens: (aggUsage.promptTokens ?? 0) + (clip.usage.promptTokens ?? 0),
                completionTokens: (aggUsage.completionTokens ?? 0) + (clip.usage.completionTokens ?? 0),
              }
            : clip.usage
        }
        await stream.write(JSON.stringify({ seq, path: clip.path, mimeType: clip.mimeType }) + '\n')
      } catch (err) {
        if (signal.aborted) break
        // A missing/failed TTS provider key (or a synth error) surfaces here, not at boot. Tell the
        // client the read-out is unavailable and stop — partial audio already played is fine.
        console.error('[speak] TTS synthesis failed:', err)
        await stream.write(JSON.stringify({ error: 'speech_unavailable' }) + '\n')
        break
      }
    }

    // Attribute the aggregated TTS cost to the conversation's most recent run (the CHANGELOG-76
    // out-of-loop pattern: a synthetic 'tts' tool_calls row + a linked llm_calls row). There's no
    // message→run FK, so "latest run" is the pragmatic anchor; it will NOT re-sum into that run's
    // already-rolled-up agent_runs.cost_usd, but shows per-call on /debug. Best-effort — a failure
    // here (or no usage, e.g. ElevenLabs) must never fail the read-out.
    if (aggUsage) {
      try {
        const runId = await latestRunIdForConversation(getDb(), conversationId)
        if (runId) {
          await recordOutOfLoopLlmCall(getDb(), {
            runId,
            ...speechLlmCallFields(aggUsage, 'tts', { detail: `${chunks.length} chunks` }),
          })
        }
      } catch (err) {
        console.error('[speak] TTS cost record failed:', err)
      }
    }
  })
})

// "Continue in Discord": materialize this conversation as a Discord forum post (multi-surface
// spec 2026-06-21). Fire-and-forget — the webserver has no Discord client, so it only NOTIFYs the
// bot over the 'discord-pull' channel (requestDiscordPull); the bot creates the post, writes the
// conversation_surfaces(discord, postId) binding, mirrors the last ~20 messages in, and opens a
// standing LISTEN, all asynchronously. The conversation appears in Discord shortly. 202 Accepted
// (the work happens out-of-process); no body. If the bot is down (or DISCORD_GUILD_ID unset) the
// request is simply lost and the owner retries — acceptable for an interactive, retryable action
// (spec: same loss accepted for watcher fires). The 409 below catches only an ALREADY-MATERIALIZED
// conversation (a binding row exists); an in-flight pull (doorbell sent, post not yet created) has
// no row yet, so two rapid clicks both 202 — single-post idempotency is enforced bot-side by the
// serial pullChain re-checking the binding, not by this route.
app.post('/api/conversations/:id/surfaces/discord', async (c) => {
  const conversationId = c.req.param('id')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)
  const db = getDb()

  // The conversation must exist and belong to the owner (single-user; OWNER_USER_ID).
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, OWNER_USER_ID)))
    .limit(1)
  if (!conv) return c.json({ error: 'not found' }, 404)

  // Idempotent: if this conversation is already bound to Discord (its post exists / pull was
  // already requested-and-materialized), don't NOTIFY a second pull — 409 with the existing key.
  // The reverse-lookup index conversation_surfaces_conversation_idx covers this select.
  const [bound] = await db
    .select({ externalKey: conversationSurfaces.externalKey })
    .from(conversationSurfaces)
    .where(
      and(
        eq(conversationSurfaces.conversationId, conversationId),
        eq(conversationSurfaces.surface, 'discord'),
      ),
    )
    .limit(1)
  if (bound) return c.json({ requested: false, alreadyBound: true, externalKey: bound.externalKey }, 409)

  await requestDiscordPull(db, conversationId)
  return c.json({ requested: true }, 202)
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

// The owner's recent conversations, for the chat-surface history sidebar (web + iOS share this).
// Newest-active first (the resurrected last_active_at, bumped per message), capped at 100. Selects
// (id, title, ingress, last_active_at) only — no message join; an untitled row (null title) is
// labelled "New conversation" by the client. ALL ingresses are included (one Alfred, one continuous
// history across surfaces — CONCEPT): web/iOS chat (ingress='web'), Discord forum posts + watcher
// posts (ingress='discord'), autonomous-watcher threads (ingress='trigger'), and future voice. The
// client uses `ingress` only to badge 'trigger'/'voice' rows — Discord rows are shown un-badged.
app.get('/api/conversations', async (c) => {
  const rows = await getDb()
    .select({
      id: conversations.id,
      title: conversations.title,
      ingress: conversations.ingress,
      lastActiveAt: conversations.lastActiveAt,
    })
    .from(conversations)
    .where(eq(conversations.userId, OWNER_USER_ID))
    .orderBy(desc(conversations.lastActiveAt))
    .limit(100)
  return c.json({ conversations: rows })
})

// Conversation metadata (the title), for the chat header, plus activeRun — whether a run is
// currently in flight, so a mid-run refresh restores the busy state and the Stop button (the
// owner's way to free a conversation stuck behind the one-active-run index). The existence
// probe hits the partial active-status index, so it's cheap. A never-created conversation is
// fine — return a null title (and no run can exist without the row's FK) rather than 404.
app.get('/api/conversations/:id', async (c) => {
  const conversationId = c.req.param('id')
  if (!UUID_RE.test(conversationId)) return c.json({ error: 'invalid conversation id' }, 400)
  const db = getDb()
  const [row] = await db
    .select({ id: conversations.id, title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  if (!row) return c.json({ id: conversationId, title: null, activeRun: false, tokens: 0, costUsd: '0' })
  const [active] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.conversationId, conversationId),
        inArray(agentRuns.status, ['pending', 'running', 'awaiting_approval']),
      ),
    )
    .limit(1)
  // Cumulative tokens/cost over the conversation's runs — the baseline the client footer
  // shows, overlaid live by the worker's `usage` SSE events (spec 2026-06-15). sum() yields
  // string|null; costUsd stays a string like every other costUsd field in this codebase.
  const [agg] = await db
    .select({
      promptTokens: sum(agentRuns.promptTokens),
      completionTokens: sum(agentRuns.completionTokens),
      costUsd: sum(agentRuns.costUsd),
    })
    .from(agentRuns)
    .where(eq(agentRuns.conversationId, conversationId))
  const tokens = Number(agg?.promptTokens ?? 0) + Number(agg?.completionTokens ?? 0)
  const costUsd = agg?.costUsd ?? '0'
  return c.json({ ...row, activeRun: active !== undefined, tokens, costUsd })
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
    // A dropped LISTEN socket (Postgres restart) is otherwise an unhandled 'error'
    // EventEmitter event that crashes the whole webserver; log and degrade — the browser's
    // EventSource reconnects on its own.
    client.on('error', (err) => console.error(`[sse ${conversationId}] LISTEN connection error:`, err))
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
// still-pending row, so a second resolver (or a timeout) loses -> 409. The body shape
// depends on the interaction's kind — an approval verdict { approved, note } or a question
// answer { selected_labels, freeform_text } — so we read the row's kind first. This pre-read
// is REQUIRED, not foldable into the UPDATE's RETURNING: the validation and the response we
// write both depend on kind, so kind must be known before the write. It's non-authoritative
// (the conditional UPDATE in writeResolution still guards the race) and also yields the
// approval prompt for the remember side effect, so it costs one round-trip, not two.
app.post('/api/interactions/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid interaction id' }, 400)

  const db = getDb()
  const [existing] = await db
    .select({ kind: userInteractions.kind, prompt: userInteractions.prompt })
    .from(userInteractions)
    .where(eq(userInteractions.id, id))
  if (!existing) return c.json({ error: 'not found' }, 404)

  if (existing.kind === 'question') {
    return resolveQuestion(c, db, id)
  }
  return resolveApproval(c, db, id, existing.prompt)
})

// Approval resolve (the runtime-injected gate): require an { approved } boolean, write the
// verdict, then the best-effort "don't ask again" side effect.
async function resolveApproval(c: Context, db: ReturnType<typeof getDb>, id: string, prompt: unknown) {
  const body = (await c.req.json().catch(() => ({}))) as {
    approved?: boolean
    note?: string
    remember?: boolean
  }
  const { approved, note, remember } = body
  if (typeof approved !== 'boolean') return c.json({ error: 'approved is required' }, 400)

  if (!(await writeResolution(db, id, { approved, note }))) {
    return c.json({ error: 'already resolved' }, 409)
  }

  // "Don't ask again": persist the decision into the same tools.require_approval store the
  // Tools page writes (§16), so it survives across runs and restarts. Deliberately AFTER the
  // resolve + NOTIFY above and best-effort (try/catch) — this is a convenience, and a failure
  // here must never block waking the parked worker. Only on approve (no "always reject" tier,
  // mirroring the Tools page). A group-scoped card covers the whole tool group; a call-scoped
  // one just the one tool.
  if (approved && remember) {
    const p = prompt as { tool?: string; scope?: 'group' | 'call' } | null
    const toolName = p?.tool
    if (toolName) {
      try {
        const [tool] = await db
          .select({ group: toolsTable.toolGroup })
          .from(toolsTable)
          .where(eq(toolsTable.name, toolName))
        const where =
          p?.scope === 'group' && tool?.group
            ? eq(toolsTable.toolGroup, tool.group)
            : eq(toolsTable.name, toolName)
        await setToolsApproval(db, where, false)
      } catch (err) {
        console.error(`[interactions] failed to persist "don't ask again" for ${toolName}:`, err)
      }
    }
  }
  return c.json({ ok: true })
}

// Question resolve (the agent-initiated ask_user answer): require at least one of a non-empty
// selected_labels array or a non-empty freeform_text, write the structured answer, then the
// same conditional UPDATE + NOTIFY. No "don't ask again" — questions aren't a tool to silence.
async function resolveQuestion(c: Context, db: ReturnType<typeof getDb>, id: string) {
  const body = (await c.req.json().catch(() => ({}))) as {
    selected_labels?: unknown
    freeform_text?: unknown
  }
  const selectedLabels = Array.isArray(body.selected_labels)
    ? body.selected_labels.filter((l): l is string => typeof l === 'string')
    : []
  const freeformText = typeof body.freeform_text === 'string' ? body.freeform_text : undefined
  if (selectedLabels.length === 0 && !freeformText?.trim()) {
    return c.json({ error: 'selected_labels or freeform_text is required' }, 400)
  }

  if (!(await writeResolution(db, id, { selected_labels: selectedLabels, freeform_text: freeformText }))) {
    return c.json({ error: 'already resolved' }, 409)
  }
  return c.json({ ok: true })
}

// First-writer-wins resolve for the web ingress: the conditional UPDATE + NOTIFY now lives in
// @alfred/db's resolveInteraction (one writer shared with the Discord ingress, no drift); this is
// the thin web caller that supplies resolvedVia:'web'. Both resolveApproval and resolveQuestion
// route through it, keeping their own kind-specific validation (and the approval "remember" side
// effect) above. Returns false (caller → 409) if the row was already resolved/timed_out.
function writeResolution(
  db: ReturnType<typeof getDb>,
  id: string,
  response: unknown,
): Promise<boolean> {
  return resolveInteraction(db, id, { response, resolvedVia: 'web' })
}

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

// Per-watcher cost view (autonomous-watchers). Two cost paths: (1) DISMISSED detections accrue to
// triggers.detection_cost_usd (a per-watcher counter — Tier-1 triage that didn't escalate, which
// never creates an agent_runs row); (2) ESCALATED action runs of a recurring watcher live on its
// dedicated conversation (ingress='trigger', channel_key = trigger.id), summed here. (One-shot
// 'self' runs live on the originating conversation and show under the normal /debug ledger.)
app.get('/api/debug/triggers', async (c) => {
  const db = getDb()
  const trigs = await listTriggers(db, OWNER_USER_ID)
  if (trigs.length === 0) return c.json({ triggers: [] })
  const ids = trigs.map((t) => t.id)
  const agg = await db
    .select({
      channelKey: conversations.channelKey,
      runCount: count(),
      promptTokens: sum(agentRuns.promptTokens),
      completionTokens: sum(agentRuns.completionTokens),
      costUsd: sum(agentRuns.costUsd),
    })
    .from(agentRuns)
    .innerJoin(conversations, eq(agentRuns.conversationId, conversations.id))
    .where(and(eq(conversations.ingress, 'trigger'), inArray(conversations.channelKey, ids)))
    .groupBy(conversations.channelKey)
  const byKey = new Map(agg.map((a) => [a.channelKey, a]))
  const result = trigs.map((t) => {
    const a = byKey.get(t.id)
    const detection = Number(t.detectionCostUsd ?? 0)
    const action = Number(a?.costUsd ?? 0)
    return {
      id: t.id,
      name: t.name,
      trigger: t.trigger,
      enabled: t.enabled,
      schedule: t.schedule,
      notifyPolicy: t.notifyPolicy,
      lastFiredAt: t.lastFiredAt,
      nextFireAt: t.nextFireAt,
      detectionCostUsd: t.detectionCostUsd ?? '0',
      actionRunCount: a ? Number(a.runCount) : 0,
      actionPromptTokens: Number(a?.promptTokens ?? 0),
      actionCompletionTokens: Number(a?.completionTokens ?? 0),
      actionCostUsd: a?.costUsd ?? '0',
      totalCostUsd: (detection + action).toFixed(6),
    }
  })
  return c.json({ triggers: result })
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

// --- Web Push subscriptions (autonomous-watcher notifications) ---

// Register this browser's Web Push subscription so the worker's notification dispatcher can
// reach the owner out-of-band (a watcher fires while no client is connected — the case SSE
// can't serve). Keyed on endpoint (upsert): the same browser re-subscribing refreshes its keys
// rather than duplicating. Single-user, so the subscription always belongs to OWNER_USER_ID.
app.post('/api/push/subscribe', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    endpoint?: unknown
    keys?: unknown
    userAgent?: unknown
  }
  const { endpoint } = body
  const keys = body.keys as { p256dh?: unknown; auth?: unknown } | undefined
  if (
    typeof endpoint !== 'string' ||
    endpoint === '' ||
    typeof keys !== 'object' ||
    keys === null ||
    typeof keys.p256dh !== 'string' ||
    typeof keys.auth !== 'string'
  ) {
    return c.json({ error: 'endpoint and keys { p256dh, auth } are required' }, 400)
  }
  const userAgent = typeof body.userAgent === 'string' ? body.userAgent : null

  await upsertPushSubscription(getDb(), {
    userId: OWNER_USER_ID,
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    userAgent,
  })
  return c.json({ ok: true })
})

// Explicit opt-out: drop this browser's subscription (the owner disabling notifications). The
// dispatcher also prunes on a 410 Gone, so a stale row self-heals even without this call.
app.post('/api/push/unsubscribe', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown }
  if (typeof body.endpoint !== 'string' || body.endpoint === '') {
    return c.json({ error: 'endpoint is required' }, 400)
  }
  await deletePushSubscription(getDb(), body.endpoint)
  return c.json({ ok: true })
})

// The VAPID public key the PWA needs to create a Web Push subscription. Null when VAPID isn't
// configured (push inert, like the email keys) — the client then skips the subscribe flow.
app.get('/api/push/vapid-public-key', (c) =>
  c.json({ publicKey: loadConfig().VAPID_PUBLIC_KEY ?? null }),
)

// --- Webhook trigger ingress ---

// Fire an event-driven webhook watcher (spec §9.4): enqueue a trigger-detect job for this
// trigger, which the worker runs through the tiered detection ladder. Only an existing,
// enabled, kind='webhook' trigger is fireable — anything else is 404 (don't leak whether a
// non-webhook trigger exists, and never enqueue detect for the wrong kind). This route creates
// NO agent_runs row; detection (Tier 0/1) runs row-free, only an escalation spawns a run.
//
// Auth: this route is intentionally UNAUTHENTICATED, like every other route here. Per
// ARCHITECTURE §12 ("network position is the authentication"), the webserver has no public
// exposure — only the owner's tailnet / LAN-behind-the-firewall can reach it, so being able to
// connect is being the owner. The 404 guard above (unknown/disabled/non-webhook ids do not
// enqueue) bounds the worst case to "amplify a detect-job the owner already configured." If this
// box ever gains public exposure, a per-trigger webhook secret (a token in the path/header,
// checked here) is the deferred hardening — out of scope for the single-user model. No schema
// change is made for that here.
app.post('/api/triggers/:id/webhook', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid trigger id' }, 400)

  const automation = await getAutomation(getDb(), id)
  if (!automation || !automation.enabled || automation.trigger !== 'webhook') {
    return c.json({ error: 'not found' }, 404)
  }

  await enqueueTriggerDetect(id)
  return c.json({ ok: true }, 202)
})

// Map a stored filename's extension to a content type. Uploads (images) and TTS clips (audio)
// are written with an extension derived from their (validated/provider) mime type, so this
// round-trips correctly: try image first, then audio, then fall back to a generic binary type.
function contentTypeFor(filename: string): string {
  const ext = path.extname(filename)
  return imageMimeForExt(ext) ?? audioMimeForExt(ext) ?? 'application/octet-stream'
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

export default app
