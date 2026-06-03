# Tools + approval (built-in tools, semantic gating)

Wire built-in tools through the worker so Alfred can *act*, gated by the trust-tier human-in-the-loop approval flow (§16, §10.2–§10.4, §10.9): before a `write`/`destructive` tool runs, the run pauses, an approval card (✅/❌) appears in the web chat, and the tool runs only if the owner approves. Scope is **built-in tools only** with the full approval cycle — demonstrated with `echo` (read, runs freely) plus one `write`-tier tool. MCP-sourced tools and the agent-initiated `ask_user` question reuse this same machinery in later steps.

This step is honest about a limit: per-tool trust tiers work for *semantic* tools (a future Gmail `send`), but **not** for the browser, whose primitives (`click`/`type`) are mechanical — its containment is profile isolation + domain gating + task-scoped approval, designed at the browser-bridge step (§15 step 5). See Follow-up doc edits.

Grounded in `docs/ARCHITECTURE.md` §6.1, §10.2/§10.3/§10.4/§10.9, §16, §7.1/§7.3, `docs/DATABASE.md`, and the existing `agent-core` / `db` / `worker` / `webserver` / `web` code.

## Key decisions

- **The gate is a loop callback** (extends `agent-core`). `runAgent` gains `requestApproval(call) => Promise<{ approved, note? }>`, consulted **only** for `write`/`destructive` tools before `invoke`. The loop stays the hand-rolled orchestrator (§7.1); the worker owns the pause/resume + DB. `read` tools run untouched.
- **Tool-call persistence via worker hooks** (extends). `runAgent` also takes `onToolStart`/`onToolEnd` hooks so the worker writes `tool_calls` rows and drives their status (the loop knows the lifecycle; the worker owns Postgres).
- **Trust tiers are declared in code for built-ins** (reuses §7.3). `echo` is `read`; the demo write tool declares `write`. Owner-assigned tiers for *MCP* tools (config-mapped, safe default) are deferred with MCP — but the principle (never server-declared) is recorded now (Follow-up doc edits).
- **`tool_calls` + `user_interactions` tables land** (extends `DATABASE.md`, which already specs them). Plus `agent_runs.awaiting_approval` is now a used status (the partial index already covers it).
- **Worker blocks on `LISTEN` for resolution** (reuses §7.6 fail-and-restart). On a write/destructive call it creates the interaction, NOTIFYs `interaction_required`, and waits on a dedicated `LISTEN` for `interaction_resolved` (with a 24h timeout). No durable resume — a crash sweeps the run to `failed` (cascading its tool_calls/interactions, §10.9 inv. 4).
- **MVP approval timeout = 1h; pg-boss lease sits just above it** (extends current config). The approval window is **1h** — a deliberate MVP shortening of §10.4's 24h default (which is configurable per-tool). `expireInSeconds` is bumped from 3600 to ≈4500 (75 min) so a job blocked on approval outlives the timeout: the in-handler timeout fires first and resolves the run, and the pg-boss lease never expires mid-wait.
- **Context-bound built-in tools** (new). Tools that act on the run/conversation are constructed per-run in the worker (`makeSetTitleTool(conversationId)`), capturing context in a closure — the `Tool.invoke(args)` signature stays context-free.
- **Two new NOTIFY events + a resolve endpoint** (extends §6.2/§9.1). `interaction_required` / `interaction_resolved` join the `RunEvent` union; webserver gains `GET /api/interactions/:id` (fetch the prompt) and `POST /api/interactions/:id` (resolve, first-writer-wins).

## Goals

- The agent can call built-in tools end to end; `write`/`destructive` ones require the owner's ✅ before running, `read` ones don't.
- The full interaction cycle works: pause → surface in the web UI → resolve (any device, first wins) → resume; with a 1h MVP timeout.
- Every tool call and every approval is persisted (`tool_calls`, `user_interactions`) — the audit trail (§16).
- The machinery is reusable: MCP tools and `ask_user` plug into it later with no rework.

## Non-goals

- **MCP-sourced tools** and the trust-tier config mapping — next step.
- **`ask_user`** (agent-initiated questions) — same tables, later step.
- **The browser** and its containment (profile isolation, domain gating, task-scoped approval) — step 5; per-tool tiers explicitly don't cover it.
- Real side-effecting tools (Gmail, etc.) — the demo write tool is a stand-in.
- Discord/voice surfacing of approvals — web only for now (the machinery is ingress-agnostic).

## Design

### Schema (`packages/db` + migration)

Add `tool_calls` and `user_interactions` exactly as `DATABASE.md` specs (FKs to `agent_runs`/`tool_calls`/`messages`; the partial `pending`-interaction index). No change to `agent_runs` columns — `awaiting_approval` is just now a used value.

### agent-core (the gate)

`runAgent` is extended:

```ts
requestApproval?: (call: { id; name; args; trustTier }) => Promise<{ approved: boolean; note?: string }>
onToolStart?: (call) => Promise<void>
onToolEnd?: (call, outcome: { status; result?; error? }) => Promise<void>
```

Per tool call in the loop: `onToolStart`; if `trustTier !== 'read'` → `await requestApproval`; if rejected, append a `{ error: 'user_rejected', note }` tool_result and `onToolEnd(rejected)`; else `invoke`, append the result, `onToolEnd(done/failed)`. Read tools skip `requestApproval` entirely. The loop test covers both approve and reject paths with a stub.

### worker (`services/worker`)

- Builds the per-run tool list: `[echoTool, makeSetTitleTool(run.conversationId)]`.
- `onToolStart/onToolEnd` → insert/update `tool_calls` rows (status `pending`→`awaiting_user`/`running`→`done`/`rejected`/`failed`).
- `requestApproval`: insert a `user_interactions` row (`kind='approval'`, `prompt={summary, tool, args, trust_tier}`, `status='pending'`); set `tool_calls.status='awaiting_user'` and `agent_runs.status='awaiting_approval'`; `notifyRun(interaction_required)`; then **block** on a dedicated `LISTEN` for that interaction's resolution (+ a 1h `setTimeout` that flips it `timed_out`). On wake, read `response`, set statuses back to `running`, return the verdict.

### webserver (`services/webserver`)

- `GET /api/interactions/:id` → the interaction row (so the client can render the approval card from the `interaction_required` event).
- `POST /api/interactions/:id` `{ approved, note? }` → conditional `UPDATE … WHERE id=$ AND status='pending' RETURNING` (first-writer-wins, §10.3); on win, `notifyRun(interaction_resolved)`; on loss, `409` (already resolved/timed out).

### web (`clients/web`)

`Chat` handles the two new SSE events: on `interaction_required`, fetch `GET /api/interactions/:id` and render an **approval card** (tool name, a readable summary, the args, ✅/❌); on ✅/❌, `POST` the resolution; on `interaction_resolved`, dismiss the card. The chat input stays disabled while awaiting approval.

### State machine (subset of §10.9)

`tool_calls`: `pending → running → done|failed` (read), or `pending → awaiting_user → running → done|failed` / `→ rejected` (write/destructive). `user_interactions`: `pending → resolved|timed_out|cancelled` (single exit, conditional UPDATE). `agent_runs`: `running → awaiting_approval → running → done|failed`. The startup sweep already fails `awaiting_*` runs and (§10.9 inv. 4) cascades to non-terminal tool_calls (→`failed`) and pending interactions (→`cancelled`).

### Verification

- **agent-core loop test** (offline): a fake `write`-tier tool + a stub `requestApproval` — assert approve→invoked, reject→rejection result fed back, and `read` tools never call `requestApproval`.
- **worker test** (Postgres-gated): a fake provider scripts a `write`-tool call; the test resolves the interaction (writes the response + NOTIFY) and asserts the tool ran, with `tool_calls`/`user_interactions` rows transitioned correctly. A second case rejects and asserts the synthetic rejection.
- Manual: chat "rename this conversation to X" → approval card → ✅ runs it, ❌ doesn't; visible in `/debug`.

## Open questions

None — resolved during review: the demo write tool is `set_conversation_title`; the approval timeout is **1h** for MVP (configurable per §10.4) with the pg-boss lease bumped to ≈75 min so a blocked job outlives it.

## Follow-up doc edits (after sign-off)

- **`ARCHITECTURE.md` §16** — add: trust-tier per-tool approval is for *semantic* tools; it is **insufficient for the browser** (mechanical `click`/`type` primitives whose danger is in the page, not the tool). The browser's containment is **profile isolation + sensitive-domain gating + task-scoped approval**, designed at step 5 — not per-click tiers. Also note trust tiers are **owner-assigned, never server-declared** (built-ins in code; MCP config-mapped with a safe default).
- **`ARCHITECTURE.md` §8** — cross-reference the above: the browser bridge needs its own approval strategy, the single highest-risk component.

## Alternatives considered

- **Wrap tools in the worker instead of a loop callback.** Hidden control flow; the hand-rolled loop (§7.1) should *visibly* own "pause here." Rejected.
- **Per-click approval for the browser (later).** Unusable (approval fatigue) and uninformative (the tool layer can't show intent). Rejected in favor of structural containment at step 5.
- **Include MCP / `ask_user` now.** Both reuse this exact machinery; bundling triples the surface area. Deferred.
