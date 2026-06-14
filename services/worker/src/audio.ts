import { extForAudioMime } from '@alfred/shared'
import { writeBytesToWorkspace } from './workspace-files.js'

// A persisted audio reference — the wire form for a TTS clip. Audio bytes live on disk in the
// conversation workspace and are served over GET /media/:conversationId/:filename; only this
// workspace-relative path rides NOTIFY/SSE (the tts_audio event), never the bytes. The audio
// sibling of writeImageToWorkspace (images.ts), sharing writeBytesToWorkspace.
export interface AudioRef {
  path: string
  mimeType: string
}

// Write TTS audio bytes into the conversation workspace and return the workspace-relative
// reference. The providers return audio/wav or audio/mpeg (both mapped by extForAudioMime); the
// 'wav' fallback is purely defensive for an unexpected mimeType — a playable audio extension
// (so /media serves audio/*), never the generic 'bin' that would serve application/octet-stream.
export function writeAudioToWorkspace(
  conversationId: string,
  audio: Buffer,
  mimeType: string,
): AudioRef {
  const ext = extForAudioMime(mimeType) ?? 'wav'
  const path = writeBytesToWorkspace(conversationId, 'tts', audio, ext)
  return { path, mimeType }
}
