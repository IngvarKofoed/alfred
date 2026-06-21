import { type DetectResult, type Trigger } from '@alfred/agent-core'

// The `timer` Trigger (spec docs/specs/2026-06-19-trigger-abstraction.md, "The Triggers"). A
// HEARTBEAT Trigger: the cron cadence IS the trigger, so detection always fires one synthetic
// event and holds no cursor. Subsumes today's recurring fixed briefing (a schedule with no gate)
// and the one-shot 'self' reminder (a timer automation with a next_fire_at instead of a
// schedule). Pair with no triage to "always escalate".

export const timerTrigger: Trigger<Record<string, never>, null> = {
  name: 'timer',
  mode: 'poll',
  paramsSchema: { type: 'object', properties: {} },
  detect(): Promise<DetectResult<null>> {
    return Promise.resolve({
      events: [{ id: 'tick', summary: 'scheduled' }],
      nextCursor: null,
    })
  },
}
