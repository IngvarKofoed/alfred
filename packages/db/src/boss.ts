import { loadConfig } from '@alfred/shared'
import { eq } from 'drizzle-orm'
import PgBoss from 'pg-boss'
import { getDb } from './client.js'
import { agentRuns } from './schema.js'

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
    expireInSeconds: 60 * 60,
  })
}

export async function workAgentRuns(handler: (runId: string) => Promise<void>): Promise<void> {
  const b = await getBoss()
  await b.work<AgentJob>(AGENT_RUN_QUEUE, async (jobs) => {
    for (const job of jobs) await handler(job.data.runId)
  })
}

// Startup sweep: any run still 'running' has no live worker (we don't resume), so fail it.
export async function sweepOrphanedRuns(): Promise<number> {
  const rows = await getDb()
    .update(agentRuns)
    .set({ status: 'failed', error: 'orphaned (worker restart)', finishedAt: new Date() })
    .where(eq(agentRuns.status, 'running'))
    .returning({ id: agentRuns.id })
  return rows.length
}
