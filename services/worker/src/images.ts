import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { extForImageMime, resolveInWorkspace } from '@alfred/shared'

// A persisted image reference — the DB/wire form (Postgres stays blob-free, the spec's
// Approach A). The inline base64 lives only in agent-core's `image` ContentPart in memory.
export interface ImageRef {
  type: 'image'
  path: string
  mimeType: string
}

// Write base64 image bytes into the conversation workspace and return the workspace-relative
// reference. Creates the conversation dir lazily on first write. The filename carries a random
// suffix as well as the timestamp so two same-prefix images written in the same millisecond
// (e.g. parallel generate_image calls in one turn) can't collide and overwrite each other.
export function writeImageToWorkspace(
  conversationId: string,
  prefix: string,
  image: { mimeType: string; data: string },
): ImageRef {
  const ext = extForImageMime(image.mimeType) ?? 'bin'
  const relPath = `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`
  const abs = resolveInWorkspace(conversationId, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, Buffer.from(image.data, 'base64'))
  return { type: 'image', path: relPath, mimeType: image.mimeType }
}
