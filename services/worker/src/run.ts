import {
  GeminiProvider,
  type LlmProvider,
  type Message,
  runAgent,
  TracingProvider,
} from '@alfred/agent-core'
import { agentRuns, getDb, llmCalls, messages } from '@alfred/db'
import { asc, eq } from 'drizzle-orm'
import { notifyRun } from './events.js'
import { rowsToMessages } from './messages.js'

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
      await db.insert(llmCalls).values({
        agentRunId: runId,
        model: trace.model,
        request: trace.request,
        responseText: trace.responseText,
        promptTokens: trace.promptTokens ?? 0,
        completionTokens: trace.completionTokens ?? 0,
        finishReason: trace.finishReason ?? null,
        latencyMs: trace.latencyMs,
        error: trace.error ?? null,
      })
    })

    const finalMessages = await runAgent({
      provider,
      tools: [],
      messages: history,
      model: run.model ?? undefined,
      onText: (delta) => {
        notifyChain = notifyChain.then(() =>
          notifyRun(run.conversationId, { type: 'token', text: delta }),
        )
      },
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

    // Roll up token usage + model from the run's llm_calls onto the run.
    const calls = await db
      .select({
        promptTokens: llmCalls.promptTokens,
        completionTokens: llmCalls.completionTokens,
        model: llmCalls.model,
      })
      .from(llmCalls)
      .where(eq(llmCalls.agentRunId, runId))
    const promptTokens = calls.reduce((sum, row) => sum + row.promptTokens, 0)
    const completionTokens = calls.reduce((sum, row) => sum + row.completionTokens, 0)

    await db
      .update(agentRuns)
      .set({
        status: 'done',
        finishedAt: new Date(),
        promptTokens,
        completionTokens,
        model: calls.at(-1)?.model ?? null,
      })
      .where(eq(agentRuns.id, runId))
    await notifyRun(run.conversationId, { type: 'done' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db
      .update(agentRuns)
      .set({ status: 'failed', finishedAt: new Date(), error: message })
      .where(eq(agentRuns.id, runId))
    await notifyRun(run.conversationId, { type: 'error', message })
  }
}
