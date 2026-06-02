// Manual runner: streams a real Gemini reply to the terminal and prints any tool
// activity. Requires GEMINI_API_KEY in the environment.
//   pnpm --filter @alfred/agent-core cli "Use echo to say hi"
import { runAgent } from './loop.js'
import { GeminiProvider } from './providers/gemini.js'
import { echoTool } from './tool.js'
import type { Message } from './types.js'

const prompt =
  process.argv.slice(2).join(' ') || 'Use the echo tool to echo "hello from Alfred", then summarize.'

const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]

const final = await runAgent({
  provider: new GeminiProvider(),
  tools: [echoTool],
  messages,
  onText: (delta) => process.stdout.write(delta),
})

process.stdout.write('\n')
for (const m of final) {
  for (const p of m.content) {
    if (p.type === 'tool_use') console.log(`[tool_use] ${p.name}(${JSON.stringify(p.args)})`)
    if (p.type === 'tool_result') console.log(`[tool_result] ${JSON.stringify(p.result)}`)
  }
}
