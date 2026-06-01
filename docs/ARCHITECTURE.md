# Alfred — Architecture

A personal AI agent platform. A single always-on agent the owner can talk to from any device (web, Discord, voice), with access to a real browser carrying their real logins, and a tool ecosystem that grows over time.

Date: 2026-05-30
Status: Initial design, pre-implementation

---

## 1. Goals & Constraints

**Functional goals**

- **One agent identity** (memory, personality, tools), reached via **many concurrent conversations** from any device. There is no single forever-running agent process — the worker spins up a run for each job. State (memory, history) is shared; runs are discrete.
- Multiple **interactive ingresses**: web/PWA (chat), Discord (chat), native app (chat + hands-free voice).
- **Autonomous triggers** (post-MVP): scheduled jobs, inbox watchers, webhooks. Architecturally a fourth ingress category — they enqueue jobs without a human at the other end and may push notifications when done.
- **Hands-free voice on the native app only.** No voice on the web PWA in v1.
- Many integrations over time: email, messaging, calendar, browser, etc.
- The agent uses a real browser with the owner's real logins (Gmail, banking, etc.) — automation must be undetectable to modern bot defenses.

**Non-functional constraints**

- Single user (the owner). No multi-tenant concerns.
- Self-hosted on a home server. No cloud VPS for the core platform.
- **OS-agnostic**: the stack must run on Linux, macOS, or Windows natively. No OS-specific dependencies in the core.
- **Pluggable LLM provider.** Default path is **OpenRouter** for multi-vendor access, but the agent core depends on a thin provider abstraction so direct Anthropic / OpenAI / Gemini / local Ollama can be swapped in by config without touching agent code.
- Minimal moving parts. No infra component included "in case we need it later."

**Explicit non-goals (for now)**

- Multi-agent orchestration. Start with a single agent with many tools.
- Public exposure / sharing with other people.
- Native mobile apps. PWA covers the mobile surface.

---

## 2. High-Level Architecture

OS-agnostic view. The same shape runs on Linux, macOS, or Windows — only filesystem paths and the process-supervisor registration differ. Windows-as-server notes are in §4.1.

```
External clients
─ web browsers / PWA (chat)
─ Discord (chat, via Discord's servers)
─ native iOS app (chat + hands-free voice, post-MVP)
        │
        │  Tailscale (encrypted, no public exposure)
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Home server (any OS)                                                  │
│                                                                       │
│  Chrome (owner profile + extension)                                   │
│        │ WebSocket                                                    │
│        ▼                                                              │
│  Browser bridge ─────── MCP (HTTP+SSE) ──────────────┐                │
│                                                       │                │
│  Postgres                                             │                │
│  ├─ state (conversations, memory, approvals)          │                │
│  ├─ job queue (pg-boss)                               │                │
│  └─ pub/sub (LISTEN / NOTIFY)                         │                │
│        ▲                                              │                │
│        │  enqueue / stream                            ▼                │
│        │                                       Agent worker(s)         │
│  Ingresses (interchangeable):                  ├─ hand-rolled loop     │
│  ├─ Hono webserver (PWA chat, SSE)             ├─ Provider abstraction │
│  ├─ Discord bot                                │   (OpenRouter, …)     │
│  ├─ Voice orchestrator (native app, post-MVP)  └─ Tool interface       │
│  └─ Triggers (cron/inbox/webhook, post-MVP)        ├─ MCP-sourced      │
│                                                    └─ built-in        │
└──────────────────────────────────────────────────────────────────────┘
                                                       │
                                                       ▼
                                       LLM providers (OpenRouter, etc.)
                                       Other MCP servers (Gmail, Calendar, …)
```

**Core idea: ingresses are interchangeable.** The agent worker doesn't know or care whether a job came from the browser, Discord, voice, or a trigger. Each ingress translates its channel's protocol into "submit job, stream output back." Adding a new interface later reuses the same pattern.

**Second core idea: tools are interchangeable.** The agent calls tools through a single internal interface (§7). Whether a tool is exposed by an MCP server (browser, Gmail) or implemented as a built-in function (a simple `now()`), the agent doesn't see the difference.

---

## 3. The Home Server

**Hardware**: any always-on box at home — Mac mini, small Intel NUC, or a repurposed PC/laptop. The stack is OS-agnostic and runs the simplest native way on whatever box the owner has; only the process-supervisor registration and a few filesystem paths differ by OS. (The owner's current box is a Windows machine, developed against from a Mac.)

**Why a home box (not a VPS)**

- Same home IP as the owner's daily browsing → far fewer "new device" challenges from Gmail, banks, etc.
- 2FA setup is trivial because the owner's phone is nearby.
- Browser sessions persist for months because nothing looks suspicious to services.
- Owner's most sensitive credentials never leave the house.
- Pays for itself vs. a VPS in ~12 months.

**Remote access**: **Tailscale**. The server has no public exposure; any client device joins the tailnet and reaches the server over encrypted private IPs.

---

## 4. Deployment & OS

The architecture is OS-agnostic. The same code runs on any of three deployment targets; OS choice is a hardware/practical decision, not an architectural one.

| Target | Process supervisor | Browser host | Notes |
|--------|--------------------|--------------|-------|
| **Linux** (NUC, mini-PC, repurposed laptop) | pm2 (or systemd) | native Chrome on the same Linux box | Cleanest setup. No filesystem boundaries. |
| **macOS** (Mac mini, old iMac) | pm2 (or launchd) | native Chrome on macOS | Quiet, low-power, "appliance" feel. |
| **Windows** | pm2 (or Task Scheduler) | native Chrome on Windows | Runs natively — no WSL2. See §4.1. |

The stack itself (Node, Postgres, pg-boss, the apps) is identical across targets. Only the supervisor configuration and a few filesystem paths differ.

### 4.1 Windows-as-server notes

Only relevant if the box is Windows. The stack runs **natively** on Windows (Node + pnpm + pm2) — no WSL2, no DrvFS boundary, no relay. Develop on whatever machine (the owner's is a Mac); deploy the built stack to the Windows box. A few host settings make a desktop OS behave like a server:

- Power: sleep set to "Never" on AC; display can sleep.
- Auto-login enabled (the Chrome session, later, needs a logged-in desktop).
- Lock screen disabled on idle.
- Windows Update active hours configured to never reboot mid-day.
- Defender exclusions for the project directory and Chrome's working dirs.

---

## 5. Process Topology

All processes are native (no Docker). Managed by **pm2** — the same process supervisor on Linux, macOS, and Windows. One config file (`ecosystem.config.js`) defines every process; one command (`pm2 start ecosystem.config.js`) brings everything up; `pm2 startup` registers pm2 itself with the host's init system (systemd on Linux, launchd on macOS, Task Scheduler on Windows) so everything survives reboot.

| Process | Language | Role | Restart policy |
|---------|----------|------|----------------|
| `postgres` | — | State, job queue, pub/sub | Auto-start via OS package manager; not under pm2 |
| `alfred-webserver` | Node/TS | Browser ingress, serves PWA, SSE | Restart on failure |
| `alfred-worker` | Node/TS | Agent execution loop | Restart on failure |
| `alfred-browser-bridge` | Node/TS | MCP server + WS server for Chrome extension | Restart on failure |
| `alfred-discord` | Node/TS | Discord ingress | Restart on failure |
| `alfred-voice` | Node/TS | Voice orchestrator (native-app surface, post-MVP) | Restart on failure |
| `alfred-triggers` | Node/TS | Scheduler / event-source ingress (post-MVP) | Restart on failure |

Each is its own pm2-managed process so a crash in one doesn't take the others down. The bridge is intentionally split from the worker so the extension's WebSocket survives worker restarts.

Deploy: `git pull && pnpm install && pnpm build && pm2 reload ecosystem.config.js`.

Postgres is installed via the host's package manager (apt/brew/the official Windows installer) and managed by the OS, not by pm2 — data services benefit from the OS's mature service infrastructure, while application processes benefit from pm2's portability.

**Alternatives** (if pm2 ever stops fitting): each target's native supervisor — systemd unit files on Linux, launchd plists on macOS — works fine and is what pm2 ultimately delegates to. pm2 is the simplest cross-platform default; native supervisors are the optimization if you outgrow it.

---

## 6. Data Layer

**Postgres only.** No Redis. Postgres does triple duty:

1. **State** — conversations, messages, runs, tool calls, approvals, memory.
2. **Job queue** — via **pg-boss**. Ingresses enqueue jobs; the worker consumes them.
3. **Streaming pub/sub** — via Postgres `LISTEN` / `NOTIFY`. The worker `NOTIFY`s progress on a per-run channel; ingresses `LISTEN` and forward to their clients.

**Why no Redis**

- pg-boss + LISTEN/NOTIFY covers everything Redis would do for this scale.
- One fewer service to install, monitor, back up.
- Pub/sub volume is tiny (one user, streamed text tokens) — Postgres handles it without effort.

**ORM**: **Drizzle**. TS-native, schema-in-code, generates migrations via Drizzle Kit. Lives in `packages/db`.

**Vector storage** (post-MVP): **pgvector** extension in the same Postgres instance. No separate vector DB.

### 6.1 Schema

The column-level data model — every table, column, index, and the interaction prompt/response shapes — lives in **`docs/DATABASE.md`**, kept separate so this document stays readable at session start. The `status` columns are governed by explicit state machines in §10.9.

Topology only (see `DATABASE.md` for columns):

- `users` — single owner row; schema is multi-user-ready.
- `conversations` — one per ingress channel (`web` / `discord` / `voice` / `trigger`); unique on `(ingress, channel_key)`.
- `messages` — `jsonb` content (text, attachments, tool-use, tool-result blocks).
- `agent_runs` — one per job; carries status, model, and token/cost accounting. A partial unique index enforces **one active run per conversation** (§7.6).
- `tool_calls` — one per invoked tool; carries `trust_tier` and status.
- `user_interactions` — the generic pause-for-user table (`approval` / `question`); the record of every owner decision.
- `memory_facts` — post-MVP placeholder; `embedding` column unused until pgvector (§6.4).

`agent_runs` + `tool_calls` + `user_interactions` together are the audit log — there is no separate `audit_log` table.

### 6.2 NOTIFY channels and payloads

Channel naming:

- `run:<run_id>` — progress stream for a single agent run. Each ingress LISTENs on the run it enqueued.

Payload schema (JSON, sent via `pg_notify`):

```ts
type RunEvent =
  | { type: 'token';                  text: string }
  | { type: 'tool_call_start';        toolCallId: uuid; toolName: string; args: object }
  | { type: 'tool_call_end';          toolCallId: uuid; result: object }
  | { type: 'interaction_required';   interactionId: uuid; kind: 'approval' | 'question' }
  | { type: 'interaction_resolved';   interactionId: uuid }
  | { type: 'done' }
  | { type: 'error';                  message: string }
```

Postgres `NOTIFY` payloads have an **8000-byte limit**. Tokens are tiny; full tool results and interaction prompts/responses are *not* sent inline — events reference IDs and consumers `SELECT` the rows if they want the full payload. This keeps the channel cheap and makes the DB the source of truth.

Ingresses subscribe to `run:<run_id>` to forward `token`s and to know when to render an interaction UI (`interaction_required` → fetch the row, show the prompt to the user) or close it (`interaction_resolved` → tear down the prompt).

### 6.3 Job queue (pg-boss)

pg-boss owns its own schema (`pgboss`) and we treat it as a black box. Job payloads are deliberately minimal:

```ts
type AgentJob = { runId: uuid }
```

The `agent_runs` row carries everything else (conversation, trigger message, status). Reasons:

- A job pulled but not yet acknowledged can be reconstructed entirely from the run row.
- Schema migrations don't ripple through queued job payloads.
- pg-boss retries are idempotent: the worker checks `agent_runs.status` and skips runs that already finished.

The worker calls `boss.work('agent-run', handler)` with a concurrency setting; pg-boss handles fetching and locking. Because a handler blocks in place while a run is paused for user input (§10.2), `agent-run` jobs are registered with **`retryLimit: 0`** and a **job expiration longer than the max interaction timeout** (§10.4): a parked worker is never redelivered to a second worker (no duplicate execution, §7.6), and a genuinely lost run simply fails rather than silently re-running. Recurring jobs (cron-style triggers, post-MVP) use pg-boss's `schedule()` API.

### 6.4 Memory (post-MVP placeholder)

The `memory_facts` table exists from day one with an unused `embedding` column. Reasons to define it early:

- Forces us to think about *what* gets remembered (manually inserted by the agent? auto-extracted from runs?) before we paper over the question with embeddings.
- Lets the agent loop have a `memory.read(scope)` tool from MVP that just returns plain rows, no vector search — useful even without embeddings.
- pgvector activation later is a single migration (`CREATE EXTENSION vector`) + a vector index, no schema change.

Open: extraction strategy (LLM-summarized after each run? user-flagged "remember this"?). Decided when memory becomes the active build target.

### 6.5 What's NOT in the database

| Thing | Where | Why |
|-------|-------|-----|
| API keys / secrets (OpenRouter, Discord, ElevenLabs, …) | `.env` file, OS keychain | DB compromise should not leak credentials |
| Large attachments (images, PDFs, audio) | Local filesystem under `data/attachments/`, referenced by path | Postgres is bad at large blobs; FS is fine and backs up trivially |
| Chrome browser profile | Wherever the OS puts it; backed up separately | Owned by Chrome, not us |
| Langfuse traces | Langfuse's own Postgres database (same server, separate DB) | Their schema, their problem |
| LLM responses' full request/response logs | Langfuse | Already captured there; no value duplicating |

---

## 7. Agent Core

The agent core lives in `packages/agent-core` and has three load-bearing pieces:

1. A **hand-rolled agent loop** (no framework dependency).
2. A **provider abstraction** for LLM access.
3. A **tool interface** that unifies MCP-sourced and built-in tools.

### 7.1 Agent loop (hand-rolled)

The loop is small enough to own — ~300–500 lines of TypeScript — and the cost of owning it is paid back in transparency and control. Sketch:

```
loop:
  response = provider.stream(messages, tools)
  for each chunk in response:
    if chunk is text:       emit token (NOTIFY)
    if chunk is tool_call:  invoke via tool interface; append result to messages; continue
  if response ended with no tool_call: done
```

No framework wrapper sits between us and the model. Streaming, tool-call parsing, conversation-history management, retries, cancellation — all explicit in our code. Trade-off: a few hundred more lines than `import { generateText } from 'ai'`, but every behaviour is inspectable and modifiable.

### 7.2 Provider abstraction

A thin interface inside `agent-core` wraps the underlying model client. The default implementation talks to **OpenRouter** via the OpenAI-compatible API. Alternative implementations (direct Anthropic, direct OpenAI, direct Gemini, local Ollama) plug in behind the same interface. Provider selection is a config/env decision, not a code change.

```ts
interface LlmProvider {
  stream(messages, tools, options): AsyncIterable<TokenOrToolCall>
}
// implementations: OpenRouterProvider, AnthropicProvider, GeminiProvider,
//                   OllamaProvider, ...
```

Optionally **LiteLLM** can sit in front of all of them as a proxy for unified logging and provider fallback, but it's optional — the in-process abstraction is what matters.

### 7.3 Tool interface

All tools, regardless of origin, look the same to the agent loop:

```ts
interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema           // for the model
  trustTier: 'read' | 'write' | 'destructive'   // see §16
  invoke(args: unknown): Promise<ToolResult>
}
```

Tools come from two sources, both adapted to this interface:

- **MCP-sourced tools** — the agent core opens MCP client connections (stdio for local subprocess servers, HTTP+SSE for long-running ones like the browser bridge) at startup. Each MCP server's `tools/list` response is converted into `Tool` objects whose `invoke` proxies to the MCP server via `tools/call`. The agent loop never sees MCP — it just sees `Tool`s.
- **Built-in tools** — implemented as `Tool` directly inside `agent-core`. Used for trivial utilities (current time, sleep, arithmetic) and for tools that must integrate tightly with the runtime — most notably **`ask_user`**, the structured-question tool (mirrors `AskUserQuestion`-style prompts). Its `invoke()` creates a `user_interactions` row of kind `question`, pauses the run, and resumes when the user responds. The agent calls it like any other tool; the runtime handles the pause/resume mechanics. See §6.1 for the prompt/response shape.

This means:
- Adding a rich integration (Gmail, Calendar, browser) = spin up an MCP server, register it in config, agent picks up its tools automatically.
- Adding a tiny utility = add a built-in `Tool`, no extra process.
- Swapping an MCP-backed tool for a built-in (or vice versa) is invisible to the agent loop.

**MCP transport choices**:

- `browser-bridge` uses **HTTP+SSE** so it can outlive worker restarts (§8).
- Other MCP servers can use **stdio** (launched as subprocess by the worker) if they don't need to be long-lived. Simpler lifecycle.

### 7.4 Other agent-core concerns

- **Cost/latency routing** (later): use a fast cheap model (Haiku / Gemini Flash / Groq-hosted Llama) for routing and chitchat, a strong model (Opus / GPT / Sonnet) for hard reasoning. With the provider abstraction this is one config knob.
- **Concurrency**: Node's async event loop. Each agent run is a coroutine; one worker process handles many concurrent runs because the work is overwhelmingly I/O-bound. Scale horizontally by adding more workers — multiple pg-boss consumers on the same queue. Serialization (one run per conversation) and physical-resource ownership (the browser lease) are defined in §7.6; correctness does not depend on worker count.

### 7.5 Conversation lifecycle & persona

A run's context is assembled fresh every invocation. The agent has no in-process state between runs — everything that matters lives in Postgres.

**Persona** — a single global file at `packages/agent-core/personas/alfred.md`, loaded into a string at process boot. Plain markdown. Identifies the agent as Alfred and the owner as Ingvar; names tool families; sets defaults for tone, response length, when to ask vs. assume.

**Per-run context assembly** — when the worker picks up a job, it builds the model input as:

```
[system]    global persona  +  identity block (current time, ingress, user)
[summary]   (optional) prior-context summary, if history was truncated
[history]   recent messages from the conversation, in order
[tools]     Tool definitions (name + description + JSON schema)
```

**History strategy (MVP)** — send the full history, fail loudly if it doesn't fit:

- Default: every message in the conversation, in order, sent verbatim to the model.
- If full history exceeds the model's context window (or a configured headroom, e.g. ~80%): the run fails with `error='context_overflow'`. The owner sees a clear failure in the UI and decides how to proceed (start a new conversation, manually trim, switch to a larger-context model).
- **No automatic summarization in MVP.** Silent summarization loses context invisibly and aligns badly with the "fail loudly" principle (§10.7). Modern context windows (200k+ for Claude/Gemini) make this rarely hit in practice.
- **Presence-dependent.** Fail-loudly only works when a human can react. Runs with no human at the other end (autonomous triggers, §9.4) cannot fail loudly — their overflow policy is defined in §7.7 and is *not* deferrable if/when triggers ship.

**History strategy (post-MVP)** — summarization, but explicit. Two options to choose between when it becomes needed:

- *Interaction-gated*: on overflow, the worker raises a `question` interaction ("history too long; summarize the oldest N messages?") via the standard mechanism (§10.2). The owner sees what's about to happen and approves. Aligns with the rest of the human-in-the-loop design.
- *Auto-with-trace*: summarize automatically, but record the action prominently (a synthetic message in the conversation, a Langfuse trace tag, a NOTIFY event for the UI to surface). Lower friction, still visible.

Decided when summarization is actually needed, not before.

**Tool scoping (MVP)** — every tool available to every conversation. Post-MVP: a `conversations.tools_allowed` array can restrict per conversation (e.g. "this Discord channel is research-only, no email/banking"). Adding it later is one column plus a filter in the assembly step — no broader change.

**Per-ingress persona overlays (post-MVP)** — the persona markdown can carry `## When on Discord` / `## When on Voice` sections. Agent-core appends the matching section based on `conversations.ingress`. Useful for tone shifts (Discord casual, voice brief) without forking the whole persona.

**Identity** — for a personal system this is trivial: the owner is the only user. The identity block in the system prompt states "You are talking to Ingvar," the current time, and which ingress the message arrived on. Multi-user is explicitly out of scope (§1).

**Single agent, many tools.** No multi-agent orchestration in v1.

### 7.6 Concurrency, serialization & resource ownership

Concurrency is real — web, Discord, and voice can all be active at once — but the **run, not the worker, is the unit of serialized execution**. This is a single-user, single-machine system, so the model is deliberately simple: keep state in memory while a run executes, and **fail-and-restart on any crash** (below) rather than engineer durable mid-run recovery.

**One active run per conversation.** Conversations are independent and run concurrently with each other; *within* a conversation, runs are strictly serial. Enforced declaratively, not by an in-memory actor registry:

```sql
create unique index one_active_run_per_conversation
  on agent_runs (conversation_id)
  where status in ('pending', 'running', 'awaiting_approval');
```

A second run for the same conversation cannot be created while one is active. The constraint *is* the actor — it makes history reads, ordering, and cancellation deterministic with no coordination protocol.

**Mid-run input (MVP): rejected.** While a conversation has an active run, new user input is refused at the source — web disables send and shows "Alfred is thinking…"; Discord reacts with a "busy" marker and drops the message. Post-MVP: buffer the message and let the running worker fold it into its next turn, or interrupt. Default is reject because it is the only option with zero ambiguity about what the model actually saw.

**The browser is a single physical resource, guarded by an in-process mutex.** There is one Chrome, one owner profile (§8) — so browser control cannot be per-run. A run acquires the browser mutex only around its browser tool-call windows and **releases it whenever the run pauses** for user input (approval or question, §10.2). This keeps a run parked on a 24h approval from blocking another conversation's browser work. On resume the agent re-acquires the mutex and re-orients (re-reads the page) — cheap, and rare in practice for one user. The mutex lives in the worker process, not Postgres: if the worker dies, the lock dies with it, which is exactly the recovery we want.

**Crash policy: fail-and-restart.** A crash (OOM, deploy, host reboot) abandons in-flight runs; we do not reconstruct them. The consequences, all accepted:

- `agent-run` jobs use `retryLimit: 0` with an expiration longer than the max interaction timeout (§6.3), so a paused worker is never redelivered to a second worker — no duplicate execution, no fencing token needed.
- On startup the worker runs a one-shot sweep marking any `running` / `awaiting_*` rows as `failed`, so the UI shows an honest failure instead of a zombie "thinking…" state. A planned deploy therefore also drops any pending approvals — intentional; the owner re-issues.
- For a single user who notices the restart, this is strictly simpler than durable resume and costs nothing this system needs.

This is reversible: the run rows already live in Postgres, so durable resume could be layered on later if Alfred ever stopped being single-user-local.

### 7.7 Autonomous & long-horizon runs

Triggers (§9.4) are described as "just another ingress." That holds for the *transport* — enqueue, stream, notify — but autonomous work has a different **execution lifecycle** than request/response, and three seams must exist in the run model from day one so adding triggers later is wiring, not an agent-core redesign.

**1. Overflow policy is a function of human-presence, not a global toggle.** §7.5's fail-loudly default assumes someone can react. Each run carries a `human_in_loop` flag, derived from `conversations.ingress` (interactive ingresses → true; `trigger` → false). It selects behaviour at the edges:

| Presence | Context overflow | Tool error / ambiguity |
|----------|------------------|------------------------|
| Human in loop (web/discord/voice) | fail loudly (§7.5) | may raise `ask_user` / approval |
| Autonomous (trigger) | **auto-summarize with trace** — synthetic message + Langfuse tag + NOTIFY event; mandatory, never silent-fail | `write`/`destructive` approvals still apply — surfaced as a notification, the run waits for the owner (or times out, §10.4); open-ended `ask_user` questions have no human to answer, so they defer the objective rather than block |

**2. Continuity comes from durable working state, not full-history replay.** A long-horizon objective ("watch this inbox for a week and report") spans many runs over time. Its continuity is an explicit, agent-maintained **objective scratchpad** — a memory scope (§6.4) summarizing progress and next steps — *not* an ever-growing message log. This is what makes overflow tractable and lets a run days later resume with a bounded, relevant context.

**3. Self-scheduling is a first-class capability.** The agent-initiated trigger of §9.4 ("remind me next Tuesday") is a built-in tool `schedule_self(when, objective_ref)` that enqueues a future run for the same objective, carrying the scratchpad forward. Stored as a Postgres row, picked up by the trigger scheduler — the same enqueue path as every other ingress.

**4. Budget is layered.** The per-run cost cap (§10.7) is insufficient for an always-on agent: a looping trigger or an injected instruction can spawn many sub-cap runs. Caps are scoped at **run** (§10.7), **objective** (sum across its runs), and a **global daily ceiling**. Exceeding the objective or daily cap pauses the objective and notifies the owner rather than failing silently.

None of this is built in MVP. The seams — the `human_in_loop` dimension, the objective scratchpad as a memory scope, and the layered budget — are reserved now so the worker and agent-core are not rewritten when triggers become the active build target (build-order step 9, §15).

---

## 8. Browser Integration

The agent uses the owner's real Chrome with all real logins. Automation is done via a **Chrome extension**, not Playwright/CDP, because modern bot defenses (Cloudflare, Datadome, banks) reliably detect headless/CDP-attached Chrome.

**Topology**

```
Chrome (owner's profile, on the server box)
└─ Alfred extension (MV3)
     │
     │ outbound WebSocket (auth token, localhost)
     ▼
Browser bridge (same box)
   ├─ WebSocket server  ← extension connects here
   └─ MCP server (HTTP+SSE)  ← agent worker connects here
        │
        ▼
   Agent worker (uses browser bridge as one MCP among many)
```

**Extension**

- Service worker (MV3) holds the outbound WebSocket.
- Content scripts injected into pages do the actual DOM work — events synthesized at the DOM level (`dispatchEvent` with real `MouseEvent`/`KeyboardEvent`), real timing.
- Reconnects with backoff on connection drop.
- MV3 service-worker suspension worked around with `chrome.alarms` heartbeats.

**Bridge process**

- WebSocket server on `127.0.0.1:<port>` — the extension and Chrome run on the same box, so it's a plain localhost connection (no WSL relay, no wildcard bind).
- Auth: shared token presented by the extension on connect.
- MCP server side uses **HTTP+SSE transport** (not stdio) so the bridge can outlive any single agent process — extension stays connected through worker restarts.
- Exposes browser-shaped tools: `navigate`, `click`, `type`, `read_page`, `wait_for_selector`, `screenshot`, etc. Translates each into messages over the WebSocket.

**Tab model & mutex**: the browser is a single physical resource shared across all runs, so it is serialized by an **in-process mutex** (§7.6), not driven concurrently. The bridge tracks one "active tab" for whichever run currently holds the mutex; because a run releases the mutex when it pauses, the next run starts from a clean handle rather than inheriting stale state. There is no persisted lease — on a crash everything restarts (§7.6), so the mutex simply dies with the worker. Passing tab IDs around per call would be the alternative; a single active-tab is simpler to reason about for a single-agent system.

**Open question**: build extension + bridge in-house vs. adopt an existing project like Browser MCP. Read their source first; adopt if it fits, otherwise borrow patterns. See §17.

---

## 9. Ingresses

All ingresses follow the same shape:

1. Receive input from their channel.
2. Look up / create a conversation row in Postgres.
3. Enqueue an agent job via pg-boss.
4. `LISTEN` on the conversation's stream channel.
5. Forward `NOTIFY` payloads back to the channel as they arrive.
6. Finalize when the worker marks the job complete.

For a single-user, single-machine system, ingresses talk **directly to Postgres/pg-boss**. (Alternative: route everything through the webserver's internal API. Cleaner separation, more code. Defer until there's a reason.)

### 9.1 Webserver (`alfred-webserver`)

**Framework**: **Hono**. Small, fast, no SSR opinions — appropriate because the UI is a single-page chat behind auth (none of Next.js's wins apply for this shape).

**Responsibilities**:

- `GET /*` — serve the built React PWA (static files).
- `POST /api/messages` — receive a user message, create job.
- `GET /api/conversations/:id/stream` — **SSE** stream of agent tokens (subscribes to `LISTEN` on the conversation channel, forwards `NOTIFY`s).
- `GET /api/conversations`, `GET /api/conversations/:id` — history.
- `POST /api/tool-approvals/:id` — human-in-the-loop approvals (the agent asks → owner clicks ✅/❌ → confirmation comes back).

### 9.2 Discord bot (`alfred-discord`)

**Library**: **discord.js**.

- Persistent WebSocket to Discord gateway, auto-reconnect.
- Auth = filter by the owner's Discord user ID. Drop everything else.
- DMs and mentions both supported. Optionally a private server with multiple channels (one per agent persona / scope).
- Streaming: edit the bot's reply message as tokens arrive, throttled to ~1 edit/sec to respect Discord rate limits.
- Long responses (>2000 chars) split into multiple messages or attached as files.
- Attachments (images, PDFs) uploaded to a temp store; agent receives a tool call to read them.
- Reactions used as confirmation UI for tool approvals.

### 9.3 Voice (`alfred-voice`) — native app only

**Constraint**: hands-free is required, and **only the native app** is a voice surface. The web PWA is chat-only. No voice on desktop browsers either.

**All voice components are cloud APIs**, which keeps this orchestrator light enough to live in TS alongside the rest. Likely providers: **ElevenLabs** or **Google** for TTS; Deepgram or Google for STT. Final choice deferred to when this is built.

**Pipeline**:

```
native app mic ── PCM/Opus over WS ──► voice orchestrator (server)
                                          │
                                          ▼
                                       Streaming STT (Deepgram / Google)
                                          │
                                          ▼
                                       Agent worker (via pg-boss + LISTEN/NOTIFY)
                                          │
                                          ▼
                                       Streaming TTS (ElevenLabs / Google)
                                          │
                                          ▼
                                       native app speaker ◄── audio chunks over WS
```

**Why this shape**

- Cloud APIs handle the heavy DSP. The orchestrator just routes audio + text streams.
- API keys live server-side, **never in the client** — otherwise anyone with the app on their device could spend the owner's API budget.
- OpenRouter remains the brain — no lock-in to GPT-4o Realtime or Gemini Live.

**Wake word**: runs on-device inside the native app — **Picovoice Porcupine** (commercial, good free tier) or **openWakeWord** (OSS). The app only opens the upstream WebSocket once the wake word fires.

**Native app platform**: deferred (mobile, desktop, dedicated device, or several). Whatever the app is, its contract with the voice orchestrator is just "WebSocket with bidirectional audio + a control channel."

### 9.4 Autonomous triggers (`alfred-triggers`) — post-MVP

**Not built in v1**, but reserved as an architectural concept so the seams are right from day one.

Triggers are ingresses with **no human at the other end**. They enqueue jobs based on time or external events, the agent runs, and the result is either silent (logged) or pushed as a notification through one of the interactive ingresses (e.g. "you have a new high-priority email" → web push + Discord DM).

Categories:

- **Scheduled** — cron-style: "every weekday at 8am, summarize my inbox." Implemented as a small scheduler process that enqueues jobs on a schedule.
- **Event-driven** — inbox watchers (Gmail push notifications), webhook receivers (GitHub, Stripe, etc.), file-system watchers. The trigger process subscribes to the upstream, normalizes the event, enqueues a job.
- **Agent-initiated** — the agent itself schedules a future trigger ("remind me about this next Tuesday"). Stored as a row in Postgres, picked up by the scheduler.

All trigger types ultimately use the same `enqueue job + LISTEN for completion + optionally notify` *transport* as the human ingresses. The *execution lifecycle* differs — overflow handling, durable objective state, self-scheduling, and budget — and those seams are defined in §7.7 so that adding triggers is wiring, not an agent-core redesign.

---

## 10. Runtime Flows

The data shape (§6) and process topology (§5) are set; this section spells out the cross-process choreography that uses them. Four flows matter: the happy path, interactions (approval/question), errors, and cancellation.

### 10.1 Happy path

Single user message, one model call, no tools.

```
Ingress              Worker                       LLM provider
   │ POST message      │                              │
   │ INSERT messages   │                              │
   │ INSERT agent_runs │                              │
   │ boss.send(runId)  │                              │
   │ ─────────────────►│ pg-boss delivers job         │
   │ LISTEN run:<id>   │                              │
   │                   │ load context (§7.5)          │
   │                   │ provider.stream(...)         │
   │                   │ ───────────────────────────► │
   │                   │ ◄── token chunks ─────────── │
   │                   │ NOTIFY run:<id> {token}      │
   │ ◄── token ────────┤                              │
   │ forward to client │                              │
   │                   │ done → INSERT messages       │
   │                   │ UPDATE agent_runs.status     │
   │                   │ NOTIFY run:<id> {done}       │
   │ ◄── done ─────────┤                              │
```

### 10.2 Interaction protocol

The agent needs the user — either a `write`/`destructive` tool call (runtime-injected approval) or an explicit `ask_user` invocation (agent-initiated question). The mechanics are identical past the trigger.

**Worker side**, on hitting a paused state:

1. INSERT a `user_interactions` row with kind, prompt, `status='pending'`.
2. UPDATE `tool_calls.status='awaiting_user'`, `agent_runs.status='awaiting_approval'`.
3. `NOTIFY run:<run_id> { type:'interaction_required', interactionId, kind }`.
4. `LISTEN` for `interaction_resolved` with that `interactionId`.

**Ingress side**, on receiving `interaction_required`:

1. Fetch the `user_interactions` row for prompt details.
2. Render: web → modal/inline card with buttons; Discord → message with reactions or buttons; voice → speak the prompt, listen for the answer.
3. The same NOTIFY reaches *every* connected ingress for that run — multi-ingress surfacing is automatic (§10.3).

**User responds** via any ingress:

1. Responding ingress writes `user_interactions.response`, `status='resolved'`, `resolved_via=<ingress>`, `resolved_at=now()` — via conditional UPDATE so only one ingress wins.
2. UPDATEs `tool_calls.status='running'` and `agent_runs.status='running'`.
3. `NOTIFY run:<run_id> { type:'interaction_resolved', interactionId }`.

**Worker** wakes from LISTEN, reads the response row, continues:

- For approvals: `approved=true` → invoke the tool; `false` → append a synthetic tool_result `{ error:'user_rejected', note }` and loop back to the model.
- For questions: feed `response` as the tool_result of `ask_user` and continue.

### 10.3 Multi-ingress surfacing

NOTIFY broadcasts to all subscribers, so a question raised during a Discord conversation can be answered in the web UI (or vice versa). First response wins:

- Whichever ingress's conditional UPDATE succeeds first owns the resolution.
- Other ingresses see `interaction_resolved`, fetch the row to see what was answered, and tear down their prompt UI.
- Race resolution is a single `UPDATE ... WHERE status='pending' RETURNING ...`. Empty return = lost the race, treat local UI as cancelled.

### 10.4 Timeouts

Interactions don't block forever. MVP default: **24h** for both approvals and questions. Configurable per-tool via the Tool interface. The timer is in-process; if the worker crashes the timer is lost — but so is the run (swept to `failed` on restart, §10.5), so there is nothing to leak.

The worker registers a `setTimeout` alongside the LISTEN. On fire:

- Conditional UPDATE: `SET status='timed_out', resolved_at=now() WHERE id=$1 AND status='pending'`.
- If it updated (won the race): NOTIFY `interaction_resolved`; resume the agent with a synthetic tool_result indicating timeout.
- If not: ignore — someone responded just before the timer fired.

### 10.5 Worker crash

A worker dies (OOM, deploy, host reboot). This system does **not** reconstruct in-flight runs — it fails and restarts (§7.6):

1. The crashed run is abandoned. Because `agent-run` jobs use `retryLimit: 0` (§6.3), pg-boss does not redeliver it to another worker, so there is no duplicate execution.
2. On startup the worker sweeps every non-terminal run — `running`, `awaiting_*`, and orphaned `pending` runs whose pg-boss job was lost — to `failed`, cascading to their `tool_calls` and pending `user_interactions` (§10.9, invariant 4), so the UI shows an honest failure rather than a stuck "thinking…" state.
3. The owner re-issues whatever was lost.

The one accepted residue: if the crash lands *after* a side-effecting tool executed but *before* its result was recorded, a manual re-issue could repeat the action. The owner knows the restart happened, and `write`/`destructive` actions are approval-gated (§16) regardless — acceptable for a single-user system.

### 10.6 User-initiated cancellation

User clicks "stop" in the UI, types `/cancel` in Discord, or says "stop" to voice.

1. Ingress UPDATEs `agent_runs.status='cancelled'`, NOTIFYs `run:<id> { type:'cancelled' }`.
2. Worker, between LLM streaming chunks or before invoking a tool, checks `agent_runs.status`. If `cancelled`, aborts:
   - Cancels any in-flight LLM stream via `AbortController`.
   - Marks any pending interaction `status='cancelled'`.
   - Writes a final 'cancelled' marker and stops.
3. Mid-stream checks happen via the AbortSignal threaded into the provider client.

Worst case: a tool already executing can't be cancelled cleanly (e.g. a browser action mid-flight). The worker waits for that tool to return or timeout, then aborts. Interruptibility is bounded by the slowest unkillable tool — accept this; alternatives (forced thread death) are worse.

### 10.7 Errors

| Error class | Behavior |
|-------------|----------|
| LLM API transient (5xx, 429) | Provider abstraction retries with backoff: 1s, 2s, 4s, 8s. After 4 attempts: fail run with `error='llm_unavailable'`. |
| LLM API permanent (4xx) | Fail run with the API's error captured in `agent_runs.error`. |
| Tool error (thrown from `invoke`) | Caught by the loop; tool_result becomes `{ error:'<message>' }`. The agent sees it next turn and can adapt. |
| Tool timeout | Each tool declares a default timeout (30s browser action, 120s inbox scan, …). Exceeding it returns `{ error:'timeout' }`. |
| Cost cap | Per-run cap (default $1, configurable). Checked after each LLM call. Exceeded: fail with `error='cost_exceeded'`. |
| Stuck / abandoned run (worker died or hung) | Startup sweep marks any `running` / `awaiting_*` rows as `failed` on worker boot (§10.5). No dead-letter machinery — a crash means restart, and the owner re-issues. |

Pattern across all of these: **fail loudly into structured rows**, never silently. Langfuse traces capture LLM-level detail; the DB captures run-level outcomes.

### 10.8 Idempotency

With fail-and-restart (§7.6, §10.5) there is no mid-run resume, so the elaborate idempotency machinery a durable model would need is out of scope. Within a *single* live run the loop still keys state on `runId` / `toolCallId` / `interactionId` rather than positional ordering, and the only concurrency guard that matters is the conditional `UPDATE ... WHERE status='pending'` that resolves the interaction race (§10.3). Cross-restart idempotency is explicitly not provided: a crashed run fails and is re-issued by the owner.

### 10.9 State machines & invariants

The three status columns (§6.1) are the correctness core of the system; every flow in §10.1–§10.8 is a transition between these states. Stating the legal transitions in one place — rather than scattering them across prose — is what catches the failure-path bugs (cancel-during-pause, timeout racing a response, restart cascade). All status writes go through a single transition guard in the worker that rejects illegal transitions; each illegal transition and each invariant below becomes a test (deferred to the worker build, §15 step 3).

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

## 11. Web Frontend

**Stack**

- **Vite + React + TypeScript** — fastest dev loop, cleanest config for a non-SSR SPA.
- **Tailwind + shadcn/ui** — copy-in components, Radix primitives under the hood, owns the design tokens.
- **`@ai-sdk/react`** (`useChat`) — handles SSE streaming, message state, optimistic updates. ~30 lines of chat code on the frontend.
- **TanStack Query** — non-chat server state (conversation list, settings, approvals queue).
- **react-router** — minimal routing if multiple screens are needed.
- **`vite-plugin-pwa`** — service worker, manifest, installability, Web Push.

**Screens (v1)**

- Chat (current conversation).
- Conversation list / history.
- Approvals queue (pending tool confirmations).
- Settings (API keys, integrations, agent persona).

**PWA implications**

- Installable on iOS / Android home screens and desktop.
- Web Push notifications work (iOS 16.4+) — used for "agent finished" and "approval needed" pings.
- Background sync limited on iOS but useful on Android/desktop.
- **No voice.** The PWA is chat-only. Voice lives exclusively in the native app (§9.3).

---

## 12. Authentication

**Network position is the authentication.** The server has no public exposure — only the owner's tailnet (and the LAN, behind the firewall) can reach it. For a single user there is no per-request identity to compute and nothing to log into: being able to connect *is* being the owner.

- No login screen, no passwords, no Auth.js boilerplate.
- Expose the server via `tailscale serve` (or Caddy-with-Tailscale) — this also provides HTTPS, which the PWA's secure context needs.
- Tailscale does inject identity headers (`Tailscale-User-Login`); reading them is **optional** and only matters if the system ever needs to distinguish *which* person is connecting. The single-user model doesn't, so the app reads no header.

If access ever needs to extend beyond a single owner (family, sharing), that's when real per-user auth goes in — Auth.js with magic-link or passkey, plus reading the identity header. Not before.

Internal trust: Discord bot, voice service, and worker all run on the same machine in the same trust boundary — no inter-process auth needed.

---

## 13. Configuration & Secrets

Three layers, in increasing specificity:

1. **Defaults in code** — sensible fallbacks in `packages/shared/config.ts`. The app boots even if no env file exists, with limited functionality.
2. **Environment variables** — loaded from `.env` at the project root, validated by zod at startup. All secrets live here.
3. **DB runtime config** (post-MVP) — a `runtime_config` table for things that should be changeable without restart (current model, per-tool cost caps, persona overrides). Reserved, not in MVP.

### 13.1 .env layout

```
# === Identity ===
TAILSCALE_USER_HEADER=Tailscale-User-Login
ALLOWED_DISCORD_USER_ID=<owner's Discord ID>

# === Data ===
POSTGRES_URL=postgres://alfred:...@localhost:5432/alfred

# === LLM ===
OPENROUTER_API_KEY=sk-or-...
DEFAULT_MODEL=anthropic/claude-3.5-sonnet
ROUTING_MODEL=anthropic/claude-3.5-haiku    # cheap model for routing/summary

# === Browser bridge ===
BRIDGE_AUTH_TOKEN=<random 32+ chars, shared with the Chrome extension>
BRIDGE_WS_PORT=8765
BRIDGE_MCP_PORT=8766

# === Ingresses ===
WEBSERVER_PORT=3000
DISCORD_BOT_TOKEN=<from Discord developer portal>

# === Observability ===
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...
LANGFUSE_HOST=http://localhost:3001         # self-hosted next to Postgres

# === Voice (post-MVP) ===
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
```

### 13.2 Loading and validation

Each process imports a typed `loadConfig()` from `packages/shared/config.ts` that:

- Calls `dotenv.config()` at boot.
- Validates the required subset via **zod**, with helpful error messages on missing/malformed values.
- Returns a strongly typed config object — no `process.env.X` access elsewhere in the codebase.
- **Fails fast on startup** if anything required is missing. Better to crash at boot than silently misbehave later.

Each process declares only the subset it needs (the Discord bot doesn't need `DEEPGRAM_API_KEY`). Minimizes blast radius — a compromised process doesn't have access to keys it never asked for.

### 13.3 File permissions and storage

- `.env` lives at the repo root, mode `0600`, owned by the running user.
- `.env.example` is committed with placeholder values, documenting every required key.
- `.env` is `.gitignored`.
- Backups of the home server **must** include `.env` separately from the DB dump. Without it, restoring the database is useless — no process can boot.

### 13.4 Rotation

Manual for MVP — sufficient for one user:

- **OpenRouter key**: generate new key in the dashboard, edit `.env`, `pm2 reload all`.
- **Discord token**: regenerate in developer portal, same flow.
- **Bridge auth token**: generate new value, update `.env` AND the extension's config (extension reads from `chrome.storage.local`; set via the extension's options page).

Post-MVP option: OS keychain (macOS Keychain, libsecret on Linux, Windows Credential Manager) via a small abstraction. Worth doing the day backups land anywhere outside the home server.

---

## 14. Project Structure

Single git repo. **pnpm workspaces** owns the TypeScript stack; non-TS sub-projects (iOS) sit alongside in their own toolchain corners — polyglot by **colocation**, not by tooling integration.

```
alfred/
├─ services/                ← backend processes (Node/TS, pnpm workspace members)
│  ├─ webserver/            ← Hono (API + static serving)
│  ├─ worker/               ← agent worker
│  ├─ browser-bridge/       ← MCP (HTTP+SSE) + WebSocket server for extension
│  ├─ discord-bot/          ← Discord ingress
│  ├─ voice/                ← voice orchestrator (post-MVP)
│  └─ triggers/             ← scheduler / event-source ingress (post-MVP)
├─ clients/                 ← user-facing apps
│  ├─ web/                  ← Vite + React PWA (chat-only; pnpm workspace member)
│  └─ ios/                  ← native iOS app (Swift + Xcode, post-MVP; NOT in pnpm workspace)
├─ packages/                ← shared TS libraries (pnpm workspace members)
│  ├─ db/                   ← Drizzle schema + migrations, query helpers
│  ├─ shared/               ← TS types shared between services and web client
│  └─ agent-core/           ← agent loop, provider abstraction, tool interface
├─ chrome-extension/        ← MV3 extension (pnpm workspace member; shares protocol types with browser-bridge)
├─ ecosystem.config.js      ← pm2 process definitions for services/*
├─ pnpm-workspace.yaml      ← lists services/*, clients/web, packages/*, chrome-extension
├─ package.json             ← root scripts (build, dev, lint)
└─ README.md
```

### 14.1 services/ vs clients/

The split makes responsibilities obvious at a glance:

- `services/` — long-running backend processes. All supervised by pm2, none directly facing a human. They share the TS toolchain and pull from `packages/`. Named for what they *do*, not what platform they run on.
- `clients/` — anything a person interacts with. Web and iOS live next to each other so "I need to make a UI change on both surfaces" is visible in the file tree, even though they use different stacks.

This naming also makes it obvious that **only `clients/web` is something an end-user opens directly**; everything in `services/` is plumbing.

### 14.2 Polyglot handling (iOS specifically)

iOS uses **Swift + SPM + Xcode** — a completely separate toolchain from pnpm/Node. The repo handles this by ignoring it from pnpm's perspective:

- pnpm's `pnpm-workspace.yaml` does not include `clients/ios/**`. `pnpm install` from the root sets up TS only.
- Xcode opens `clients/ios/Alfred.xcworkspace` directly. It has its own dependency manager (SPM) and knows nothing about pnpm.
- CI runs TS jobs and iOS jobs as independent pipelines.
- Cross-cutting changes (e.g., a new field in the voice WebSocket protocol) land in **one commit** that touches both `services/voice/` and `clients/ios/`, with coordinated review and atomic merge. This is the *whole point* of one repo.

**Why one repo, not two** — for a personal system, the convenience of atomic cross-protocol commits and a single source of truth outweighs the small cost of two toolchains living next to each other. If iOS ever spins out (open-sourcing the client separately, say), splitting later is straightforward; merging back from two repos is much harder.

### 14.3 chrome-extension/ placement

The Chrome extension is TS but lives at the **repo root**, not under `clients/`. Reasons:

- It's not a "client" in the user-facing sense — the human is using Chrome, the extension is a transparent helper.
- It shares the most code with `services/browser-bridge/` (protocol message types), so a workspace member it stays — pnpm reaches it, types are shared.
- It has its own build story (Vite + `@crxjs/vite-plugin` or similar) that's distinct from both services and web client.

Conceptually it's a peer of `services/browser-bridge`, just running in Chrome instead of Node.

### 14.4 Day-to-day commands

```
# TypeScript side
pnpm install                                      # workspace setup
pnpm --filter "./services/*" build                # build all services
pnpm --filter web dev                             # web client dev server
pm2 start ecosystem.config.js                     # bring services up
pm2 reload all                                    # post-deploy

# iOS side (post-MVP)
open clients/ios/Alfred.xcworkspace               # Xcode does the rest
```

---

## 15. Build Order

Each step is independently verifiable. The seams (Postgres queue, SSE, MCP) don't change between steps — later steps just fill in pieces.

1. **Hono webserver + stub Vite+React page over HTTPS.** Tailscale auth middleware. Verify access from phone over tailnet.
2. **Postgres + Drizzle schema.** `conversations`, `messages`, plus pg-boss tables (auto-created).
3. **Agent core skeleton.** Provider abstraction in `packages/agent-core` with an OpenRouter implementation. Tool interface with one built-in tool (`echo`). Hand-rolled loop. Wired into a worker that streams text via `NOTIFY`. End-to-end "type → echo" through SSE.
4. **Real model + observability.** Replace the echo tool with the actual agent loop talking to OpenRouter. Wire in **Langfuse** (self-hosted, runs alongside Postgres) from day one — every LLM call and tool invocation traced. This pays off immediately during debugging.
5. **Browser bridge + Chrome extension** as the first MCP-sourced tool. End-to-end browser automation through the agent. Built in-house, drawing from the owner's existing `chrome-mcp` project.
6. **Discord bot** as a second ingress. Same conversation shape as the web ingress, separate thread, shared agent memory.

**End of MVP.** Below the line is post-MVP, in rough priority order:

7. **Additional MCP integrations** (Gmail, Calendar, filesystem, etc.) — one at a time.
8. **Voice orchestrator + native iOS app** as the third ingress. Hands-free, wake-word on device, cloud STT/TTS.
9. **Autonomous triggers** — scheduler + first event watcher (likely inbox).
10. **Long-term memory** (pgvector-backed). See §17.
11. **Backup strategy**. See §17.

---

## 16. Security & Blast Radius

An agent with browser access to the owner's email, banking, and messaging accounts is **enormously powerful and enormously dangerous**. A prompt injection from an email body, a Slack message, or a webpage the agent reads could instruct it to forward the inbox, send messages, or move money.

**Principles baked into the architecture from day one**

- **Tools declare a trust tier**: `read`, `write`, `destructive`. The agent runtime treats each differently.
- **Read by default**: `write` and `destructive` tools trigger a runtime-injected approval interaction (§6) *before* the tool runs. The owner sees the proposed action with full args, clicks ✅/❌ in the web UI or reacts in Discord, and only then does the worker invoke the tool. Rejection short-circuits with a structured error the agent can read.
- **Destructive actions** (sending money, mass-delete, "send to all") always require approval, regardless of agent confidence — this is enforced by the tool's declared tier, not by agent judgment.
- **Per-integration scoping**: the Gmail tool exposes `read`/`draft`/`label` as `read`-tier and `send` as `write`-tier — same MCP server, different per-tool tiers.
- **Same machinery, different trigger**: structured questions (agent calls `ask_user`) use the same `user_interactions` table and ingress surfacing as approvals. One UI/Discord/voice flow handles both — easier to make robust, easier to reason about.
- **Auditable trail**: every tool invocation logged in `tool_calls`; every owner decision logged in `user_interactions` with timestamp and ingress used. Together they are the audit log.
- **Browser profile isolation** (consider later): separate "untrusted reading" profile for arbitrary web pages vs. "trusted actions" profile for logged-in services. The agent decides which to use based on the task.

This is the actual hard problem — the architecture should make it easy to enforce, not the other way around.

---

## 17. Decisions & Open Questions

### Resolved

- **Agent loop: hand-rolled.** No Vercel AI SDK or other framework wrapping the model client. Direct ownership of streaming, tool-call parsing, and history management.
- **Tool interface: unified.** MCP-sourced and built-in tools share one interface inside agent-core. See §7.3.
- **Browser bridge: build in-house.** Drawing inspiration from the owner's existing `chrome-mcp` project.
- **Voice scope: native app only.** No voice on the web PWA or desktop browsers.
- **Voice provider lean: ElevenLabs or Google.** Final choice deferred to when the voice orchestrator is the active build target.
- **Native app platform: iOS** (when voice rollout begins). Tech choice (Swift vs. React Native vs. Expo) deferred until then.
- **Process supervisor: pm2.** Cross-platform default; native supervisors as fallback.
- **Observability: in from MVP, self-hosted Langfuse.** Wired in at build-order step 4 (§15). Reasoning: when an agent does something weird, the cost of *not* having traces is high, and Langfuse is cheap to run alongside Postgres on the same box.
- **Concurrency & crash model: serialize, don't recover.** One active run per conversation (DB constraint); the browser is serialized by an in-process mutex released on pause; crashes fail-and-restart — no durable resume, `retryLimit: 0`, startup sweep marks orphans `failed`. Deliberately simple for single-user-local, and reversible later. See §7.6.
- **Autonomous lifecycle seams reserved.** Presence-dependent overflow policy, durable objective scratchpad for cross-run continuity, agent self-scheduling, and layered (run/objective/daily) budget. Defined now, built when triggers ship. See §7.7.

### Deferred to future work

- **Voice framework specifics.** Hand-rolled orchestrator in Node with cloud SDKs, vs. LiveKit Agents TS, vs. managed Vapi/Retell. Decide when building the voice service is the active task.
- **Long-term memory.** "Memory" here means the agent's ability to remember things across conversations — preferences, ongoing projects, facts told to it months ago — not just what's in the current chat. The standard approach is **pgvector**, a Postgres extension that stores text as numeric "embeddings" so the agent can pull up relevant past content for the current context. Without it, each conversation starts with a blank slate apart from a global system prompt. Open questions: when to introduce, what to embed (raw messages? summaries?), how to scope (per-ingress? global?). Not v1.
- **Backup strategy.** Postgres dumps + Chrome profile + `.env` files should be backed up off-box. Target options: a Tailscale-connected NAS, an encrypted cloud bucket (Backblaze B2, S3 + age). Worth doing before the system holds anything irreplaceable. Not part of MVP.

---

## 18. Summary

```
Browser / phone (PWA, chat)      Native iOS app (chat + voice, post-MVP)
       │                                  │
       │  Tailscale                       │  Tailscale
       ▼                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ Home server (Linux / macOS / Windows — all native)              │
│                                                                  │
│  Chrome ─ extension ─ ws ─► browser-bridge                       │
│                                  │                               │
│  Hono webserver  ──┐             │ MCP (HTTP+SSE)                │
│  Discord bot      ─┼─► Postgres + pg-boss ◄─► agent-worker       │
│  Voice (post-MVP) ─┤    state · queue · pub/sub    │             │
│  Triggers (post)  ─┘                               │             │
│                                                    ▼             │
│                                       hand-rolled agent loop     │
│                                              │                   │
│                                ┌─────────────┴────────────┐      │
│                                ▼                          ▼      │
│                       LLM provider abstraction     Tool interface│
│                        ├─ OpenRouter (default)     ├─ MCP-sourced│
│                        ├─ Anthropic/OpenAI/Gemini  └─ built-in   │
│                        └─ Ollama (local, optional)               │
│                                                                  │
│  Langfuse (self-hosted) ◄── traces from worker ──┘               │
└─────────────────────────────────────────────────────────────────┘
```

- **One agent identity, many concurrent conversations.** Worker runs are discrete jobs; state is shared.
- **Ingresses are interchangeable**: web (PWA, chat-only), Discord, native iOS app (chat + hands-free voice, post-MVP), autonomous triggers (post-MVP).
- **Tools are interchangeable**: MCP-sourced and built-in tools share one interface inside agent-core.
- **Hand-rolled agent loop** — no framework dependency.
- **Postgres is the only stateful infra** — state, job queue (pg-boss), and pub/sub (LISTEN/NOTIFY) all in one.
- **Cross-platform**: pm2 supervises Node processes natively on Linux / macOS / Windows identically. No Docker, no WSL2.
- **Browser automation via Chrome extension** (undetectable) → bridge (MCP over HTTP+SSE) → agent.
- **LLM provider abstraction**: OpenRouter by default, swappable to direct vendors or local models by config.
- **Voice is native-iOS-app only** when it lands — cloud STT/TTS, server-side keys, OpenRouter still the brain.
- **Observability from day one** via self-hosted Langfuse running alongside Postgres.
- **Tailscale** = remote access; **network position is the auth** (no public exposure, single user — nothing to log into).
