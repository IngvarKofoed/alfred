// Scheduler helpers for alfred-triggers (autonomous-watchers spec
// docs/specs/2026-06-16-autonomous-watchers.md). Timing only: it computes which triggers are due
// and enqueues `trigger-detect` jobs on the existing pg-boss queue (via the @alfred/db helpers —
// never PgBoss directly). It does NOT import the tool layer; all tool execution stays in the
// worker's detect handler.
//
// Two firing mechanisms:
//   - Recurring 'schedule' | 'inbox' triggers with a cron `schedule` → pg-boss cron
//     (scheduleTrigger), which enqueues a trigger-detect on each tick.
//   - One-shot 'self' triggers with a `nextFireAt` → a lightweight periodic sweep that
//     enqueues a single trigger-detect once the row is due.
//
// Fail-and-restart (§7.6): we hold no durable scheduler state of our own. On boot — AND on every
// periodic reconcile tick — we unscheduleAll() and re-register from the current enabled rows; a
// missed tick during downtime just fires late. The periodic re-register is what makes a watcher
// inserted at runtime (e.g. the agent calling schedule_self with a cron `when`) actually start
// firing without restarting this process.

import {
  type Db,
  enqueueTriggerDetect,
  listEnabledTriggers,
  OWNER_USER_ID,
  scheduleTrigger,
  unscheduleAll,
  type DbOrTx,
} from '@alfred/db'

// Timezone cron schedules are evaluated in, so the owner's "8am" means 8am in their zone, not UTC.
// Read from TRIGGER_TZ (an IANA zone like "Europe/Copenhagen"); defaults to the host's resolved
// zone. Read directly off process.env (not the shared zod schema) so this slice owns its one knob
// without touching packages/shared. Resolved once at module load, and forwarded to scheduleTrigger
// (→ pg-boss's `tz` ScheduleOption) at registration so cron actually evaluates in this zone.
export const TRIGGER_TZ = process.env.TRIGGER_TZ?.trim() || hostTimeZone()

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// pg-boss schedule name for a trigger's cron registration. The detect handler reads the trigger
// id off the job's `data` payload (scheduleTrigger carries { triggerId }), so this name only has
// to be unique + stable per trigger.
function scheduleName(triggerId: string): string {
  return `trigger:${triggerId}`
}

type TriggerRow = Awaited<ReturnType<typeof listEnabledTriggers>>[number]

// Register (boot) / reconcile (periodic) the cron schedules. Idempotent by construction: it clears
// EVERY prior trigger-detect cron schedule (unscheduleAll) and re-registers from the current enabled
// rows, so additions (a runtime-inserted 'schedule'/'inbox' row), removals, and disables all
// converge to the live truth on each call — no per-process "already registered" bookkeeping to drift.
// We don't trust pre-restart state, and we don't trust state from a previous reconcile tick either.
// Returns the count of cron schedules registered (for the readiness / reconcile log).
export async function registerSchedules(db: Db): Promise<number> {
  await unscheduleAll()
  const enabled = await listEnabledTriggers(db, OWNER_USER_ID)
  let registered = 0
  for (const t of enabled) {
    // Only recurring 'schedule' | 'inbox' kinds with a cron expression are pg-boss-cron driven.
    // 'webhook' is enqueued by the webserver; 'self' is handled by the sweep below.
    if ((t.kind === 'schedule' || t.kind === 'inbox') && t.schedule) {
      try {
        await scheduleTrigger(scheduleName(t.id), t.schedule, { triggerId: t.id }, TRIGGER_TZ)
        registered++
      } catch (e) {
        // A malformed cron expression must not abort registering the rest of the triggers.
        console.error(`[triggers] failed to schedule trigger ${t.id} (${t.name}): ${String(e)}`)
      }
    }
  }
  return registered
}

// One-shot 'self' triggers: enqueue a single trigger-detect once `nextFireAt` is due. Idempotent —
// `fired` records ids we've already enqueued this process so the row staying due (the worker clears
// next_fire_at via markTriggerFired only after the detect runs) can't double-enqueue. The worker is
// the source of truth: once it clears next_fire_at the row stops being due, and we drop it from the
// set so a re-armed self trigger (same id, new next_fire_at) can fire again.
export async function sweepSelfTriggers(db: DbOrTx, fired: Set<string>): Promise<void> {
  const enabled = await listEnabledTriggers(db, OWNER_USER_ID)
  const now = Date.now()
  const dueIds = new Set<string>()
  const work: Promise<void>[] = []
  for (const t of enabled) {
    if (t.kind !== 'self') continue
    const due = isDue(t, now)
    if (due) dueIds.add(t.id)
    if (due && !fired.has(t.id)) {
      fired.add(t.id)
      work.push(
        enqueueTriggerDetect(t.id).catch((e) => {
          // Let the next sweep retry: drop it from `fired` so it's eligible again.
          fired.delete(t.id)
          console.error(`[triggers] failed to enqueue self trigger ${t.id} (${t.name}): ${String(e)}`)
        }),
      )
    }
  }
  // Forget ids that are no longer due (worker cleared next_fire_at) so a re-arm can fire again.
  for (const id of fired) if (!dueIds.has(id)) fired.delete(id)
  await Promise.all(work)
}

function isDue(t: TriggerRow, now: number): boolean {
  return t.nextFireAt != null && t.nextFireAt.getTime() <= now
}
