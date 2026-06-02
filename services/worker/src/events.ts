import { pgNotify } from '@alfred/db'

// The streamed run events forwarded over NOTIFY -> SSE (subset of ARCHITECTURE §6.2;
// tool/interaction events arrive with tools). Kept tiny — well under the 8000-byte limit.
export type RunEvent =
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export async function notifyRun(conversationId: string, event: RunEvent): Promise<void> {
  await pgNotify(`conversation:${conversationId}`, JSON.stringify(event))
}
