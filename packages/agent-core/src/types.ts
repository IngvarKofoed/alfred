// Provider-agnostic conversation model. Shaped compatibly with messages.content
// (docs/DATABASE.md §6.1) but deliberately not coupled to packages/db — mapping to
// rows happens at persistence time, a later step.

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: unknown }

export type Message = { role: Role; content: ContentPart[] }

// What a provider's stream() yields, one event at a time.
export type StreamEvent =
  | { type: 'text'; text: string } // a streamed text delta
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  // Terminal metadata for observability (ARCHITECTURE §6 / observability spec). The
  // loop ignores it; TracingProvider records it.
  | {
      type: 'usage'
      model: string
      promptTokens?: number
      completionTokens?: number
      finishReason?: string
    }
