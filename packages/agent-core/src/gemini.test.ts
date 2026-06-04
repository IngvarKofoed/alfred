import { describe, expect, it } from 'vitest'
import { runAgent } from './loop.js'
import { GeminiProvider, toGeminiContents } from './providers/gemini.js'
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
