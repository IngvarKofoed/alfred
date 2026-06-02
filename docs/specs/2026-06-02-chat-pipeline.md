# Chat pipeline — agent-core end to end (text-only)

Wire the existing `packages/agent-core` into a real, usable chat: type in the web client → the message is persisted and a job enqueued → an `alfred-worker` runs the Gemini loop → tokens stream back over Postgres `LISTEN/NOTIFY` → an SSE endpoint forwards them → the browser renders them live → the assistant reply is persisted. **Text-only** this step — no tools, no approval, no `tool_calls`. This is the first time the worker, pg-boss, NOTIFY-streaming, and persistence come together.

Grounded in `docs/ARCHITECTURE.md` §5 (topology), §6 (data + NOTIFY), §9 (ingresses), §10 (runtime flows), §7.6 (concurrency/crash), `docs/DATABASE.md`, and the existing `packages/agent-core` / `packages/db` / `packages/shared` / `services/webserver` / `clients/web`.

## Key decisions

- **New `alfred-worker` service** (new). A pg-boss consumer that runs the agent loop. Added to `ecosystem.config.cjs` as a second process; the bridge-vs-worker split (§5) isn't relevant yet, but webserver-vs-worker is — the webserver only enqueues.
- **pg-boss lives in `packages/db`** (new). It's Postgres infra sharing `POSTGRES_URL`; a `getBoss()` singleton + the `'agent-run'` job name (`{ runId }`) live next to the Drizzle client. Jobs use **`retryLimit: 0` + a long `expireInSeconds`** (fail-and-restart, §7.6/§6.3) — no auto-redelivery, no duplicate runs.
- **Streaming over `LISTEN/NOTIFY`, channel `conversation:<id>`** (new, §6.2/§10.3). The worker `pg_notify`s small JSON events; the webserver SSE endpoint `LISTEN`s and forwards. Events: `{type:'token',text}` | `{type:'done'}` | `{type:'error',message}` (a subset of §6.2 — tool/interaction events arrive with tools).
- **`agent_runs` table added per `DATABASE.md`** (extends). Full columns as documented, but only `pending→running→done→failed` statuses are used now (`awaiting_*` arrives with tools). Includes the **one-active-run-per-conversation** partial unique index (§7.6).
- **`messages.content` stores the agent-core `ContentPart[]`** (new). This is the mapping layer deferred in step 3: the webserver writes the user message, the worker writes the assistant message, both as `ContentPart[]` jsonb.
- **Single owner user, fixed id, ensured on boot** (new). Resolves the seeding deferred in step 2: a constant `OWNER_USER_ID` upserted (`ON CONFLICT DO NOTHING`) at webserver startup, so `conversations.user_id` always resolves.
- **Hand-rolled SSE; web client uses `EventSource`** (diverges from §11's `useChat` plan). The NOTIFY/SSE token stream is our own protocol, so `@ai-sdk/react useChat` wouldn't fit cleanly; a built-in `EventSource` reader keeps the no-framework stance (§7.1) with zero new deps.
- **Worker takes an injectable provider** (new). `runJob(runId, { provider })` defaults to `GeminiProvider` but accepts a fake one, so an automated test drives the full worker→persistence path with no API key.

## Goals

- A working chat end to end: browser ↔ tailnet ↔ webserver ↔ pg-boss ↔ worker ↔ Gemini, streaming live.
- The conversation persisted (`messages`) with run records (`agent_runs`).
- Crash behavior per fail-and-restart: orphaned `running` runs swept to `failed` on worker boot; one active run per conversation.
- An automated test of the worker loop + persistence using the fake provider (no key needed).

## Non-goals

- Tools, `tool_calls`, approvals, `ask_user`, the interaction state machine — next step.
- Cancellation and timeouts (§10.4/§10.6) — arrive with interactions.
- NOTIFY replay/outbox — tokens emitted before a client's `LISTEN` are lost; the DB still has the final message (§6.2 gap, accepted for now).
- Conversation list / switching UI, multi-worker scaling, durable mid-run resume.
- Persona assembly (§7.5) — a single minimal hardcoded system message for now.
- Cost/token accounting population (columns exist, left at defaults).

## Design

### Schema (`packages/db`)

New migration adds `agent_runs` exactly as `DATABASE.md` specifies (incl. the partial unique index on `(conversation_id) where status in ('pending','running','awaiting_approval')`). `tool_calls`/`user_interactions`/`memory_facts` stay unbuilt. The mapping helpers `toAgentMessages(rows)` / `contentToJson(parts)` convert between `messages` rows and agent-core `Message[]`.

### Job queue (`packages/db/src/boss.ts`)

`getBoss()` lazily constructs `new PgBoss(POSTGRES_URL)` and `start()`s it (pg-boss auto-creates its `pgboss` schema). Enqueue: `boss.send('agent-run', { runId }, { retryLimit: 0, expireInSeconds: 60 * 60 })`. The worker calls `boss.work('agent-run', handler)`.

### Worker (`services/worker`)

On boot: `getBoss().start()`, then a **startup sweep** — `UPDATE agent_runs SET status='failed', error='orphaned' WHERE status='running'` (a run in `running` with no live worker is dead). Then `boss.work('agent-run', ([job]) => runJob(job.data.runId))`.

`runJob(runId, deps)`:
1. Load the run; if status ≠ `pending`, return (idempotent — already handled).
2. `UPDATE` status `running`, `started_at=now()`.
3. Load the conversation's `messages` (ordered), map to agent-core `Message[]`, prepend a minimal system message.
4. `runAgent({ provider: deps.provider ?? new GeminiProvider(), tools: [], messages, onText })` — `onText` does `SELECT pg_notify('conversation:'||$id, '{"type":"token",...}')` per delta.
5. On success: insert the assistant `messages` row (the final assistant `ContentPart[]`), `UPDATE` status `done`/`finished_at`, `pg_notify {type:'done'}`.
6. On throw: `UPDATE` status `failed`/`error`, `pg_notify {type:'error',message}`. (Tool errors don't apply — no tools.)

### Webserver (`services/webserver`) — new routes

- `POST /api/conversations/:id/messages` `{ text }`: in one transaction — upsert the conversation (`ingress='web'`, `channel_key=:id`, `user_id=OWNER_USER_ID`), insert the user message, insert an `agent_runs` row (`pending`, `trigger_message_id`). The one-active-run index makes a concurrent send fail → return `409` ("Alfred is busy"). After commit, `boss.send`. Returns `{ runId }`.
- `GET /api/conversations/:id/messages`: the persisted history (so a refresh restores the thread).
- `GET /api/conversations/:id/stream`: SSE via Hono `streamSSE`. Acquires a dedicated `pg` client, `LISTEN "conversation:<id>"`, forwards each notification as an SSE event, and releases the client on disconnect.

### Web client (`clients/web`)

The stub becomes a chat: a message list (user/assistant bubbles), a text input, and a streaming assistant bubble. A `conversationId` (uuid) is kept in `localStorage`. On mount: load history (`GET …/messages`) and open the SSE stream (`EventSource …/stream`). Send: optimistically append the user message, `POST …/messages`, and append SSE `token`s to the in-progress assistant bubble until `done`. Hand-rolled, ~a page of code; Tailwind for the bubbles.

### State machine (minimal subset of §10.9)

`agent_runs`: `pending → running → done | failed`; startup sweep `running → failed`. The partial unique index is the only concurrency guard. No `awaiting_*`, no cancellation — those land with tools/interactions.

### Verification

- **Automated** (`services/worker`, gated on `POSTGRES_URL` like the db test): seed a conversation + user message + `pending` run, call `runJob` with a **fake provider** scripted to stream `"hello"`, assert the assistant message persisted and the run went `done`. Proves worker + persistence + loop wiring with no API key.
- **Manual e2e** (needs `POSTGRES_URL` + `GEMINI_API_KEY`): start Postgres, migrate, run worker + webserver, open the app, chat → a streaming Gemini reply. Flagged: the real model leg needs the key.
- Build, lint, and existing tests stay green.

## Open questions

None — resolved during review: streaming is hand-rolled with the browser `EventSource` API over our NOTIFY→SSE protocol (no `@ai-sdk/react`).

## Alternatives considered

- **C (full, incl. tools/echo end to end).** Adds `tool_calls`, tool execution in the worker, and the approval/trust-tier interaction machinery (§10.9) all at once. Rejected for this step — the approval/interaction layer is a large separable increment; text-only proves the transport first.
- **B (curl-first, no chat UI).** Same backend, proven via `curl` on the SSE endpoint. Rejected — the UI is the interesting milestone and is only ~a page of code.
- **Webserver calls Gemini directly (skip worker/pg-boss).** Simpler, but throws away the ingress/worker separation the whole architecture rests on and would be rebuilt immediately. Rejected.
