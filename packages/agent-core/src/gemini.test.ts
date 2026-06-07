import { describe, expect, it } from 'vitest'
import { runAgent } from './loop.js'
import { GeminiProvider, toGeminiContents, translateGeminiError } from './providers/gemini.js'
import { echoTool } from './tool.js'
import type { Message } from './types.js'

// Offline regression for the functionResponse Struct bug: a tool that returns an array
// must not be sent as a bare list (Gemini rejects "Proto field is not repeating, cannot
// start list" and the whole conversation dies). Arrays/primitives are wrapped under `value`.
describe('toGeminiContents — functionResponse must be a Struct', () => {
  it('wraps an array tool result under `value`, passes an object through as-is', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        content: [
          { type: 'tool_result', id: 'a', name: 'get_links', result: [{ href: '/x' }, { href: '/y' }] },
          { type: 'tool_result', id: 'b', name: 'navigate', result: { ok: true } },
        ],
      },
    ]
    const [content] = toGeminiContents(messages)
    const responses = (content!.parts ?? []).map((p) => p.functionResponse?.response)
    expect(responses[0]).toEqual({ value: [{ href: '/x' }, { href: '/y' }] })
    expect(Array.isArray(responses[0])).toBe(false)
    expect(responses[1]).toEqual({ ok: true })
  })

  // A tool that returns an image (screenshot, generate_image, read_file on an image) yields a
  // tool turn carrying BOTH a tool_result and an image part. Gemini rejects a Content that
  // mixes functionResponse with inlineData, so they must split into two separate Contents:
  // the functionResponse turn stays pure, the image follows as its own user turn.
  it('splits a tool turn with an image into separate functionResponse and inlineData Contents', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        content: [
          { type: 'tool_result', id: 'a', name: 'screenshot', result: { summary: 'a page' } },
          { type: 'image', mimeType: 'image/png', data: 'YWJj' },
        ],
      },
    ]
    const contents = toGeminiContents(messages)
    expect(contents).toHaveLength(2)

    const fnParts = contents[0]!.parts ?? []
    expect(fnParts.every((p) => p.functionResponse && !p.inlineData)).toBe(true)

    const imgParts = contents[1]!.parts ?? []
    expect(imgParts).toHaveLength(1)
    expect(imgParts[0]!.inlineData).toEqual({ mimeType: 'image/png', data: 'YWJj' })
    expect(imgParts[0]!.functionResponse).toBeUndefined()
  })
})

// A network failure (no internet) surfaces from Node's fetch as a bare `TypeError: fetch
// failed`, which is useless when it reaches the owner via agent_runs.error. translateGeminiError
// turns the recognized offline cases into an actionable message; real API errors pass through.
describe('translateGeminiError', () => {
  it('rewrites a bare "fetch failed" into a connectivity message', () => {
    const out = translateGeminiError(new TypeError('fetch failed'))
    expect((out as Error).message).toMatch(/Couldn't reach the Gemini API/)
  })

  it('includes the underlying code when the cause carries one', () => {
    const err = new TypeError('fetch failed')
    ;(err as { cause?: unknown }).cause = { code: 'ENOTFOUND' }
    const out = translateGeminiError(err)
    expect((out as Error).message).toContain('ENOTFOUND')
  })

  it('passes a genuine API error through untouched', () => {
    const apiErr = new Error('got status: 429 Too Many Requests')
    expect(translateGeminiError(apiErr)).toBe(apiErr)
  })
})

// Live integration test: hits the real Gemini API. Skipped when GEMINI_API_KEY is
// unset, so `pnpm test` stays green without credentials (same pattern as db.test.ts).
describe.skipIf(!process.env.GEMINI_API_KEY)('GeminiProvider (live)', () => {
  it(
    'calls the echo tool and produces a final answer',
    async () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Call the echo tool with the text "ping", then tell me what it returned.',
            },
          ],
        },
      ]

      const final = await runAgent({ provider: new GeminiProvider(), tools: [echoTool], messages })

      const calledEcho = final
        .flatMap((m) => m.content)
        .some((p) => p.type === 'tool_use' && p.name === 'echo')
      expect(calledEcho).toBe(true)

      const finalText = final
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.content)
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
      expect(finalText.length).toBeGreaterThan(0)
    },
    30_000,
  )
})
