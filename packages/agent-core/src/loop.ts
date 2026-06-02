import type { LlmProvider } from './provider.js'
import type { Tool } from './tool.js'
import type { ContentPart, Message } from './types.js'

export interface RunOptions {
  provider: LlmProvider
  tools: Tool[]
  messages: Message[]
  onText?: (delta: string) => void
  model?: string
  signal?: AbortSignal
  maxTurns?: number
}

// The hand-rolled agent loop (ARCHITECTURE §7.1). No framework: streaming, tool-call
// parsing, and history are all explicit here. Returns the full message list including
// the assistant's turns and any tool results.
export async function runAgent(opts: RunOptions): Promise<Message[]> {
  const { provider, tools, onText, model, signal } = opts
  const messages: Message[] = [...opts.messages]
  const maxTurns = opts.maxTurns ?? 10
  const toolsByName = new Map(tools.map((t) => [t.name, t]))

  for (let turn = 0; turn < maxTurns; turn++) {
    let text = ''
    const toolCalls: { id: string; name: string; args: unknown }[] = []

    for await (const ev of provider.stream(messages, tools, { model, signal })) {
      if (ev.type === 'text') {
        text += ev.text
        onText?.(ev.text)
      } else {
        toolCalls.push({ id: ev.id, name: ev.name, args: ev.args })
      }
    }

    const assistantParts: ContentPart[] = []
    if (text) assistantParts.push({ type: 'text', text })
    for (const tc of toolCalls) {
      assistantParts.push({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args })
    }
    messages.push({ role: 'assistant', content: assistantParts })

    if (toolCalls.length === 0) return messages

    const resultParts: ContentPart[] = []
    for (const tc of toolCalls) {
      const tool = toolsByName.get(tc.name)
      const result = tool ? await tool.invoke(tc.args) : { error: `unknown tool: ${tc.name}` }
      resultParts.push({ type: 'tool_result', id: tc.id, name: tc.name, result })
    }
    messages.push({ role: 'tool', content: resultParts })
  }

  throw new Error(`runAgent exceeded maxTurns (${maxTurns})`)
}
