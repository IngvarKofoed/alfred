import { describe, expect, it } from 'vitest'
import type { LlmProvider } from './provider.js'
import { RetryProvider, TransientLlmError } from './retry.js'
import type { Message, StreamEvent } from './types.js'

const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

// A deterministic, offline LlmProvider: each call to stream() replays the next scripted
// attempt — events to yield, then optionally an error to throw (the last attempt repeats
// if called again). Tracks how many times the inner provider was called.
function scriptedProvider(attempts: { events?: StreamEvent[]; error?: unknown }[]) {
  let calls = 0
  const provider: LlmProvider = {
    async *stream(): AsyncIterable<StreamEvent> {
      const attempt = attempts[Math.min(calls, attempts.length - 1)]
      calls++
      for (const ev of attempt?.events ?? []) yield ev
      if (attempt?.error !== undefined) throw attempt.error
    },
  }
  return { provider, calls: () => calls }
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const ev of stream) events.push(ev)
  return events
}

// Tiny injected delays keep the suite fast; the production schedule (1/2/4/8s) is only
// the default argument.
const TINY_DELAYS = [1, 1, 1, 1]

describe('RetryProvider', () => {
  it('retries a transient failure and delivers the successful stream exactly once', async () => {
    const { provider, calls } = scriptedProvider([
      { error: new TransientLlmError('503 from Gemini') },
      { events: [{ type: 'text', text: 'hello' }] },
    ])
    const rp = new RetryProvider(provider, TINY_DELAYS)

    const events = await collect(rp.stream(messages, []))

    expect(events).toEqual([{ type: 'text', text: 'hello' }])
    expect(calls()).toBe(2)
  })

  it('exhausts retries on a persistent transient failure and throws llm_unavailable', async () => {
    const last = new TransientLlmError('still down')
    const { provider, calls } = scriptedProvider([{ error: last }])
    const rp = new RetryProvider(provider, TINY_DELAYS)

    let caught: unknown
    try {
      await collect(rp.stream(messages, []))
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    // Deliberately NOT TransientLlmError — terminal, never re-retryable.
    expect(caught).not.toBeInstanceOf(TransientLlmError)
    expect((caught as Error).message).toMatch(/^llm_unavailable: /)
    expect((caught as { cause?: unknown }).cause).toBe(last)
    expect(calls()).toBe(TINY_DELAYS.length + 1)
  })

  it('rethrows a non-transient error untouched without retrying', async () => {
    const permanent = new Error('got status: 400 Bad Request')
    const { provider, calls } = scriptedProvider([{ error: permanent }])
    const rp = new RetryProvider(provider, TINY_DELAYS)

    await expect(collect(rp.stream(messages, []))).rejects.toBe(permanent)
    expect(calls()).toBe(1)
  })

  it('rethrows a transient error untouched once events were yielded (mid-stream stays fatal)', async () => {
    // Once a token has reached the consumer it is already NOTIFYed downstream — restarting
    // the stream would duplicate it, so a mid-stream failure must not retry.
    const midStream = new TransientLlmError('connection dropped')
    const { provider, calls } = scriptedProvider([
      {
        events: [
          { type: 'text', text: 'par' },
          { type: 'text', text: 'tial' },
        ],
        error: midStream,
      },
    ])
    const rp = new RetryProvider(provider, TINY_DELAYS)

    const seen: StreamEvent[] = []
    let caught: unknown
    try {
      for await (const ev of rp.stream(messages, [])) seen.push(ev)
    } catch (err) {
      caught = err
    }

    expect(caught).toBe(midStream)
    expect(seen).toEqual([
      { type: 'text', text: 'par' },
      { type: 'text', text: 'tial' },
    ])
    expect(calls()).toBe(1)
  })

  it('rejects promptly when the signal aborts during a backoff sleep', async () => {
    // A cancel (§10.6) must never wait out a backoff window — use a real 5s delay and
    // assert the rejection lands in milliseconds, not seconds.
    const { provider, calls } = scriptedProvider([{ error: new TransientLlmError('503') }])
    const rp = new RetryProvider(provider, [5000])
    const controller = new AbortController()

    const start = Date.now()
    const consume = collect(rp.stream(messages, [], { signal: controller.signal }))
    setTimeout(() => controller.abort(), 10)

    await expect(consume).rejects.toHaveProperty('name', 'AbortError')
    expect(Date.now() - start).toBeLessThan(1000)
    expect(calls()).toBe(1)
  })

  it('rethrows a transient error untouched when the signal is already aborted, without sleeping', async () => {
    const transient = new TransientLlmError('503')
    const { provider, calls } = scriptedProvider([{ error: transient }])
    const rp = new RetryProvider(provider, [5000])
    const controller = new AbortController()
    controller.abort()

    const start = Date.now()
    await expect(collect(rp.stream(messages, [], { signal: controller.signal }))).rejects.toBe(
      transient,
    )
    expect(Date.now() - start).toBeLessThan(1000)
    expect(calls()).toBe(1)
  })
})
