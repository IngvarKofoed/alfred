// One uniform shape for every tool the loop can call (ARCHITECTURE §7.3), whether
// built-in (like echo) or MCP-sourced later. `trustTier` is declared here but nothing
// enforces approvals in this step — that's the worker/runtime, a later increment.
export interface Tool {
  name: string
  description: string
  inputSchema: object // JSON Schema, surfaced to the model
  trustTier: 'read' | 'write' | 'destructive'
  // Optional grouping label (e.g. 'browser'). The loop ignores it; the worker uses it for
  // group-scoped approval and (later) per-conversation tool exposure (ARCHITECTURE §7.5/§16).
  // Ungrouped tools are each their own implicit group of one.
  group?: string
  // True if the tool pauses mid-invoke for owner input (e.g. ask_user raises a question and
  // blocks). The loop ignores it; the worker uses it to record the tool_calls row as 'pending'
  // so it can legally transition pending → awaiting_user → done (§10.9), rather than the
  // read-tier "starts running" shortcut. Generic so a second pausing tool needs no name check.
  pausesForInput?: boolean
  // `ctx` is optional and backward-compatible: tools that make AI calls of their own (e.g.
  // generate_image) use ctx.recordLlmCall to attribute that cost; plain tools ignore it.
  invoke(args: unknown, ctx?: ToolContext): Promise<unknown>
}

// A provider call a tool made outside the agent loop (e.g. generate_image). Recorded so the
// cost reaches llm_calls / agent_runs instead of reading as $0. Summaries never carry image
// base64. `images` drives cost for flat-per-image models (pricing.ts perImageOutput).
export interface ToolLlmCall {
  model: string
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  images?: number
  requestSummary?: unknown
  responseSummary?: string
  finishReason?: string
  latencyMs?: number
}

// Passed to Tool.invoke so a tool can report its own AI calls back to the worker, which
// persists each as an llm_calls row linked to the originating tool_call (ARCHITECTURE §6.5).
export interface ToolContext {
  recordLlmCall(call: ToolLlmCall): void | Promise<void>
  // The agent-core call id of this invocation; a tool uses it to correlate to its own
  // tool_calls row (e.g. ask_user flips that row to awaiting_user while it pauses).
  callId?: string
}

// The single built-in tool for the skeleton: enough to exercise a full tool-call
// round-trip without any side effects.
export const echoTool: Tool = {
  name: 'echo',
  description: 'Echo the given text back to the caller.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The text to echo back.' } },
    required: ['text'],
  },
  trustTier: 'read',
  async invoke(args: unknown): Promise<unknown> {
    const text = (args as { text?: unknown } | null)?.text
    return { echoed: typeof text === 'string' ? text : String(text) }
  },
}
