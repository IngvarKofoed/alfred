import { describe, expect, it } from 'vitest'
import { type ApprovalRequest, CancelledError, runAgent } from './loop.js'
import type { LlmProvider } from './provider.js'
import { echoTool, type Tool } from './tool.js'
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

  it("threads a write tool's group onto the approval request", async () => {
    // The worker's gate uses ApprovalRequest.group for group-scoped approval (§16); the
    // loop's only job is to copy it from the resolved Tool onto the request it surfaces.
    const groupedTool: Tool = {
      name: 'navigate',
      description: 'Navigate the browser',
      inputSchema: { type: 'object' },
      trustTier: 'write',
      group: 'browser',
      async invoke() {
        return { ok: true }
      },
    }
    const provider = fakeProvider([
      [{ type: 'tool_call', id: 'c1', name: 'navigate', args: { url: 'https://x' } }],
      [{ type: 'text', text: 'done' }],
    ])

    const seen: ApprovalRequest[] = []
    await runAgent({
      provider,
      tools: [groupedTool],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      requestApproval: async (call) => {
        seen.push(call)
        return { approved: true }
      },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ name: 'navigate', trustTier: 'write', group: 'browser' })
  })

  it('rejects with CancelledError on a pre-aborted signal without calling the provider', async () => {
    // The top-of-turn checkpoint (§10.6) must fire BEFORE provider.stream — a cancelled run
    // must never spend another model call.
    let providerCalls = 0
    const provider: LlmProvider = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls++
      },
    }
    const controller = new AbortController()
    controller.abort()

    await expect(
      runAgent({
        provider,
        tools: [echoTool],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancelledError)
    expect(providerCalls).toBe(0)
  })

  it('aborting mid-tool cancels before the next tool starts and before the next provider call', async () => {
    // A cancel landing while a tool is mid-invoke takes effect at the next checkpoint: the
    // per-tool-call check sits BEFORE onToolStart, so the second call in the same turn is
    // never recorded as a tool_calls row, and no further provider call happens.
    const controller = new AbortController()
    const abortingTool: Tool = {
      name: 'abort_run',
      description: 'Aborts the run controller mid-invoke (simulates a cancel during a tool)',
      inputSchema: { type: 'object' },
      trustTier: 'read',
      async invoke() {
        controller.abort()
        return { ok: true }
      },
    }
    const inner = fakeProvider([
      [
        { type: 'tool_call', id: 'c1', name: 'abort_run', args: {} },
        { type: 'tool_call', id: 'c2', name: 'echo', args: { text: 'never' } },
      ],
      [{ type: 'text', text: 'unreachable' }],
    ])
    let providerCalls = 0
    const provider: LlmProvider = {
      stream(messages, tools, opts): AsyncIterable<StreamEvent> {
        providerCalls++
        return inner.stream(messages, tools, opts)
      },
    }

    const started: string[] = []
    await expect(
      runAgent({
        provider,
        tools: [abortingTool, echoTool],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        signal: controller.signal,
        onToolStart: (call) => {
          started.push(call.name)
        },
      }),
    ).rejects.toBeInstanceOf(CancelledError)

    expect(providerCalls).toBe(1)
    expect(started).toEqual(['abort_run']) // c2 never started — the checkpoint precedes onToolStart
  })
})
