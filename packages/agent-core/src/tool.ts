// One uniform shape for every tool the loop can call (ARCHITECTURE §7.3), whether
// built-in (like echo) or MCP-sourced later. `trustTier` is declared here but nothing
// enforces approvals in this step — that's the worker/runtime, a later increment.
export interface Tool {
  name: string
  description: string
  inputSchema: object // JSON Schema, surfaced to the model
  trustTier: 'read' | 'write' | 'destructive'
  invoke(args: unknown): Promise<unknown>
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
