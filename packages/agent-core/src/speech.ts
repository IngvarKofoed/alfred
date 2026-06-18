import { writeAudioToWorkspace } from '@alfred/shared'
import { makeTtsProvider, type SpeechUsage } from './speech-provider.js'

// Speech helpers shared across ingresses (spec docs/specs/2026-06-18-read-out-command.md). The
// portable core behind the /speak command: strip markdown, split complete text into ordered
// sentence chunks, and synthesize one chunk to a workspace clip. These mirror the worker's
// live (incremental) TTS path in run.ts but operate on COMPLETE, non-streaming text, so the
// webserver (and later Discord) can re-speak an existing message without an agent run.

// Strip light markdown so the spoken text reads as plain prose, not symbols ("star star bold").
// Best-effort and conservative — emphasis/heading/code markers, link/image syntax (keep the
// visible label, drop the URL). Not a full markdown parser; the model's prose is mostly plain.
export function stripMarkdownForSpeech(text: string): string {
  return (
    text
      // images then links: ![alt](url) / [label](url) -> alt / label
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // fenced/inline code fences -> drop the backticks, keep the content
      .replace(/`+/g, '')
      // emphasis/bold markers and leading heading hashes/blockquote markers
      .replace(/[*_~]+/g, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

// A flushed sentence chunk is at least this long, so a tiny fragment ("Hi.") merges into the
// next chunk rather than producing a premature, choppy clip. Mirrors the worker's incremental
// flush rule (run.ts), but applied to complete text.
export const TTS_MIN_SENTENCE_CHARS = 12

// Split COMPLETE text into ordered sentence chunks on [.!?\n] boundaries, merging any fragment
// whose trimmed length is below TTS_MIN_SENTENCE_CHARS into the next chunk (so abbreviations /
// short openers don't make tiny clips). The whole text is covered: the trailing remainder after
// the last qualifying boundary is its own chunk. Returns trimmed, non-empty chunks in order.
//
// This is the non-streaming counterpart to the worker's incremental flush loop (run.ts): there
// the buffer grows delta-by-delta and we flush the first qualifying boundary each time; here the
// text is whole, so we walk every boundary once and carve where the accumulated chunk qualifies.
export function splitIntoSpeechChunks(text: string): string[] {
  const chunks: string[] = []
  const re = /[.!?\n]/g
  let start = 0
  // One forward pass: at each boundary, flush [start, end) as a chunk once it's long enough,
  // otherwise keep scanning so a sub-min fragment merges into the next chunk. Single regex, no
  // per-iteration re-slice of a shrinking string.
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + 1
    const chunk = text.slice(start, end).trim()
    if (chunk.length >= TTS_MIN_SENTENCE_CHARS) {
      chunks.push(chunk)
      start = end
    }
  }
  // Trailing remainder (no qualifying boundary left) is its own chunk, so the whole text is
  // covered even when it doesn't end on punctuation or is shorter than the min length.
  const tail = text.slice(start).trim()
  if (tail) chunks.push(tail)
  return chunks
}

// Synthesize one piece of text to TTS audio bytes (markdown stripped), returning null when the
// text strips to nothing (markdown-only, e.g. "[](url)") so callers skip an empty synth. The
// ingress-agnostic bytes primitive — a future Discord/WhatsApp path that uploads an attachment
// uses this directly without writing a workspace file. A missing/failed provider key throws here
// (mirroring STT in /audio), never a boot failure.
export async function synthesizeSpeech(
  text: string,
  opts?: { signal?: AbortSignal },
): Promise<{ audio: Buffer; mimeType: string; usage?: SpeechUsage } | null> {
  const stripped = stripMarkdownForSpeech(text)
  if (!stripped) return null
  return makeTtsProvider().synthesize(stripped, opts)
}

// Synthesize one piece of text to a clip in the conversation workspace, returning the
// workspace-relative path + mimeType (the unit /media serves) plus any provider usage, or null
// when there's nothing to say. The clip naming/ext-fallback is the shared writeAudioToWorkspace,
// the same writer the worker's live-run TTS uses.
export async function synthesizeToClip(
  conversationId: string,
  text: string,
  opts?: { signal?: AbortSignal },
): Promise<{ path: string; mimeType: string; usage?: SpeechUsage } | null> {
  const synth = await synthesizeSpeech(text, opts)
  if (!synth) return null
  const ref = writeAudioToWorkspace(conversationId, synth.audio, synth.mimeType)
  return { path: ref.path, mimeType: ref.mimeType, usage: synth.usage }
}
