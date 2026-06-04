import {
  type ApprovalRequest,
  type ApprovalVerdict,
  computeCostUsd,
  echoTool,
  GeminiProvider,
  type LlmProvider,
  type Message,
  runAgent,
  TracingProvider,
} from '@alfred/agent-core'
import { agentRuns, getDb, llmCalls, messages, toolCalls, userInteractions } from '@alfred/db'
import { loadConfig } from '@alfred/shared'
import { and, asc, eq } from 'drizzle-orm'
import pg from 'pg'
import { getBridge } from './browser/bridge.js'
import { makeBrowserTools } from './browser/tools.js'
import { notifyRun } from './events.js'
import { rowsToMessages } from './messages.js'
import { makeSetTitleTool } from './tools.js'

// MVP approval window (§10.4): a deliberate shortening of the 24h default. The pg-boss
// lease sits just above it so a job blocked on approval outlives the timeout.
const APPROVAL_TIMEOUT_MS = 60 * 60 * 1000

// The browser toolset is process-static (the bridge is a singleton, the tools carry no
// per-conversation state), so build it once rather than on every run.
const BROWSER_TOOLS = makeBrowserTools(getBridge())

// Minimal system prompt for now; full persona assembly (§7.5) is deferred.
const SYSTEM_PROMPT = 'You are Alfred, a helpful personal assistant. Be concise and direct.'

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
      ...rowsToMessages(rows),
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

    // Built-in tools for this run: echo (read, runs freely), a context-bound write tool, and
    // the process-static browser tools (all write-tier → each pauses for approval) backed by
    // the embedded bridge (the server runs in index.ts).
    const tools = [echoTool, makeSetTitleTool(run.conversationId), ...BROWSER_TOOLS]

    // Maps an agent-core call id to the tool_calls row id, so onToolEnd / requestApproval
    // can update the row the loop is talking about.
    const toolCallRowIds = new Map<string, string>()

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
            status: call.trustTier === 'read' ? 'running' : 'pending',
            startedAt: new Date(),
          })
          .returning({ id: toolCalls.id })
        toolCallRowIds.set(call.id, row!.id)
      },
      onToolEnd: async (call, outcome) => {
        const rowId = toolCallRowIds.get(call.id)
        if (!rowId) return
        await db
          .update(toolCalls)
          .set({
            status: outcome.status,
            result: outcome.result ?? null,
            error: outcome.error ?? null,
            finishedAt: new Date(),
          })
          .where(eq(toolCalls.id, rowId))
      },
      requestApproval: (call) => requestApproval(db, run.conversationId, runId, toolCallRowIds, call),
    })
    await notifyChain

    // Persist everything the loop appended beyond the input (the assistant turn(s)).
    for (const m of finalMessages.slice(history.length)) {
      if (m.role === 'assistant' || m.role === 'tool') {
        await db.insert(messages).values({
          conversationId: run.conversationId,
          role: m.role,
          content: m.content,
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
    })
    .from(llmCalls)
    .where(eq(llmCalls.agentRunId, runId))
  return {
    promptTokens: calls.reduce((sum, row) => sum + row.promptTokens, 0),
    completionTokens: calls.reduce((sum, row) => sum + row.completionTokens, 0),
    costUsd: calls.reduce((sum, row) => sum + Number(row.costUsd), 0).toFixed(6),
    model: calls.at(-1)?.model ?? null,
  }
}

// The approval gate (§10.2–§10.4, §16). For a write/destructive call: persist the
// interaction, surface it over NOTIFY, and BLOCK on a dedicated LISTEN until the owner
// resolves it (or a 1h timeout flips it to timed_out). No durable resume — a crash
// sweeps the run to failed on startup (§7.6).
async function requestApproval(
  db: ReturnType<typeof getDb>,
  conversationId: string,
  runId: string,
  toolCallRowIds: Map<string, string>,
  call: ApprovalRequest,
): Promise<ApprovalVerdict> {
  const toolCallId = toolCallRowIds.get(call.id) ?? null

  // (a) the tool_call is now waiting on the user.
  if (toolCallId) {
    await db
      .update(toolCalls)
      .set({ status: 'awaiting_user' })
      .where(eq(toolCalls.id, toolCallId))
  }

  // (b) record the pending interaction (the approval card the client renders).
  const [interaction] = await db
    .insert(userInteractions)
    .values({
      agentRunId: runId,
      toolCallId,
      kind: 'approval',
      prompt: {
        summary: 'Run ' + call.name,
        tool: call.name,
        args: call.args,
        trust_tier: call.trustTier,
      },
      status: 'pending',
    })
    .returning({ id: userInteractions.id })
  const interactionId = interaction!.id

  // (c) the run is parked awaiting approval; (d) tell the client.
  await db
    .update(agentRuns)
    .set({ status: 'awaiting_approval' })
    .where(eq(agentRuns.id, runId))
  await notifyRun(conversationId, { type: 'interaction_required', interactionId, kind: 'approval' })

  // (e) block until resolved on a dedicated LISTEN connection.
  const { POSTGRES_URL } = loadConfig()
  if (!POSTGRES_URL) throw new Error('POSTGRES_URL is not set — required to await approval')
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

  // (f) read the verdict, resume the run, return it.
  const [resolved] = await db
    .select({ response: userInteractions.response })
    .from(userInteractions)
    .where(eq(userInteractions.id, interactionId))
  const response = resolved?.response as { approved?: boolean; note?: string } | null
  const verdict: ApprovalVerdict = response?.approved
    ? { approved: true, note: response.note }
    : { approved: false, note: response?.note }

  await db.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId))

  return verdict
}
