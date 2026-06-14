# Voice STT/TTS cost accounting

Record the speech-leg LLM calls — audio→text (STT) and text→audio (TTS) — against the
conversation's run, the same way `generate_image` and `auto_title` already attribute their
out-of-loop AI calls: a synthetic `tool_calls` row + a linked `llm_calls` row (non-null
`tool_call_id`), so tokens/cost roll into `agent_runs.cost_usd` and show on `/debug` without
mislabeling the run's model. Approach A — record each call where it already runs (STT in the
webserver `/audio` route, TTS in the worker), through one shared helper.

## Key decisions

- **Reuse the out-of-loop attribution pattern** (extends). Each speech call becomes a synthetic
  `tool_calls` row (`tool_name` `'stt'`/`'tts'`, `trust_tier` `'read'`, status `done`) + an
  `llm_calls` row whose `tool_call_id` points at it — identical in shape to `auto_title` /
  `generate_image`. `rollupUsage` already sums every `llm_calls` row of a run and derives
  `agent_runs.model` from `tool_call_id IS NULL` rows only, so cost rolls in and the run's model
  stays the chat model. **No change to `rollupUsage`.**
- **Shared `recordOutOfLoopLlmCall` helper in `@alfred/db`** (new). One writer for "synthetic
  tool_call + linked llm_calls row," taking a *precomputed* `costUsd` (keeps `@alfred/db` free of
  any pricing/agent-core dependency). Used by the worker (TTS) and the webserver (STT). Mirrors
  the existing `createUserMessageRun` / `terminateRuns` extraction.
- **Providers return usage** (extends). `SttProvider.transcribe` and `TtsProvider.synthesize`
  return an optional `usage` (`{ model, promptTokens?, completionTokens? }`, the speech sibling of
  `ImageUsage`) read from Gemini's `usageMetadata`. They currently discard it.
- **STT recorded in the webserver `/audio` route** (extends). After the run is created, the route
  records the STT call (best-effort) against that run. The webserver gains cost recording — small,
  and it already imports `@alfred/agent-core` (for `makeSttProvider`) so `computeSpeechCostUsd` is
  in reach.
- **TTS recorded in the worker, aggregated per run** (extends). The per-sentence `synthesize`
  usages accumulate; one `'tts'` row is written when the TTS chain drains (before `done`), so a
  five-sentence reply is one row, not five.
- **Audio pricing** (extends). `pricing.ts` gains the speech models' audio rates + a thin
  `computeSpeechCostUsd` — audio *input* for STT, audio *output* for TTS, both billed differently
  than text, which the text `computeCostUsd` can't express on a model id it shares with the chat
  loop. Rates are set in the Pricing section (STT audio-in $1.00/1M, TTS audio-out $10.00/1M); the
  mechanism is rate-agnostic regardless, so tokens always record even if a rate later changes.
- **Best-effort, never fails the turn** (reuses). A recording failure logs and is swallowed,
  exactly like `maybeAutoTitle` and the TTS synthesis itself — observability must not break voice.

## Goals

- A voice run's STT and TTS calls appear as `llm_calls` rows on `/debug`, linked to the run, with
  their real token counts.
- Their cost rolls into `agent_runs.cost_usd`, so a voice conversation's spend is no longer
  under-reported.
- The run's `model` stays the chat model (speech models never leak into it).
- One shared helper for out-of-loop call recording, not three copies.

## Non-goals

- **Exact ElevenLabs dollar cost.** ElevenLabs bills per audio-minute (STT) / per character (TTS),
  not tokens; record what's available (model + a request summary) with cost 0 unless its pricing is
  added later. Google (the default) is the focus.
- **Confirming Google's current audio rates.** The mechanism lands now; the precise $/1M values are
  owner-confirmed (Open Question) and trivially updatable in `pricing.ts`.
- **Refactoring `generate_image` / `auto_title` onto the new helper.** They already work; folding
  them in is optional cleanup, out of scope here.
- **A per-run / voice cost cap or budget.** Enforcement is the separate §10.7 / §7.7 TODO; this is
  accounting only.

## Design

### Provider usage (`packages/agent-core/src/speech-provider.ts`)

Add a `SpeechUsage { model: string; promptTokens?: number; completionTokens?: number }` and widen
the returns:

```ts
transcribe(audio, opts): Promise<{ text: string; usage?: SpeechUsage }>
synthesize(text, opts?): Promise<{ audio: Buffer; mimeType: string; usage?: SpeechUsage }>
```

`GoogleSttProvider` / `GoogleTtsProvider` read `response.usageMetadata` (`promptTokenCount`,
`candidatesTokenCount`) — exactly as `GeminiImageProvider` already does — and return `usage`.
ElevenLabs returns no `usage` (cost 0 for now, per Non-goals).

### Pricing (`packages/agent-core/src/pricing.ts`)

Add audio rates for the speech models and a `computeSpeechCostUsd(usage, kind: 'stt' | 'tts')`:

- **STT** (`gemini-2.5-flash`, audio in / text out): input (audio) **$1.00/1M**, output (text)
  **$2.50/1M**. The audio-input premium is the binding reason for a separate path — the same model
  id bills *text* input at $0.30/1M for the chat loop, so STT can't reuse
  `MODEL_PRICING['gemini-2.5-flash']`.
- **TTS** (`gemini-2.5-flash-preview-tts`, text in / audio out): input (text) **$0.50/1M**, output
  (audio) **$10.00/1M**. (This one *could* sit in `MODEL_PRICING` as its own id, but lives in
  `computeSpeechCostUsd` alongside STT to keep all audio rates in one place.)

Kept separate from `computeCostUsd` because the audio rates attach to a model id that's *also* used
for text (the chat loop), so they can't live in a single `MODEL_PRICING[model]` lookup. An
unset/unknown rate → 0.

Concrete rates: STT = audio-in `$1.00`/1M + text-out `$2.50`/1M; TTS = text-in `$0.50`/1M +
audio-out `$10.00`/1M.

### Shared recorder (`packages/db`)

```ts
recordOutOfLoopLlmCall(db, {
  runId, toolName,                            // 'stt' | 'tts'
  model, requestSummary, responseSummary,
  promptTokens, completionTokens, costUsd,    // costUsd precomputed by the caller
}): Promise<void>
```

Inserts a terminal synthetic `tool_calls` row (`trust_tier: 'read'`, `status: 'done'`, `args: {}`,
`result: { summary }`) and an `llm_calls` row linked to it (`request: { tool: true, summary }`,
`responseText: summary`, tokens, `costUsd`). Inserted `done` because the call already completed
(unlike `auto_title`, which starts `running` because it finalizes later). Exported alongside
`createUserMessageRun`.

### STT recording (`services/webserver/src/app.ts`, `/audio`)

`transcribe(...)` now returns `usage`. After the transaction creates the run (we have `runId`),
best-effort:

```ts
if (sttUsage) {
  try {
    await recordOutOfLoopLlmCall(db, {
      runId, toolName: 'stt', model: sttUsage.model,
      requestSummary: `transcribe ${audio.length} bytes`,
      responseSummary: transcript.slice(0, 120),
      promptTokens: sttUsage.promptTokens ?? 0,
      completionTokens: sttUsage.completionTokens ?? 0,
      costUsd: computeSpeechCostUsd(sttUsage, 'stt').toFixed(6),
    })
  } catch (err) { console.error('[audio] STT cost record failed:', err) }
}
```

Timing is safe: `rollupUsage` runs at the *end* of the run (worker), long after this row is written.

### TTS recording (`services/worker/src/run.ts`)

`speakSentence` already calls `provider.synthesize`. Accumulate usage across the run's clips (sum
`promptTokens` / `completionTokens`, remember `usage.model`). After `await ttsChain` and before the
`done` NOTIFY, if any TTS usage accumulated, best-effort `recordOutOfLoopLlmCall(db, { runId,
toolName: 'tts', model, …, costUsd: computeSpeechCostUsd(agg, 'tts') })`. Skipped on the
cancel/abort path (where `done` isn't emitted) and when no clips were produced.

## Alternatives considered

- **Approach B — centralize STT in the worker** (move transcription out of `/audio` into the run's
  first step). One owner for cost recording, but it reshapes the just-shipped `/audio → {runId,
  transcript}` flow (the transcript would arrive over SSE, changing the iOS optimistic display) —
  too much blast radius for an observability feature.
- **Estimate tokens from text length instead of extending the provider interfaces.** Rejected —
  `usageMetadata` is exact and already returned by the API; estimating would be a confidently-wrong
  number, against the file's "0, never a guess" stance.
