// alfred-triggers — the pure scheduler for autonomous watchers (ARCHITECTURE §9.4 / RUNTIME §7.7;
// spec docs/specs/2026-06-16-autonomous-watchers.md). It owns *timing only*: at boot it loads
// enabled `triggers` rows and registers schedules on the existing pg-boss queue, enqueuing
// `trigger-detect` jobs that the worker runs through the detection ladder. It never imports the
// tool layer — all tool execution stays in the worker.
//
// Fail-and-restart (§7.6): the scheduler holds no durable state of its own. On boot it re-reads
// enabled triggers and re-registers (registerSchedules does unscheduleAll + re-register); a missed
// tick during downtime just fires late.

import { getDb } from '@alfred/db'
import { APP_VERSION } from '@alfred/shared'
import { registerSchedules, sweepSelfTriggers, TRIGGER_TZ } from './scheduler.js'

// How often the periodic sweep runs: it (a) checks for due one-shot 'self' triggers and (b)
// reconciles the cron schedules so a watcher inserted at runtime starts firing without a restart.
const SWEEP_INTERVAL_MS = 30_000

console.log(`alfred-triggers: version ${APP_VERSION}`)

const db = getDb()

// Boot: register the cron schedules for recurring watchers. registerSchedules internally starts
// pg-boss (via unscheduleAll), so a missing/unreachable Postgres fails fast here.
const registered = await registerSchedules(db)

// In-memory de-dup set for the self-trigger sweep (see sweepSelfTriggers): which 'self' triggers
// we've already enqueued this process. Not durable — that's fine, the worker clears next_fire_at.
const firedSelf = new Set<string>()

let sweeping = false
async function sweep(): Promise<void> {
  if (sweeping) return // don't overlap a slow sweep with the next tick
  sweeping = true
  try {
    // (a) One-shot 'self' triggers due since the last tick.
    await sweepSelfTriggers(db, firedSelf)
    // (b) Reconcile cron schedules so a 'schedule'/'inbox' row inserted at runtime (e.g. the agent
    // calling schedule_self with a cron `when`) actually starts firing — without restarting this
    // process. registerSchedules is idempotent (unscheduleAll + re-register from live rows), so it
    // also picks up disables/removals. Guarded by `sweeping` above, so it never overlaps itself.
    await registerSchedules(db)
  } catch (e) {
    console.error('[triggers] sweep failed:', e)
  } finally {
    sweeping = false
  }
}

// Run one sweep immediately so a self trigger already due at boot fires without waiting a full
// interval, then on the periodic timer. (The boot registerSchedules above already covered cron.)
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
