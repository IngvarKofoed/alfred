import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { extForAudioMime } from './mime.js'
import { resolveInWorkspace } from './workspace.js'

// Write bytes into the conversation workspace under a collision-proof filename and return the
// workspace-relative path. The single place the "<prefix>-<timestamp>-<random>.<ext>" naming,
// lazy dir creation, and confined write live — shared by the image (worker images.ts) and audio
// (worker audio.ts, webserver speak route) workspace writers so the naming + confinement can't
// drift between them. The random suffix (on top of the ms timestamp) keeps two same-prefix files
// written in the same millisecond (parallel generate_image calls, back-to-back TTS sentences)
// from colliding.
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

// A persisted audio clip reference — the wire form for a TTS clip (the unit /media serves and
// Discord uploads). The single audio-clip naming + ext-fallback decision, shared by the worker's
// live-run TTS (run.ts) and the webserver's /speak read-out (agent-core synthesizeToClip) so the
// 'tts' prefix and the defensive 'wav' fallback can't drift between the two paths. The 'wav'
// fallback is a playable audio extension (so /media serves audio/*), never the generic 'bin'.
export interface AudioRef {
  path: string
  mimeType: string
}

export function writeAudioToWorkspace(
  conversationId: string,
  audio: Buffer,
  mimeType: string,
): AudioRef {
  const ext = extForAudioMime(mimeType) ?? 'wav'
  return { path: writeBytesToWorkspace(conversationId, 'tts', audio, ext), mimeType }
}
