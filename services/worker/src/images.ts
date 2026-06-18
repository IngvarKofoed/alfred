import { extForImageMime, writeBytesToWorkspace } from '@alfred/shared'

// A persisted image reference — the DB/wire form (Postgres stays blob-free, the spec's
// Approach A). The inline base64 lives only in agent-core's `image` ContentPart in memory.
export interface ImageRef {
  type: 'image'
  path: string
  mimeType: string
}

// Write base64 image bytes into the conversation workspace and return the workspace-relative
// reference. Naming + confinement live in writeBytesToWorkspace (shared with the audio writer).
export function writeImageToWorkspace(
  conversationId: string,
  prefix: string,
  image: { mimeType: string; data: string },
): ImageRef {
  const ext = extForImageMime(image.mimeType) ?? 'bin'
  const path = writeBytesToWorkspace(conversationId, prefix, Buffer.from(image.data, 'base64'), ext)
  return { type: 'image', path, mimeType: image.mimeType }
}
