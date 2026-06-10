import {
  type ApprovalRequest,
  type ApprovalVerdict,
  computeCostUsd,
  type ContentPart,
  GeminiProvider,
  isImageResult,
  type LlmProvider,
  type Message,
  runAgent,
  TracingProvider,
} from '@alfred/agent-core'
import { agentRuns, getDb, llmCalls, messages, toolCalls, tools as toolsTable, userInteractions } from '@alfred/db'
import { loadConfig } from '@alfred/shared'
import { and, asc, eq } from 'drizzle-orm'
import pg from 'pg'
import { buildRunTools } from './catalog.js'
import { notifyRun } from './events.js'
import { type ImageRef, writeImageToWorkspace } from './images.js'
import { rowsToMessages } from './messages.js'

// MVP approval window (§10.4): a deliberate shortening of the 24h default. The pg-boss
// lease sits just above it so a job blocked on approval outlives the timeout.
const APPROVAL_TIMEOUT_MS = 60 * 60 * 1000

// Minimal system prompt for now; full persona assembly (§7.5) is deferred.
const SYSTEM_PROMPT =
  'You are Alfred, a helpful personal assistant. Be concise and direct. ' +
  'Images you create with generate_image are shown to the user automatically; ' +
  "don't thank the user for them or describe them back unless asked. " +
  "You can run Python in this conversation's working directory with run_python (the same directory " +
  'the file tools use) and install packages with pip_install.'

export interface RunDeps {
  provider?: LlmProvider
}

// Advance one run to completion: load history, run the loop streaming tokens over NOTIFY,
// persist the assistant turn, and move the run to done/failed. Idempotent on status.
export async function runJob(runId: string, deps: RunDeps = {}): Promise<void> {
  const db = getDb()

  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId))
  if (!run || run.status !== 'pending') return // already handled / cancelled

  await db
    .update(agentRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(agentRuns.id, runId))

  try {
    const rows = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, run.conversationId))
      .orderBy(asc(messages.createdAt))

    const history: Message[] = [
      { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
      ...(await rowsToMessages(run.conversationId, rows)),
    ]

    // Serialize NOTIFYs so tokens reach the client in order (onText is synchronous).
    let notifyChain: Promise<void> = Promise.resolve()
    const base = deps.provider ?? new GeminiProvider()
    // Decorate with tracing: each provider call persists an llm_calls row (observability).
    const provider = new TracingProvider(base, async (trace) => {
      const promptTokens = trace.promptTokens ?? 0
      const completionTokens = trace.completionTokens ?? 0
      await db.insert(llmCalls).values({
        agentRunId: runId,
        model: trace.model,
        request: trace.request,
        tools: trace.tools,
        responseText: trace.responseText,
        responseToolCalls: trace.responseToolCalls,
        promptTokens,
        completionTokens,
        costUsd: computeCostUsd(
          trace.model,
          promptTokens,
          completionTokens,
          trace.cachedTokens ?? 0,
        ).toFixed(6),
        finishReason: trace.finishReason ?? null,
        latencyMs: trace.latencyMs,
        error: trace.error ?? null,
      })
    })

    // Maps an agent-core call id to the tool_calls row id, so onToolEnd / requestApproval /
    // ask_user can update the row the loop is talking about. Built before the toolset so
    // ask_user's pause can resolve its own row from the call id (invariant 2, §10.9).
    const toolCallRowIds = new Map<string, string>()

    // ask_user's run-bound pause (§7.3, §10.2): the agent calls ask_user, which calls this to
    // raise a question interaction and block until the owner answers (or it times out). Maps
    // the resolved user_interactions.response to the tool result the model sees.
    const askUserPause = async (callId: string, prompt: unknown): Promise<unknown> => {
      const response = (await awaitInteraction(db, {
        conversationId: run.conversationId,
        runId,
        toolCallId: toolCallRowIds.get(callId) ?? null,
        kind: 'question',
        prompt,
      })) as { selected_labels?: string[]; freeform_text?: string } | null
      // null/timeout ⇒ an error-shaped result so the model sees the question went unanswered
      // rather than mistaking it for an empty selection.
      if (!response) return { error: 'no_answer', note: 'question timed out' }
      return { selected_labels: response.selected_labels ?? [], freeform_text: response.freeform_text }
    }

    // The full toolset for this run (echo + the context-bound title tool + the browser
    // tools), assembled in one place so the boot catalog publish can't drift from it.
    const tools = buildRunTools(run.conversationId, askUserPause)

    // The owner's per-tool approval overrides (the tools page, §16), loaded once per run.
    // require_approval is a tri-state: null/absent ⇒ fall back to the trust-tier default.
    const overrideRows = await db
      .select({ name: toolsTable.name, requireApproval: toolsTable.requireApproval })
      .from(toolsTable)
    const approvalOverrides = new Map(overrideRows.map((r) => [r.name, r.requireApproval]))
    const requiresApproval = (call: ApprovalRequest): boolean =>
      approvalOverrides.get(call.name) ?? call.trustTier !== 'read'

    // When a tool returns an image, the loop puts the inline base64 on an `image` part of the
    // tool turn (so the model sees it this turn) but Postgres must stay blob-free. onToolEnd
    // writes the bytes to the workspace and records base64 -> reference here; the message
    // persistence below swaps each inline `image` part for its on-disk reference.
    const imageRefByData = new Map<string, ImageRef>()

    // Group-scoped approval (§16): once the owner approves a tool group (e.g. 'browser'),
    // further calls in that group skip the prompt for the rest of THIS run. Per-run and
    // in-memory — a crash drops the grant with the run (fail-and-restart, §7.6). Only
    // successful approvals are remembered; a rejection rejects just that call.
    const approvedGroups = new Set<string>()

    const finalMessages = await runAgent({
      provider,
      tools,
      messages: history,
      model: run.model ?? undefined,
      onText: (delta) => {
        notifyChain = notifyChain.then(() =>
          notifyRun(run.conversationId, { type: 'token', text: delta }),
        )
      },
      onToolStart: async (call) => {
        const [row] = await db
          .insert(toolCalls)
          .values({
            agentRunId: runId,
            toolName: call.name,
            args: call.args,
            trustTier: call.trustTier,
            // 'pending' if it will pause for approval, else 'running' (it runs immediately).
            // Mirrors the same predicate the loop gates on, so an owner-disabled gate (the
            // tools page) isn't recorded as a misleading 'pending'. A pausesForInput tool
            // (e.g. ask_user) also starts 'pending': it pauses on its own (question, §10.2),
            // so it walks the §10.9-sanctioned pending -> awaiting_user -> done path even
            // though it's read-tier.
            status: requiresApproval(call) || call.pausesForInput ? 'pending' : 'running',
            startedAt: new Date(),
          })
          .returning({ id: toolCalls.id })
        toolCallRowIds.set(call.id, row!.id)
        // Subtle live signal to the chat (chained after this turn's tokens for ordering).
        // Carry the args for the chip's summary, but only when small — large args (e.g. an
        // evaluate_javascript script) could exceed the 8000-byte NOTIFY cap and fail the run;
        // omit them and the live chip shows just the name (history still summarizes from the
        // persisted tool_use part).
        const argsForChip =
          call.args != null && JSON.stringify(call.args).length <= 1024 ? call.args : undefined
        notifyChain = notifyChain.then(() =>
          notifyRun(run.conversationId, {
            type: 'tool_call_start',
            id: call.id,
            toolName: call.name,
            args: argsForChip,
          }),
        )
      },
      onToolEnd: async (call, outcome) => {
        const rowId = toolCallRowIds.get(call.id)
        if (!rowId) return
        // Image results: write the bytes to the workspace and store only the REFERENCE in
        // tool_calls.result — base64 never lands in Postgres (spec's two-representation
        // design). The in-memory base64 already flowed to the model this turn via the loop.
        let persistedResult: unknown = outcome.result ?? null
        if (isImageResult(outcome.result)) {
          // The model already saw the image this turn; a workspace-write failure must not
          // crash an otherwise-healthy run, and base64 must never land in Postgres. On
          // failure, persist a reference-less marker and leave the map unset (toRef below
          // then drops the inline part rather than writing bytes to the DB).
          try {
            const ref = writeImageToWorkspace(run.conversationId, call.name, outcome.result.image)
            imageRefByData.set(outcome.result.image.data, ref)
            persistedResult = { ...ref, summary: outcome.result.summary }
          } catch (err) {
            console.error(`[run ${runId}] failed to persist image from ${call.name}:`, err)
            persistedResult = { error: 'image persistence failed', summary: outcome.result.summary }
          }
        }
        await db
          .update(toolCalls)
          .set({
            status: outcome.status,
            result: persistedResult,
            error: outcome.error ?? null,
            finishedAt: new Date(),
          })
          .where(eq(toolCalls.id, rowId))
        notifyChain = notifyChain.then(() =>
          notifyRun(run.conversationId, { type: 'tool_call_end', id: call.id }),
        )
      },
      // An AI call a tool made outside the loop (e.g. generate_image). Persist it as an
      // llm_calls row linked to the originating tool_call so its cost is attributed (§6.5);
      // the summaries never carry image base64.
      onToolLlmCall: async (callId, call) => {
        const promptTokens = call.promptTokens ?? 0
        const completionTokens = call.completionTokens ?? 0
        await db.insert(llmCalls).values({
          agentRunId: runId,
          toolCallId: toolCallRowIds.get(callId) ?? null,
          model: call.model,
          // A small summary, never image base64.
          request: { tool: true, summary: call.requestSummary ?? null },
          tools: null,
          responseText: call.responseSummary ?? '',
          responseToolCalls: null,
          promptTokens,
          completionTokens,
          costUsd: computeCostUsd(
            call.model,
            promptTokens,
            completionTokens,
            call.cachedTokens ?? 0,
            call.images ?? 0,
          ).toFixed(6),
          finishReason: call.finishReason ?? null,
          latencyMs: call.latencyMs ?? 0,
          error: null,
        })
      },
      requiresApproval,
      requestApproval: async (call) => {
        // Group already granted this run → auto-approve without prompting. The tool_calls
        // row is still written by onToolStart above, so the action stays in the audit log.
        // Destructive calls are exempt: §16 requires them to always prompt, regardless of
        // any group grant (a grant earned by a write call must never cover a destructive one).
        if (call.group && call.trustTier !== 'destructive' && approvedGroups.has(call.group)) {
          return { approved: true }
        }
        const verdict = await requestApproval(db, run.conversationId, runId, toolCallRowIds, call)
        if (verdict.approved && call.group) approvedGroups.add(call.group)
        return verdict
      },
    })
    await notifyChain

    // Persist everything the loop appended beyond the input (the assistant turn(s)). Inline
    // `image` parts (carrying base64) are swapped for their on-disk reference so Postgres
    // stays blob-free; the bytes were written to the workspace in onToolEnd. The persisted
    // shape (the reference) deliberately diverges from the in-memory ContentPart.
    const toRef = (part: ContentPart): ContentPart | ImageRef => {
      if (part.type !== 'image') return part
      const ref = imageRefByData.get(part.data)
      if (ref) return ref
      // No reference means the workspace write failed (logged in onToolEnd) — never persist
      // the raw base64 into Postgres. Drop it to a placeholder; the model saw it in-run.
      console.error(`[run ${runId}] image part has no workspace reference; storing placeholder`)
      return { type: 'text', text: '[image not persisted]' }
    }
    for (const m of finalMessages.slice(history.length)) {
      if (m.role === 'assistant' || m.role === 'tool') {
        await db.insert(messages).values({
          conversationId: run.conversationId,
          role: m.role,
          content: m.content.map(toRef),
        })
      }
    }

    await db
      .update(agentRuns)
      .set({ status: 'done', finishedAt: new Date(), ...(await rollupUsage(db, runId)) })
      .where(eq(agentRuns.id, runId))
    await notifyRun(run.conversationId, { type: 'done' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Roll up usage on failure too: llm_calls rows are written per call (even when the
    // run later throws), so a run that made paid calls before failing still reports its
    // true cost/tokens rather than the 0 default.
    await db
      .update(agentRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        error: message,
        ...(await rollupUsage(db, runId)),
      })
      .where(eq(agentRuns.id, runId))
    await notifyRun(run.conversationId, { type: 'error', message })
  }
}

// Sum token usage + cost (and pick the model) from a run's llm_calls, shaped for an
// agent_runs update. costUsd is numeric → string in JS; summed as floats and stored at
// 6-decimal scale. Used on both the done and failed paths so cost accounting is honest
// regardless of outcome.
async function rollupUsage(db: ReturnType<typeof getDb>, runId: string) {
  const calls = await db
    .select({
      promptTokens: llmCalls.promptTokens,
      completionTokens: llmCalls.completionTokens,
      costUsd: llmCalls.costUsd,
      model: llmCalls.model,
      toolCallId: llmCalls.toolCallId,
    })
    .from(llmCalls)
    .where(eq(llmCalls.agentRunId, runId))
  // The run's model reflects the AGENT LOOP only (tool_call_id IS NULL) — an image-tool call
  // has its own llm_calls row and must not mislabel the run as the image model. Fall back to
  // the last call of any kind only if there are no loop calls.
  const loopModel = calls.filter((row) => row.toolCallId === null).at(-1)?.model
  return {
    // SUMS span ALL calls (image cost still counts toward the run); only the model is filtered.
    promptTokens: calls.reduce((sum, row) => sum + row.promptTokens, 0),
    completionTokens: calls.reduce((sum, row) => sum + row.completionTokens, 0),
    costUsd: calls.reduce((sum, row) => sum + Number(row.costUsd), 0).toFixed(6),
    model: loopModel ?? calls.at(-1)?.model ?? null,
  }
}

// The generic pause-for-user mechanism (§10.2–§10.4): persist a user_interactions row of the
// given kind/prompt, surface it over NOTIFY, and BLOCK on a dedicated LISTEN until the owner
// resolves it (or a 1h timeout flips it to timed_out). Returns the resolved row's `response`
// (raw — null on timeout). No durable resume — a crash sweeps the run to failed on startup
// (§7.6). Both the approval gate and ask_user's question pause are thin callers of this.
async function awaitInteraction(
  db: ReturnType<typeof getDb>,
  args: {
    conversationId: string
    runId: string
    toolCallId: string | null
    kind: 'approval' | 'question'
    prompt: unknown
  },
): Promise<unknown> {
  const { conversationId, runId, toolCallId, kind, prompt } = args

  // (a) the tool_call is now waiting on the user.
  if (toolCallId) {
    await db
      .update(toolCalls)
      .set({ status: 'awaiting_user' })
      .where(eq(toolCalls.id, toolCallId))
  }

  // (b) record the pending interaction (the card the client renders).
  const [interaction] = await db
    .insert(userInteractions)
    .values({
      agentRunId: runId,
      toolCallId,
      kind,
      prompt,
      status: 'pending',
    })
    .returning({ id: userInteractions.id })
  const interactionId = interaction!.id

  // (c) the run is parked awaiting input; (d) tell the client.
  await db
    .update(agentRuns)
    .set({ status: 'awaiting_approval' })
    .where(eq(agentRuns.id, runId))
  await notifyRun(conversationId, { type: 'interaction_required', interactionId, kind })

  // (e) block until resolved on a dedicated LISTEN connection.
  const { POSTGRES_URL } = loadConfig()
  if (!POSTGRES_URL) throw new Error('POSTGRES_URL is not set — required to await interaction')
  const client = new pg.Client({ connectionString: POSTGRES_URL })
  await client.connect()

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }

      client.on('notification', (msg) => {
        if (!msg.payload) return
        try {
          const event = JSON.parse(msg.payload)
          if (event.type === 'interaction_resolved' && event.interactionId === interactionId) {
            finish()
          }
        } catch {
          // ignore malformed payloads
        }
      })

      // 1h timeout: conditionally flip a still-pending interaction to timed_out, then wake.
      timeout = setTimeout(() => {
        void db
          .update(userInteractions)
          .set({ status: 'timed_out', resolvedAt: new Date() })
          .where(and(eq(userInteractions.id, interactionId), eq(userInteractions.status, 'pending')))
          .then(() => finish())
      }, APPROVAL_TIMEOUT_MS)

      // Subscribe, then check once for a resolution that raced the LISTEN.
      client
        .query(`LISTEN "conversation:${conversationId}"`)
        .then(() => db.select().from(userInteractions).where(eq(userInteractions.id, interactionId)))
        .then(([row]) => {
          if (row && row.status !== 'pending') finish()
        })
    })
  } finally {
    if (timeout) clearTimeout(timeout)
    await client.query(`UNLISTEN "conversation:${conversationId}"`).catch(() => {})
    await client.end().catch(() => {})
  }

  // (f) read the response, resume the run, return it (null on timeout).
  const [resolved] = await db
    .select({ response: userInteractions.response })
    .from(userInteractions)
    .where(eq(userInteractions.id, interactionId))

  await db.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId))

  return resolved?.response ?? null
}

// The approval gate (§10.2–§10.4, §16). A thin caller of awaitInteraction: build the approval
// prompt (group vs call summary + scope), pause with kind='approval', map the resolved
// response to an ApprovalVerdict (null/absent ⇒ not approved).
async function requestApproval(
  db: ReturnType<typeof getDb>,
  conversationId: string,
  runId: string,
  toolCallRowIds: Map<string, string>,
  call: ApprovalRequest,
): Promise<ApprovalVerdict> {
  const prompt = {
    // Group calls render a task-scoped card: approving covers every action in the
    // group for the rest of the run, not just the one triggering call (§16).
    summary: call.group
      ? `Allow Alfred to use its ${call.group} tools for this task? Approving covers all ${call.group} actions until this run finishes.`
      : 'Run ' + call.name,
    tool: call.name,
    args: call.args,
    trust_tier: call.trustTier,
    scope: call.group ? 'group' : 'call',
  }
  const response = (await awaitInteraction(db, {
    conversationId,
    runId,
    toolCallId: toolCallRowIds.get(call.id) ?? null,
    kind: 'approval',
    prompt,
  })) as { approved?: boolean; note?: string } | null
  return response?.approved
    ? { approved: true, note: response.note }
    : { approved: false, note: response?.note }
}
