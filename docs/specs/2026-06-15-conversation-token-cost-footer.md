# Conversation token + cost footer

A persistent footer at the bottom of the chat (web + iOS) showing the conversation's cumulative
token count and USD cost — a running tab that climbs *during* a run, not just when it finishes.
The cost is already computed and stored (`llm_calls` → `agent_runs` rollup, §6.5); this increment
only **surfaces** it. The baseline (sum across completed runs) comes from the existing
`GET /api/conversations/:id` meta endpoint; a new lightweight `usage` SSE event overlays the
in-flight run's climbing total so the footer updates live "along the way."

## Key decisions

- **Reuse the existing cost accounting** (reuses). No new pricing, columns, or rollup. Every
  `llm_calls` row already carries `cost_usd` (`agent-core/pricing.ts`), summed onto `agent_runs`
  by `rollupUsage` (`worker/src/run.ts`). `/api/debug/conversations` already sums per conversation.
- **Extend `GET /api/conversations/:id`** (extends). It already returns `{ id, title, activeRun }`
  and is already fetched on mount by both clients (web `Chat.tsx`, iOS `loadMeta()`). Add cumulative
  `tokens` + `costUsd` summed over the conversation's `agent_runs` — one shared baseline source for
  both clients, no per-client query.
- **New `usage` RunEvent** (new). The worker emits `{ type:'usage', promptTokens, completionTokens,
  costUsd }` after each in-loop `llm_calls` write, carrying the **cumulative total for the current
  run** (a full snapshot, not a delta — so a missed event self-corrects, last-wins). Threaded
  through `events.ts` → `run.ts` → web `RunEvent` → iOS `RunEvent`. Tiny payload, far under the
  8000-byte NOTIFY cap.
- **Footer total = baseline + live overlay** (new). Baseline = `agent_runs` sum from meta (excludes
  the in-flight run, whose rollup is 0 until `done`). Live overlay = the latest `usage` event's run
  total. On any terminal event the client re-fetches meta (now includes the just-finished run's
  rollup) and clears the overlay — so the two never double-count and any live drift is reconciled.
- **Footer state is client-local** (reuses pattern). It lives in `Chat.tsx` / `ConversationViewModel`
  alongside the existing meta fetch + SSE handler — not threaded through `App.tsx` / `AppModel`.
- **`usage` rides the existing straggler guard** (extends). After a cancel, the worker may flush
  queued events; the clients already drop late `token`/`tool_call_*`/`title` events
  (`cancelledRef` / `cancelledStraggler`). Add `usage` to that set so a straggler can't bump the
  footer past the reconciled total.

## Goals

- Show, at the bottom of every conversation, how many tokens and how much money it has cost so far.
- Update the number live as the agent works within a run (per LLM call), on both web and iOS.
- Add no new accounting — surface what's already recorded, accurately.

## Non-goals

- Per-message or per-tool cost breakdown — that already lives on `/debug`.
- A budget cap / enforcement — that's the separate, still-unbuilt per-run cost cap (§10.7).
- Cost for non-`web`/non-chat ingresses, or a global all-conversations total.
- True per-token cost (estimating tokens before the call settles) — the per-LLM-call granularity is
  the "along the way" resolution.

## Design

### Backend

**`GET /api/conversations/:id`** (`webserver/src/app.ts`). Add a sum over the conversation's runs
to the existing handler:

```ts
const [agg] = await db
  .select({
    promptTokens: sum(agentRuns.promptTokens),
    completionTokens: sum(agentRuns.completionTokens),
    costUsd: sum(agentRuns.costUsd),
  })
  .from(agentRuns)
  .where(eq(agentRuns.conversationId, conversationId))
// tokens = prompt + completion (combined); costUsd kept as a string like elsewhere.
return c.json({ ...row, activeRun, tokens, costUsd })
```

The never-created-conversation branch returns `tokens: 0, costUsd: '0'` alongside the existing
`title: null, activeRun: false`. `sum()` yields `string | null` → coerce with `Number(... ?? 0)`.

**`usage` event** (`worker/src/events.ts`): add to the `RunEvent` union:

```ts
| { type: 'usage'; promptTokens: number; completionTokens: number; costUsd: number }
```

**Emitting it** (`worker/src/run.ts`). Keep a per-run accumulator in `runJob`:

```ts
const runUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0 }
```

`insertLlmCall` already computes the per-call cost; have it return `{ promptTokens, completionTokens,
costUsd }` so the caller can accumulate without recomputing. At the two **in-loop** call sites — the
`TracingProvider` callback (loop calls, `tool_call_id` null) and `onToolLlmCall` (tool AI calls) —
add the returned figures to `runUsage` and emit a cumulative snapshot, chained on `notifyChain` so
it lands in order after that call's tokens:

```ts
runUsage.promptTokens += r.promptTokens
runUsage.completionTokens += r.completionTokens
runUsage.costUsd += r.costUsd
notifyChain = notifyChain.then(() => notifyRun(run.conversationId, { type: 'usage', ...runUsage }))
```

`maybeAutoTitle` and the TTS/STT speech-leg rows are deliberately **not** wired to emit a live
`usage` event: they run at/after the `done` boundary (or, for STT, in the webserver before the run),
and the client's terminal meta re-fetch captures them via `rollupUsage` (which sums *all* of a run's
`llm_calls`). The live overlay momentarily under-shows the sub-cent auto-title; the re-sync corrects
it. (No double-count: the worker never emits `usage` after `done`, and a straggler would be dropped.)

### Web (`clients/web/src/Chat.tsx`)

- Two pieces of state: `baseUsage` (`{ tokens, costUsd }`, from meta) and `runUsage`
  (`{ promptTokens, completionTokens, costUsd } | null`, the live overlay).
- The existing mount-time `GET /api/conversations/:id` fetch (currently sets `busy` from `activeRun`)
  also sets `baseUsage`.
- SSE handler: on `usage`, set `runUsage` (drop it when `cancelledRef.current`, like the other live
  events). On `done`/`cancelled`/`error`, re-fetch meta to refresh `baseUsage` and set `runUsage`
  to null. (This is one extra cheap GET per run; the handlers already do work on these events.)
- Footer: a thin muted strip rendered between the transcript and the composer `<form>` — always
  visible (a status bar, not scrolling content). Shows
  `baseUsage.tokens + runUsage.{prompt+completion}` and `baseUsage.costUsd + runUsage.costUsd`.
  Hidden when the combined total is 0 (a brand-new conversation shows nothing).
- Formatting: tokens compact (`12.4k` for ≥1000), cost trailing-zero-trimmed for sub-cent legibility
  — mirror the existing `/debug` cost formatting (factor a tiny shared helper if convenient).

### iOS (`clients/ios/Alfred/Alfred/`)

- `Model/WireModels.swift`: `ConversationMeta` gains `tokens: Int` and `costUsd: String` (default 0
  via the decoder). `RunEvent` gains
  `case usage(promptTokens: Int, completionTokens: Int, costUsd: Double)` + a `"usage"` decode case.
- `Conversation/ConversationViewModel.swift`: observed `baseTokens: Int` / `baseCostUsd: Double`
  (set in `loadMeta()`) and `runTokens: Int` / `runCostUsd: Double` (live overlay). On `.usage`,
  set the overlay (dropped while `cancelledStraggler`, like the other live events). On
  `.done`/`.cancelled`/`.error`, call `loadMeta()` to refresh the baseline and zero the overlay
  (`loadMeta`'s `activeRun` busy logic is already `terminalSeen`-guarded, so a terminal re-fetch
  can't re-stick Stop).
- `Conversation/ConversationView.swift`: a caption-style footer line above the composer `VStack`
  showing combined tokens + cost (same compact formatting as web), hidden when the total is 0.

### Reconciliation walk-through

1. Open a conversation: meta → `baseUsage` = sum of completed runs; overlay = 0. Footer shows the
   historical total.
2. Send a message: the in-flight run's `agent_runs` cost is 0 (not yet rolled up), so `baseUsage`
   still excludes it. Each LLM call fires a `usage` snapshot → overlay climbs → footer = base + live.
3. `done`: `rollupUsage` writes the run's total onto `agent_runs`; the client re-fetches meta
   (`baseUsage` now includes the run) and clears the overlay. Footer is unchanged in value but now
   sourced entirely from the authoritative baseline.

## Alternatives considered

- **Run-boundary updates only (Approach A).** Footer bumps once per completed run, no `usage` event,
  no worker change. Rejected in favour of B because "update along the way" wants the live climb
  during long multi-tool runs; the extra code is modest since the cost is already computed per call.
- **Client polls the meta endpoint while busy.** Rejected — laggy and wasteful when the SSE push
  channel already exists; against the codebase's push-everywhere grain.
