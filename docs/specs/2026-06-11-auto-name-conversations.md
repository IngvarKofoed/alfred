# Auto-name conversations

After the first run of an untitled conversation finishes, the worker makes one cheap LLM
call to generate a short title from the opening exchange and writes it to
`conversations.title` — directly, the way `/rename` does, **not** through the agent loop or
the `set_conversation_title` tool. This makes the history sidebar (CHANGELOG 63) browsable
instead of a wall of "New conversation". Deterministic (always runs while the title is null),
no approval friction, negligible cost.

## Key decisions

- **Titling lives in the worker's `done` path** (new). A best-effort step in `run.ts` after
  the assistant turn is persisted and the run is marked `done` (run.ts:287–291), gated on the
  conversation still having a null title. It's a worker step, not a tool and not in the agent
  loop — it writes `conversations.title` with a plain `UPDATE`, exactly like `/rename`
  (`ensureConversation`/the rename command). `set_conversation_title`'s trust tier is
  irrelevant and untouched.
- **Gate = title-is-null, idempotent** (new). Generate only when `conversations.title IS
  NULL`; once a title exists (auto, agent-set, or `/rename`'d) it's never overwritten.
  Self-correcting: if a titling attempt fails, the next run on the same still-null
  conversation retries it. No separate "first run" bookkeeping.
- **One out-of-loop LLM call** (extends). Calls the `LlmProvider` directly (drain the stream,
  `tools: []`) with the opening exchange to produce a ~3–6 word title. Reuses the provider
  abstraction; no new framework.
- **Cost attribution must not mislabel the run** (extends). `rollupUsage` derives
  `agent_runs.model` from the last `llm_calls` row with `tool_call_id IS NULL` (run.ts:328).
  A title call recorded naively as a null-`tool_call_id` row would steal the run's model
  label. Default: reuse the existing out-of-loop attribution path (CHANGELOG 47) — link the
  title's `llm_calls` row to a synthetic internal `tool_calls` row, so model derivation
  excludes it and its cost still rolls into `agent_runs.cost_usd` with zero `rollupUsage`
  changes. (See Open questions — there's a lighter alternative.)
- **Live surfacing via a new `title` RunEvent** (extends). After writing the title the worker
  NOTIFYs `{ type: 'title', title }`; the SSE route forwards it unchanged; `Chat.tsx` handles
  it by calling the existing `onTitleChange(title)`, which updates the header and bumps the
  sidebar's reload signal (App.tsx:113–116). No polling, no new endpoint.
- **Model: reuse `GEMINI_MODEL`** (reuses). Default to the already-configured, already-priced
  chat model so there's no new config key and no missing `pricing.ts` entry (an unpriced
  model reports $0, undercounting). (See Open questions.)
- **Best-effort, never fails the run** (reuses). The whole step is wrapped in try/catch and
  runs after the run is already `done`; a titling error logs and is swallowed, mirroring the
  "don't ask again" side-effect pattern in `app.ts`.

## Goals

- Every conversation ends up with a meaningful title automatically, so the history sidebar is
  actually navigable.
- No approval card, no dependence on the agent electing to call a tool.
- Honest cost + observability for the extra call (it shows on `/debug` like any other).

## Non-goals

- Re-titling as a conversation evolves — title once, while null, then leave it.
- Touching `set_conversation_title` (its tier, its behavior) — Approach A doesn't use it.
- Titling via the agent loop / system-prompt nudge (rejected Approach B) or a no-LLM
  first-words heuristic (rejected Approach C).
- User-facing controls (disable auto-titling, "regenerate title") — future.

## Design

### Trigger point & gate

In `run.ts`, after the `status:'done'` update and its `{type:'done'}` NOTIFY (run.ts:291),
run the titling step. Re-read (or carry) the conversation's current title; if non-null, do
nothing. The gate is purely `title IS NULL`, so the step is idempotent and self-healing — no
"is this the first run" check. Placing it *after* the done transition keeps the user-visible
turn fast and means a titling failure can't regress a successful run.

(If the chosen cost-attribution option needs the title's cost folded into the run's rollup,
the step instead runs just *before* the final `rollupUsage` + done update — see Cost
attribution.)

### The title call

Assemble a tiny prompt from the opening exchange — the first user message text and (by
default) the first assistant reply — with a system instruction: *return only a 3–6 word
title, no quotes, no punctuation-as-decoration, plain text.* Call the provider directly,
`tools: []`, and drain the stream to a string. Sanitize: strip newlines, trim, collapse
whitespace, cap to ~60 chars, and ignore an empty result (leave the title null → retried next
run). Then `UPDATE conversations SET title = … WHERE id = … AND title IS NULL` (the
`title IS NULL` guard closes the race with a concurrent `/rename`).

### Cost attribution

The title call is neither a loop call nor an agent tool call, but it costs tokens and should
appear on `/debug`. The constraint: it must not become `agent_runs.model`.

Default (reuse CHANGELOG 47's mechanism): create a synthetic internal `tool_calls` row
(e.g. `tool_name = 'auto_title'`, `trust_tier = 'read'`, `status = 'done'`), insert the
title's `llm_calls` row with `tool_call_id` pointing at it, and run the step before the final
`rollupUsage`. Then `rollupUsage`'s `tool_call_id IS NULL` filter naturally excludes it from
the model pick, its cost rolls into the all-calls sum, and `/debug` shows it as its own
labelled bucket — all with no `rollupUsage` change. Cost: one extra `tool_calls` row for an
action the agent didn't invoke.

### Live surfacing

Add `{ type: 'title'; title: string }` to `events.ts`'s `RunEvent` union and emit it right
after the title write. The SSE route already forwards every NOTIFY raw, so no webserver
change. In `Chat.tsx`, handle the event by calling `onTitleChange(ev.title)` — the same path
`/rename` uses — which updates the header title and increments the sidebar's `reloadKey` so
the rail re-fetches and the new title appears live, in both the open conversation and the
list.

## Alternatives considered

- **Approach B — nudge the agent to self-title via `set_conversation_title`** (drop its tier
  to skip approval). Cheapest to build, but unreliable (the model skips it), adds a tool
  round-trip inside the user-facing loop, and clutters the agent's reasoning. Unreliability
  defeats the purpose — the list must be *fully* named.
- **Approach C — no-LLM heuristic** (first ~6 words of the first message). Free and instant,
  but low quality; we already rejected a message snippet for the sidebar for the same reason.
