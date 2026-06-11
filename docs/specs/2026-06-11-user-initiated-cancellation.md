# User-initiated cancellation (§10.6)

Build the reserved cancellation flow: a Stop button in the web chat cancels the
conversation's active run — the cancel route writes `cancelled` plus the §10.9 invariant-4
cascade in one transaction and NOTIFYs `{type:'cancelled'}`; the worker holds a per-run
`AbortController`, aborts on that event (killing the in-flight LLM stream via the SDK's
`abortSignal`), and finalizes without touching the status the route already wrote. This is
the route-authoritative shape RUNTIME §10.6 documents — chosen over a worker-authoritative
request/acknowledge precisely because it still works when the worker is hung or dead, which
is when the owner most needs to unblock a conversation stuck behind the one-active-run index.

## Key decisions

- **Conversation-scoped cancel route** (new). `POST /api/conversations/:id/cancel` cancels
  *the* active run of the conversation — the one-active-run partial index (§7.6) makes that
  unambiguous, and the client doesn't reliably know the `runId` after a refresh. Returns the
  cancelled run id, or 409 when there is nothing active to cancel.
- **The route owns the `cancelled` transition + cascade** (extends). One transaction: flip
  the active run → `cancelled`, every non-terminal `tool_call` → `failed`, every `pending`
  interaction → `cancelled` (§10.9 invariant 4), then NOTIFY. `sweepOrphanedRuns`
  (`packages/db/src/boss.ts`) already implements this exact cascade for `failed` — extract a
  shared `terminateRuns(tx, runIds, { status, error })` helper in `packages/db` used by both,
  so invariant 4 has one implementation.
- **NOTIFY-driven abort, not status polling** (extends). The worker opens a dedicated
  per-run LISTEN client (the same pattern `awaitInteraction` uses per pause) on the
  conversation channel; a `{type:'cancelled'}` event aborts the run's `AbortController`. The
  loop's `signal.aborted` checks before each turn and each tool invoke are §10.6's "mid-run
  status check," made event-driven instead of polled.
- **The AbortSignal threads loop → provider → SDK** (extends). `RunOptions.signal` and
  `StreamOptions.signal` already exist unused; the loop starts honoring them and
  `GeminiProvider` forwards `config.abortSignal` to `generateContentStream` (supported by
  `@google/genai`; client-side only — Google may still bill the partially generated tokens).
- **Worker status writes become terminal-guarded** (extends). The done/failed finalizations,
  `awaitInteraction`'s resume write, and `onToolEnd`'s tool_call update gain
  `WHERE status = <expected>` conditions so they can never overwrite the route's terminal
  write. This is §10.9's "terminal states are absorbing" invariant finally enforced at the
  write sites, not just documented.
- **Cancel discards partial output but keeps cost honest** (new). The cancelled path
  persists no messages (matching the failed path) but still runs the usage rollup —
  tokens/cost land on the run without touching `status`. No `error` NOTIFY; the route's
  `cancelled` event already told every client.
- **`cancelled` RunEvent emitted by the webserver** (extends). `events.ts` gains
  `{ type: 'cancelled' }` (reserved in §6.2 until now); the route emits it the same way the
  resolve route already emits `interaction_resolved`. The web client's existing defensive
  handler becomes the real path; the send button swaps to a Stop button while busy.

## Goals

- The owner can stop a runaway or wrong-direction run from the web chat, and the in-flight
  LLM stream dies immediately (no tokens burned past the click).
- Cancel works in every active state: `pending` (pre-pickup), `running` (mid-stream or
  mid-tool), and `awaiting_approval` (parked on an approval or question — the pending card
  resolves to cancelled and the parked worker wakes).
- Cancelling a run whose worker is hung or dead still frees the conversation — the
  one-active-run index stops blocking new messages.
- All three state machines follow their §10.9 `cancelled` transitions, which exist on paper
  but have never been exercised.

## Non-goals

- **Discord / voice cancel surfaces** (`/cancel`, "stop" by voice) — post-MVP ingresses;
  the route is ingress-agnostic so they only need to call it.
- **A `/cancel` slash command.** The composer is disabled while a run is busy, so a typed
  command can't reach it anyway; the button is the surface.
- **Killing an in-flight tool invoke.** Per §10.6, a tool already executing (a browser
  command, a Python run) runs to its own completion/timeout; the abort takes effect at the
  next loop checkpoint. Interruptibility stays bounded by the slowest tool.
- **Cancelling the pg-boss job itself.** The delivered job no-ops against the terminal run
  row (the existing `status !== 'pending'` guard in `runJob`), same as the sweep's trade.

## Design

### The cancel route

`POST /api/conversations/:id/cancel` in `services/webserver/src/app.ts`:

```ts
const cancelled = await db.transaction((tx) =>
  terminateRuns(tx, {
    where: active run of conversationId,         // status IN ('pending','running','awaiting_approval')
    runStatus: 'cancelled', error: null,
    toolCallError: 'run cancelled',
  }),
)
if (!cancelled) return c.json({ error: 'nothing to cancel' }, 409)
await pgNotify(`conversation:${conversationId}`, JSON.stringify({ type: 'cancelled' }))
return c.json({ cancelledRunId: cancelled.id })
```

`terminateRuns` is the cascade extracted from `sweepOrphanedRuns`: conditional run UPDATE
(`RETURNING`), cascade non-terminal `tool_calls` → `failed`, `pending` interactions →
`cancelled`, all in the caller's transaction. The sweep becomes its other caller
(`runStatus: 'failed'`, `error: 'orphaned (worker restart)'`). The route sets
`finished_at = now()`; the worker's later best-effort rollup fills tokens/cost.

### Worker: abort plumbing (`run.ts`)

`runJob` creates one `AbortController` per run and a cancel watcher around the whole try
block:

```ts
const controller = new AbortController()
const unwatch = await watchForCancel(run.conversationId, () => controller.abort())
try { ... runAgent({ ..., signal: controller.signal }) ... } finally { await unwatch() }
```

`watchForCancel` opens a dedicated `pg.Client`, LISTENs on `conversation:<id>`, and fires on
a `{type:'cancelled'}` payload — the same dedicated-client pattern `awaitInteraction` already
uses, one connection per *active run* (fine at single-user scale; a multiplexing singleton is
a later optimization if connection count ever matters).

`awaitInteraction`'s notification handler additionally finishes on `{type:'cancelled'}`, so a
worker parked on an approval/question wakes promptly. It then reads the interaction row as
usual (the cascade already flipped it to `cancelled`, response `null` → approval maps to
not-approved / question to `no_answer`), and the aborted signal short-circuits the loop at
the next checkpoint before another model call can happen.

### Loop & provider (`agent-core`)

- `runAgent`: before each turn's `provider.stream(...)` and before each tool invoke, check
  `signal?.aborted` and throw a `CancelledError` (exported from agent-core so the worker can
  discriminate). Cancellation between checkpoints surfaces as the provider's own abort
  rejection — equivalent, since the worker classifies by `signal.aborted`, not error type.
- `GeminiProvider.stream`: add `abortSignal: opts?.signal` to the `generateContentStream`
  config. `translateGeminiError` must pass abort errors through untouched (they are not
  connectivity failures; the worker never surfaces them to the owner anyway).

### The cancelled finalization path (`run.ts` catch)

The catch block branches first on `controller.signal.aborted`:

- **Aborted** → cancelled path: skip message persistence, skip auto-title, run a best-effort
  usage-only rollup (`UPDATE agent_runs SET prompt_tokens, completion_tokens, cost_usd,
  model WHERE id = runId` — no `status`, no `finished_at`; the route owns those), emit
  nothing (the route's `cancelled` NOTIFY was the user-facing signal).
- **Not aborted** → existing failed path, with its UPDATE now guarded (below).

### Terminal guards

Every worker write that §10.9 implies must lose to a terminal state becomes conditional:

| Write site | Guard | On losing the race |
|---|---|---|
| done finalization (`run.ts`) | `WHERE status = 'running'` + RETURNING | skip the `done` NOTIFY (run was cancelled at the finish line; messages already persisted — accepted ms-window race) |
| failed finalization (`run.ts`) | `WHERE status IN ('pending','running','awaiting_approval')` + RETURNING | skip the `error` NOTIFY |
| resume after pause (`awaitInteraction`) | `WHERE status = 'awaiting_approval'` | nothing — the loop aborts at its next checkpoint |
| `onToolEnd` tool_call update | `WHERE status IN ('pending','awaiting_user','running')` | nothing — the cascade's `failed` stands; the settled in-flight result is dropped |

### Web UI (`Chat.tsx`)

- While `busy`, the Send button renders as **Stop**; click → `POST .../cancel` (disabled
  while the request is in flight). The existing `cancelled` SSE handler (busy → false,
  `loadHistory`, clear live segments and any open approval/question card) does the teardown.
- After handling `cancelled`, ignore further `token`/`tool_call_*` events until the next
  send — the worker's NOTIFY chain may flush a few stragglers after the route's event, and
  they must not resurrect the live block.
- **Refresh-proof Stop:** `GET /api/conversations/:id` additionally reports whether the
  conversation has an active run (`activeRun: boolean` — a cheap EXISTS against the
  one-active-run partial index), and the chat initializes `busy` from it on mount. A mid-run
  refresh thus restores the disabled composer, the thinking state, and — crucially — the
  Stop button, which is the owner's only way to free a conversation stuck behind the index.

### State machines (§10.9)

No new states or transitions — this builds the reserved ones: `agent_runs`
`pending|running|awaiting_approval → cancelled`, the invariant-4 cascade, and
`user_interactions pending → cancelled`. Docs to touch at build time: RUNTIME §10.6 (drop
"planned, not yet built"), ARCHITECTURE §6.2 (`cancelled` no longer reserved), `docs/TODO.md`.

## Resolved choices

- **Partial assistant text is discarded on cancel** (owner-settled). Matches the failed
  path; the streamed text vanishes from the chat on the post-cancel reload. The owner
  cancelled because the output was wrong — revisit if the vanishing proves annoying.
- **Stop is refresh-proof** (owner-settled). `GET /api/conversations/:id` reports the active
  run and the chat initializes `busy` from it on mount (Design: Web UI).

## Alternatives considered

- **Worker-authoritative (request/acknowledge).** The route only NOTIFYs a
  `cancel_requested`; the worker aborts, settles in-flight tools, and is the single writer of
  `cancelled` + cascade. No racing writes, and "cancelled" would mean "actually stopped" —
  but a hung/dead worker can't be cancelled until restart (the case that most needs it), and
  it diverges from the documented §10.6 shape. Rejected.
- **Polling only.** The worker re-SELECTs `agent_runs.status` between turns and before
  tools, no AbortSignal. Smallest diff, but the LLM stream keeps burning tokens until the
  turn ends, and the TODO explicitly calls for the AbortSignal. Rejected.
