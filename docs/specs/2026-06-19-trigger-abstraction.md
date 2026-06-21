# Pluggable Triggers + Automations — fix watcher delta-detection

Today a watcher's entire memory of "what have I already seen" is **one scalar** in
`triggers.last_seen_signal` (a `maxUid`/`count`/`hash` reduction diffed in `gate.ts`). That answers
*did anything change?* but not *which discrete items are new, and have I handled each exactly once?*
— which is precisely what email needs.

This spec splits the model into two named concepts and fixes the email case:

- A **Trigger** is the pluggable *firing mechanism* — `email`, `timer`, `webhook` — a sibling
  abstraction to `Tool`/`LlmProvider`. Each carries a typed params schema and owns its own
  deterministic delta-detection, producing an **explicit list of new items** plus an advanced
  **cursor**.
- An **Automation** is a configured instance: *a chosen Trigger + its params + the action* (the
  objective) + notify policy + the cursor state. This is what the `triggers` table actually holds, so
  it's renamed `automations`.

The cursor commits only *after* the action run succeeds (at-least-once). The Tier-1 triage / Tier-2
action-run ladder is unchanged; only Tier-0 (detection) changes.

## Key decisions

- **`Trigger` interface** (new). A pluggable detection abstraction in `agent-core` — the missing
  sibling to `Tool`/`LlmProvider`. Each declares `name` (`email|timer|webhook`, parallels `Tool.name`),
  `mode` (`poll|push`), a `paramsSchema` (JSON Schema, validated at create time like `Tool.inputSchema`),
  and `detect()` returning `{ items, nextCursor }`. A worker `triggerRegistry` maps `name → Trigger`.
- **Automation = the row; `triggers` table → `automations`** (breaking, DB). The row is a Trigger
  choice + params + action + state, so it's an *automation*, not a trigger. `kind` → `trigger` (the
  Trigger name). Drop `gate` and `last_seen_signal`; add `params`, `cursor`, `pending_cursor` (jsonb).
- **Per-Trigger `cursor` replaces the scalar `last_seen_signal`** (breaking). "Did it change?" and
  "where's my offset?" stop being the same opaque scalar — each Trigger owns its own cursor shape.
  The framework never *interprets* the cursor (it stores jsonb and stages/commits it); all cursor
  semantics live in `detect()` — which is why it scales across Trigger kinds (see "Why this
  generalizes": scalar high-water mark, opaque sync token, windowed seen-set, or last-state edge).
- **Cursor commits *after* the action run, not at escalation** (extends → fixes a bug). `pending_cursor`
  is staged at escalation; `run.ts` commits `cursor ← pending_cursor` only when the escalated run
  reaches `done`. A crashed/failed run re-delivers the same delta next tick (at-least-once). This is
  the core fix — `gate.ts` advances the signal at *detection* time today, silently dropping mail if
  the run dies.
- **The delta reaches triage and the run as untrusted, fenced context** (extends). `runTriage` and the
  Tier-2 objective receive the new items' `{ uid, from, subject }`, not a scalar — fenced exactly like
  the classifier hint in `composeObjective` (§16: watched content is untrusted). The agent reads full
  bodies via the existing read-tier email tools by uid.
- **Detection lives in the worker registry; the scheduler stays pure** (reuses). The registry and
  `detect()` run in the worker (where Tools + providers live). `services/triggers` still reads only
  `trigger` + `schedule`/`next_fire_at` to decide *when* to enqueue a detect job — it never imports the
  registry (DEPLOYMENT §5 invariant preserved).
- **Email detection bypasses the agent Tool layer** (extends). The `email` Trigger's `detect()` calls a
  new UID-floor IMAP fetch in `services/worker/src/email/` directly (deterministic, read-only, no
  approval), since `list_emails` only returns newest-N with no UID floor.
- **`create_automation` tool supersedes `schedule_self`** (extends). One creation path: pick a Trigger
  and supply schema-validated params, killing the freeform-`gate`-or-null footgun that made email
  watchers fire every tick. (Named `create_automation`, not `create_trigger` — you're configuring an
  automation, not defining a trigger.)
- **Existing rows are dropped, not migrated** (breaking). Per the owner: a clean cutover beats a
  fragile translation. The migration drops `triggers` and creates `automations`; watchers are
  re-created via `create_automation`. (`triggers` is referenced by no FK, so the drop is safe.)

## Goals

- An email automation reports each new message **exactly once** (modulo at-least-once on crash) and
  never re-reports mail it already handled — without depending on the agent's scratchpad discipline.
- Adding a new Trigger is "implement the `Trigger` interface," the same shape as adding a `Tool`.
- Keep the free Tier-0 / cheap Tier-1 / full Tier-2 cost ladder intact.

## Non-goals

- A **seen-set** (windowed set of processed ids) for non-monotonic feeds. Email's UID monotonicity
  makes a single cursor sufficient; the seen-set is the general fallback, deferred until a Trigger
  needs it.
- An **`rss`** Trigger. The interface must *accommodate* it (a hash/etag cursor), but it isn't built here.
- An automation-management **UI**. Still managed via `create_automation` + direct rows (as today).
- Exactly-once delivery. At-least-once (re-deliver on failure) is the deliberate, safe direction.
- Changing the notification outbox, the Discord forum-post routing, or the scratchpad mechanism (its
  scope key just renames, below).

## Design

### The interface

```ts
// agent-core: sibling to Tool / LlmProvider
interface Trigger<Params = unknown, Cursor = unknown> {
  name: string                 // 'email' | 'timer' | 'webhook'  (parallels Tool.name)
  mode: 'poll' | 'push'        // poll → scheduler-driven cadence; push → enqueued by an ingress
  paramsSchema: JSONSchema     // validated when an automation is created
  detect(ctx: DetectCtx<Params, Cursor>): Promise<DetectResult<Cursor>>
}

interface DetectCtx<Params, Cursor> { params: Params; cursor: Cursor | null }
// detect() runs in the worker with the same ambient access Tools have (config, getDb(),
// withImap, outbound fetch) — closed over like Tools, not threaded through DetectCtx.

interface DetectResult<Cursor> {
  events: TriggerEvent[]   // what's new/actionable this fire; [] ⇒ nothing, no fire
  nextCursor: Cursor       // advanced cursor — staged, committed only after the run succeeds
}

interface TriggerEvent {   // whatever the Trigger surfaces: a new message, a threshold crossing, a payload
  id: string               // stable per-Trigger (email: uid; rss: guid; edge: 'crossed@81')
  summary: string          // human line read by triage + the objective (the normalization point)
  data?: unknown           // optional structured payload the run acts on (email: { uid, from, subject })
}
```

A worker-side `triggerRegistry` maps `name → Trigger`, looked up in `detect.ts` the way
`toolCatalog()` is looked up in `gate.ts` today. `gate.ts` and its `runGate`/`reduceSignal`/
`decideSignalChange`/`GateConfig` are **deleted** — the three reducers don't disappear, they become
implementation details *inside* the Triggers that need them (a future `webpage` Trigger owns a `hash`
cursor; `email` owns a uid cursor).

### The Triggers

- **`email`** (`mode: 'poll'`). `params: { mailbox?: string; from?: string; subject?: string;
  unreadOnly?: boolean }`. `cursor: { lastUid: number }`. `detect()` runs an IMAP UID-floor search
  (`{ uid: \`${lastUid + 1}:*\` }` plus the param criteria) via a new `fetchSinceUid` helper next to
  `fetchMessages` in `email/tools.ts`; `events` = the matching messages (`id = uid`,
  `summary = "from — subject"`, `data = { uid, from, subject }`), `nextCursor.lastUid = max(uid)`.
  First detect with `cursor == null` establishes the baseline silently (no fire on the pre-existing
  backlog) — same rule as `decideSignalChange` today, now owned by the Trigger.
- **`timer`** (`mode: 'poll'`, no cursor). `params: {}`. `detect()` always returns one synthetic event
  (`[{ id: tick, summary: 'scheduled' }]`, `nextCursor: null`) — the cron cadence *is* the trigger.
  Subsumes both today's recurring `schedule`/`inbox`-with-null-gate (a fixed briefing) and the
  one-shot `self` reminder (a `timer` automation with a `next_fire_at` instead of a `schedule`). Pair
  with no triage to "always escalate."
- **`webhook`** (`mode: 'push'`). Not scheduled; the webserver's hook route enqueues a detect job
  carrying the event, which `detect()` passes through as the event. Lightly specified here — the push
  transport is largely the reserved `webhook` kind already.

### Why this generalizes — the cursor is opaque

The framework never *interprets* a cursor: it stores it as jsonb, hands it to `detect()`, and
stages/commits it (`pending_cursor → cursor` on `done`). Every cursor semantic — what it is, how to
diff it, when an event counts as new — lives inside `detect()`. So a new Trigger scales by choosing
the cursor shape its source needs; no framework change. `detect()` is just the canonical
stateful-stream fold `(params, priorState) → (events, nextState)`, and that one shape spans the
archetypes:

| Archetype | Examples | mode | Cursor | "event" = |
|---|---|---|---|---|
| Monotonic feed | email (uid), chat (ts), bank txn | poll/push | scalar high-water mark | each new item |
| Opaque-sync feed | Google Calendar, Gmail history | poll | provider sync token | each changed item |
| Unordered feed | RSS (guid), scraped lists | poll | windowed seen-set | each unseen item |
| State edge | temp > 80°, price < X, site up/down | poll | last observed state | the transition (0–1) |
| Heartbeat | daily briefing, reminder | poll | none | "it's time" (always 1) |
| Push | webhook, IMAP IDLE | push | optional dedup key | the delivered payload |

Two glue points let heterogeneous sources share one downstream: every Trigger normalizes its event to
`{ id, summary, data? }` (triage + the objective read `summary`; the run acts on `data`), and `mode`
and `cursor` are orthogonal — a push Trigger can still hold a cursor to dedup redeliveries (IMAP IDLE
is push *and* uid-cursored).

Limits this surfaces, recorded honestly:
- **Ephemeral sources are best-effort, not at-least-once.** Re-delivery (don't commit `cursor` until
  `done`) only works if the source still reflects the event next tick — true for a durable feed (the
  mail's still there), not for a state edge that has since reverted. `pending_cursor` is still
  correct: at-least-once where the source allows, best-effort otherwise, never worse than
  commit-at-detection.
- **Seen-sets must be windowed.** A scalar can't dedup non-monotonic ids; the seen-set Trigger that
  replaces it caps/ages its set — that Trigger's concern, not the interface's.
- **The agent must discover Triggers.** Like the tool catalog, `create_automation` needs the
  registry's `{ name, paramsSchema }` exposed so the agent picks a Trigger and fills valid params.
- **One Trigger = one source.** Cross-source composition ("mail from X *and* calendar free") is the
  objective's job, not a Trigger.

### Detection flow (`detect.ts`)

Tier-0 changes from `runGate` to a registry `detect()`; everything downstream is the same code path:

1. `const { events, nextCursor } = await triggerRegistry[automation.trigger].detect({ params, cursor })`.
2. `events.length === 0` ⇒ `markAutomationFired`, done. **Free idle path, no `agent_runs` row** (unchanged).
3. Else Tier-1 `runTriage(automation, events)`. `dismiss` ⇒ `bumpDetectionCost` + **commit the cursor now**
   (`cursor ← nextCursor`; the events were evaluated and rejected — don't re-triage them forever) +
   `markAutomationFired`.
4. `escalate` ⇒ `createAutomationRun` with an objective composed from `automation.objective` + the
   fenced untrusted delta (uids + from/subject) + the classifier hint, **stage**
   `pending_cursor = nextCursor` (do **not** touch `cursor`), `enqueueAgentRun`, `markAutomationFired`.
   The one-active-run coalesce, the orphan-terminate-on-enqueue-failure, and the `force` "run now"
   path are all unchanged.

### Cursor commit (`run.ts`)

`run.ts` already resolves the automation from the run's conversation (`getAutomationByConversation`,
renamed from `getTriggerByConversation`) and scopes the scratchpad to `automation:<id>`. Add one step
at terminal `done`: if the run's automation has a `pending_cursor`, `cursor ← pending_cursor` and clear
`pending_cursor`, terminal-guarded like every other status write (§10.9). On `failed`/`cancelled`,
leave both untouched — the next detect tick re-reads the same `cursor`, recomputes the same delta, and
re-escalates (at-least-once). A run still active when the next tick fires hits the one-active-run
coalesce, so there's no double escalation.

### Creation (`create_automation` tool)

Replaces `schedule_self`'s freeform `gate`. Signature `create_automation({ trigger, params?, when?,
objective, notify_policy? })`:

- `trigger` selects the `Trigger`; `params` is validated against its `paramsSchema` (an invalid email
  automation is rejected at create time, not silently degraded to fire-every-tick).
- `when` is a cron (recurring → `schedule`) or a one-shot timestamp (→ `next_fire_at`), parsed by the
  existing `decideWhen`. A `webhook` trigger needs no `when`.
- The standing-automation cap, `notify_policy` defaulting, and `source_run_id` provenance carry over
  from `schedule_self`. `run_trigger` (force run-now) becomes `run_automation`, otherwise unchanged.

### Schema delta (`automations`, was `triggers`)

Rename table `triggers` → `automations`. Drop `gate`, `last_seen_signal`. Rename `kind` → `trigger`.
Add `params` (jsonb), `cursor` (jsonb), `pending_cursor` (jsonb). Keep `triage`, `objective`,
`notify_policy`, `conversation_id`, `schedule`, `next_fire_at`, `detection_cost_usd`, `source_run_id`.

### Naming cascade

Domain identifiers rename with the table; operational names stay to bound churn:

- **Renames** (domain): the queries (`getTrigger`→`getAutomation`, `getTriggerByConversation`→
  `getAutomationByConversation`, `createTriggerRun`→`createAutomationRun`, `markTriggerFired`→
  `markAutomationFired`, `listEnabledTriggers`→`listEnabledAutomations`, `insertTrigger`→
  `insertAutomation`, `setTriggerConversation`→`setAutomationConversation`; `updateTriggerSignal`
  deleted); the tools (`schedule_self`→`create_automation`, `run_trigger`→`run_automation`); the
  scratchpad scope (`trigger:<id>`→`automation:<id>`); docs (`DATABASE.md`, `INGRESSES.md` §9.4,
  `ARCHITECTURE.md`/`RUNTIME.md` references).
- **Stays** (operational): the pm2 process `alfred-triggers` (it schedules the triggers that fire
  automations) and the pg-boss queue `trigger-detect` / `AutomationDetectJob` payload — renaming these
  is cosmetic churn touching `ecosystem.config.cjs`, the scheduler, and config docs for no design gain.

## Alternatives considered

- **Keep the scalar gate, just document "always set `signal: maxUid`."** Rejected — even with a
  `maxUid` gate, the action run never learns *which* uids are new (it re-lists newest-20), and the
  signal still advances at detection time (drops mail on crash). The bug is structural, not config.
- **Make the agent track seen state in the scratchpad.** Rejected — non-deterministic,
  model-discipline-dependent dedup for something that needs an exactly-once guarantee. The scratchpad
  stays for continuity of *reasoning*, not deduplication.
- **Generic seen-set for all Triggers now.** Deferred — heavier (stored set, windowing) and unnecessary
  while email's only feed has monotonic UIDs. The interface leaves room (`Cursor` is opaque).
- **Translate existing rows instead of dropping.** Rejected by the owner — a clean cutover beats a
  fragile mapping over a handful of rows, and the email watcher is broken anyway.
