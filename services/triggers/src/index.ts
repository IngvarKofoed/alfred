// alfred-triggers — the pure scheduler for autonomous automations (ARCHITECTURE §9.4 / RUNTIME §7.7;
// trigger-abstraction spec docs/specs/2026-06-19-trigger-abstraction.md). It owns *timing only*: at
// boot it loads enabled `automations` rows and arms an in-process cron timer per recurring one, whose
// ticks enqueue `trigger-detect` jobs that the worker runs through the Trigger detect() + detection
// ladder. It never imports the triggerRegistry or the tool layer — all detection + tool execution
// stays in the worker (the scheduler decides WHEN purely from each row's `trigger` + schedule /
// next_fire_at, never from a Trigger's semantics).
//
// Fail-and-restart (§7.6): the scheduler holds no durable state of its own. On boot it re-reads
// enabled automations and re-arms the cron timers (registerSchedules stops + re-creates them); a tick
// missed while down is skipped, not replayed (the per-Trigger cursor means nothing is lost).

import { getDb } from '@alfred/db'
import { APP_VERSION } from '@alfred/shared'
import { registerSchedules, sweepSelfTriggers, TRIGGER_TZ } from './scheduler.js'

// How often the periodic sweep runs: it (a) checks for due one-shot automations and (b)
// reconciles the cron schedules so an automation inserted at runtime starts firing without a restart.
const SWEEP_INTERVAL_MS = 30_000

console.log(`alfred-triggers: version ${APP_VERSION}`)

const db = getDb()

// Boot: arm the in-process cron timers for recurring automations. registerSchedules reads the enabled
// automations from Postgres, so a missing/unreachable DB fails fast here. (pg-boss is first touched
// only when a timer ticks and enqueues a trigger-detect.)
const registered = await registerSchedules(db)

// In-memory de-dup set for the one-shot sweep (see sweepSelfTriggers): which one-shot automations
// we've already enqueued this process. Not durable — that's fine, the worker clears next_fire_at.
const firedSelf = new Set<string>()

let sweeping = false
async function sweep(): Promise<void> {
  if (sweeping) return // don't overlap a slow sweep with the next tick
  sweeping = true
  try {
    // (a) One-shot automations due since the last tick.
    await sweepSelfTriggers(db, firedSelf)
    // (b) Reconcile cron timers so a recurring automation inserted at runtime (e.g. the agent
    // calling create_automation with a cron `when`) actually starts firing — without restarting this
    // process. registerSchedules is idempotent (stops + re-creates timers from live rows), so it
    // also picks up disables/removals. Guarded by `sweeping` above, so it never overlaps itself.
    await registerSchedules(db)
  } catch (e) {
    console.error('[triggers] sweep failed:', e)
  } finally {
    sweeping = false
  }
}

// Run one sweep immediately so a one-shot automation already due at boot fires without waiting a
// full interval, then on the periodic timer. (The boot registerSchedules above already covered cron.)
await sweep()
const sweepTimer = setInterval(() => {
  void sweep()
}, SWEEP_INTERVAL_MS)

console.log(
  `alfred-triggers: ready — ${registered} cron schedule(s) registered (tz ${TRIGGER_TZ}), ` +
    `sweep every ${SWEEP_INTERVAL_MS}ms`,
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(sweepTimer)
    process.exit(0)
  })
}
