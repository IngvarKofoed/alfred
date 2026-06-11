import { pgNotify } from '@alfred/db'

// The streamed run events forwarded over NOTIFY -> SSE (subset of ARCHITECTURE §6.2;
// tool/interaction events arrive with tools). Kept tiny — well under the 8000-byte limit.
export type RunEvent =
  | { type: 'token'; text: string }
  // Subtle live tool-activity for the chat. `id` is the agent-core call id (same id
  // the persisted tool_use part carries), so the client keys chips on it and end
  // removes the right one even with parallel same-name calls. `args` is the call's
  // raw arguments for the chip to summarize — omitted when large to stay under the
  // 8000-byte NOTIFY cap (history still renders a truncated summary). The full result
  // is never sent — it lives in tool_calls (the /debug page).
  | { type: 'tool_call_start'; id: string; toolName: string; args?: unknown }
  | { type: 'tool_call_end'; id: string }
  // The worker auto-titled an untitled conversation (§7.5 auto-name); the client applies it
  // to the header + sidebar. Tiny payload, well under the 8000-byte cap.
  | { type: 'title'; title: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'interaction_required'; interactionId: string; kind: 'approval' | 'question' }
  | { type: 'interaction_resolved'; interactionId: string }

export async function notifyRun(conversationId: string, event: RunEvent): Promise<void> {
  await pgNotify(`conversation:${conversationId}`, JSON.stringify(event))
}
