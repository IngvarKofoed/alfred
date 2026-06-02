import { describe, expect, it } from 'vitest'
import { runAgent } from './loop.js'
import { GeminiProvider } from './providers/gemini.js'
import { echoTool } from './tool.js'
import type { Message } from './types.js'

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
