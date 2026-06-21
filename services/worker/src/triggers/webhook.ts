import { type DetectCtx, type DetectResult, type Trigger, type TriggerEvent } from '@alfred/agent-core'

// The `webhook` Trigger (spec docs/specs/2026-06-19-trigger-abstraction.md, "The Triggers" —
// "lightly specified"). A PUSH Trigger: not scheduler-driven. A future webserver hook route
// enqueues a detect job carrying the delivered payload, which detect() passes straight through as
// one TriggerEvent. No hook route is built here (out of scope, step 1) — this is the passthrough
// detection contract the route will target.
//
// The payload travels in DetectCtx.params (the detect job carries the delivered event as the
// params for that one detect call). cursor is an optional dedup key the framework stages/commits
// like any other; this minimal passthrough doesn't dedup, so it leaves the cursor untouched.

// Whatever the hook route delivers. `id` (optional) lets a delivery name a stable dedup key;
// `summary` is the human line read by triage/objective; `data` is the structured payload the run
// acts on. A bare/unknown payload still produces a single event.
export interface WebhookPayload {
  id?: string
  summary?: string
  data?: unknown
}

export function detectWebhook(payload: WebhookPayload | null, cursor: unknown): DetectResult<unknown> {
  const p = payload ?? {}
  const event: TriggerEvent = {
    id: typeof p.id === 'string' && p.id ? p.id : 'webhook',
    summary: typeof p.summary === 'string' && p.summary ? p.summary : 'webhook delivery',
    data: 'data' in p ? p.data : p,
  }
  // Passthrough: no dedup state, so carry the prior cursor forward unchanged.
  return { events: [event], nextCursor: cursor }
}

export const webhookTrigger: Trigger<WebhookPayload, unknown> = {
  name: 'webhook',
  mode: 'push',
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Optional stable id for the delivery (dedup key)' },
      summary: { type: 'string', description: 'Human line describing the delivery' },
      data: { description: 'Structured payload the run acts on' },
    },
  },
  detect(ctx: DetectCtx<WebhookPayload, unknown>): Promise<DetectResult<unknown>> {
    return Promise.resolve(detectWebhook(ctx.params ?? null, ctx.cursor))
  },
}
