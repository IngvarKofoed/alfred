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

**Moved to `docs/DEPLOYMENT.md`** (§3). In brief: any always-on home box, OS-agnostic; **Tailscale** for remote access (no public exposure, encrypted private IPs). Why a home box, not a VPS: same home IP as the owner → fewer "new device" challenges, and credentials never leave the house.

---

## 4. Deployment & OS

**Moved to `docs/DEPLOYMENT.md`** (§4, incl. §4.1 Windows-as-server notes). In brief: a native stack (no Docker, no WSL2) — the same code on Linux/macOS/Windows, only the supervisor + a few paths differ.

---

## 5. Process Topology

**Moved to `docs/DEPLOYMENT.md`** (§5). In brief: **pm2** supervises native Node processes from one `ecosystem.config.cjs`. Built today: `alfred-webserver` + `alfred-worker` (the browser bridge is embedded in the worker, §8) + `alfred-updater` (auto-deploy, inert unless `DEPLOY_ENABLED=true`); `alfred-discord`/`alfred-voice`/`alfred-triggers` are the reserved post-MVP shape.

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
- `memory_facts` — **planned, not yet created** (design only; no schema entry or migration yet, §6.4).

`agent_runs` + `tool_calls` + `user_interactions` together are the audit log — no separate `audit_log` table.

### 6.2 NOTIFY channels and payloads

Channel: **`conversation:<conversation_id>`** — keyed on the conversation, not the run, because an ingress subscribes before it knows the run id and a conversation has at most one active run (§7.6), so it can follow successive runs over one subscription. Payload shape emitted by the worker (`services/worker/src/events.ts`):

```ts
type RunEvent =
  | { type: 'token';                text: string }
  | { type: 'tool_call_start';      id: string; toolName: string; args?: unknown }
  | { type: 'tool_call_end';        id: string }
  | { type: 'title';                title: string }
  | { type: 'tts_audio';            seq: number; path: string; mimeType: string }
  | { type: 'interaction_required'; interactionId: string; kind: 'approval' | 'question' }
  | { type: 'interaction_resolved'; interactionId: string }
  | { type: 'done' }
  | { type: 'cancelled' }           // emitted by the webserver cancel route, not the worker (§10.6)
  | { type: 'error';                message: string }
```

`NOTIFY` payloads have an **8000-byte limit**, so events reference IDs and consumers `SELECT` the rows for full payloads (DB is the source of truth). Hence: `tool_call_start` includes `args` only when their JSON is ≤1024 chars (a large `evaluate_javascript` script can't breach the cap; full args always persist on `tool_calls`); `tool_call_end` carries only the `id` (result lives on the row / `/debug`); `title` carries the worker's auto-generated conversation title (§7.5 auto-name), applied to the chat header + history sidebar; `tts_audio` carries a workspace-relative `path` to a synthesized speech clip (served by `/media`) plus a per-run, 0-based `seq` for playback order — audio bytes never ride NOTIFY; emitted only for `speak` runs (iOS voice, §7.2), ignored by the web client; `interaction_required.kind` is `'approval'` or `'question'` (the `ask_user` question path, CHANGELOG 59); `cancelled` is distinct from `done` and is the one event the worker doesn't emit — the webserver's cancel route (§9.1) NOTIFYs it after writing the run terminal + cascade, and the worker reacts by aborting (§10.6, built).

### 6.3 Job queue (pg-boss)

pg-boss owns its own schema (`pgboss`), treated as a black box. Job payloads are minimal — `type AgentJob = { runId: uuid }` — the `agent_runs` row carries everything else, so a pulled-but-unacked job reconstructs from the run row, migrations don't ripple through payloads, and retries are idempotent (the worker skips already-finished runs). The worker calls `boss.work('agent-run', handler)` with concurrency; because a handler blocks in place while paused for user input (§10.2), `agent-run` jobs use **`retryLimit: 0`** and a **job expiration longer than the max interaction timeout** (§10.4) — a parked worker is never redelivered (no duplicate execution, §7.6), a lost run just fails. Recurring jobs (post-MVP) use `schedule()`.

### 6.4 Memory (planned, not yet created)

The design: a `memory_facts` table with an unused `embedding` column, defined early to force the *what gets remembered* question, give the loop a plain-rows `memory.read(scope)` before pgvector, and make pgvector activation a single migration + index, no schema change. **The "exists from day one" intent was never executed** — the table is in no Drizzle schema and no migration; only this doc and `DATABASE.md` describe it. It lands when memory becomes the active build target (§15 step 10). Open: extraction strategy (LLM-summarized vs. user-flagged), decided then.

### 6.5 What's NOT in the database

| Thing | Where | Why |
|-------|-------|-----|
| API keys / secrets | `.env`, OS keychain | DB compromise shouldn't leak credentials |
| Large attachments (images, PDFs, audio) | Filesystem, by workspace-relative path | Postgres is bad at blobs; FS backs up trivially |
| Chrome browser profile | Where the OS puts it; backed up separately | Owned by Chrome, not us |
| LLM request/response + traces | `llm_calls` table, rolled up onto `agent_runs` | In-house observability on `/debug`; replaces Langfuse (§17) |

**Attachment storage — per-conversation workspaces (built).** The flat `data/attachments/` is superseded by a **per-conversation working directory** `data/conversations/<conversation_id>/` — the foundation for file-bearing capabilities (images and Python execution now, §7.3). Files are referenced by a path *relative to that directory* (a movable, deletable unit), and all access goes through one `resolveInWorkspace(conversationId, relPath)` confinement helper (rejects absolute/`..`/symlink-outs), centralized so a future shared scope is a root swap, not a rewrite. `messages.content` stores the reference (`{ type:'image', path, mimeType }`); the worker bridges it to the inline-base64 the model needs — Postgres/NOTIFY never carry image bytes. Spec: `docs/specs/2026-06-05-conversation-workspace-and-images.md`.

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

**Image generation is a parallel abstraction.** Text streaming lives behind `LlmProvider`; image *generation* lives behind a sibling **`ImageProvider`** interface (`packages/agent-core/src/image-provider.ts`). Two impls are built: `GeminiImageProvider` (Gemini-native "Nano Banana" models over `generateContent` + `inlineData`) and `ImagenProvider` (Imagen 4 models over `generateImages` + `imageBytes`). The worker's `images-registry.ts` maps six model ids to the right provider, and the built-in `generate_image` tool takes a `model` enum arg so the agent picks per call (default `gemini-2.5-flash-image`). The cost of these out-of-loop AI calls is attributed via the tool-context seam (§7.3) and recorded on `llm_calls` linked to the originating `tool_call` (§6.5).

**Speech is another parallel pair.** Voice (iOS, §9.3/INGRESSES) rides the text pipeline as an I/O modality, fronted by sibling **`SttProvider`** (audio→text) and **`TtsProvider`** (text→audio) interfaces (`packages/agent-core/src/speech-provider.ts`). Google (`@google/genai` + `GEMINI_API_KEY`, Gemini-native audio; PCM TTS wrapped in a WAV container, no transcode dep) and ElevenLabs (`fetch` + `ELEVENLABS_API_KEY`) impls are selected by `makeSttProvider()`/`makeTtsProvider()` on the `STT_PROVIDER`/`TTS_PROVIDER` config (default `google`); a missing key for the selected provider errors at call time, never at boot. The webserver uses STT (its first `@alfred/agent-core` dependency), the worker uses TTS.

### 7.3 Tool interface

All tools, regardless of origin, look the same to the agent loop:

```ts
interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema           // for the model
  trustTier: 'read' | 'write' | 'destructive'   // see §16
  group?: string                    // e.g. 'browser' — the worker uses it for group-scoped approval (§16)
  invoke(args: unknown, ctx?: ToolContext): Promise<ToolResult>
}
// ctx is optional + backward-compatible: a tool that makes its own AI calls (e.g. generate_image)
// reports them via ctx.recordLlmCall so the cost reaches llm_calls / agent_runs (§6.5); plain tools ignore it.
```

Tools come from two sources, both adapted to this interface:

- **MCP-sourced tools** — the agent core opens MCP client connections (stdio for short-lived subprocess servers, HTTP+SSE for long-running ones) at startup and converts each `tools/list` into `Tool`s whose `invoke` proxies via `tools/call`. The loop never sees MCP. *None exist yet* — the browser is **not** MCP-sourced (it's built-in tools over the embedded bridge, §8).
- **Built-in tools** — `Tool` directly inside `agent-core` or the worker: trivial utilities (`echo`, `set_conversation_title`), the browser tools (§8), the image/file tools — `generate_image` plus a workspace-confined `list_files`/`read_file`/`write_file` trio (§6.5) — the Python tools — `run_python`/`pip_install` over a shared lazily-created venv, cwd = the conversation workspace, group `python` (spec `docs/specs/2026-06-10-python-execution-sandbox.md`) — and the email tools — `list_emails`/`search_emails`/`read_email` (read-tier) plus `save_draft`/`send_email` (write-tier), connect-per-call over IMAP/SMTP, group `email` (spec `docs/specs/2026-06-10-email-tools.md`). *Planned, not yet built:* **`ask_user`**, whose `invoke()` *would* create a `user_interactions` row of kind `question`, pause the run, and resume on response (the agent would call it like any tool; §6.1 has the shape). The DB column allows `kind='question'`, but nothing references `ask_user` today — the `question` pause path is reserved, not wired (§6.2).

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

*Built today:* the `[system]` slot is the static `SYSTEM_PROMPT` alone — the **identity block (current time, ingress, user) is not yet injected**; like the persona file above, a small deferred piece, not current behaviour.

**History strategy (MVP)** — send the full history, fail loudly if it doesn't fit. *Intended:* a pre-flight headroom check (~80% of context) fails the run with `error='context_overflow'` so the owner can react. **Not yet built:** no headroom check today — overflow surfaces only as whatever raw provider error comes back. No automatic summarization in MVP (silent summarization loses context invisibly; modern 200k+ windows rarely hit this). **Presence-dependent:** fail-loudly only works with a human watching — autonomous triggers (§9.4) can't, so their overflow policy is the mandatory auto-summarize-with-trace of §7.7 (RUNTIME.md).

**History strategy (post-MVP)** — explicit summarization, chosen when needed: either *interaction-gated* (raise a `question` to approve summarizing the oldest N) or *auto-with-trace* (summarize but record it as a synthetic message + trace + NOTIFY).

**Tool scoping (MVP)** — every tool available to every conversation. Post-MVP: a `conversations.tools_allowed` array restricts per conversation (one column + a filter in assembly).

**Per-ingress persona overlays (post-MVP)** — the persona markdown can carry `## When on Discord` / `## When on Voice` sections appended by ingress, for tone shifts without forking the persona.

**Identity** *(intended — the block isn't injected yet, see above)* — trivial for a single user: the identity block states "You are talking to Ingvar," the time, and the ingress. Multi-user is out of scope (§1). **Single agent, many tools** — no multi-agent orchestration in v1.

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

**Bridge (embedded in the worker):** `BrowserBridge` (`services/worker/src/browser/`) runs a `ws` server on `127.0.0.1:<BRIDGE_WS_PORT>` (default 7865), one extension connection at a time, started at boot / stopped on SIGINT/SIGTERM; the extension reconnects on its own across worker restarts (§7.6). It exposes **24 built-in browser tools** (`navigate`, `click`, `type_text`, `get_page_text`, `evaluate_javascript`, `scroll`, `query_selector`, …) — each `invoke()` sends one id-keyed command and awaits the reply (30s timeout); string/structured results capped at 100k chars. **Multi-tab model** (`list_tabs`/`switch_tab`/`open_tab`/`close_tab`). Screenshots ship as image-returning tools (`screenshot`/`screenshot_element`) flowing through agent-core's `image` content part and the per-conversation workspace (§6.5), bypassing the 100k cap (which is for text, not image bytes).

**Containment (no auth token, no MCP)** — two cheap guards replace the originally-planned shared `BRIDGE_AUTH_TOKEN`: (1) **loopback bind** (`127.0.0.1`, so off-box devices can't reach it); (2) **Origin guard** — the WS upgrade is accepted only if `Origin` starts with `chrome-extension://`, which a visited webpage **cannot forge**, closing the drive-by where a page impersonates the extension. (A non-browser local process could still spoof it — out of scope on a single-user box.)

**Approval strategy (MVP):** trust tiers don't fit the browser (mechanical primitives; danger is in the page — §16), and the structural answer is deferred, so as a stopgap **every browser tool is `write`-tier** and pauses for approval (§10.2 / RUNTIME.md). High-friction by design; the browser remains the highest-risk component (§16).

---

## 9. Ingresses

All ingresses follow the same shape: receive input → look up/create the conversation row → enqueue a job (pg-boss) → `LISTEN` on the conversation channel → forward `NOTIFY` payloads back → finalize on job complete. For a single-user system they talk **directly to Postgres/pg-boss** (routing through the webserver's API is cleaner but more code — deferred until there's a reason).

### 9.1 Webserver (`alfred-webserver`)

**Hono** (small, fast, no SSR — the UI is a single-page chat behind auth). Actual routes (`services/webserver/src/app.ts`):

- `GET /*` — serve the built PWA (static, fallback `index.html`); `GET /api/health` — liveness.
- `POST /api/conversations/:id/messages` — user message (text and/or `attachments`) → create run + job; `GET …/messages` — history; `GET …/stream` — **SSE** (LISTENs `conversation:<id>`, forwards each NOTIFY raw); `POST …/cancel` — cancel the conversation's active run: terminal `cancelled` write + the §10.9 invariant-4 cascade in one transaction (the shared `terminateRuns`), then a `{type:'cancelled'}` NOTIFY; 409 when nothing is active (§10.6); `GET /api/conversations/:id` — `{ id, title, activeRun }` for the chat header and the refresh-proof busy/Stop state (null title + `activeRun: false` for a never-created conversation, not 404); `GET /api/conversations` — the owner's recent `web` conversations (`{ id, title, lastActiveAt }`, newest-active first, ≤100) backing the history sidebar.
- `POST /api/conversations/:id/commands` — run a backend-owned slash command (`/rename`, `/help`) instead of messaging the agent: no message row, no run, no LLM cost; `GET /api/commands` — the command catalog driving the web autocomplete palette. Spec: `docs/specs/2026-06-09-chat-commands.md`.
- `POST /api/conversations/:id/files` — multipart image upload into the conversation workspace (§6.5); `GET /media/:conversationId/:filename` — serve a workspace file (path-confined; audio Content-Types too). Together they underpin vision input + in-chat image rendering.
- `POST /api/conversations/:id/audio` — multipart audio upload (iOS voice, §7.2): STT-transcribes, then in the same transaction shape as `/messages` inserts the user message (text = transcript) + a `speak` run and returns `{ runId, transcript }`; 422 on an empty transcript (silence), 409 on an active run.
- `GET`/`POST /api/interactions/:id` — generic fetch-prompt + first-writer-wins resolve, serving *both* approvals and questions (§10.2). The POST accepts an optional `remember` flag that persists the decision into `tools.require_approval` (§16).
- `GET`/`PATCH /api/tools` — tool catalog + per-tool approval settings (§16). Debug (§6.5): `GET /api/debug/conversations` — the per-conversation ledger (recent runs grouped by conversation, uncapped token/cost aggregates); `GET /api/debug/runs/:id` — the full per-run exchange. The flat `GET /api/debug/runs` list still exists but the page no longer uses it.

The client routes each conversation at `/conversation/:id` (deep-linkable, refresh-stable; `/` redirects to the last-opened or newest conversation), and `GET /api/conversations` backs a history sidebar (§11). Ordering uses `conversations.last_active_at`, bumped on each posted user message via `ensureConversation({ touch: true })` (spec `docs/specs/2026-06-11-conversation-list-history.md`).

### 9.2 Discord · 9.3 Voice · 9.4 Autonomous triggers — all post-MVP

**Moved to `docs/INGRESSES.md`** (§9.2–9.4). All three reuse the §9 ingress contract above; in brief: **Discord** (`alfred-discord`, discord.js — owner-ID-filtered, streaming reply edits, reactions as approval UI); **Voice** (`alfred-voice`, native-app-only, cloud STT/TTS with server-side keys, on-device wake word — the agent core stays the brain); **Autonomous triggers** (`alfred-triggers`, no human at the other end — scheduled / event-driven / agent-initiated, same enqueue+LISTEN+notify transport, different execution lifecycle per §7.7 / RUNTIME.md). Full detail in `INGRESSES.md`.

---

## 10. Runtime Flows

**Moved to `docs/RUNTIME.md`** (§10): the cross-process choreography — happy path (§10.1), interaction/approval protocol + multi-ingress surfacing (§10.2–10.3), timeouts (§10.4), worker-crash sweep (§10.5), cancellation (§10.6), errors (§10.7 — LLM retry/backoff is built; the cost cap remains *planned, not yet built*), idempotency (§10.8), and the **state machines & invariants** governing the three `status` columns (§10.9). Read it before touching the worker, loop, or run state.

---

## 11. Web Frontend

**Stack** (as built — `clients/web/package.json`): **Vite + React + TS** (non-SSR SPA); **Tailwind v4** owning the design tokens (warm espresso/brass theme) with hand-rolled components (shadcn/Radix planned but *not adopted* — too small to earn it) and self-hosted Hanken Grotesk (no CDN, per CONCEPT); **`react-router-dom`** for Chat (`/conversation/:id`, with `/` redirecting to the last-opened or newest conversation), Tools (`/tools`), Debug (`/debug`); **streaming via a hand-rolled `EventSource`**, not `@ai-sdk/react` (neither it nor TanStack Query is installed — chat state is plain `useState`, non-chat fetches plain `fetch`). **PWA (`vite-plugin-pwa`) planned, not yet installed** — a plain HTTPS SPA today; installability + Web Push land when notifications do (push intended for "agent finished" / "approval needed"; iOS 16.4+). **No voice — the PWA is chat-only** (§9.3).

**Screens** — *Built:*

- **Chat** (`/conversation/:id`) — streams Alfred's turns as one cohesive live block; approvals render *inline* as a card (with a "don't ask again" checkbox that writes the §16 setting); tool calls show as quiet inline chips; image content (uploads, screenshots, generated) renders as thumbnails with a click-to-zoom lightbox; a paperclip control uploads images; the conversation title sits in the header; and a slash-command palette offers prefix autocomplete (`/rename`, `/help`).
- **Tools** (`/tools`) — per-tool and per-group approval toggles (§16).
- **Debug** (`/debug`) — a **per-conversation ledger**: conversations in a rail (run-status sparkline + token/cost totals), each expanding to a timeline of its runs, each run lazy-loading the full exchange (per-tool cost breakdown, `llm_calls`, tool calls). *Reworked from the original flat per-run `llm_calls` list.*
- **Conversation history** — a collapsible sidebar on the chat surface lists past conversations (newest-active first; titled, or "New conversation" when untitled), each a `/conversation/:id` link with the active one highlighted; a persistent rail on desktop, an overlay drawer on mobile.

*Planned:* an approvals queue and Settings (keys, integrations, persona).

---

## 12. Authentication

**Network position is the authentication.** The server has no public exposure — only the owner's tailnet (and LAN behind the firewall) can reach it, so for a single user being able to connect *is* being the owner: no login screen, no passwords, no Auth.js. Expose via `tailscale serve` (or Caddy-with-Tailscale), which also provides the HTTPS the PWA needs. The webserver's bind interface is configurable (`WEBSERVER_HOST`, default `0.0.0.0` so the LAN/tailnet — e.g. the iOS app — can reach it; set `127.0.0.1` to restrict to loopback when fronted solely by `tailscale serve`); LAN-behind-the-firewall is part of the trusted position, so an unauthenticated LAN bind is in-model, not public exposure. The **browser bridge stays loopback-only** regardless (§8) — it drives the owner's logged-in Chrome and the extension connects from the same box, so it never needs LAN reach. Tailscale injects identity headers (`Tailscale-User-Login`) but the app reads none — the single-user model doesn't need to know *which* person. Real per-user auth (Auth.js magic-link/passkey + the header) only goes in if access ever extends beyond the owner. Internal processes share one machine + trust boundary — no inter-process auth.

---

## 13. Configuration & Secrets

**Moved to `docs/DEPLOYMENT.md`** (§13, incl. §13.1–§13.4). In brief: three layers (code defaults → `.env` zod-validated at boot → post-MVP DB runtime config). Secrets live in `.env` at the repo root (mode `0600`, gitignored), never in the DB; the built keys are `WEBSERVER_PORT`, `POSTGRES_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `BRIDGE_WS_PORT`, `WORKSPACE_ROOT`, `PYTHON_BIN`, `PYTHON_VENV_DIR` (§13.1).

---

## 14. Project Structure

**Moved to `docs/DEPLOYMENT.md`** (§14, incl. §14.1–§14.4). In brief: a single git repo; **pnpm workspaces** owns the TS stack (`services/*`, `clients/web`, `packages/*`, `chrome-extension`); iOS (post-MVP) is colocated under `clients/ios` but outside pnpm. Tree + rationale in §14.1–§14.4.

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
