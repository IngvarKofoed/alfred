# Lightweight observability + a debug page

Capture what Alfred is doing — per agent run and per LLM call — into Postgres, and surface it in a `/debug` page in the web app that's built to grow into the home for dev/admin tooling. A `TracingProvider` decorator wraps any `LlmProvider`, records each `stream()` call (model, request, response, tokens, latency, errors) to a new `llm_calls` table, and the page lists recent runs with drill-down. No Langfuse — this stays in our own Postgres, consistent with no-Docker / minimal / "your data, your house".

Grounded in `docs/ARCHITECTURE.md` §6 (data; §6.5 and §17 Langfuse lines now revisited), §7 (provider abstraction), §11 (web), `docs/DATABASE.md`, and the existing `agent-core` / `db` / `worker` / `webserver` / `web` code.

## Key decisions

- **`TracingProvider` decorator** (new, `packages/agent-core`). Wraps any `LlmProvider`; times each `stream()`, accumulates the response text, captures usage, and fires `onTrace(trace)` in a `finally` (so failed calls are traced too). The loop is **unchanged** — observability is cross-cutting and works for every future provider.
- **A terminal `usage` `StreamEvent`** (extends `agent-core`). `GeminiProvider` emits `{ type: 'usage', model, promptTokens?, completionTokens?, finishReason? }` from Gemini's final chunk (`usageMetadata`). The loop is updated to switch on `ev.type` explicitly and **ignore** unknown events (today it treats any non-text event as a tool call) — so `usage` passes through harmlessly.
- **New `llm_calls` table** (new, add to `DATABASE.md`). One row per `stream()` call, FK → `agent_runs`: `model`, `request` jsonb (messages sent), `response_text`, `prompt_tokens`, `completion_tokens`, `finish_reason`, `latency_ms`, `error`, `created_at`. The detail that makes a trace useful, kept out of `agent_runs` itself.
- **Roll up onto `agent_runs`** (extends). On run completion the worker sums `llm_calls` tokens into the existing `prompt_tokens`/`completion_tokens` columns and sets `agent_runs.model`. `cost_usd` stays `0` — see below.
- **Tokens now, `$` cost later** (diverges from `DATABASE.md`'s `cost_usd` intent). Capture token counts; defer dollar cost — a per-model price map drifts and isn't needed for the overview. `cost_usd` stays a reserved column.
- **Worker wires the decorator** (extends `services/worker`). `new TracingProvider(deps.provider ?? new GeminiProvider(), persistLlmCall)`. The loop sees a plain `LlmProvider`; persistence lives in the worker.
- **`/debug` page on `react-router`** (new, `clients/web`). Introduce `react-router-dom` (§11 planned it): chat at `/`, debug at `/debug`, a header nav between them. The debug page is laid out as panels so future tooling drops in alongside the runs panel.
- **Debug read API on the webserver** (new). `GET /api/debug/runs` (recent runs overview) and `GET /api/debug/runs/:id` (run + its `llm_calls`). Read-only; same network-position access as everything else.

## Goals

- See, per run and per call: model, the prompt sent, the response, token usage, latency, finish reason, and any error.
- An at-a-glance `/debug` overview of recent runs with one-click drill-down.
- A reusable, extensible home in the web app for future dev/admin tooling.
- Zero changes to the agent loop's behavior; no new infra or external service.

## Non-goals

- Langfuse (self-hosted or cloud) — explicitly replaced by this.
- `$` cost computation — tokens only for now.
- Charts/metrics dashboards, aggregations, alerting.
- Retention/pruning of `llm_calls` — single-user volume is low; revisit if it grows.
- Live sub-second tailing — the page polls / has a refresh button.
- Auth on `/debug`, and tracing tool calls (no tools yet; `tool_calls` arrives with tools).

## Design

### Schema (`packages/db`, new migration + `DATABASE.md`)

```
llm_calls
  id                 uuid pk (uuidv7)
  agent_run_id       uuid fk → agent_runs.id
  model              text
  request            jsonb        -- the Message[] sent to the provider
  response_text      text
  prompt_tokens      int  default 0
  completion_tokens  int  default 0
  finish_reason      text         -- nullable
  latency_ms         int
  error              text         -- nullable
  created_at         timestamptz default now()
  index (agent_run_id, created_at)
```

### agent-core

- `types.ts`: add the `usage` variant to `StreamEvent` (carries `model` + token counts + `finishReason`).
- `providers/gemini.ts`: after the stream, emit one `usage` event from the last chunk's `usageMetadata` / `finishReason`, tagged with the resolved model.
- `loop.ts`: change the event handling to `if (ev.type === 'text') … else if (ev.type === 'tool_call') …` — anything else (e.g. `usage`) is ignored.
- `tracing.ts` (new): `class TracingProvider implements LlmProvider`, constructed with an inner provider and an `onTrace(trace: LlmTrace) => Promise<void>`. `LlmTrace = { model, request: Message[], responseText, promptTokens?, completionTokens?, finishReason?, latencyMs, error? }`. It re-yields the inner stream untouched, accumulating `responseText` and the `usage` event, and calls `onTrace` in `finally`.

### worker (`services/worker`)

`runJob` wraps the provider: `new TracingProvider(base, (t) => db.insert(llmCalls).values({ agentRunId: runId, ...t }))`. After `runAgent`, sum the run's `llm_calls` tokens into `agent_runs` and set `agent_runs.model`. (Update the existing worker test's cleanup to delete `llm_calls` before `agent_runs` — FK order.)

### webserver (`services/webserver`)

- `GET /api/debug/runs?limit=50` → recent `agent_runs` (id, conversationId, status, model, startedAt, finishedAt, prompt/completion tokens, derived duration), newest first.
- `GET /api/debug/runs/:id` → the run plus its `llm_calls` (request, response_text, tokens, latency, error). uuid-validated like the other routes.

### web (`clients/web`)

Add `react-router-dom`. `App` becomes a router with a small header nav:
- `/` → `Chat` (today's chat UI, extracted into a component).
- `/debug` → `Debug`: fetches `/api/debug/runs` (a scannable table — time, status pill, model, duration, tokens), and selecting a run loads `/api/debug/runs/:id` to show its calls — each expandable to the full prompt (messages) and response. A manual **Refresh** button (+ optional light auto-poll). Built as panels so future tools slot in next to "Runs".

### Verification

- **agent-core unit test** (offline): a fake inner provider that yields text then a `usage` event; assert `TracingProvider` re-yields everything and calls `onTrace` once with the right `responseText`, token counts, and `latencyMs ≥ 0`.
- **worker test** (existing, Postgres-gated): now also asserts an `llm_calls` row was written and `agent_runs` token aggregates updated; cleanup deletes `llm_calls` first.
- Manual: chat, open `/debug`, see the run with its model, tokens, latency, and the exact prompt/response.
- Build, lint, existing tests stay green.

## Open questions

None — chosen during review: `TracingProvider` decorator + `usage` event; new `llm_calls` table with `agent_runs` roll-up; tokens now / `$` deferred; `react-router` for the page; poll/refresh (no live tailing).

## Follow-up doc edits (after sign-off)

- `ARCHITECTURE.md` §6.5 — the "LLM request/response logs → Langfuse" row becomes "→ `llm_calls` in Postgres".
- `ARCHITECTURE.md` §17 — the "self-hosted Langfuse from day one" resolved decision is replaced by "lightweight in-Postgres observability; Langfuse reconsidered and rejected (Docker/infra/privacy)".

## Alternatives considered

- **Worker records around the call.** The worker can't see the individual `provider.stream()` calls *inside* the loop, so it would need a wrapper anyway — the decorator is that wrapper, done cleanly.
- **`agent_runs`-only (no `llm_calls`).** Loses per-call request/response detail, which is the point of a trace.
- **Langfuse (self-host / cloud).** Self-host drags in ClickHouse + Redis + Docker (vs no-Docker/minimal); cloud ships personal prompt/response data off-box (vs the privacy principle). Rejected.
