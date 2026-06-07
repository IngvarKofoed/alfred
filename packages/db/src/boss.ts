import { loadConfig } from '@alfred/shared'
import { and, eq, inArray } from 'drizzle-orm'
import PgBoss from 'pg-boss'
import { getDb } from './client.js'
import { agentRuns, toolCalls, userInteractions } from './schema.js'

// pg-boss lives here because it's Postgres infra sharing POSTGRES_URL. Consumers use
// the typed helpers below and never touch PgBoss directly — the dependency stays internal.
export const AGENT_RUN_QUEUE = 'agent-run'
export interface AgentJob {
  runId: string
}

let boss: PgBoss | null = null
let starting: Promise<PgBoss> | null = null

async function getBoss(): Promise<PgBoss> {
  if (boss) return boss
  if (!starting) {
    const { POSTGRES_URL } = loadConfig()
    if (!POSTGRES_URL) throw new Error('POSTGRES_URL is not set — required for pg-boss')
    const instance = new PgBoss(POSTGRES_URL)
    starting = (async () => {
      await instance.start()
      await instance.createQueue(AGENT_RUN_QUEUE).catch(() => {}) // idempotent
      boss = instance
      return instance
    })()
  }
  return starting
}

// Enqueue a run. retryLimit:0 + a long expiration = no auto-redelivery, so a crashed
// worker never causes a duplicate run (fail-and-restart, ARCHITECTURE §7.6/§6.3).
export async function enqueueAgentRun(runId: string): Promise<void> {
  const b = await getBoss()
  await b.send(AGENT_RUN_QUEUE, { runId } satisfies AgentJob, {
    retryLimit: 0,
    expireInSeconds: 4500,
  })
}

export async function workAgentRuns(handler: (runId: string) => Promise<void>): Promise<void> {
  const b = await getBoss()
  await b.work<AgentJob>(AGENT_RUN_QUEUE, async (jobs) => {
    for (const job of jobs) await handler(job.data.runId)
  })
}

// Startup sweep: any non-terminal run (pending/running/awaiting_approval) has no live worker
// — we don't resume (ARCHITECTURE §7.6/§10.5) — so fail it and cascade per §10.9 invariant 4:
// every non-terminal tool_call → failed, every still-pending interaction → cancelled. Without
// the awaiting_approval case, a restart while an approval is open would leave a zombie run that
// the one-active-run-per-conversation index never lets the conversation move past.
export async function sweepOrphanedRuns(): Promise<number> {
  const now = new Date()
  return getDb().transaction(async (tx) => {
    const rows = await tx
      .update(agentRuns)
      .set({ status: 'failed', error: 'orphaned (worker restart)', finishedAt: now })
      .where(inArray(agentRuns.status, ['pending', 'running', 'awaiting_approval']))
      .returning({ id: agentRuns.id })
    if (rows.length === 0) return 0
    const runIds = rows.map((r) => r.id)
    await tx
      .update(toolCalls)
      .set({ status: 'failed', error: 'orphaned (worker restart)', finishedAt: now })
      .where(
        and(
          inArray(toolCalls.agentRunId, runIds),
          inArray(toolCalls.status, ['pending', 'awaiting_user', 'running']),
        ),
      )
    await tx
      .update(userInteractions)
      .set({ status: 'cancelled', resolvedAt: now })
      .where(and(inArray(userInteractions.agentRunId, runIds), eq(userInteractions.status, 'pending')))
    return rows.length
  })
}
