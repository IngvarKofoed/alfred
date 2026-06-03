import type { LlmProvider } from './provider.js'
import type { Tool } from './tool.js'
import type { ContentPart, Message } from './types.js'

// The payload the loop hands to the approval gate and lifecycle hooks for a single
// tool call. `trustTier` comes from the resolved Tool (default 'read' if unknown).
export interface ApprovalRequest {
  id: string
  name: string
  args: unknown
  trustTier: 'read' | 'write' | 'destructive'
}

// The owner's decision on a pending approval. `note` is an optional reason, surfaced
// back to the model in the synthetic rejection result.
export interface ApprovalVerdict {
  approved: boolean
  note?: string
}

export interface RunOptions {
  provider: LlmProvider
  tools: Tool[]
  messages: Message[]
  onText?: (delta: string) => void
  model?: string
  signal?: AbortSignal
  maxTurns?: number
  // Consulted only for write/destructive tools before invoke. Absent ⇒ auto-approve.
  requestApproval?: (call: ApprovalRequest) => Promise<ApprovalVerdict>
  // Tool-call lifecycle hooks (the worker persists tool_calls rows from these).
  onToolStart?: (call: ApprovalRequest) => void | Promise<void>
  onToolEnd?: (
    call: { id: string; name: string },
    outcome: { status: 'done' | 'rejected' | 'failed'; result?: unknown; error?: string },
  ) => void | Promise<void>
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
      } else if (ev.type === 'tool_call') {
        toolCalls.push({ id: ev.id, name: ev.name, args: ev.args })
      }
      // other event types (e.g. 'usage') are observability-only — ignored here
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
      const trustTier = tool?.trustTier ?? 'read'
      const call: ApprovalRequest = { id: tc.id, name: tc.name, args: tc.args, trustTier }

      await opts.onToolStart?.(call)

      // Write/destructive tools pause for owner approval before running.
      if (trustTier !== 'read') {
        const verdict = opts.requestApproval ? await opts.requestApproval(call) : { approved: true }
        if (!verdict.approved) {
          const result = { error: 'user_rejected', note: verdict.note }
          resultParts.push({ type: 'tool_result', id: tc.id, name: tc.name, result })
          await opts.onToolEnd?.({ id: tc.id, name: tc.name }, { status: 'rejected', result })
          continue
        }
      }

      try {
        const result = tool ? await tool.invoke(tc.args) : { error: `unknown tool: ${tc.name}` }
        resultParts.push({ type: 'tool_result', id: tc.id, name: tc.name, result })
        await opts.onToolEnd?.({ id: tc.id, name: tc.name }, { status: 'done', result })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const result = { error }
        resultParts.push({ type: 'tool_result', id: tc.id, name: tc.name, result })
        await opts.onToolEnd?.({ id: tc.id, name: tc.name }, { status: 'failed', error })
      }
    }
    messages.push({ role: 'tool', content: resultParts })
  }

  throw new Error(`runAgent exceeded maxTurns (${maxTurns})`)
}
