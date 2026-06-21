import { loadConfig } from '@alfred/shared'
import { and, eq, inArray, type SQL } from 'drizzle-orm'
import PgBoss from 'pg-boss'
import { getDb } from './client.js'
import { type DbOrTx } from './queries.js'
import { agentRuns, toolCalls, userInteractions } from './schema.js'

// pg-boss lives here because it's Postgres infra sharing POSTGRES_URL. Consumers use
// the typed helpers below and never touch PgBoss directly — the dependency stays internal.
export const AGENT_RUN_QUEUE = 'agent-run'
export interface AgentJob {
  runId: string
}

// The second job type (autonomous-watchers spec): a due trigger enqueues a trigger-detect job
// that the worker runs through Tier 0 → Tier 1, only escalating to a real agent-run on signal.
// The detect handler creates NO agent_runs row (no row-litter on idle polls).
export const TRIGGER_DETECT_QUEUE = 'trigger-detect'
export interface TriggerDetectJob {
  triggerId: string
  // Manual "run now" (the run_trigger tool): skip the Tier-0 gate + Tier-1 triage and escalate
  // immediately. Absent/false on scheduled, webhook, and self-sweep fires (the normal ladder).
  force?: boolean
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
      await instance.createQueue(TRIGGER_DETECT_QUEUE).catch(() => {}) // idempotent
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

// Enqueue a trigger-detect job (a due trigger / a webhook hit). Same delivery shape as an
// agent-run: retryLimit:0 + a long expiration, so a crashed worker never re-runs detection.
export async function enqueueTriggerDetect(
  triggerId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const b = await getBoss()
  await b.send(TRIGGER_DETECT_QUEUE, { triggerId, force: opts.force } satisfies TriggerDetectJob, {
    retryLimit: 0,
    expireInSeconds: 4500,
  })
}

export async function workTriggerDetects(handler: (job: TriggerDetectJob) => Promise<void>): Promise<void> {
  const b = await getBoss()
  await b.work<TriggerDetectJob>(TRIGGER_DETECT_QUEUE, async (jobs) => {
    for (const job of jobs) await handler(job.data)
  })
}

// NOTE: cron timing for recurring automations is NOT done via pg-boss scheduling. pg-boss v10 keys a
// schedule by queue name and requires that queue to exist, which doesn't fit "N automations → one
// shared trigger-detect consumer." The pure scheduler (alfred-triggers) owns the cron clock
// in-process (Croner) and calls enqueueTriggerDetect on each tick — so there are no scheduleTrigger /
// unscheduleAll helpers here.

// §10.9 invariant 4 in one implementation: flip the runs matched by `where` to a terminal
// status, then — in the same transaction — cascade: every non-terminal tool_call → failed,
// every still-pending interaction → cancelled, so a terminated run can never leave zombie
// rows behind (RUNTIME §10.5/§10.6). The caller owns the transaction (the tx param, like
// ensureConversation): the startup sweep wraps its own, the webserver's cancel route folds
// the cascade into its request transaction. Returns the ids of the runs actually
// transitioned ([] when `where` matched nothing — e.g. nothing active to cancel).
export async function terminateRuns(
  tx: DbOrTx,
  opts: {
    where: SQL
    runStatus: 'failed' | 'cancelled'
    error: string | null
    toolCallError: string
  },
): Promise<string[]> {
  const now = new Date()
  const rows = await tx
    .update(agentRuns)
    .set({ status: opts.runStatus, error: opts.error, finishedAt: now })
    .where(opts.where)
    .returning({ id: agentRuns.id })
  if (rows.length === 0) return []
  const runIds = rows.map((r) => r.id)
  await tx
    .update(toolCalls)
    .set({ status: 'failed', error: opts.toolCallError, finishedAt: now })
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
  return runIds
}

// Startup sweep: any non-terminal run (pending/running/awaiting_approval) has no live worker
// — we don't resume (ARCHITECTURE §7.6/§10.5) — so fail it via the shared terminateRuns
// cascade. Without the awaiting_approval case, a restart while an approval is open would leave
// a zombie run that the one-active-run-per-conversation index never lets the conversation
// move past.
export async function sweepOrphanedRuns(): Promise<number> {
  return getDb().transaction(async (tx) => {
    const ids = await terminateRuns(tx, {
      where: inArray(agentRuns.status, ['pending', 'running', 'awaiting_approval']),
      runStatus: 'failed',
      error: 'orphaned (worker restart)',
      toolCallError: 'orphaned (worker restart)',
    })
    return ids.length
  })
}
