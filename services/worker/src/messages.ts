import { readFile } from 'node:fs/promises'
import type { ContentPart, Message, Role } from '@alfred/agent-core'
import { resolveInWorkspace, textFromContent } from '@alfred/shared'

// messages.content is stored as the agent-core ContentPart[]. Images are persisted as a
// workspace reference { type:'image', path, mimeType } (Postgres stays blob-free, the spec's
// Approach A); the model needs the inline { type:'image', mimeType, data:<base64> } form, so
// the worker reads the bytes off disk here when assembling history.

// A persisted image reference (on the wire / in the DB). Distinct from the agent-core inline
// `image` ContentPart, which carries base64 `data` instead of a `path`.
interface ImageRef {
  type: 'image'
  path: string
  mimeType: string
}

function isImageRef(part: unknown): part is ImageRef {
  if (part === null || typeof part !== 'object') return false
  const p = part as { type?: unknown; path?: unknown; mimeType?: unknown }
  return p.type === 'image' && typeof p.path === 'string' && typeof p.mimeType === 'string'
}

// Inline a persisted image reference by reading its bytes from the conversation workspace.
// Async so a large image doesn't block the event loop. A missing/unreadable file becomes a
// text part (fail loud, don't crash the run — §10.7).
async function inlinePart(conversationId: string, part: ContentPart): Promise<ContentPart> {
  if (!isImageRef(part)) return part
  try {
    const abs = resolveInWorkspace(conversationId, part.path)
    const data = (await readFile(abs)).toString('base64')
    return { type: 'image', mimeType: part.mimeType, data }
  } catch {
    return { type: 'text', text: `[image unavailable: ${part.path}]` }
  }
}

// A stored `trigger_context` part (the fenced, model-only watcher delta written by createAutomationRun)
// is normalized to a plain text part so the provider includes it in the model input. The chat
// renderers skip it (non-text), so it stays out of the visible thread; the model still sees the fenced
// delta — keeping the §16 fencing in the prompt. Defined loosely because trigger_context is a
// storage-only shape (not an agent-core ContentPart) that exists only between createAutomationRun here.
function normalizeTriggerContext(part: ContentPart): ContentPart {
  const p = part as { type?: unknown; text?: unknown }
  if (p.type === 'trigger_context' && typeof p.text === 'string') return { type: 'text', text: p.text }
  return part
}

export async function rowsToMessages(
  conversationId: string,
  rows: { role: string; content: unknown }[],
): Promise<Message[]> {
  // Inline every part of every row concurrently — image reads are I/O-bound and independent.
  return Promise.all(
    rows.map(async (r) => ({
      role: r.role as Role,
      content: await Promise.all(
        (r.content as ContentPart[]).map((p) => inlinePart(conversationId, normalizeTriggerContext(p))),
      ),
    })),
  )
}

export function textOf(content: ContentPart[]): string {
  return textFromContent(content)
}
