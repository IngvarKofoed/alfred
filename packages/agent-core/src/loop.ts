import { isImageResult } from './image-result.js'
import type { LlmProvider } from './provider.js'
import type { Tool, ToolLlmCall } from './tool.js'
import type { ContentPart, Message } from './types.js'

// The payload the loop hands to the approval gate and lifecycle hooks for a single
// tool call. `trustTier` comes from the resolved Tool (default 'read' if unknown).
export interface ApprovalRequest {
  id: string
  name: string
  args: unknown
  trustTier: 'read' | 'write' | 'destructive'
  // Copied from the resolved Tool. The loop carries it through but acts on it nowhere — the
  // worker's approval gate uses it for group-scoped approval (ARCHITECTURE §16).
  group?: string
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
  // Whether a given call must pause for owner approval. Absent ⇒ the default gate
  // (write/destructive gate, read runs free). The worker supplies a settings-aware
  // predicate so per-tool approval overrides (the tools page, §16) take effect here.
  requiresApproval?: (call: ApprovalRequest) => boolean
  // An AI call a tool made of its own (e.g. generate_image). The worker persists each as an
  // llm_calls row linked to the originating tool_call so its cost is attributed (§6.5).
  onToolLlmCall?: (callId: string, call: ToolLlmCall) => void | Promise<void>
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
      const call: ApprovalRequest = { id: tc.id, name: tc.name, args: tc.args, trustTier, group: tool?.group }

      await opts.onToolStart?.(call)

      // Pause for owner approval when required. Default: write/destructive gate; the worker
      // can override per tool (e.g. "never ask for this tool", or "always ask for this read").
      if (opts.requiresApproval?.(call) ?? trustTier !== 'read') {
        const verdict = opts.requestApproval ? await opts.requestApproval(call) : { approved: true }
        if (!verdict.approved) {
          const result = { error: 'user_rejected', note: verdict.note }
          resultParts.push({ type: 'tool_result', id: tc.id, name: tc.name, result })
          await opts.onToolEnd?.({ id: tc.id, name: tc.name }, { status: 'rejected', result })
          continue
        }
      }

      try {
        const result = tool
          ? await tool.invoke(tc.args, { recordLlmCall: (call) => opts.onToolLlmCall?.(tc.id, call) })
          : { error: `unknown tool: ${tc.name}` }
        if (isImageResult(result)) {
          // Gemini's functionResponse can't carry an image, so the tool_result holds a text
          // ack; the actual bytes ride on a sibling `image` part of the same tool turn, so
          // the model sees the image (the spec's image-feedback path). The worker reads the
          // original ImageToolResult from onToolEnd to persist the reference, not base64.
          resultParts.push({
            type: 'tool_result',
            id: tc.id,
            name: tc.name,
            result: { summary: result.summary ?? 'image' },
          })
          resultParts.push({ type: 'image', mimeType: result.image.mimeType, data: result.image.data })
        } else {
          resultParts.push({ type: 'tool_result', id: tc.id, name: tc.name, result })
        }
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
