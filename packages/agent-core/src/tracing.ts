import type { LlmProvider, StreamOptions } from './provider.js'
import type { Tool } from './tool.js'
import type { Message, StreamEvent } from './types.js'

// A captured tool the model was offered this call — the function-declaration shape, not
// the live Tool (no invoke/closure), so it serializes cleanly into the trace.
export interface TracedTool {
  name: string
  description: string
  parameters: unknown
}

// A tool the model asked to call in its response this turn.
export interface TracedToolCall {
  id: string
  name: string
  args: unknown
}

export interface LlmTrace {
  model: string
  request: Message[]
  tools: TracedTool[]
  responseText: string
  responseToolCalls: TracedToolCall[]
  promptTokens?: number
  cachedTokens?: number
  completionTokens?: number
  finishReason?: string
  latencyMs: number
  error?: string
}

// Cross-cutting observability: wraps any LlmProvider, re-yields its stream untouched,
// and reports one LlmTrace per call (even on error, via finally). The loop is unaware.
export class TracingProvider implements LlmProvider {
  constructor(
    private readonly inner: LlmProvider,
    private readonly onTrace: (trace: LlmTrace) => void | Promise<void>,
  ) {}

  async *stream(
    messages: Message[],
    tools: Tool[],
    opts?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    const start = Date.now()
    let model = opts?.model ?? 'unknown'
    let responseText = ''
    const responseToolCalls: TracedToolCall[] = []
    let promptTokens: number | undefined
    let cachedTokens: number | undefined
    let completionTokens: number | undefined
    let finishReason: string | undefined
    let error: string | undefined

    try {
      for await (const ev of this.inner.stream(messages, tools, opts)) {
        if (ev.type === 'text') {
          responseText += ev.text
        } else if (ev.type === 'tool_call') {
          responseToolCalls.push({ id: ev.id, name: ev.name, args: ev.args })
        } else if (ev.type === 'usage') {
          model = ev.model
          promptTokens = ev.promptTokens
          cachedTokens = ev.cachedTokens
          completionTokens = ev.completionTokens
          finishReason = ev.finishReason
        }
        yield ev
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      // Best-effort: a throw from a finally REPLACES the in-flight exception, so a failed
      // trace write (e.g. a transient Postgres error in the worker's llm_calls insert) would
      // otherwise mask the provider's own error — defeating the RetryProvider's
      // TransientLlmError check — or fail a healthy stream. Observability must never
      // change the call's outcome; log and move on.
      try {
        await this.onTrace({
          model,
          request: messages,
          tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
          responseText,
          responseToolCalls,
          promptTokens,
          cachedTokens,
          completionTokens,
          finishReason,
          latencyMs: Date.now() - start,
          error,
        })
      } catch (traceErr) {
        console.error('[tracing] failed to record LLM trace:', traceErr)
      }
    }
  }
}
