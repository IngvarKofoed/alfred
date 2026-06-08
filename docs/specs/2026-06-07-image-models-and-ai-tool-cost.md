# Image-generation models + AI-tool cost accounting

Two coupled changes, both centred on `generate_image`. **(1)** Make image generation
multi-model: introduce an `ImageProvider` abstraction (mirroring `LlmProvider`) plus a
model registry, and give the `generate_image` tool a `model` argument the agent picks
per call. Ships **six** models behind two implementations — the three Gemini-native
"Nano Banana" variants (`generateContent` API) and the three Imagen 4 variants
(`generateImages` API); non-Google providers slot in later behind the same interface.
**(2)** Fix the cost hole: AI calls made by tools *outside* the agent loop (today only
`generate_image`) bypass `TracingProvider`, so they never reach `llm_calls` and read as
$0. Route them through a worker-bound `recordLlmCall` recorder, link each to the
`tool_call` that spawned it, surface a per-tool cost breakdown on `/debug`, and close the
deferred image-pricing TODO (`pricing.ts:24-30`) — Gemini-native image models are priced
on their reported output tokens (the existing formula, right rates), Imagen flat per-image
— so the recorded cost is real, not the current ~$0.

## Key decisions

- **`ImageProvider` interface in `agent-core`** (new). Mirrors `LlmProvider`
  (`provider.ts`): `generate(prompt, opts) → { mimeType, data, usage }`. Lives with the
  other provider abstractions; the worker tool dispatches to it. **Two impls:**
  `GeminiImageProvider` (the three Nano Banana models, sharing the `generateContent` +
  `inlineData` path the tool uses today) and `ImagenProvider` (the three Imagen 4 models
  over the different `generateImages` API — `generatedImages[0].image.imageBytes`).
- **Image model registry** (new). A single map `model id → ImageProvider`, the source
  of truth for which image models exist. The `generate_image` tool's `model` enum is
  *derived* from it so the schema can't drift from what's wired — same discipline as
  the tool catalog being derived from real `Tool` instances (`catalog.ts`).
- **Two billing models, resolved** (extends `pricing.ts`; closes the deferred TODO).
  Per the official pricing page, the **Gemini-native** image models bill **per output
  token** ($30/$60/$120 per 1M out) — the API returns the image's token count in
  `candidatesTokenCount`, so the *existing* token formula already prices them (and scales
  with resolution for free, since 4K consumes more tokens). Only **Imagen** is flat
  per-image and reports no tokens, so `ModelPrice` gains optional `perImageOutput?: number`
  used only when set; `computeCostUsd` gains an `images` arg for that case. Loop and
  Gemini-native image calls are unaffected (`perImageOutput` unset ⇒ token formula).
- **`generate_image` gains a `model` enum arg** (extends). The agent chooses per call;
  omitted ⇒ default `gemini-2.5-flash-image` (unchanged behaviour). Owner-config default
  is deferred (non-goal).
- **Cost attribution via a `recordLlmCall` recorder — Approach Y** (new). `Tool.invoke`
  gains an optional second arg `ctx` carrying `recordLlmCall(call)`; the worker binds it
  to insert an `llm_calls` row. Generalises to any future AI-using tool, not just images.
- **`llm_calls.tool_call_id`** — nullable FK (extends; precedent
  `user_interactions.tool_call_id`, `schema.ts:181`). NULL ⇒ an agent-loop call; set ⇒
  attributed to that tool. This is what makes the per-tool breakdown possible.
- **`/debug` cost breakdown** (extends). Group a run's `llm_calls` by `tool_call_id`:
  NULL = "Conversation (LLM loop)"; non-NULL = per tool (joined to `tool_calls.tool_name`).
  The detail endpoint already returns both `calls` and `toolCalls` — grouping is mostly
  client-side in `Debug.tsx`.
- **`agent_runs.model` is the agent LLM only** (extends). `rollupUsage` (`run.ts:271`)
  currently takes the last call's model of *any* kind; once image `llm_calls` exist that
  would mislabel the run as the image model. Fix: derive `model` solely from loop calls
  (`tool_call_id IS NULL`). The image model lives on its own `llm_calls` row and never
  touches `agent_runs.model`. Note the split: run **cost** sums across *all* calls (the
  whole point of attribution); the run **model** reflects only the agent loop.

## Goals

- Let the agent choose among the six Gemini/Imagen image models per call, behind an
  abstraction that accommodates non-Google providers later without touching the tool.
- Count every out-of-loop AI call toward the run's cost (`llm_calls` → `agent_runs`),
  priced correctly — per image for image models.
- Show, on `/debug`, a run's cost split into the conversation (loop) part and each tool
  that actually cost more than $0.

## Non-goals

- **Owner-configurable default model** (a settings/`runtime_config` choice). Deferred —
  the agent picks via the `model` arg for now.
- **Non-Google image providers** (OpenAI gpt-image, Replicate-hosted SD, local). The
  `ImageProvider` interface is shaped for them; no impl here.
- **Batch / Flex / Priority tier pricing.** Each tier has different rates (e.g. Batch
  halves image output); we price at the **standard** tier only, since that's what the tool
  requests. (Gemini-native *resolution* scaling is *not* a non-goal — it's handled free via
  the token count.)
- **A general per-tool *timeout* / budget framework.** Out of scope; this is cost
  *accounting*, not enforcement (the unbuilt cost cap is still §10.7).
- **Per-tool approval differences between image models.** One `generate_image` tool = one
  `tools` row = one approval setting (the one-tool-per-model alternative is rejected below).

## Design

### Part 1 — multi-model image generation

`ImageProvider` in `agent-core` (new file `image-provider.ts`, exported from `index.ts`):

```ts
// images: count of output images (cost basis for image models). promptTokens et al. are
// recorded for observability; output is priced per image (see pricing below).
export interface ImageUsage {
  model: string; images: number
  promptTokens?: number; completionTokens?: number; cachedTokens?: number
}
export interface GeneratedImage { mimeType: string; data: string; usage?: ImageUsage }
export interface ImageProvider {
  readonly model: string
  generate(prompt: string, opts?: { signal?: AbortSignal }): Promise<GeneratedImage>
}
```

Two implementations, because Gemini-native and Imagen are different API surfaces:

- **`GeminiImageProvider`** — wraps the `generateContent` call currently inlined in
  `tools.ts:59-67` (same `GoogleGenAI` client, same `inlineData` extraction), parameterized
  by model id; reads `usageMetadata` for token counts (as the loop does, `gemini.ts:69-73`)
  and sets `images: 1`.
- **`ImagenProvider`** — wraps `ai.models.generateImages({ model, prompt, config:{ numberOfImages:1 }})`;
  pulls bytes from `response.generatedImages[0].image.imageBytes` (+ mimeType); sets
  `images: 1` (Imagen reports no token usage).

The registry lives in the worker alongside `catalog.ts` (it binds the concrete model ids
the worker ships), mapping each id to its provider:

| Model id | API | Enum description |
|---|---|---|
| `gemini-2.5-flash-image` | generateContent | Nano Banana — fast, general creative/editing (default) |
| `gemini-3.1-flash-image` | generateContent | Nano Banana 2 — newer, production-scale |
| `gemini-3-pro-image` | generateContent | Nano Banana Pro — studio-quality, 4K, precise text/layout |
| `imagen-4.0-fast-generate-001` | generateImages | Imagen 4 Fast — cheapest, volume |
| `imagen-4.0-generate-001` | generateImages | Imagen 4 — standard text-to-image |
| `imagen-4.0-ultra-generate-001` | generateImages | Imagen 4 Ultra — tightest prompt adherence |

`makeGenerateImageTool` (`tools.ts:40`) gains a `model` property in `inputSchema` whose
`enum` + per-value descriptions are generated from the registry. `invoke` resolves
`args.model` (default `gemini-2.5-flash-image`) → registry → `provider.generate(prompt)`,
then returns the existing `ImageToolResult` shape — now also carrying `usage` for Part 2.

### Pricing

Two billing models (official list rates, standard tier):

- **Gemini-native (token-based).** The `generateContent` response reports the image's
  output tokens in `candidatesTokenCount` (1290 tokens/1K image for 2.5; 1120 for 1–2K /
  2000 for 4K on Pro, etc.), so the existing `computeCostUsd` token formula prices them
  with the right `inputPerMTok`/`outputPerMTok` — and resolution scales automatically via
  the token count. `MODEL_PRICING` entries:

  | Model | `inputPerMTok` | `outputPerMTok` |
  |---|---|---|
  | `gemini-2.5-flash-image` | `0.30` | `30.0` *(already present — correct)* |
  | `gemini-3.1-flash-image` | `0.50` | `60.0` |
  | `gemini-3-pro-image` | `2.00` | `120.0` |

- **Imagen (flat per-image).** No token usage is reported, so these need
  `perImageOutput`; `computeCostUsd(model, prompt, completion, cached, images=0)` uses
  `images × perImageOutput` when it's set (input/output token rates 0 for these):

  | Model | `perImageOutput` |
  |---|---|
  | `imagen-4.0-fast-generate-001` | `0.02` |
  | `imagen-4.0-generate-001` | `0.04` |
  | `imagen-4.0-ultra-generate-001` | `0.06` |

`ImageUsage.images` is the count for the Imagen path; for the Gemini-native path the
`completionTokens` it also carries are what drive cost.

### Part 2 — cost attribution + breakdown

**The recorder.** `Tool.invoke` becomes `invoke(args, ctx?: ToolContext)` where:

```ts
export interface ToolLlmCall {
  model: string
  promptTokens?: number; completionTokens?: number; cachedTokens?: number; images?: number
  requestSummary?: unknown; responseSummary?: string; finishReason?: string; latencyMs?: number
}
export interface ToolContext { recordLlmCall(call: ToolLlmCall): void | Promise<void> }
```

The loop (`loop.ts:100`) builds a per-call `ctx` and passes it:
`tool.invoke(tc.args, { recordLlmCall: (call) => opts.onToolLlmCall?.(tc.id, call) })`,
where `onToolLlmCall?(callId, call)` is a new optional `RunOptions` hook. Existing tools
ignore the second arg — fully backward-compatible.

**The worker** (`run.ts`) implements `onToolLlmCall(callId, call)`: insert an `llm_calls`
row with `agentRunId = runId`, `toolCallId = toolCallRowIds.get(callId)`, `model`,
tokens, and `costUsd = computeCostUsd(model, promptTokens, completionTokens, cachedTokens, images)`
— the `images` count is what makes the image cost real. `request`/`responseText` get the
summaries (never image base64). Because `rollupUsage` already sums *all* `llm_calls` for
the run (`run.ts:257-273`), the image cost rolls onto `agent_runs.cost_usd` automatically
— no rollup change beyond the model-pick fix (loop-calls-only).

`generate_image`'s `invoke` calls `ctx?.recordLlmCall({ model, images, ...usage })` after a
successful generation, using the `usage` returned by `ImageProvider.generate`.

**Schema.** Migration adds `llm_calls.tool_call_id uuid references tool_calls(id)`,
nullable. Update `DATABASE.md` (`llm_calls` columns + a note that a non-NULL value marks a
tool-originated provider call).

**The breakdown** (`/debug`). `/api/debug/runs/:id` already returns `calls` + `toolCalls`;
add `tool_call_id` to the `calls` projection (it's `select()` today, so it's already
included — confirm). `Debug.tsx` groups the run's calls: NULL → "Conversation (LLM loop)";
non-NULL → bucketed by `tool_call_id`, labelled from the matching `toolCalls` row's name,
shown only when the bucket's summed cost > 0.

### Cancellation note

`generate_image` is not abortable today, and neither is anything else: run cancellation
(§10.6) is **documented but unbuilt** — the loop accepts a `signal` (`loop.ts:31,60`) but
the worker never constructs an `AbortController` or passes one into `runAgent`, and the web
client only *renders* a `cancelled` event (there's no stop button or cancel endpoint).
`ImageProvider.generate` takes an optional `signal` so the seam matches the loop, but it is
**inert until run cancellation is actually wired** — this spec adds the parameter, not a
working abort. Driving it is part of building §10.6, out of scope here.

## Open questions

None outstanding. Resolved during design: all six models exposed now (agent picks via the
`model` arg); rates taken from the official pricing page (Gemini-native token-based,
Imagen flat per-image, standard tier); `/debug` breakdown computed client-side;
`agent_runs.model` derived from loop calls only; resolution scaling handled free via token
counts for Gemini-native; `ImageProvider` accepts a `signal` but cancellation is inert
until §10.6 is built.

## Alternatives considered

- **Approach X (image-result carries usage; `onToolEnd` writes the `llm_calls` row).**
  Smaller — reuses the existing image-result special-casing — but image-shaped: one tool,
  one call, no clean path to a tool making several AI calls, and the per-tool breakdown
  still needs the same `tool_call_id` link. Rejected in favour of Y now that more AI-using
  tools are expected, so the general recorder earns its keep immediately.
- **One tool per model** (`generate_image_gemini_pro`, …). Gives per-model approval/settings
  for free (each is its own `tools` row), but pollutes the catalog and the agent's tool
  list, and doesn't extend to non-Google cleanly. Rejected — capability selection belongs
  in an argument, not the tool name. (If per-model *approval* ever matters, revisit.)
