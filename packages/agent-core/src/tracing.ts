import type { LlmProvider, StreamOptions } from './provider.js'
import type { Tool } from './tool.js'
import type { Message, StreamEvent } from './types.js'

export interface LlmTrace {
  model: string
  request: Message[]
  responseText: string
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
    let promptTokens: number | undefined
    let cachedTokens: number | undefined
    let completionTokens: number | undefined
    let finishReason: string | undefined
    let error: string | undefined

    try {
      for await (const ev of this.inner.stream(messages, tools, opts)) {
        if (ev.type === 'text') {
          responseText += ev.text
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
      await this.onTrace({
        model,
        request: messages,
        responseText,
        promptTokens,
        cachedTokens,
        completionTokens,
        finishReason,
        latencyMs: Date.now() - start,
        error,
      })
    }
  }
}
