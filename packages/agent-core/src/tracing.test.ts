import { describe, expect, it } from 'vitest'
import type { LlmProvider } from './provider.js'
import { type LlmTrace, TracingProvider } from './tracing.js'
import type { Message, StreamEvent } from './types.js'

const inner: LlmProvider = {
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: 'text', text: 'hel' }
    yield { type: 'text', text: 'lo' }
    yield { type: 'tool_call', id: 'c1', name: 'echo', args: { text: 'hi' } }
    yield {
      type: 'usage',
      model: 'gemini-2.5-flash',
      promptTokens: 5,
      completionTokens: 2,
      finishReason: 'STOP',
    }
  },
}

const echoTool = {
  name: 'echo',
  description: 'Echo the text back.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  trustTier: 'read' as const,
  invoke: async () => ({}),
}

describe('TracingProvider', () => {
  it('re-yields the stream and reports one trace', async () => {
    const traces: LlmTrace[] = []
    const tp = new TracingProvider(inner, (t) => {
      traces.push(t)
    })
    const request: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

    const seen: string[] = []
    for await (const ev of tp.stream(request, [echoTool])) {
      if (ev.type === 'text') seen.push(ev.text)
    }

    expect(seen.join('')).toBe('hello')
    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({
      model: 'gemini-2.5-flash',
      responseText: 'hello',
      promptTokens: 5,
      completionTokens: 2,
      finishReason: 'STOP',
    })
    expect(traces[0]!.latencyMs).toBeGreaterThanOrEqual(0)
    expect(traces[0]!.request).toBe(request)
    expect(traces[0]!.error).toBeUndefined()
    // the trace captures the tools offered and the tool calls the model returned
    expect(traces[0]!.tools).toEqual([
      { name: 'echo', description: 'Echo the text back.', parameters: echoTool.inputSchema },
    ])
    expect(traces[0]!.responseToolCalls).toEqual([{ id: 'c1', name: 'echo', args: { text: 'hi' } }])
  })
})
