import { GeminiProvider, type LlmProvider, type Message, runAgent } from '@alfred/agent-core'
import { agentRuns, getDb, messages } from '@alfred/db'
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
    const provider = deps.provider ?? new GeminiProvider()

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

    await db
      .update(agentRuns)
      .set({ status: 'done', finishedAt: new Date() })
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
