import type { Tool } from '@alfred/agent-core'
import { conversations, getDb } from '@alfred/db'
import { eq } from 'drizzle-orm'

// A context-bound built-in tool (ARCHITECTURE §7.3): it acts on a specific
// conversation, captured in a closure so Tool.invoke(args) stays context-free.
// trustTier 'write' ⇒ the loop pauses for owner approval before it runs.
export function makeSetTitleTool(conversationId: string): Tool {
  return {
    name: 'set_conversation_title',
    description: 'Set the title of the current conversation.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'New conversation title' } },
      required: ['title'],
    },
    trustTier: 'write',
    async invoke(args: unknown): Promise<unknown> {
      const title = String((args as { title?: unknown } | null)?.title)
      await getDb()
        .update(conversations)
        .set({ title })
        .where(eq(conversations.id, conversationId))
      return { ok: true, title }
    },
  }
}
