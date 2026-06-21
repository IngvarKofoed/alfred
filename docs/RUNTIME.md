# Alfred — Run Execution, Lifecycle & Safety

The run-lifecycle reference for Alfred: how runs are serialized, how autonomous runs differ, the cross-process runtime flows, the state machines that govern the `status` columns, and the security/blast-radius model. Split out of `ARCHITECTURE.md` (which keeps the high-level system shape) so the always-loaded boot context stays small — read this when working on the worker, the agent loop, the interaction/approval flow, or anything touching run state.

Section numbers (e.g. §6.1, §9.4) reference `ARCHITECTURE.md`; the headings here retain their original `ARCHITECTURE` numbers (7.6, 7.7, 10, 16) so cross-references stay intact. The state machines here govern the `status` columns defined in `DATABASE.md`.

---

## 7.6 Concurrency, serialization & resource ownership

Concurrency is real — web, Discord, and voice can all be active at once — but the **run, not the worker, is the unit of serialized execution**. This is a single-user, single-machine system, so the model is deliberately simple: keep state in memory while a run executes, and **fail-and-restart on any crash** (below) rather than engineer durable mid-run recovery.

**One active run per conversation.** Conversations are independent and run concurrently with each other; *within* a conversation, runs are strictly serial. Enforced declaratively, not by an in-memory actor registry:

```sql
create unique index one_active_run_per_conversation
  on agent_runs (conversation_id)
  where status in ('pending', 'running', 'awaiting_approval');
```

A second run for the same conversation cannot be created while one is active. The constraint *is* the actor — it makes history reads, ordering, and cancellation deterministic with no coordination protocol.

**Mid-run input (MVP): rejected.** While a conversation has an active run, new user input is refused at the source — web disables send and shows "Alfred is thinking…"; Discord reacts with a "busy" marker and drops the message. Post-MVP: buffer the message and let the running worker fold it into its next turn, or interrupt. Default is reject because it is the only option with zero ambiguity about what the model actually saw.

**The browser is a single physical resource.** There is one Chrome, one owner profile (§8) — so browser control cannot truly be per-run. The design calls for an in-process mutex: a run acquires it only around its browser tool-call windows and **releases it whenever the run pauses** for user input (approval or question, §10.2), so a run parked on an approval doesn't block another conversation's browser work. **The mutex is not implemented in the MVP bridge (§8, step 5)**: every browser tool is approval-gated, so the owner already serializes browser use in practice, and two conversations driving Chrome at the same instant is not a real single-user scenario. It remains the right thing to add if that assumption ever breaks; the mutex would live in the worker process, not Postgres, so a crash drops the lock with the worker (the recovery we want).

**Crash policy: fail-and-restart.** A crash (OOM, deploy, host reboot) abandons in-flight runs; we do not reconstruct them. The consequences, all accepted:

- `agent-run` jobs use `retryLimit: 0` with an expiration longer than the max interaction timeout (§6.3), so a paused worker is never redelivered to a second worker — no duplicate execution, no fencing token needed.
- On startup the worker runs a one-shot sweep marking any non-terminal (`pending` / `running` / `awaiting_*`) rows as `failed`, so the UI shows an honest failure instead of a zombie "thinking…" state. A planned deploy therefore also drops any pending approvals — intentional; the owner re-issues.
- For a single user who notices the restart, this is strictly simpler than durable resume and costs nothing this system needs.

This is reversible: the run rows already live in Postgres, so durable resume could be layered on later if Alfred ever stopped being single-user-local.

## 7.7 Autonomous & long-horizon runs

Triggers (§9.4) are described as "just another ingress." That holds for the *transport* — enqueue, stream, notify — but autonomous work has a different **execution lifecycle** than request/response, and three seams must exist in the run model from day one so adding triggers later is wiring, not an agent-core redesign.

**1. Overflow policy is a function of human-presence, not a global toggle.** §7.5's fail-loudly default assumes someone can react. Each run carries a `human_in_loop` flag, derived from `conversations.ingress` (interactive ingresses → true; `trigger` → false). It selects behaviour at the edges:

| Presence | Context overflow | Tool error / ambiguity |
|----------|------------------|------------------------|
| Human in loop (web/discord/voice) | fail loudly (§7.5) | may raise `ask_user` / approval |
| Autonomous (trigger) | **auto-summarize with trace** — synthetic message + trace record + NOTIFY event; mandatory, never silent-fail | `write`/`destructive` approvals still apply — surfaced as a notification, the run waits for the owner (or times out, §10.4); open-ended `ask_user` questions have no human to answer, so they defer the objective rather than block |

**2. Continuity comes from durable working state, not full-history replay.** A long-horizon objective ("watch this inbox for a week and report") spans many runs over time. Its continuity is an explicit, agent-maintained **objective scratchpad** — a memory scope (§6.4) summarizing progress and next steps — *not* an ever-growing message log. This is what makes overflow tractable and lets a run days later resume with a bounded, relevant context. *(Built.)* Each fire now lands in its **own fresh conversation** (per-fire spec `docs/specs/2026-06-20-watcher-conversation-per-fire.md`), not one growing thread, so history is never replayed across fires at all — the scratchpad (`memory_facts` scope `automation:<id>`) carries continuity. The scope is keyed on the automation id and resolved from `conversations.automation_id` (run.ts `getAutomationForConversation`), so it survives across the per-fire conversations and a follow-up reply in any of them recalls/writes the same scratchpad.

**3. Self-scheduling is a first-class capability.** The agent-initiated trigger of §9.4 ("remind me next Tuesday") is a built-in tool `create_automation({ trigger, params?, when?, objective, notify_policy? })` (was `schedule_self`) that creates an automation — a chosen Trigger + schema-validated params + the action — picked up by the trigger scheduler. A one-shot enqueues a future run for the same objective, carrying the scratchpad forward; stored as a Postgres row on the same enqueue path as every other ingress.

**4. Budget is layered.** The per-run cost cap (§10.7) is insufficient for an always-on agent: a looping trigger or an injected instruction can spawn many sub-cap runs. Caps are scoped at **run** (§10.7), **objective** (sum across its runs), and a **global daily ceiling**. Exceeding the objective or daily cap pauses the objective and notifies the owner rather than failing silently.

None of this is built in MVP. The seams — the `human_in_loop` dimension, the objective scratchpad as a memory scope, and the layered budget — are reserved now so the worker and agent-core are not rewritten when triggers become the active build target (build-order step 9, §15).

---

## 10. Runtime Flows

The data shape (§6) and process topology (§5) are set; this section spells out the cross-process choreography that uses them. Four flows matter: the happy path, interactions (approval/question), errors, and cancellation.

### 10.1 Happy path

Single user message, one model call, no tools.

```
Ingress                  Worker                       LLM provider
   │ POST message          │                              │
   │ INSERT messages       │                              │
   │ INSERT agent_runs     │                              │
   │ boss.send(runId)      │                              │
   │ ─────────────────────►│ pg-boss delivers job         │
   │ LISTEN conversation:… │                              │
   │                       │ load context (§7.5)          │
   │                       │ provider.stream(...)         │
   │                       │ ───────────────────────────► │
   │                       │ ◄── token chunks ─────────── │
   │                       │ NOTIFY conversation:… {token}│
   │ ◄── token ────────────┤                              │
   │ forward to client     │                              │
   │                       │ done → INSERT messages       │
   │                       │ UPDATE agent_runs.status     │
   │                       │ NOTIFY conversation:… {done} │
   │ ◄── done ─────────────┤                              │
```

### 10.2 Interaction protocol

The agent needs the user — either a `write`/`destructive` tool call (runtime-injected approval) or an explicit `ask_user` invocation (agent-initiated question). The mechanics are identical past the trigger. *Built today: only the approval trigger.* The `ask_user`/question path is reserved, not wired (§7.3), so the question-specific steps below (and the `ask_user` tool_result resume) describe the intended shape, not current behaviour.

**Worker side**, on hitting a paused state:

1. INSERT a `user_interactions` row with kind, prompt, `status='pending'`.
2. UPDATE `tool_calls.status='awaiting_user'`, `agent_runs.status='awaiting_approval'`.
3. `NOTIFY conversation:<conversation_id> { type:'interaction_required', interactionId, kind }`.
4. `LISTEN` for `interaction_resolved` with that `interactionId`.

**Ingress side**, on receiving `interaction_required`:

1. Fetch the `user_interactions` row for prompt details.
2. Render: web → modal/inline card with buttons; Discord → message with reactions or buttons; voice → speak the prompt, listen for the answer.
3. The same NOTIFY reaches *every* connected ingress for that run — multi-ingress surfacing is automatic (§10.3).

**User responds** via any ingress:

1. Responding ingress writes `user_interactions.response`, `status='resolved'`, `resolved_via=<ingress>`, `resolved_at=now()` — via conditional UPDATE so only one ingress wins.
2. UPDATEs `tool_calls.status='running'` and `agent_runs.status='running'`.
3. `NOTIFY conversation:<conversation_id> { type:'interaction_resolved', interactionId }`.

**Worker** wakes from LISTEN, reads the response row, continues:

- For approvals: `approved=true` → invoke the tool; `false` → append a synthetic tool_result `{ error:'user_rejected', note }` and loop back to the model.
- For questions: feed `response` as the tool_result of `ask_user` and continue.

### 10.3 Multi-ingress surfacing

NOTIFY broadcasts to all subscribers, so a question raised during a Discord conversation can be answered in the web UI (or vice versa). First response wins:

- Whichever ingress's conditional UPDATE succeeds first owns the resolution.
- Other ingresses see `interaction_resolved`, fetch the row to see what was answered, and tear down their prompt UI.
- Race resolution is a single `UPDATE ... WHERE status='pending' RETURNING ...`. Empty return = lost the race, treat local UI as cancelled.

### 10.4 Timeouts

Interactions don't block forever. **MVP default: 1h** for the approval pause — a single `APPROVAL_TIMEOUT_MS` constant in `services/worker/src/run.ts`, deliberately shortened from the originally-planned 24h (the pg-boss job expiration sits just above it at 4500s so a parked worker outlives the timeout, §6.3). Per-tool configurability and a distinct question timeout are *intended, not yet built* — it's one constant today, and the `ask_user` question path isn't wired (§7.3). The timer is in-process; if the worker crashes the timer is lost — but so is the run (swept to `failed` on restart, §10.5), so there is nothing to leak.

The worker registers a `setTimeout` alongside the LISTEN. On fire:

- Conditional UPDATE: `SET status='timed_out', resolved_at=now() WHERE id=$1 AND status='pending'`.
- If it updated (won the race): NOTIFY `interaction_resolved`; resume the agent with a synthetic tool_result indicating timeout.
- If not: ignore — someone responded just before the timer fired.

### 10.5 Worker crash

A worker dies (OOM, deploy, host reboot). This system does **not** reconstruct in-flight runs — it fails and restarts (§7.6):

1. The crashed run is abandoned. Because `agent-run` jobs use `retryLimit: 0` (§6.3), pg-boss does not redeliver it to another worker, so there is no duplicate execution.
2. On startup the worker sweeps every non-terminal run — `pending`, `running`, and `awaiting_*` — to `failed`, cascading to their `tool_calls` and pending `user_interactions` (§10.9, invariant 4), so the UI shows an honest failure rather than a stuck "thinking…" state. The sweep is unconditional: a `pending` run whose pg-boss job *survived* the restart (a message enqueued while the worker was down) is also failed, and the later-delivered job no-ops against the terminal row — a deliberate trade (no pg-boss state check, no half-resumed runs); the owner re-issues, same as any other restart loss.
3. The owner re-issues whatever was lost.

The one accepted residue: if the crash lands *after* a side-effecting tool executed but *before* its result was recorded, a manual re-issue could repeat the action. The owner knows the restart happened, and `write`/`destructive` actions are approval-gated (§16) regardless — acceptable for a single-user system.

### 10.6 User-initiated cancellation

User clicks **Stop** in the web chat while a run is busy (Discord's `/cancel` and voice "stop" arrive with those ingresses — the route is ingress-agnostic). The flow is **route-authoritative**: the ingress writes the terminal state itself rather than asking the worker to stop, so cancellation still works when the worker is hung or dead — exactly the case where the owner most needs to free a conversation stuck behind the one-active-run index (§7.6).

1. **Route** — `POST /api/conversations/:id/cancel`. Conversation-scoped, not run-scoped: the one-active-run index makes "the active run" unambiguous, and the client doesn't reliably know the `runId` after a refresh. In one transaction it flips the active run (`pending`/`running`/`awaiting_approval`) → `cancelled` and applies the §10.9 invariant-4 cascade — non-terminal `tool_calls` → `failed`, `pending` interactions → `cancelled` — via the shared `terminateRuns` helper in `packages/db`, the same implementation the startup sweep (§10.5) calls, so invariant 4 has one writer. After commit it NOTIFYs `conversation:<id> { type:'cancelled' }` — the one `RunEvent` emitted by the webserver, never the worker (§6.2). 409 when nothing is active. The chat's busy/Stop state is refresh-proof: `GET /api/conversations/:id` reports `activeRun` and the client initializes from it.
2. **Worker abort** — each run holds an `AbortController` plus a dedicated LISTEN watcher on its conversation channel (the same dedicated-client pattern the interaction pause uses); a `{type:'cancelled'}` payload aborts the controller. The `AbortSignal` threads loop → `GeminiProvider` → the SDK's `abortSignal`, so the in-flight LLM stream dies immediately (client-side — the provider may still bill the partially generated tokens). The loop additionally checks `signal.aborted` before each turn and before each tool invoke — the "mid-run status check," event-driven instead of polled. A worker parked on an approval/question wakes from the same event: the cascade already flipped its interaction row to `cancelled`, and the aborted signal short-circuits at the next checkpoint before another model call can happen.
3. **Worker finalization** — the catch path classifies by its own `signal.aborted`: partial output is discarded (no messages persisted, matching the failed path) and a best-effort usage rollup still lands tokens/cost on the run, but the worker never touches `status`/`finished_at` — the route owns the terminal write — and emits nothing (the route's NOTIFY already told every client). Every other worker status write (the pickup flip, the done/failed finalizations, pause entry and resume, tool_call settlement, the auto-title row's finalize) is **terminal-guarded** with a per-write-site conditional `WHERE status = <expected>`, so a finish racing the cancel can never overwrite the route's terminal row; a pause-entry write that loses the race cancels its just-inserted interaction and bails instead of parking. (These are point conditionals, not the §10.9 single transition guard — that still doesn't exist.)

Worst case unchanged: a tool already executing can't be cancelled cleanly (e.g. a browser action mid-flight) — it runs to its own completion or timeout, and the abort takes effect at the next checkpoint. Interruptibility is bounded by the slowest unkillable tool — accept this; alternatives (forced thread death) are worse.

### 10.7 Errors

| Error class | Behavior |
|-------------|----------|
| LLM API transient (5xx, 429) | Retried by agent-core's `RetryProvider` decorator (wrapping `TracingProvider`, so each failed attempt is its own `llm_calls` row): up to 4 retries at 1/2/4/8s backoff, only before the first streamed event reaches the consumer — a mid-stream failure stays fatal. An abort is never retried, and the backoff sleep aborts immediately. Exhausted retries fail the run with an `llm_unavailable:`-prefixed error in `agent_runs.error`. Providers classify by throwing `TransientLlmError` (Gemini: `ApiError` 429/≥500 plus the recognized offline codes). *(Built.)* |
| LLM API permanent (4xx) | Fail run with the API's error captured in `agent_runs.error`. *(Built.)* |
| Tool error (thrown from `invoke`) | Caught by the loop; tool_result becomes `{ error:'<message>' }`. The agent sees it next turn and can adapt. *(Built.)* |
| Tool timeout | Each tool declares a default timeout, returning `{ error:'timeout' }` on exceed. Built per tool family, not as a framework: browser tools 30s per command (§8); `run_python` a 1–300s clamp (default 60s) with a process-tree kill, `pip_install` its own install timeout (§7.3). A *general* per-tool-timeout mechanism still doesn't exist — each family carries its own. |
| Cost cap | **Planned, not yet built.** Intended: a per-run cap (default $1, configurable), checked after each LLM call, failing with `error='cost_exceeded'`. Today per-call and per-run cost is *computed and recorded* (`llm_calls.cost_usd` → `agent_runs.cost_usd`, §6.5) but **never enforced** — nothing aborts a run for exceeding a budget. The layered run/objective/daily budgets (§7.7) build on this same unbuilt cap. |
| Stuck / abandoned run (worker died or hung) | Startup sweep marks any non-terminal (`pending` / `running` / `awaiting_*`) rows as `failed` on worker boot (§10.5). No dead-letter machinery — a crash means restart, and the owner re-issues. *(Built.)* |

Pattern across all of these: **fail loudly into structured rows**, never silently. The `llm_calls` table captures LLM-level detail; `agent_runs` / `tool_calls` capture run-level outcomes — all in the one Postgres. (The one row still marked *planned* above is the exception still owed: there is no cost ceiling yet.)

### 10.8 Idempotency

With fail-and-restart (§7.6, §10.5) there is no mid-run resume, so the elaborate idempotency machinery a durable model would need is out of scope. Within a *single* live run the loop still keys state on `runId` / `toolCallId` / `interactionId` rather than positional ordering, and the only concurrency guard that matters is the conditional `UPDATE ... WHERE status='pending'` that resolves the interaction race (§10.3). Cross-restart idempotency is explicitly not provided: a crashed run fails and is re-issued by the owner.

### 10.9 State machines & invariants

The three status columns (§6.1) are the correctness core of the system; every flow in §10.1–§10.8 is a transition between these states. Stating the legal transitions in one place — rather than scattering them across prose — is what catches the failure-path bugs (cancel-during-pause, timeout racing a response, restart cascade). *Intended, not yet built:* a single transition guard in the worker that all status writes route through, rejecting illegal transitions, with each illegal transition and invariant below as a test. **Today there is no guard** — `run.ts` and `boss.ts` write `status` directly (the writes are believed legal, but nothing enforces it). The tables below are therefore the *specification* the code is expected to honour, and the target for that guard when it lands (§15 step 3). *(Note: `services/CLAUDE.md` still instructs writes to "go through the single transition guard" — aspirational until the guard exists.)*

**`agent_runs.status`**

| From | Event | To |
|------|-------|----|
| *(insert)* | ingress creates the run (§9) | `pending` |
| `pending` | worker picks up the job (§10.1) | `running` |
| `pending` | user cancels before pickup (§10.6) | `cancelled` |
| `running` | loop ends with no tool call (§10.1) | `done` |
| `running` | `write`/`destructive` approval injected, or `ask_user` called (§10.2) | `awaiting_approval` |
| `running` | LLM permanent error / cost cap / context overflow (§10.7) | `failed` |
| `running` | user cancels mid-run (§10.6) | `cancelled` |
| `awaiting_approval` | all pending interactions resolved or timed out → resume (§10.2, §10.4) | `running` |
| `awaiting_approval` | user cancels during pause (§10.6) | `cancelled` |
| `pending` / `running` / `awaiting_approval` | startup sweep after crash (§10.5) | `failed` |

Terminal (absorbing): `done`, `failed`, `cancelled`.

**`tool_calls.status`**

| From | Event | To |
|------|-------|----|
| *(insert)* | model proposes the call; worker records it (§10.2) | `pending` |
| `pending` | `read`-tier / no approval needed → execute | `running` |
| `pending` | `write`/`destructive` → approval injected (§10.2, §16) | `awaiting_user` |
| `pending` | built-in `ask_user` invoked → question raised (§10.2) | `awaiting_user` |
| `awaiting_user` | approval granted (§10.2) | `running` |
| `awaiting_user` | approval denied → synthetic rejection result fed back (§10.2) | `rejected` |
| `awaiting_user` | `ask_user` answered or timed out → result returned (§10.2, §10.4) | `done` |
| `running` | tool returns | `done` |
| `running` | tool throws or times out → `{error}` fed back (§10.7) | `failed` |
| non-terminal | parent run → `failed`/`cancelled` (cascade, §10.5/§10.6) | `failed` |

Terminal (absorbing): `done`, `rejected`, `failed`.

**`user_interactions.status`**

| From | Event | To |
|------|-------|----|
| *(insert)* | run pauses for input (§10.2) | `pending` |
| `pending` | first ingress writes a response (§10.3) | `resolved` |
| `pending` | timeout sweeper fires (§10.4) | `timed_out` |
| `pending` | parent run cancelled or swept on restart (§10.5/§10.6) | `cancelled` |

Terminal (absorbing): `resolved`, `timed_out`, `cancelled`.

**Invariants**

1. **Terminal states are absorbing.** No transition leaves a terminal state, for any of the three entities. A late NOTIFY or a racing timer that targets a terminal row is a no-op.
2. **Pause coupling.** `agent_runs.status = 'awaiting_approval'` ⟺ the run has ≥1 `user_interactions` row in `pending` ⟺ ≥1 of its `tool_calls` is in `awaiting_user`. (The status name predates the `question` kind and covers both approval and question pauses — §6.1.)
3. **Resume gate.** A run leaves `awaiting_approval` only when *all* its pending interactions are terminal (see the parallel-tool-call note below).
4. **Cancel / fail cascade.** When a run enters `failed` or `cancelled`, in the same transaction every non-terminal `tool_call` of that run → `failed` and every `pending` interaction → `cancelled`. This is what prevents a swept run (§10.5) from leaving zombie `running` / `awaiting_user` tool_calls.
5. **Single exit from a `pending` interaction.** Guaranteed by the conditional `UPDATE ... WHERE status = 'pending' RETURNING` — the first writer (responding ingress, timeout sweeper, or cancel) wins; everyone else observes a terminal state and tears down their local UI (§10.3).
6. **No `running` without an owner.** A `running` (or `awaiting_*`) run implies a live worker. Because crashes do not resume (§7.6), any such row present at startup is by definition orphaned and is swept to `failed`.

**Notes & decisions this surfaced**

- **Parallel tool calls.** A single model turn may emit several tool calls, and the LLM API requires *all* their results returned together in the next turn. So a turn's calls are handled as one batch: each `write`/`destructive` call spawns its own approval, the run stays `awaiting_approval` until **all** are resolved, then approved calls execute, rejected calls return a rejection result, `read` calls execute, and all results return in one turn. This is why invariant 2 says "≥1 pending interaction," not "exactly one."
- **Orphaned tool_calls on restart** are handled by invariant 4 (the sweep cascade), not left dangling.
- **`awaiting_approval` naming** is retained for continuity with §6.1/§10; renaming to a neutral `awaiting_input` (it also serves questions) is a deferred cleanup, not a behavioural change.

---

## 16. Security & Blast Radius

An agent with browser access to the owner's email, banking, and messaging accounts is **enormously powerful and enormously dangerous**. A prompt injection from an email body, a Slack message, or a webpage the agent reads could instruct it to forward the inbox, send messages, or move money.

**Principles baked into the architecture from day one**

- **Tools declare a trust tier**: `read`, `write`, `destructive`. The agent runtime treats each differently.
- **Read by default**: `write` and `destructive` tools trigger a runtime-injected approval interaction (§6) *before* the tool runs. The owner sees the proposed action with full args, clicks ✅/❌ in the web UI or reacts in Discord, and only then does the worker invoke the tool. Rejection short-circuits with a structured error the agent can read.
- **The trust tier is the *default*, owner-overridable per tool.** The tier (above) decides whether a tool asks by default; the owner can override that per tool from the web **Tools page**, persisted in the `tools` table (`require_approval`, a tri-state — `null` = tier default, `true` = always ask, `false` = never ask). The worker reads these per run to build its approval predicate. The catalog the page lists is published to the `tools` table by the worker at boot from its live tools (so it can't drift, and covers MCP tools too). Within a run, an *enabled* gate still gets the group-scoped approval treatment (first prompt, rest auto-approved).
- **Destructive actions** (sending money, mass-delete, "send to all") require approval by default. **This is now an owner-overridable default, not a hard invariant** (a deliberate change from the original "always require approval, regardless"): the owner may disable approval even for a `destructive` tool from the Tools page, the owner's box and the owner's risk. The web UI's one guard rail is a confirm prompt before disabling approval on a destructive tool; the worker and API enforce no destructive-specific lock.
- **Per-integration scoping**: the Gmail tool exposes `read`/`draft`/`label` as `read`-tier and `send` as `write`-tier — same MCP server, different per-tool tiers.
- **Same machinery, different trigger** *(approvals built; questions planned)*: structured questions (agent calls `ask_user`) are *designed* to reuse the same `user_interactions` table and ingress surfacing as approvals — one flow for both. Only the approval trigger is wired today; `ask_user` is not yet built (§7.3).
- **Auditable trail**: every tool invocation logged in `tool_calls`; every owner decision logged in `user_interactions` with timestamp and ingress used. Together they are the audit log.
- **Trust tiers are owner-assigned, never server-declared.** Built-in tools declare their tier in code (§7.3); MCP-sourced tools are config-mapped with a safe default — the system never trusts an MCP server's own claim about how dangerous its tools are. A compromised or careless server cannot self-promote to `read`.
- **Per-tool tiers gate *semantic* tools, not the browser.** Trust-tier approval works for semantic tools whose name *is* the intent — a future Gmail `send` is `write`, so it pauses for ✅. It is **insufficient for the browser**: its primitives (`click`/`type`) are mechanical, and the danger lives in the *page*, not the tool. Gating `click` as `read` is unsafe (one click can send money); gating it `destructive` means approving every click — approval fatigue, and the card can't show real intent. So the browser is **not** contained by per-click tiers.
- **The browser's containment is structural**: separate browser profiles (untrusted-reading vs. trusted-action), sensitive-domain gating, and task-scoped approval (one approval for an objective, not per primitive). This is the deferred real answer — **not yet built**. As the step-5 (§8) stopgap, every browser tool is `write`-tier so each action pauses for approval (accepting approval fatigue), and the embedded bridge is contained by a loopback bind + a `chrome-extension://` Origin guard rather than the structural measures. See §8.

This is the actual hard problem — the architecture should make it easy to enforce, not the other way around.
