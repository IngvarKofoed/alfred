// The pluggable *firing mechanism* abstraction — a sibling to Tool / LlmProvider
// (ARCHITECTURE §7.3; spec docs/specs/2026-06-19-trigger-abstraction.md). A Trigger owns
// its own deterministic delta-detection: given its params and a prior cursor, detect() folds
// the underlying source into an explicit list of new events plus an advanced cursor.
//
// These are pure types. Concrete Triggers (email/timer/webhook) live in the worker, where the
// Tools + providers already live — agent-core stays framework-free, so it never opens an IMAP
// connection or imports the DB. A worker-side triggerRegistry maps name → Trigger, looked up in
// detect.ts the way the tool catalog is looked up today.
//
// The framework never *interprets* a Cursor: it stores it as jsonb, hands it to detect(), and
// stages/commits it (pending_cursor → cursor only after the action run reaches `done`, the
// at-least-once contract). Every cursor semantic — its shape, how to diff it, when an event
// counts as new — lives inside detect(). That's why one shape spans the archetypes (monotonic
// feed, opaque-sync token, windowed seen-set, state edge, heartbeat, push): the cursor is opaque
// and detect() is the canonical stateful-stream fold (params, priorState) → (events, nextState).
export interface Trigger<Params = unknown, Cursor = unknown> {
  name: string // 'email' | 'timer' | 'webhook' (parallels Tool.name)
  // poll → scheduler-driven cadence; push → enqueued by an ingress. Orthogonal to cursor: a
  // push Trigger can still hold a cursor to dedup redeliveries (IMAP IDLE is push and cursored).
  mode: 'poll' | 'push'
  // JSON Schema, surfaced to the agent for create_automation and validated when an automation is
  // created — same type and role as Tool.inputSchema.
  paramsSchema: object
  // CONTRACT (§16): detect() MUST be read-only / side-effect-free. It runs OUTSIDE the agent
  // loop's approval gate (unlike a write/destructive Tool), so the trust-tier check that used to
  // guard the old config-named gate tool no longer applies — read-only is enforced here by
  // construction, by every Trigger implementation, not by a runtime tier check. A Trigger that
  // mutated the world (sent mail, moved money) would do so unattended and ungated. Don't.
  detect(ctx: DetectCtx<Params, Cursor>): Promise<DetectResult<Cursor>>
}

// detect() runs in the worker with the same ambient access Tools have (config, getDb(),
// withImap, outbound fetch) — closed over like Tools, not threaded through here. cursor is null
// on the first detect: the Trigger establishes its baseline silently (no fire on the
// pre-existing backlog) and returns an advanced nextCursor.
export interface DetectCtx<Params = unknown, Cursor = unknown> {
  params: Params
  cursor: Cursor | null
}

export interface DetectResult<Cursor = unknown> {
  // What's new/actionable this fire; [] ⇒ nothing changed, no fire (the free idle path).
  events: TriggerEvent[]
  // Advanced cursor — staged at escalation, committed only after the run succeeds.
  nextCursor: Cursor
}

// Whatever the Trigger surfaces, normalized so heterogeneous sources share one downstream:
// triage + the objective read `summary`; the run acts on `data`.
export interface TriggerEvent {
  id: string // stable per-Trigger (email: uid; rss: guid; edge: 'crossed@81')
  summary: string // human line read by triage + the objective (the normalization point)
  data?: unknown // optional structured payload the run acts on (email: { uid, from, subject })
}
