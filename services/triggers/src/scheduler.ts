// Scheduler helpers for alfred-triggers (trigger-abstraction spec
// docs/specs/2026-06-19-trigger-abstraction.md; supersedes the autonomous-watchers gate model).
// Timing only: it computes which automations are due and enqueues `trigger-detect` jobs (via the
// @alfred/db enqueue helper — never PgBoss directly). It does NOT import the triggerRegistry or any
// Trigger impl; all detection + tool execution stays in the worker's detect handler (DEPLOYMENT §5
// invariant — the scheduler stays pure, timing-only).
//
// It decides WHEN purely from two row fields, never from the Trigger's semantics:
//   - A `schedule` (cron expr) → an in-process cron timer (Croner) whose tick enqueues a
//     trigger-detect. This is the recurring-poll cadence (an `email` poll, a recurring `timer`
//     heartbeat). The cron *is* the cadence; the worker's detect() decides if anything fired. We own
//     the clock in-process rather than via pg-boss's scheduler because pg-boss v10 keys a schedule by
//     queue name and requires that queue to exist — which doesn't fit "N automations → one shared
//     trigger-detect consumer." The pure scheduler owning the cron clock is exactly its job.
//   - A `nextFireAt` with no `schedule` → a one-shot: a lightweight periodic sweep enqueues a
//     single trigger-detect once the row is due (the old kind='self' reminder is now a `timer`
//     automation carrying a `next_fire_at`).
//   - A push Trigger (`webhook`) is enqueued by an ingress, never scheduled here, so it's excluded
//     from both paths even if a row carries stray schedule/next_fire_at.
//
// Fail-and-restart (§7.6): we hold no durable scheduler state of our own. On boot — AND on every
// periodic reconcile tick — we stop every cron timer and re-create from the current enabled rows. A
// recurring cron simply arms its next future occurrence: a tick missed while the process was down is
// skipped, not replayed — and the per-Trigger cursor means no data is lost (the next tick re-reads
// the cursor and surfaces everything new since). The periodic re-register is what makes an automation
// inserted at runtime (e.g. the agent calling create_automation with a cron `when`) start firing
// without restarting this process.

import { Cron } from 'croner'
import { type Db, enqueueTriggerDetect, listEnabledAutomations, OWNER_USER_ID, type DbOrTx } from '@alfred/db'

// The only push-mode Trigger: enqueued by the webserver's hook route, never scheduled here. Kept as
// a literal (not a registry import) so the scheduler stays timing-only — it needs to know *that*
// webhook isn't time-driven, not *how* any Trigger detects.
const PUSH_TRIGGERS = new Set(['webhook'])

// Timezone cron schedules are evaluated in, so the owner's "8am" means 8am in their zone, not UTC.
// Read from TRIGGER_TZ (an IANA zone like "Europe/Copenhagen"); defaults to the host's resolved
// zone. Read directly off process.env (not the shared zod schema) so this slice owns its one knob
// without touching packages/shared. Resolved once at module load, and passed to Croner's `timezone`
// option at registration so cron actually evaluates in this zone.
export const TRIGGER_TZ = process.env.TRIGGER_TZ?.trim() || hostTimeZone()

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// The live in-process cron timers, keyed by automation id, so a reconcile can stop the ones it
// replaces. Non-durable by design (fail-and-restart): re-derived from the DB on boot + each reconcile.
const cronJobs = new Map<string, Cron>()

// A stable, human-readable name for an automation's cron timer (surfaces in Croner introspection /
// errors). Only needs to be unique per automation.
function cronName(automationId: string): string {
  return `automation:${automationId}`
}

type AutomationRow = Awaited<ReturnType<typeof listEnabledAutomations>>[number]

// Register (boot) / reconcile (periodic) the in-process cron timers. Idempotent by construction: it
// stops EVERY prior timer and re-creates from the current enabled rows, so additions (a
// runtime-inserted recurring automation), removals, and disables all converge to the live truth on
// each call — no per-process "already registered" bookkeeping to drift. We don't trust pre-restart
// state, and we don't trust state from a previous reconcile tick either. Returns the count registered.
export async function registerSchedules(db: Db): Promise<number> {
  for (const job of cronJobs.values()) job.stop()
  cronJobs.clear()
  const enabled = await listEnabledAutomations(db, OWNER_USER_ID)
  let registered = 0
  for (const a of enabled) {
    // A `schedule` (cron) drives the recurring-poll cadence; a push Trigger is never time-driven.
    // The one-shot sweep below owns `nextFireAt`-only rows.
    if (a.schedule && !PUSH_TRIGGERS.has(a.trigger)) {
      try {
        const job = new Cron(a.schedule, { timezone: TRIGGER_TZ, name: cronName(a.id) }, () => {
          // The Trigger's detect() runs in the worker; this tick only enqueues. A failed enqueue is
          // logged, not fatal — the next tick re-enqueues (detection is at-least-once via the cursor).
          enqueueTriggerDetect(a.id).catch((e) =>
            console.error(`[triggers] enqueue failed for automation ${a.id} (${a.name}): ${String(e)}`),
          )
        })
        cronJobs.set(a.id, job)
        registered++
      } catch (e) {
        // A malformed cron expression must not abort registering the rest of the automations.
        console.error(`[triggers] failed to schedule automation ${a.id} (${a.name}): ${String(e)}`)
      }
    }
  }
  return registered
}

// One-shot automations: enqueue a single trigger-detect once `nextFireAt` is due. A one-shot is a
// row with a `nextFireAt` and no `schedule` (the old kind='self' reminder is now a `timer`
// automation carrying a next_fire_at). Idempotent — `fired` records ids we've already enqueued this
// process so the row staying due (the worker clears next_fire_at via markAutomationFired only after
// the detect runs) can't double-enqueue. The worker is the source of truth: once it clears
// next_fire_at the row stops being due, and we drop it from the set so a re-armed one-shot (same id,
// new next_fire_at) can fire again.
export async function sweepSelfTriggers(db: DbOrTx, fired: Set<string>): Promise<void> {
  const enabled = await listEnabledAutomations(db, OWNER_USER_ID)
  const now = Date.now()
  const dueIds = new Set<string>()
  const work: Promise<void>[] = []
  for (const a of enabled) {
    if (!isOneShot(a)) continue
    const due = isDue(a, now)
    if (due) dueIds.add(a.id)
    if (due && !fired.has(a.id)) {
      fired.add(a.id)
      work.push(
        enqueueTriggerDetect(a.id).catch((e) => {
          // Let the next sweep retry: drop it from `fired` so it's eligible again.
          fired.delete(a.id)
          console.error(`[triggers] failed to enqueue one-shot automation ${a.id} (${a.name}): ${String(e)}`)
        }),
      )
    }
  }
  // Forget ids that are no longer due (worker cleared next_fire_at) so a re-arm can fire again.
  for (const id of fired) if (!dueIds.has(id)) fired.delete(id)
  await Promise.all(work)
}

// A one-shot is a non-push automation armed by `nextFireAt` rather than a recurring `schedule` (cron
// rows are driven by registerSchedules). Gating on the absence of a schedule keeps a single row from
// being both cron-scheduled and one-shot-swept.
function isOneShot(a: AutomationRow): boolean {
  return !a.schedule && a.nextFireAt != null && !PUSH_TRIGGERS.has(a.trigger)
}

export function isDue(a: AutomationRow, now: number): boolean {
  return a.nextFireAt != null && a.nextFireAt.getTime() <= now
}
