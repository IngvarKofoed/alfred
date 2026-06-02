# Agent core (Gemini) — build-order step 3

Build `packages/agent-core` — the project's own hand-rolled agent loop (no framework, §7.1/§17) — with four pieces: a streaming `LlmProvider` abstraction (§7.2), a `GeminiProvider` implementation on Google's `@google/genai` SDK (streaming + function-calling), the unified `Tool` interface (§7.3) plus one built-in `echo` tool, and the loop that ties them together. It's a **library** this step: proven by a deterministic fake-provider unit test and a `GEMINI_API_KEY`-gated integration test + CLI runner that hit real Gemini. No worker, pg-boss, NOTIFY, SSE, or web wiring yet — that's the next step.

Grounded in `docs/ARCHITECTURE.md` §7 (agent core), §6/§10 (data + runtime flows), §13 (config), §15 (build order), `docs/DATABASE.md`, and the existing `packages/shared` / `packages/db` patterns.

## Key decisions

- **New `packages/agent-core`, framework-free** (new). Our own loop/provider/tool code, not a wrapper over the Vercel AI SDK (§7.1, §17). Built with `tsc` like `packages/shared`/`db`.
- **`LlmProvider` is a streaming async-iterable** (new, §7.2). `provider.stream(messages, tools, opts)` yields a sequence of events (text deltas and tool-call requests). The loop consumes events; vendors live behind this one interface so a swap is config, not code.
- **`GeminiProvider` on `@google/genai`** (new). The current unified Google Gen AI SDK (not the sunset `@google/generative-ai`). It maps our messages → Gemini `contents`, our `Tool` definitions → `functionDeclarations`, streams `generateContentStream`, and yields text + `functionCall` events; tool results go back as `functionResponse` parts.
- **`Tool` interface + built-in `echo`** (new, §7.3). `{ name, description, inputSchema, trustTier, invoke(args) }`. `echo` is `read`-tier and returns its input — enough to exercise a full tool-call round-trip. `trustTier` exists on the type but **nothing enforces approvals this step** (that's the worker/runtime, later).
- **agent-core owns its message/content/tool-call types** (new). A small provider-agnostic model (roles + `text` / `tool_use` / `tool_result` parts) shaped *compatibly* with `messages.content` jsonb (§6.1) but not importing `packages/db` — mapping to rows happens at persistence time, a later step.
- **Config: `GEMINI_API_KEY` + `DEFAULT_MODEL` optional in shared** (extends). Same pattern as `POSTGRES_URL` (step 2): optional in the shared zod schema so non-LLM processes still boot; the `GeminiProvider` fails fast if the key is missing when constructed.
- **Verification: fake provider + gated real call** (extends). The loop is unit-tested with a scripted fake `LlmProvider` (deterministic, offline). A separate integration test + CLI runner hit real Gemini and **skip when `GEMINI_API_KEY` is unset** — the same skip-without-credential pattern as the db integration test.
- **Pipeline deferred** (diverges from §15 step 3 wording). §15 step 3 wires this into `alfred-worker` + pg-boss + NOTIFY + SSE + web. Here agent-core stays a standalone library; the pipeline is its own next increment so each step stays independently verifiable.

## Goals

- A hand-rolled loop that streams assistant text and completes a tool-call round-trip, fully provider-agnostic.
- A real `GeminiProvider` proven against the live API (streaming + function-calling).
- The loop covered by a deterministic, offline unit test.
- The API key + model wired through the existing typed config.

## Non-goals

- `alfred-worker`, pg-boss, LISTEN/NOTIFY, the SSE endpoint, web streaming UI — next step.
- Persisting messages/runs to the DB (`agent_runs`/`tool_calls` tables come with the worker).
- MCP-sourced tools, `ask_user`, approval/trust-tier *enforcement* — only the `echo` built-in here.
- Persona/system-prompt assembly (§7.5), history truncation, cost caps, retries — a minimal system-instruction passthrough only.
- A second provider — Gemini only; the abstraction merely proves swap-ability.

## Design

### Layout (`packages/agent-core`)

```
packages/agent-core/
├─ package.json            @alfred/agent-core; deps: @google/genai, @alfred/shared
├─ tsconfig.json           extends ../../tsconfig.base.json
└─ src/
   ├─ types.ts             Message, ContentPart, StreamEvent, ToolCall
   ├─ provider.ts          LlmProvider interface
   ├─ providers/gemini.ts  GeminiProvider
   ├─ tool.ts              Tool interface + the echo built-in
   ├─ loop.ts              runAgent() — the hand-rolled loop
   ├─ cli.ts               tiny runner: prompt -> streamed reply (manual proof)
   ├─ index.ts             public exports
   ├─ loop.test.ts         fake-provider unit test (always runs)
   └─ gemini.test.ts       real-Gemini integration test (skips without key)
```

### Types (`types.ts`)

```ts
type Role = 'system' | 'user' | 'assistant' | 'tool'
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; result: unknown }
type Message = { role: Role; content: ContentPart[] }

type StreamEvent =
  | { type: 'text'; text: string }                          // a streamed delta
  | { type: 'tool_call'; id: string; name: string; args: unknown }
```

### Provider (`provider.ts`)

```ts
interface LlmProvider {
  stream(messages: Message[], tools: Tool[], opts?: { model?: string; signal?: AbortSignal }):
    AsyncIterable<StreamEvent>
}
```

`GeminiProvider` constructs `new GoogleGenAI({ apiKey })`, translates `messages`→`contents` and `tools`→`functionDeclarations`, calls `generateContentStream`, and yields `text`/`tool_call` events. A system message becomes Gemini's `systemInstruction`.

### Tool (`tool.ts`)

```ts
interface Tool {
  name: string
  description: string
  inputSchema: object        // JSON Schema, for the model
  trustTier: 'read' | 'write' | 'destructive'
  invoke(args: unknown): Promise<unknown>
}
```

`echo`: `read`-tier, `inputSchema` = `{ text: string }`, `invoke` returns `{ echoed: args.text }`.

### Loop (`loop.ts`)

`runAgent({ provider, tools, messages, onText })` runs:

1. `for await` over `provider.stream(messages, tools)`: emit `text` deltas via `onText`, collect any `tool_call`s.
2. Append the assistant message (accumulated text + `tool_use` parts).
3. If there were no tool calls → return the final messages (done).
4. Otherwise `invoke` each requested tool, append a `tool_result` message per call, and loop back to step 1.

Streaming, tool-call parsing, and history handling are all explicit here — the "hand-rolled" point of §7.1.

### Verification

- **`loop.test.ts`** (always runs): a fake `LlmProvider` scripted to (round 1) request `echo`, then (round 2) emit final text. Asserts the loop invoked `echo`, fed the result back, and produced the final assistant message — the full round-trip, offline and deterministic.
- **`gemini.test.ts`** (`describe.skipIf(!GEMINI_API_KEY)`): prompts real Gemini to use the `echo` tool and asserts a tool call happened and a final text answer came back.
- **`cli.ts`**: `pnpm --filter @alfred/agent-core exec tsx src/cli.ts "<prompt>"` — streams a real reply to the terminal for manual play.

## Open questions

None — resolved during review: `DEFAULT_MODEL` = `gemini-2.5-flash`; agent-core's message/content types stay independent of `packages/db` (mapping layer added when persistence lands).

## Alternatives considered

- **Vercel AI SDK** (`ai` + `@ai-sdk/google`) owning the loop. Less code, but it's exactly the framework §17 rejected; we lose direct control of streaming/tool-call/history. The SDK stays a frontend-only choice (`@ai-sdk/react`, §11).
- **Full vertical slice now** (worker + pg-boss + NOTIFY + SSE + web). Rejected for this step — bundles the agent core with the distributed pipeline (and its run/crash state machine, §10.9), making the result hard to verify; split into two steps.
- **`@google/generative-ai` SDK.** The older Google SDK, now being sunset in favor of `@google/genai`.
