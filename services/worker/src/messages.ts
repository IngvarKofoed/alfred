import type { ContentPart, Message, Role } from '@alfred/agent-core'

// messages.content is stored as the agent-core ContentPart[] (the mapping deferred in
// step 3). These convert between DB rows and the loop's Message[].
export function rowsToMessages(rows: { role: string; content: unknown }[]): Message[] {
  return rows.map((r) => ({ role: r.role as Role, content: r.content as ContentPart[] }))
}

export function textOf(content: ContentPart[]): string {
  return content.map((p) => (p.type === 'text' ? p.text : '')).join('')
}
