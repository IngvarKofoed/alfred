import { describe, expect, it } from 'vitest'
import { runAgent } from './loop.js'
import type { LlmProvider } from './provider.js'
import { echoTool } from './tool.js'
import type { Message, StreamEvent } from './types.js'

// A deterministic, offline LlmProvider: each call to stream() replays the next
// scripted batch of events. Lets us drive the loop without touching the network.
function fakeProvider(turns: StreamEvent[][]): LlmProvider {
  let turn = 0
  return {
    async *stream(): AsyncIterable<StreamEvent> {
      const events = turns[turn] ?? []
      turn++
      for (const ev of events) yield ev
    },
  }
}

describe('runAgent', () => {
  it('drives a tool-call round-trip and returns the final assistant message', async () => {
    const provider = fakeProvider([
      [{ type: 'tool_call', id: 'c1', name: 'echo', args: { text: 'hi' } }], // turn 1: call echo
      [{ type: 'text', text: 'I echoed: hi' }], // turn 2: final answer
    ])

    const deltas: string[] = []
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'echo hi' }] }]

    const final = await runAgent({
      provider,
      tools: [echoTool],
      messages,
      onText: (d) => deltas.push(d),
    })

    const toolResult = final.flatMap((m) => m.content).find((p) => p.type === 'tool_result')
    expect(toolResult).toMatchObject({ name: 'echo', result: { echoed: 'hi' } })

    expect(deltas.join('')).toBe('I echoed: hi')
    expect(final.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'I echoed: hi' }],
    })
  })
})
