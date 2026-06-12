# LLM retry/backoff (§10.7)

Build the planned transient-error retry for loop LLM calls: a `RetryProvider` decorator in
agent-core wraps the provider stack and re-attempts a call that failed with a *transient*
error (HTTP 429/5xx or a connectivity drop) before any stream output was consumed — up to 4
retries at 1/2/4/8s — then fails the run with an `llm_unavailable`-prefixed error. Today a
single 503 from Gemini kills the run immediately (RUNTIME §10.7, "planned, not yet built").
Classification stays in the provider, where the error shapes are known; policy lives in the
decorator, provider-agnostic — the same split `TracingProvider` established for
observability.

## Key decisions

- **`RetryProvider` decorator, not provider-internal retry** (reuses). A new
  `packages/agent-core/src/retry.ts` modeled exactly on `TracingProvider`: implements
  `LlmProvider`, wraps any inner provider, re-yields the stream untouched. Future providers
  (OpenRouter, Ollama) inherit the policy for free.
- **Retry wraps *outside* tracing** (new). `run.ts` builds
  `new RetryProvider(new TracingProvider(base, …))`, so every failed attempt is traced as
  its own `llm_calls` row with its error — `/debug` shows the three 503s that preceded the
  success, honoring §10.7's "fail loudly into structured rows". Inverting the order would
  hide retries inside one trace whose latency silently includes backoff.
- **Providers classify via a typed `TransientLlmError`** (extends). `translateGeminiError`
  already recognizes the connectivity cases (CHANGELOG 44); it now throws them as
  `TransientLlmError` (same friendly message) and gains one new branch: the SDK's
  `ApiError` with `status === 429 || status >= 500` is wrapped as `TransientLlmError` too
  (message preserved, original as `cause`). The decorator checks `instanceof` — it never
  inspects provider-specific shapes.
- **Retry only before the first yielded event** (new). Once a stream event has reached the
  consumer, tokens are already NOTIFYed to the client and accumulated by the loop —
  restarting would duplicate them. A mid-stream failure rethrows untouched, exactly today's
  behavior. 429/5xx/connect failures surface at the `await generateContentStream`, before
  any yield, so the common cases are all covered.
- **Schedule: 4 retries at 1/2/4/8s ⇒ ≤5 attempts, ≤15s added worst-case** (new). Fixed
  delays, no jitter (one client, no thundering herd). RUNTIME §10.7's "after 4 attempts"
  phrasing is updated to match at build time.
- **Exhausted retries throw `llm_unavailable: <last error message>`** (extends). The prefix
  is the greppable code §10.7 calls for; the remainder keeps the owner-readable detail
  (e.g. the CHANGELOG-44 offline message). It lands in `agent_runs.error` and the `error`
  NOTIFY via the worker's existing failed path — no `run.ts` error-handling change.
- **Cancellation stays prompt** (extends). An abort error is not `TransientLlmError`
  (`translateGeminiError` already passes `AbortError` through untouched), so it is never
  retried; the backoff sleep itself listens on `StreamOptions.signal` and rejects
  immediately on abort. A cancel never waits out a backoff window.

## Goals

- A transient Gemini hiccup (429 rate limit, 5xx, dropped connection, DNS blip) no longer
  fails the run — it retries quietly and the owner usually never notices.
- When the provider is genuinely down, the run fails loudly after ~15s with a clear,
  recognizable `llm_unavailable` error instead of a raw SDK message.
- Every retry attempt is visible on `/debug` as its own `llm_calls` row.

## Non-goals

- **Retrying mid-stream failures.** A stream that breaks after emitting tokens stays fatal;
  resuming or deduplicating partial streams is machinery this system doesn't need.
- **`ImageProvider` / `generate_image` retry.** A failed image call already returns an
  error-shaped tool result the model can react to; the image abstraction is a parallel
  track (§7.2).
- **Honoring server retry hints** (`Retry-After` headers / the 429 body's `retryDelay`).
  Fixed schedule for MVP; revisit if Gemini rate limits bite in practice.
- **The per-run cost cap** — §10.7's other planned row; separate work (it builds on the
  layered budgets of §7.7).
- **pg-boss job-level retry.** `retryLimit: 0` stays (§6.3) — this is intra-call retry,
  invisible to the queue.

## Design

### `RetryProvider` (`packages/agent-core/src/retry.ts`)

```ts
export class TransientLlmError extends Error {}   // providers throw this for retryable failures

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000]

export class RetryProvider implements LlmProvider {
  constructor(private readonly inner: LlmProvider, private readonly delaysMs = RETRY_DELAYS_MS) {}

  async *stream(messages, tools, opts) {
    for (let attempt = 0; ; attempt++) {
      let yielded = false
      try {
        for await (const ev of this.inner.stream(messages, tools, opts)) {
          yielded = true
          yield ev
        }
        return
      } catch (err) {
        const retryable = err instanceof TransientLlmError && !yielded && !opts?.signal?.aborted
        if (!retryable) throw err                        // permanent, mid-stream, or aborted: untouched
        if (attempt >= this.delaysMs.length) {
          throw new Error(`llm_unavailable: ${err.message}`, { cause: err })
        }
        await abortableSleep(this.delaysMs[attempt], opts?.signal)   // rejects on abort
      }
    }
  }
}
```

Behavior table:

| Failure | Decorator action |
|---|---|
| `TransientLlmError`, nothing yielded, retries remain | sleep (abortable), re-call `inner.stream` |
| `TransientLlmError`, nothing yielded, retries exhausted | throw `llm_unavailable: <message>` (last error as `cause`) |
| `TransientLlmError` after events were yielded | rethrow untouched (mid-stream stays fatal) |
| any other error (4xx, `AbortError`, …) | rethrow untouched, no sleep |
| signal aborts during a backoff sleep | reject immediately with the abort error |

### Gemini classification (`providers/gemini.ts`)

`translateGeminiError` is the single place Gemini error shapes are known; two changes:

- The existing offline/connectivity rewrite returns `new TransientLlmError(friendlyMessage,
  { cause: err })` instead of a bare `Error` — same message, now retryable.
- New branch: `err instanceof ApiError && (err.status === 429 || err.status >= 500)` →
  `new TransientLlmError(err.message, { cause: err })`. (`ApiError` is exported by
  `@google/genai` with a numeric `status`.) All other `ApiError`s (4xx) pass through
  untouched — permanent, never retried.

The `AbortError` early-return stays first, before any wrapping.

### Wiring (`services/worker/src/run.ts`)

One line changes:

```ts
const provider = new RetryProvider(new TracingProvider(base, (trace) => insertLlmCall(db, runId, trace)))
```

The loop, the worker's failed path, and the NOTIFY plumbing are untouched: an exhausted
retry propagates as a normal run failure whose message starts with `llm_unavailable:`.
Injected test providers (`deps.provider`) throw plain errors, not `TransientLlmError`, so
existing tests see no retries.

Each failed attempt's trace row carries the full request `Message[]` (the existing
`TracingProvider` shape), so 5 attempts store the request up to 5 times — accepted at
single-user scale, and it is exactly what `/debug` needs to show what happened.

The auto-title call (`maybeAutoTitle`) keeps its unwrapped `TracingProvider(base)` — it is
best-effort and self-healing (retries on the next still-untitled run), and retrying it
would hold the run's `done` event up to ~15s longer for a cosmetic feature.

### Docs touched at build time

RUNTIME §10.7 (LLM-transient row → built, phrasing aligned to 4-retries/5-attempts),
`docs/TODO.md` item 7 checked off.

## Resolved choices

- **Connectivity/offline codes are retryable alongside 429/5xx** (owner-settled). A router
  blip or Wi-Fi handoff is exactly the transient case; genuinely offline just means the
  friendly failure arrives ~15s later.
- **Auto-title keeps no retry** (owner-settled). Best-effort and self-healing; not worth
  delaying the run's `done` event (see Design).

## Alternatives considered

- **Retry inside `GeminiProvider.stream`** (Approach A). Matches §10.7's literal "provider
  abstraction retries", but every future provider reimplements the policy, and retries
  happen beneath `TracingProvider` — failed attempts never reach `llm_calls`, leaving one
  trace whose latency silently includes backoff. Rejected for observability.
- **Retry in `runAgent`.** The loop would need provider-specific error knowledge — exactly
  what the provider abstraction exists to prevent. Rejected.
- **Buffering the stream to make mid-stream failures retryable.** Kills token streaming,
  the web chat's core UX. Rejected.
