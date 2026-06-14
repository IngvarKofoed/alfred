import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveInWorkspace } from '@alfred/shared'

// Write bytes into the conversation workspace under a collision-proof filename and return the
// workspace-relative path. The single place the "<prefix>-<timestamp>-<random>.<ext>" naming,
// lazy dir creation, and confined write live — shared by the image (images.ts) and audio
// (audio.ts) workspace writers so the naming + confinement can't drift between them. The random
// suffix (on top of the ms timestamp) keeps two same-prefix files written in the same
// millisecond (parallel generate_image calls, back-to-back TTS sentences) from colliding.
export function writeBytesToWorkspace(
  conversationId: string,
  prefix: string,
  bytes: Buffer,
  ext: string,
): string {
  const relPath = `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`
  const abs = resolveInWorkspace(conversationId, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, bytes)
  return relPath
}
