# Alfred — Architecture

A personal AI agent platform. A single always-on agent the owner can talk to from any device (web, Discord, voice), with access to a real browser carrying their real logins, and a tool ecosystem that grows over time.

Date: 2026-05-30
Status: Initial design, pre-implementation

---

## 1. Goals & Constraints

**Functional goals**

- **One agent identity** (memory, personality, tools), reached via **many concurrent conversations** from any device — no forever-running agent process; the worker spins up a discrete run per job, state is shared.
- Multiple **interactive ingresses** — web/PWA (chat), Discord (chat), native app (chat + **hands-free voice, native-app only**, no voice on the PWA in v1) — plus **autonomous triggers** (post-MVP): scheduled jobs / inbox watchers / webhooks, a fourth ingress category that enqueues jobs with no human at the other end.
- Many integrations over time (email, messaging, calendar, browser, …). The agent uses a **real browser with the owner's real logins** — automation must be undetectable to modern bot defenses.

**Non-functional constraints** — single user (no multi-tenant); self-hosted on a home server (no cloud VPS for the core); **OS-agnostic** (Linux/macOS/Windows native, no OS-specific core deps); **pluggable LLM provider** (default **Google Gemini** via `@google/genai`, swappable by config to OpenRouter / Anthropic / OpenAI / local Ollama); minimal moving parts.

**Explicit non-goals (for now):** multi-agent orchestration (one agent, many tools), public exposure / sharing, native mobile apps (the PWA covers mobile).

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
│        │ WebSocket (ws://127.0.0.1, chrome-extension:// origin)       │
│        ▼                                                              │
│  Postgres                                       Agent worker(s)        │
│  ├─ state (conversations, memory, approvals)    ├─ hand-rolled loop    │
│  ├─ job queue (pg-boss)                         ├─ Provider abstraction│
│  └─ pub/sub (LISTEN / NOTIFY)                   │   (Gemini, …)        │
│        ▲                                        ├─ Tool interface      │
│        │  enqueue / stream                      │   ├─ built-in        │
│        │                                        │   └─ MCP-sourced     │
│  Ingresses (interchangeable):                   └─ embedded browser    │
│  ├─ Hono webserver (PWA chat, SSE)                  bridge (WS server) │
│  ├─ Discord bot                                       ▲                │
│  ├─ Voice orchestrator (native app, post-MVP)         │ extension      │
│  └─ Triggers (cron/inbox/webhook, post-MVP)           connects here    │
└──────────────────────────────────────────────────────────────────────┘
                                                       │
                                                       ▼
                                       LLM providers (Gemini, etc.)
                                       Other MCP servers (Gmail, Calendar, …)
```

**Two core ideas.** *Ingresses are interchangeable* — the worker doesn't know whether a job came from web, Discord, voice, or a trigger; each ingress just translates its channel into "submit job, stream output back." *Tools are interchangeable* — the agent calls every tool through one internal interface (§7), so a built-in function and a future MCP-server tool look identical to it.

---

## 3. The Home Server

**Hardware**: any always-on box at home (Mac mini, NUC, repurposed PC/laptop) — OS-agnostic, only the supervisor registration + a few paths differ by OS. (Owner's box is Windows, developed against from a Mac.)

**Why a home box (not a VPS):** same home IP as the owner's daily browsing → far fewer "new device" challenges; trivial 2FA (phone nearby); browser sessions persist for months; sensitive credentials never leave the house; pays for itself vs. a VPS in ~12 months.

**Remote access**: **Tailscale** — no public exposure; client devices join the tailnet and reach the server over encrypted private IPs.

---

## 4. Deployment & OS

OS-agnostic — the same code runs on three targets, OS choice being practical not architectural. The stack (Node, Postgres, pg-boss, apps) is identical; only the supervisor config + a few paths differ:

| Target | Supervisor | Browser host | Notes |
|--------|-----------|--------------|-------|
| **Linux** (NUC, mini-PC, laptop) | pm2 (or systemd) | native Chrome | Cleanest; no FS boundaries. |
| **macOS** (Mac mini, old iMac) | pm2 (or launchd) | native Chrome | Quiet, low-power "appliance". |
| **Windows** | pm2 (or Task Scheduler) | native Chrome | Native — no WSL2. See §4.1. |

### 4.1 Windows-as-server notes

If the box is Windows: the stack runs **natively** (Node + pnpm + pm2 — no WSL2, no DrvFS boundary). Develop anywhere (owner's is a Mac), deploy the built stack to the Windows box. Desktop-OS-as-server settings: sleep "Never" on AC; auto-login (the later Chrome session needs a logged-in desktop); no idle lock screen; Update active hours that never reboot mid-day; Defender exclusions for the project + Chrome dirs.

---

## 5. Process Topology

All processes are native (no Docker). Managed by **pm2** — the same process supervisor on Linux, macOS, and Windows. One config file (`ecosystem.config.cjs`) defines every process; one command (`pm2 start ecosystem.config.cjs`) brings everything up; `pm2 startup` registers pm2 itself with the host's init system (systemd on Linux, launchd on macOS, Task Scheduler on Windows) so everything survives reboot.

| Process | Language | Role | Restart policy |
|---------|----------|------|----------------|
| `postgres` | — | State, job queue, pub/sub | Auto-start via OS package manager; not under pm2 |
| `alfred-webserver` | Node/TS | Browser ingress, serves PWA, SSE | Restart on failure |
| `alfred-worker` | Node/TS | Agent execution loop + **embedded browser bridge** (WS server for the Chrome extension) | Restart on failure |
| `alfred-discord` | Node/TS | Discord ingress (post-MVP) | Restart on failure |
| `alfred-voice` | Node/TS | Voice orchestrator (native-app surface, post-MVP) | Restart on failure |
| `alfred-triggers` | Node/TS | Scheduler / event-source ingress (post-MVP) | Restart on failure |

**Built today:** only `alfred-webserver` and `alfred-worker` are in `ecosystem.config.cjs`; the `discord`/`voice`/`triggers` rows are the reserved post-MVP shape (so the topology is whole, not because they exist — §15). Each is its own pm2 process so one crash doesn't take down the others. The browser bridge was originally a separate `alfred-browser-bridge` process but is instead **embedded in `alfred-worker`** (§8) — the extension's own auto-reconnect covers restarts for one user.

Deploy: `git pull && pnpm install && pnpm build && pm2 reload ecosystem.config.cjs`. Postgres is installed via the host's package manager and managed by the OS, not pm2. **Alternative** if pm2 ever stops fitting: each target's native supervisor (systemd/launchd), which is what pm2 delegates to anyway.

---

## 6. Data Layer

**Postgres only.** No Redis. Postgres does triple duty: **state** (conversations, messages, runs, tool calls, approvals, memory), **job queue** (via **pg-boss**), and **streaming pub/sub** (via `LISTEN`/`NOTIFY` — the worker NOTIFYs progress per conversation, ingresses LISTEN and forward). No Redis because pg-boss + LISTEN/NOTIFY covers everything Redis would at this scale (one user, tiny streamed-token volume) with one fewer service to run and back up.

**ORM**: **Drizzle** (TS-native, schema-in-code, Drizzle Kit migrations) in `packages/db`. **Vector storage** (post-MVP): **pgvector** in the same instance, no separate vector DB.

### 6.1 Schema

The column-level data model — every table, column, index, and the interaction prompt/response shapes — lives in **`docs/DATABASE.md`** (kept separate for session-start readability); its `status` columns are governed by the state machines in §10.9 (RUNTIME.md). Topology only:

- `users` — single owner row (multi-user-ready).
- `conversations` — one per ingress channel; unique on `(ingress, channel_key)`.
- `messages` — `jsonb` content (text, attachments, tool-use/result blocks).
- `agent_runs` — one per job (status, model, token/cost); partial unique index = **one active run per conversation** (§7.6).
- `tool_calls` — one per invoked tool (`trust_tier`, status).
- `user_interactions` — generic pause-for-user (`approval`/`question`); the record of every owner decision.
- `tools` — worker-published catalog + the owner's per-tool `require_approval`; read per run to gate (§16).
- `memory_facts` — post-MVP placeholder (`embedding` unused until pgvector, §6.4).

`agent_runs` + `tool_calls` + `user_interactions` together are the audit log — no separate `audit_log` table.

### 6.2 NOTIFY channels and payloads

Channel: **`conversation:<conversation_id>`** — keyed on the conversation, not the run, because an ingress subscribes before it knows the run id and a conversation has at most one active run (§7.6), so it can follow successive runs over one subscription. Payload shape emitted by the worker (`services/worker/src/events.ts`):

```ts
type RunEvent =
  | { type: 'token';                text: string }
  | { type: 'tool_call_start';      id: string; toolName: string; args?: unknown }
  | { type: 'tool_call_end';        id: string }
  | { type: 'interaction_required'; interactionId: string; kind: 'approval' }
  | { type: 'interaction_resolved'; interactionId: string }
  | { type: 'done' }
  | { type: 'cancelled' }
  | { type: 'error';                message: string }
```

`NOTIFY` payloads have an **8000-byte limit**, so events reference IDs and consumers `SELECT` the rows for full payloads (DB is the source of truth). Hence: `tool_call_start` includes `args` only when their JSON is ≤1024 chars (a large `evaluate_javascript` script can't breach the cap; full args always persist on `tool_calls`); `tool_call_end` carries only the `id` (result lives on the row / `/debug`); `interaction_required.kind` is only `'approval'` today (the `question` kind / `ask_user` isn't wired yet, though the DB column allows it); `cancelled` is distinct from `done` (§10.6).

### 6.3 Job queue (pg-boss)

pg-boss owns its own schema (`pgboss`), treated as a black box. Job payloads are minimal — `type AgentJob = { runId: uuid }` — the `agent_runs` row carries everything else, so a pulled-but-unacked job reconstructs from the run row, migrations don't ripple through payloads, and retries are idempotent (the worker skips already-finished runs). The worker calls `boss.work('agent-run', handler)` with concurrency; because a handler blocks in place while paused for user input (§10.2), `agent-run` jobs use **`retryLimit: 0`** and a **job expiration longer than the max interaction timeout** (§10.4) — a parked worker is never redelivered (no duplicate execution, §7.6), a lost run just fails. Recurring jobs (post-MVP) use `schedule()`.

### 6.4 Memory (post-MVP placeholder)

The `memory_facts` table exists from day one with an unused `embedding` column — defining it early forces the *what gets remembered* question now, lets the loop have a plain-rows `memory.read(scope)` from MVP, and makes pgvector activation a single migration + index, no schema change. Open: extraction strategy (LLM-summarized vs. user-flagged), decided when memory is the active target.

### 6.5 What's NOT in the database

| Thing | Where | Why |
|-------|-------|-----|
| API keys / secrets | `.env`, OS keychain | DB compromise shouldn't leak credentials |
| Large attachments (images, PDFs, audio) | Filesystem, by workspace-relative path | Postgres is bad at blobs; FS backs up trivially |
| Chrome browser profile | Where the OS puts it; backed up separately | Owned by Chrome, not us |
| LLM request/response + traces | `llm_calls` table, rolled up onto `agent_runs` | In-house observability on `/debug`; replaces Langfuse (§17) |

**Attachment storage — per-conversation workspaces (built).** The flat `data/attachments/` is superseded by a **per-conversation working directory** `data/conversations/<conversation_id>/` — the foundation for file-bearing capabilities (images now; code execution later). Files are referenced by a path *relative to that directory* (a movable, deletable unit), and all access goes through one `resolveInWorkspace(conversationId, relPath)` confinement helper (rejects absolute/`..`/symlink-outs), centralized so a future shared scope is a root swap, not a rewrite. `messages.content` stores the reference (`{ type:'image', path, mimeType }`); the worker bridges it to the inline-base64 the model needs — Postgres/NOTIFY never carry image bytes. Spec: `docs/specs/2026-06-05-conversation-workspace-and-images.md`.

---

## 7. Agent Core

The agent core lives in `packages/agent-core` with three load-bearing pieces: a **hand-rolled agent loop**, a **provider abstraction**, and a **tool interface** unifying MCP-sourced and built-in tools.

### 7.1 Agent loop (hand-rolled)

~300–500 lines of TS, owned for the transparency it buys (streaming, tool-call parsing, history, retries, cancellation all explicit — no framework wrapper between us and the model). Sketch:

```
loop:
  response = provider.stream(messages, tools)
  for each chunk in response:
    if chunk is text:       emit token (NOTIFY)
    if chunk is tool_call:  invoke via tool interface; append result to messages; continue
  if response ended with no tool_call: done
```

### 7.2 Provider abstraction

A thin interface in `agent-core` wraps the model client; provider selection is config, not code. Default (and only built) impl is **Google Gemini** (`@google/genai`); OpenRouter / Anthropic / OpenAI / Ollama plug in behind the same interface. (**LiteLLM** could optionally proxy for unified logging/fallback, but the in-process abstraction is what matters.)

```ts
interface LlmProvider {
  stream(messages, tools, options): AsyncIterable<TokenOrToolCall>
}
// implementations: GeminiProvider (built), OpenRouterProvider, AnthropicProvider, OllamaProvider, ...
```

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

- **MCP-sourced tools** — the agent core opens MCP client connections (stdio for short-lived subprocess servers, HTTP+SSE for long-running ones) at startup and converts each `tools/list` into `Tool`s whose `invoke` proxies via `tools/call`. The loop never sees MCP. *None exist yet* — the browser is **not** MCP-sourced (it's built-in tools over the embedded bridge, §8).
- **Built-in tools** — `Tool` directly inside `agent-core`: trivial utilities, and tools that must integrate tightly with the runtime — most notably **`ask_user`**, whose `invoke()` creates a `user_interactions` row of kind `question`, pauses the run, and resumes on response (the agent calls it like any tool; §6.1 has the shape).

So: a rich integration = spin up an MCP server (auto-discovered); a tiny utility = a built-in `Tool`; swapping one for the other is invisible to the loop.

### 7.4 Other agent-core concerns

- **Cost/latency routing** (later): a cheap model for routing/chitchat, a strong one for hard reasoning — one config knob via the provider abstraction.
- **Concurrency**: each run is a coroutine on Node's event loop; one worker handles many concurrent (I/O-bound) runs, scale out with more pg-boss consumers. Serialization (one run per conversation) and the browser lease are in §7.6 (RUNTIME.md); correctness doesn't depend on worker count.

### 7.5 Conversation lifecycle & persona

A run's context is assembled fresh every invocation. The agent has no in-process state between runs — everything that matters lives in Postgres.

**Persona** — the agent identity (names the agent Alfred and owner Ingvar, tool families, tone/length defaults, when to ask vs. assume). *Target:* a global markdown file `packages/agent-core/personas/alfred.md` loaded at boot. *Built today:* a hardcoded `SYSTEM_PROMPT` constant in `services/worker/src/run.ts`; moving it to the file is a small deferred refactor.

**Per-run context assembly** — the worker builds the model input as:

```
[system]    global persona  +  identity block (current time, ingress, user)
[summary]   (optional) prior-context summary, if history was truncated
[history]   recent messages from the conversation, in order
[tools]     Tool definitions (name + description + JSON schema)
```

**History strategy (MVP)** — send the full history, fail loudly if it doesn't fit. *Intended:* a pre-flight headroom check (~80% of context) fails the run with `error='context_overflow'` so the owner can react. **Not yet built:** no headroom check today — overflow surfaces only as whatever raw provider error comes back. No automatic summarization in MVP (silent summarization loses context invisibly; modern 200k+ windows rarely hit this). **Presence-dependent:** fail-loudly only works with a human watching — autonomous triggers (§9.4) can't, so their overflow policy is the mandatory auto-summarize-with-trace of §7.7 (RUNTIME.md).

**History strategy (post-MVP)** — explicit summarization, chosen when needed: either *interaction-gated* (raise a `question` to approve summarizing the oldest N) or *auto-with-trace* (summarize but record it as a synthetic message + trace + NOTIFY).

**Tool scoping (MVP)** — every tool available to every conversation. Post-MVP: a `conversations.tools_allowed` array restricts per conversation (one column + a filter in assembly).

**Per-ingress persona overlays (post-MVP)** — the persona markdown can carry `## When on Discord` / `## When on Voice` sections appended by ingress, for tone shifts without forking the persona.

**Identity** — trivial for a single user: the identity block states "You are talking to Ingvar," the time, and the ingress. Multi-user is out of scope (§1). **Single agent, many tools** — no multi-agent orchestration in v1.

### 7.6 Concurrency, serialization & resource ownership · 7.7 Autonomous & long-horizon runs

**Moved to `docs/RUNTIME.md`** (§7.6, §7.7). In brief: the **run, not the worker, is the unit of serialized execution** — one active run per conversation (partial unique index), the browser a single shared resource, crashes **fail-and-restart** rather than durably resume. Autonomous runs (§9.4) reserve three seams now (presence-dependent overflow, a durable objective scratchpad, layered run/objective/daily budgets) so adding triggers is wiring, not a redesign — none built in MVP.

---

## 8. Browser Integration

The agent drives the owner's real Chrome (real logins) via a **Chrome extension**, not Playwright/CDP — modern bot defenses (Cloudflare, Datadome, banks) reliably detect headless/CDP-attached Chrome.

**Built (step 5) as Option C — bridge *embedded in the worker*, no separate process, no MCP.** Browser commands are **built-in agent-core tools** (§7.3) whose `invoke()` proxies to the extension over a worker-hosted WebSocket (ported from the owner's `chrome-mcp`; the standalone-MCP alternative is §17's rejected option).

**Topology**

```
Chrome (owner's profile, on the server box)
└─ Alfred extension (MV3)
     │ outbound WebSocket → ws://127.0.0.1:<BRIDGE_WS_PORT>
     │   (loopback-only; accepted only if Origin is chrome-extension://…)
     ▼
alfred-worker
   ├─ BrowserBridge (WebSocket server, singleton started at boot)
   └─ agent loop → built-in browser tools → bridge.sendCommand(cmd, params)
```

**Extension** (`chrome-extension/`, a pnpm workspace member, esbuild): an MV3 service worker holds the outbound WebSocket (reconnect-with-backoff, 20s keepalive to survive MV3 suspension); content scripts injected on demand (`chrome.scripting.executeScript`) do the DOM work. Connects to `127.0.0.1` (not `localhost`, which can resolve to IPv6 `::1` and miss the bind).

**Bridge (embedded in the worker):** `BrowserBridge` (`services/worker/src/browser/`) runs a `ws` server on `127.0.0.1:<BRIDGE_WS_PORT>` (default 7865), one extension connection at a time, started at boot / stopped on SIGINT/SIGTERM; the extension reconnects on its own across worker restarts (§7.6). It exposes **22 built-in browser tools** (`navigate`, `click`, `type_text`, `get_page_text`, `evaluate_javascript`, …) — each `invoke()` sends one id-keyed command and awaits the reply (30s timeout); string/structured results capped at 100k chars. **Multi-tab model** (`list_tabs`/`switch_tab`/`open_tab`/`close_tab`). Screenshots ship as image-returning tools (`screenshot`/`screenshot_element`) flowing through agent-core's `image` content part and the per-conversation workspace (§6.5), bypassing the 100k cap (which is for text, not image bytes).

**Containment (no auth token, no MCP)** — two cheap guards replace the originally-planned shared `BRIDGE_AUTH_TOKEN`: (1) **loopback bind** (`127.0.0.1`, so off-box devices can't reach it); (2) **Origin guard** — the WS upgrade is accepted only if `Origin` starts with `chrome-extension://`, which a visited webpage **cannot forge**, closing the drive-by where a page impersonates the extension. (A non-browser local process could still spoof it — out of scope on a single-user box.)

**Approval strategy (MVP):** trust tiers don't fit the browser (mechanical primitives; danger is in the page — §16), and the structural answer is deferred, so as a stopgap **every browser tool is `write`-tier** and pauses for approval (§10.2 / RUNTIME.md). High-friction by design; the browser remains the highest-risk component (§16).

---

## 9. Ingresses

All ingresses follow the same shape: receive input → look up/create the conversation row → enqueue a job (pg-boss) → `LISTEN` on the conversation channel → forward `NOTIFY` payloads back → finalize on job complete. For a single-user system they talk **directly to Postgres/pg-boss** (routing through the webserver's API is cleaner but more code — deferred until there's a reason).

### 9.1 Webserver (`alfred-webserver`)

**Hono** (small, fast, no SSR — the UI is a single-page chat behind auth). Actual routes (`services/webserver/src/app.ts`):

- `GET /*` — serve the built PWA (static, fallback `index.html`).
- `POST /api/conversations/:id/messages` — user message → create run + job; `GET …/messages` — history; `GET …/stream` — **SSE** (LISTENs `conversation:<id>`, forwards each NOTIFY raw).
- `GET`/`POST /api/interactions/:id` — generic fetch-prompt + first-writer-wins resolve, serving *both* approvals and questions (§10.2).
- `GET`/`PATCH /api/tools` — tool catalog + per-tool approval settings (§16); `GET /api/debug/runs[/:id]` — `/debug` observability (§6.5).

No conversation-*list* route yet — the client opens a single conversation by id (a list view is post-MVP, §11).

### 9.2 Discord · 9.3 Voice · 9.4 Autonomous triggers — all post-MVP

**Moved to `docs/INGRESSES.md`** (§9.2–9.4). All three reuse the §9 ingress contract above; in brief: **Discord** (`alfred-discord`, discord.js — owner-ID-filtered, streaming reply edits, reactions as approval UI); **Voice** (`alfred-voice`, native-app-only, cloud STT/TTS with server-side keys, on-device wake word — the agent core stays the brain); **Autonomous triggers** (`alfred-triggers`, no human at the other end — scheduled / event-driven / agent-initiated, same enqueue+LISTEN+notify transport, different execution lifecycle per §7.7 / RUNTIME.md). Full detail in `INGRESSES.md`.

---

## 10. Runtime Flows

**Moved to `docs/RUNTIME.md`** (§10): the cross-process choreography — happy path (§10.1), interaction/approval protocol + multi-ingress surfacing (§10.2–10.3), timeouts (§10.4), worker-crash sweep (§10.5), cancellation (§10.6), errors (§10.7 — LLM retry/backoff and the cost cap are *planned, not yet built*), idempotency (§10.8), and the **state machines & invariants** governing the three `status` columns (§10.9). Read it before touching the worker, loop, or run state.

---

## 11. Web Frontend

**Stack** (as built — `clients/web/package.json`): **Vite + React + TS** (non-SSR SPA); **Tailwind v4** owning the design tokens (warm espresso/brass theme) with hand-rolled components (shadcn/Radix planned but *not adopted* — too small to earn it) and self-hosted Hanken Grotesk (no CDN, per CONCEPT); **`react-router-dom`** for Chat (`/`), Tools (`/tools`), Debug (`/debug`); **streaming via a hand-rolled `EventSource`**, not `@ai-sdk/react` (neither it nor TanStack Query is installed — chat state is plain `useState`, non-chat fetches plain `fetch`). **PWA (`vite-plugin-pwa`) planned, not yet installed** — a plain HTTPS SPA today; installability + Web Push land when notifications do (push intended for "agent finished" / "approval needed"; iOS 16.4+). **No voice — the PWA is chat-only** (§9.3).

**Screens** — *Built:* Chat (single conversation by id; approvals render *inline* as a card), Tools (per-tool approval settings, §16), Debug (`llm_calls` view, §6.5). *Planned:* a conversation list/history view (no list route yet, §9.1), an approvals queue, and Settings (keys, integrations, persona).

---

## 12. Authentication

**Network position is the authentication.** The server has no public exposure — only the owner's tailnet (and LAN behind the firewall) can reach it, so for a single user being able to connect *is* being the owner: no login screen, no passwords, no Auth.js. Expose via `tailscale serve` (or Caddy-with-Tailscale), which also provides the HTTPS the PWA needs. Tailscale injects identity headers (`Tailscale-User-Login`) but the app reads none — the single-user model doesn't need to know *which* person. Real per-user auth (Auth.js magic-link/passkey + the header) only goes in if access ever extends beyond the owner. Internal processes share one machine + trust boundary — no inter-process auth.

---

## 13. Configuration & Secrets

Three layers, increasing specificity: **(1) defaults in code** (`packages/shared/config.ts` fallbacks — the app boots without an env file, limited); **(2) environment variables** (`.env` at the project root, zod-validated at startup, all secrets here); **(3) DB runtime config** (post-MVP `runtime_config` table for restart-free changes — model, cost caps, persona; reserved, not in MVP).

### 13.1 .env layout

The *target* layout. Only the built keys are in the zod schema / `.env.example` today (`WEBSERVER_PORT`, `POSTGRES_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `BRIDGE_WS_PORT`); the rest are **reserved for post-MVP ingresses**, documented here so the layout is whole.

```
# Built
POSTGRES_URL=postgres://alfred:...@localhost:5432/alfred
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash    # provider-scoped; a future provider adds OPENAI_MODEL/etc.
BRIDGE_WS_PORT=7865              # loopback-only WS for the extension; no token/MCP (127.0.0.1 + Origin guard)
WEBSERVER_PORT=3000
# Observability is in-Postgres (llm_calls + /debug) — no keys.

# Reserved (post-MVP)
TAILSCALE_USER_HEADER=Tailscale-User-Login    # not read today (§12)
ALLOWED_DISCORD_USER_ID=<owner's Discord ID>
DISCORD_BOT_TOKEN=<from Discord developer portal>
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
```

### 13.2 Loading and validation

Each process imports a typed `loadConfig()` from `packages/shared/config.ts`: `dotenv.config()` at boot, validates via **zod** (helpful errors), returns a typed object (no `process.env.X` elsewhere), and **fails fast** if anything required is missing. *Intended:* each process declares only the subset it needs, minimizing blast radius. *Today:* a single shared schema all processes validate against; optionality (`POSTGRES_URL`, `GEMINI_API_KEY`) lets a process boot without keys it doesn't use — the per-process split isn't built yet.

### 13.3 File permissions and storage

`.env` lives at the repo root, mode `0600`, `.gitignored`; `.env.example` is committed with placeholders. Backups **must** include `.env` separately from the DB dump — without it, restoring the database is useless (no process can boot).

### 13.4 Rotation

Manual for MVP: edit `.env`, `pm2 reload all` (Gemini key from Google AI Studio; Discord token from the developer portal). Post-MVP option: OS keychain (macOS Keychain / libsecret / Windows Credential Manager) — worth doing the day backups land off-box.

---

## 14. Project Structure

Single git repo. **pnpm workspaces** owns the TypeScript stack; non-TS sub-projects (iOS) sit alongside in their own toolchain corners — polyglot by **colocation**, not by tooling integration.

```
alfred/
├─ services/                ← backend processes (Node/TS, pnpm workspace members)
│  ├─ webserver/            ← Hono (API + static serving)
│  ├─ worker/               ← agent worker (+ embedded browser bridge: src/browser/)
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
├─ chrome-extension/        ← MV3 extension (pnpm workspace member; built with esbuild; talks to the worker's embedded bridge)
├─ ecosystem.config.cjs     ← pm2 process definitions for services/*
├─ pnpm-workspace.yaml      ← lists services/*, clients/web, packages/*, chrome-extension
├─ package.json             ← root scripts (build, dev, lint)
└─ README.md
```

### 14.1 services/ vs clients/

`services/` — long-running backend processes, all pm2-supervised, none human-facing, sharing the TS toolchain and `packages/`; named for what they *do*. `clients/` — anything a person interacts with (web + iOS colocated so cross-surface changes are visible in the tree, despite different stacks). Only `clients/web` is opened directly by an end user; everything in `services/` is plumbing.

### 14.2 Polyglot handling (iOS specifically)

iOS uses **Swift + SPM + Xcode**, ignored from pnpm's perspective (`pnpm-workspace.yaml` excludes `clients/ios/**`; Xcode opens `Alfred.xcworkspace` with its own SPM deps; CI runs TS and iOS as independent pipelines). The one-repo payoff: a cross-cutting change (e.g. a voice WS protocol field) lands in **one atomic commit** across `services/voice/` + `clients/ios/`. Splitting iOS out later is easy; merging two repos back is hard.

### 14.3 chrome-extension/ placement

The extension is TS but lives at the **repo root**, not `clients/`: not user-facing (the human uses Chrome; it's a transparent helper), its own esbuild build (`build.js`), and it shares the wire-protocol types (`WebSocketRequest`/`WebSocketResponse`) with the worker's bridge **duplicated, not imported** (a browser/esbuild build can't pull in a Node package), synced by hand. Conceptually a peer of the embedded bridge, in Chrome instead of Node.

### 14.4 Day-to-day commands

```
pnpm install                          # workspace setup
pnpm --filter "./services/*" build    # build all services
pnpm --filter web dev                 # web dev server
pm2 start ecosystem.config.cjs        # bring services up  (pm2 reload all = post-deploy)
open clients/ios/Alfred.xcworkspace   # iOS, post-MVP — Xcode does the rest
```

---

## 15. Build Order

Each step is independently verifiable; the seams (Postgres queue, SSE, MCP) don't change between steps. **Steps 1–5 (incl. tools+approval and vision) are built; step 6 and all post-MVP steps are planned.**

1. ✅ **Hono webserver + stub Vite+React over HTTPS** (Tailscale auth, verified from phone over tailnet).
2. ✅ **Postgres + Drizzle schema** (`users`/`conversations`/`messages`/`agent_runs`/`llm_calls` + pg-boss tables).
3. ✅ **Agent core** — provider abstraction + **Gemini** impl, hand-rolled loop, `Tool` interface.
4. ✅ **Real model + observability end to end** — the loop talks to Gemini via `alfred-worker` (pg-boss), streaming tokens `NOTIFY`→SSE→web; every call traced to `llm_calls` + `/debug`. Plus **tools + approval** (trust-tier gate, §16) — turns Alfred from chat into action.
5. ✅ **Browser bridge + Chrome extension** — Option C (§8: embedded bridge, built-in tools, no MCP; ported from `chrome-mcp`). Plus **vision + image support** — per-conversation workspaces (§6.5), an `image` content part + Gemini `inlineData`, screenshots + web upload, `generate_image`, and a workspace-confined `list_files`/`read_file`/`write_file` trio (spec `docs/specs/2026-06-05-conversation-workspace-and-images.md`).
6. **Discord bot** — second ingress, same conversation shape, shared memory.

**End of MVP.** Post-MVP, rough priority: **7.** more MCP integrations (Gmail, Calendar, …) one at a time; **8.** voice orchestrator + native iOS app (hands-free, on-device wake-word, cloud STT/TTS); **9.** autonomous triggers (scheduler + first watcher, likely inbox); **10.** long-term memory (pgvector, §17); **11.** backup strategy (§17).

---

## 16. Security & Blast Radius

**Moved to `docs/RUNTIME.md`** (§16). An agent with browser access to email/banking/messaging is enormously dangerous (prompt injection from a page/email it reads). In brief: tools declare a **trust tier** (`read`/`write`/`destructive`); `write`/`destructive` pause for a runtime-injected approval; the tier is the **owner-overridable default** (`tools.require_approval` tri-state from the Tools page — even destructive is overridable, with only a UI confirm guard), and tiers are owner-assigned, never server-declared. Per-tool tiers gate *semantic* tools but **not the browser** (mechanical primitives; danger in the page) — its real containment is structural (profile isolation, domain gating, task-scoped approval), **not yet built**; step-5 stopgap is every browser tool `write`-tier + loopback + Origin guard (§8). Full detail in `RUNTIME.md`.

---

## 17. Decisions & Open Questions

### Resolved

- **Agent loop: hand-rolled.** No framework wrapping the model client — direct ownership of streaming, tool-call parsing, history.
- **Tool interface: unified.** MCP-sourced and built-in tools share one interface (§7.3).
- **Browser bridge: in-house, embedded in the worker, no MCP (Option C, §8).** Ported from `chrome-mcp` but the WS server lives *inside* `alfred-worker` with built-in-tool commands. Rejected: (A) standalone MCP/HTTP+SSE process (adds MCP before it earns its keep; restart-survival redundant with the extension's reconnect); (B) standalone plain-HTTP (worst of both). Containment = loopback + Origin guard, not a token.
- **Voice scope: native app only**; provider lean ElevenLabs or Google; platform iOS — all deferred to the voice build.
- **Process supervisor: pm2.** Cross-platform default; native supervisors as fallback.
- **Observability: lightweight, in-Postgres** (`llm_calls` + `/debug`). Langfuse rejected — self-host drags in ClickHouse+Redis+Docker; cloud ships personal data off-box.
- **Concurrency & crash model: serialize, don't recover** (§7.6 / RUNTIME.md). One active run per conversation, browser a single shared resource, crashes fail-and-restart. Reversible later.
- **Autonomous lifecycle seams reserved** (§7.7 / RUNTIME.md): presence-dependent overflow, objective scratchpad, self-scheduling, layered budget.

### Deferred to future work

- **Voice framework** — hand-rolled Node + cloud SDKs vs. LiveKit Agents vs. managed Vapi/Retell. Decide at voice-build time.
- **Long-term memory** — remembering across conversations via **pgvector** embeddings. Open: when, what to embed (raw vs. summaries), scope. Not v1.
- **Backup strategy** — Postgres dumps + Chrome profile + `.env` off-box (Tailscale NAS or encrypted bucket). Before anything irreplaceable lands. Not MVP.

---

## 18. Summary

(Topology diagram in §2.)

- **One agent identity, many concurrent conversations** (discrete worker runs, shared state). **Ingresses and tools both interchangeable** behind single interfaces — ingresses all "submit job, stream back"; MCP-sourced and built-in tools share one `Tool` interface.
- **Hand-rolled agent loop**, no framework. **Postgres the only stateful infra** (state + pg-boss queue + LISTEN/NOTIFY). **pm2** supervises Node natively on Linux/macOS/Windows — no Docker, no WSL2.
- **Browser automation** via Chrome extension (undetectable) → loopback WS → worker-embedded bridge (built-in tools, no MCP). **LLM provider abstraction** — Gemini default, swappable. **Observability** — every call → `llm_calls` → `/debug`.
- **Tailscale** = remote access; **network position is the auth** (no public exposure, nothing to log into).
