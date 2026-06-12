import type { LlmProvider, StreamOptions } from './provider.js'
import type { Tool } from './tool.js'
import type { Message, StreamEvent } from './types.js'

// Thrown by providers for retryable failures (HTTP 429/5xx, connectivity drops). The
// RetryProvider checks `instanceof` — providers classify, the decorator never inspects
// provider-specific error shapes.
export class TransientLlmError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TransientLlmError'
  }
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000]

// Transient-error retry for loop LLM calls (RUNTIME §10.7): wraps any LlmProvider and
// re-attempts a call that failed with a TransientLlmError before any stream output was
// consumed — backing off per RETRY_DELAYS_MS, then failing with `llm_unavailable: …`.
// It wraps OUTSIDE TracingProvider, so each failed attempt becomes its own llm_calls
// row with its error — fail loudly into structured rows. The loop is unaware.
export class RetryProvider implements LlmProvider {
  constructor(
    private readonly inner: LlmProvider,
    // Injectable so tests can use tiny delays.
    private readonly delaysMs: number[] = RETRY_DELAYS_MS,
  ) {}

  async *stream(
    messages: Message[],
    tools: Tool[],
    opts?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    for (let attempt = 0; ; attempt++) {
      let yielded = false
      try {
        for await (const ev of this.inner.stream(messages, tools, opts)) {
          yielded = true
          yield ev
        }
        return
      } catch (err) {
        // Permanent (incl. AbortError), mid-stream (tokens already reached the consumer —
        // restarting would duplicate them), or aborted: rethrow untouched, no sleep.
        const retryable = err instanceof TransientLlmError && !yielded && !opts?.signal?.aborted
        if (!retryable) throw err
        if (attempt >= this.delaysMs.length) {
          // Deliberately a plain Error, not TransientLlmError — terminal, never re-retryable.
          throw new Error(`llm_unavailable: ${err.message}`, { cause: err })
        }
        await abortableSleep(this.delaysMs[attempt]!, opts?.signal)
      }
    }
  }
}

// A setTimeout raced against the signal: on abort, clear the timer and reject immediately
// so a cancel (§10.6) never waits out a backoff window. The abort listener is always
// removed on settle — no listener/timer leaks across retries.
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = () =>
      signal?.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' })
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    // onAbort only fires after the listener is registered below, so `timer` is assigned.
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
