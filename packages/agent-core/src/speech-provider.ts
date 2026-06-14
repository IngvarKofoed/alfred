import { loadConfig } from '@alfred/shared'
import { GoogleGenAI, Modality } from '@google/genai'

// The provider abstractions for speech — the audio siblings of LlmProvider (provider.ts) and
// ImageProvider (image-provider.ts). Voice rides the existing run/message/SSE pipeline as an
// input/output modality (spec docs/specs/2026-06-14-voice-stt-tts.md): the webserver uses an
// SttProvider to turn an uploaded clip into a user message; the worker uses a TtsProvider to
// speak Alfred's streamed reply sentence-by-sentence. Both are provider-swappable by config
// (STT_PROVIDER / TTS_PROVIDER), default Google (one credential, reusing @google/genai).

// STT: audio in, text out (whole-utterance batch — no streaming STT, spec non-goal).
export interface SttProvider {
  transcribe(audio: Buffer, opts: { mimeType: string }): Promise<{ text: string }>
}

// TTS: text in, audio out. `signal` threads a run cancel (§10.6) so in-flight synthesis aborts.
// `mimeType` lets the worker pick the clip's file extension (the /media route derives the
// Content-Type back from the filename).
export interface TtsProvider {
  synthesize(text: string, opts?: { signal?: AbortSignal }): Promise<{ audio: Buffer; mimeType: string }>
}

// Config keys for the speech providers (added to the shared zod schema by the config slice).
// Read defensively here so this module compiles standalone — the contract guarantees the keys
// at runtime, but agent-core must not hard-depend on a sibling slice's schema edit.
interface SpeechConfig {
  STT_PROVIDER?: string
  TTS_PROVIDER?: string
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  GOOGLE_SPEECH_API_KEY?: string
  ELEVENLABS_API_KEY?: string
  TTS_VOICE?: string
}

function speechConfig(): SpeechConfig {
  return loadConfig() as unknown as SpeechConfig
}

// Construct the shared @google/genai client, throwing a clear credential-naming error when the
// key is absent — the one place both Google providers build their client (no duplicated guard).
function googleAi(apiKey: string | undefined, who: string): GoogleGenAI {
  if (!apiKey) throw new Error(`GEMINI_API_KEY is not set — required for the ${who}`)
  return new GoogleGenAI({ apiKey })
}

// A Gemini model that accepts audio input for transcription. The chat model (gemini-2.5-flash)
// is multimodal and accepts audio, so reuse GEMINI_MODEL when set.
const DEFAULT_STT_MODEL = 'gemini-2.5-flash'
// Gemini-native TTS model. The 2.5 flash/pro "preview-tts" models are the ones that return
// AUDIO; the chat model does NOT, so TTS always uses this dedicated model regardless of
// GEMINI_MODEL.
const DEFAULT_TTS_MODEL = 'gemini-2.5-flash-preview-tts'
// Gemini prebuilt voice used when TTS_VOICE is unset. "Kore" is one of the documented prebuilt
// voices; any prebuilt voice name is accepted via TTS_VOICE.
const DEFAULT_GEMINI_VOICE = 'Kore'
// ElevenLabs defaults. The voice id is required by the endpoint; "Rachel" (21m00Tcm4TlvDq8ikWAM)
// is the long-standing default sample voice, overridable via TTS_VOICE. eleven_flash_v2_5 is the
// low-latency model, the right fit for sentence-granular synthesis.
const DEFAULT_ELEVENLABS_VOICE = '21m00Tcm4TlvDq8ikWAM'
const ELEVENLABS_TTS_MODEL = 'eleven_flash_v2_5'
const ELEVENLABS_STT_MODEL = 'scribe_v1'

// ---- Google (Gemini-native) ----

// GoogleSttProvider — transcription via @google/genai generateContent with the audio as
// inlineData plus a terse instruction. The audio-capable chat model reads the clip and replies
// with the spoken text. Mirrors GeminiImageProvider's construction + inlineData read.
export class GoogleSttProvider implements SttProvider {
  private readonly ai: GoogleGenAI
  private readonly model: string

  constructor(opts?: { apiKey?: string; model?: string }) {
    const config = speechConfig()
    this.ai = googleAi(opts?.apiKey ?? config.GEMINI_API_KEY, 'Google STT provider')
    this.model = opts?.model ?? config.GEMINI_MODEL ?? DEFAULT_STT_MODEL
  }

  async transcribe(audio: Buffer, opts: { mimeType: string }): Promise<{ text: string }> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: opts.mimeType, data: audio.toString('base64') } },
            { text: 'Transcribe this audio. Reply with ONLY the spoken text, no commentary.' },
          ],
        },
      ],
    })

    // Concatenate the text parts of the first candidate (skip any `thought` parts, as the
    // GeminiProvider stream does, gemini.ts:66).
    const parts = response.candidates?.[0]?.content?.parts ?? []
    const text = parts
      .filter((p) => typeof p.text === 'string' && p.text && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim()
    return { text }
  }
}

// GoogleTtsProvider — Gemini-native TTS via @google/genai generateContent with
// responseModalities:[AUDIO] + a prebuilt voice. The model returns base64 PCM (signed 16-bit
// little-endian, mono, 24000 Hz) on a candidate part's inlineData; we wrap that raw PCM in a
// minimal 44-byte WAV header ourselves (no transcoding dependency) and return audio/wav.
//
// Format note: the spec's prose mentions MP3 (audio/mpeg) for clips, but the *default* Google
// provider deliberately returns audio/wav instead — Gemini-native TTS emits raw PCM, and
// producing MP3 here would require a transcoding dependency (e.g. ffmpeg/lame), which the spec
// explicitly rules out ("no transcoding dependency"). The wire contract is format-agnostic: the
// tts_audio event carries an explicit `mimeType`, the shared mime helpers cover both audio/wav
// and audio/mpeg, and AVPlayer plays WAV natively, so WAV is a correct, dependency-free output.
// The ElevenLabs provider returns audio/mpeg (MP3) for callers who want it; switch via
// TTS_PROVIDER=elevenlabs.
//
// SDK note: @google/genai 1.52.0 supports AUDIO output (Modality.AUDIO, SpeechConfig /
// PrebuiltVoiceConfig in node.d.ts), so this Gemini-native path is used — NOT the Google Cloud
// Text-to-Speech REST fallback. GOOGLE_SPEECH_API_KEY remains the documented escape hatch if a
// future SDK drops AUDIO output, but it is not exercised here.
export class GoogleTtsProvider implements TtsProvider {
  private readonly ai: GoogleGenAI
  private readonly model: string
  private readonly voice: string

  constructor(opts?: { apiKey?: string; model?: string; voice?: string }) {
    const config = speechConfig()
    this.ai = googleAi(opts?.apiKey ?? config.GEMINI_API_KEY, 'Google TTS provider')
    this.model = opts?.model ?? DEFAULT_TTS_MODEL
    this.voice = opts?.voice ?? config.TTS_VOICE ?? DEFAULT_GEMINI_VOICE
  }

  async synthesize(
    text: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ audio: Buffer; mimeType: string }> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text }] }],
      config: {
        ...(opts?.signal ? { abortSignal: opts.signal } : {}),
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
      },
    })

    const parts = response.candidates?.[0]?.content?.parts ?? []
    const inline = parts.find((p) => p.inlineData?.data)?.inlineData
    if (!inline?.data) throw new Error(`${this.model}: the model returned no audio`)

    // Gemini TTS returns raw PCM (e.g. "audio/L16;codec=pcm;rate=24000"); parse the sample rate
    // from the mimeType when present, default 24000. Wrap as WAV so AVPlayer can play it.
    const pcm = Buffer.from(inline.data, 'base64')
    const sampleRate = parseSampleRate(inline.mimeType) ?? 24000
    const wav = pcmToWav(pcm, { sampleRate, channels: 1, bitsPerSample: 16 })
    return { audio: wav, mimeType: 'audio/wav' }
  }
}

// ---- ElevenLabs (plain fetch, no SDK) ----

// ElevenLabsSttProvider — Scribe over the multipart speech-to-text endpoint.
export class ElevenLabsSttProvider implements SttProvider {
  private readonly apiKey: string

  constructor(opts?: { apiKey?: string }) {
    const apiKey = opts?.apiKey ?? speechConfig().ELEVENLABS_API_KEY
    if (!apiKey) {
      throw new Error('ELEVENLABS_API_KEY is not set — required for the ElevenLabs STT provider')
    }
    this.apiKey = apiKey
  }

  async transcribe(audio: Buffer, opts: { mimeType: string }): Promise<{ text: string }> {
    const form = new FormData()
    form.append('model_id', ELEVENLABS_STT_MODEL)
    form.append('file', new Blob([new Uint8Array(audio)], { type: opts.mimeType }), 'audio')

    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      body: form,
    })
    if (!res.ok) {
      // Status only — never embed the upstream response body in the thrown message (it can carry
      // rate-limit / auth detail and would otherwise propagate into logs).
      throw new Error(`ElevenLabs STT failed (${res.status})`)
    }
    const json = (await res.json()) as { text?: string }
    return { text: (json.text ?? '').trim() }
  }
}

// ElevenLabsTtsProvider — the convert endpoint, returns MP3 (audio/mpeg).
export class ElevenLabsTtsProvider implements TtsProvider {
  private readonly apiKey: string
  private readonly voice: string

  constructor(opts?: { apiKey?: string; voice?: string }) {
    const config = speechConfig()
    const apiKey = opts?.apiKey ?? config.ELEVENLABS_API_KEY
    if (!apiKey) {
      throw new Error('ELEVENLABS_API_KEY is not set — required for the ElevenLabs TTS provider')
    }
    this.apiKey = apiKey
    this.voice = opts?.voice ?? config.TTS_VOICE ?? DEFAULT_ELEVENLABS_VOICE
  }

  async synthesize(
    text: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ audio: Buffer; mimeType: string }> {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voice)}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: ELEVENLABS_TTS_MODEL }),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      },
    )
    if (!res.ok) {
      // Status only — see the STT note above (don't propagate the provider's response body).
      throw new Error(`ElevenLabs TTS failed (${res.status})`)
    }
    const audio = Buffer.from(await res.arrayBuffer())
    return { audio, mimeType: 'audio/mpeg' }
  }
}

// ---- Factories ----

// Select the STT provider by config (default 'google'). Throws a clear, credential-naming error
// at call time when the selected provider's key is absent — never a boot failure (mirroring the
// GEMINI_API_KEY optionality: a process that never transcribes still boots).
export function makeSttProvider(): SttProvider {
  const provider = (speechConfig().STT_PROVIDER ?? 'google').toLowerCase()
  switch (provider) {
    case 'elevenlabs':
      return new ElevenLabsSttProvider()
    case 'google':
      return new GoogleSttProvider()
    default:
      throw new Error(`Unknown STT_PROVIDER '${provider}' — expected 'google' or 'elevenlabs'`)
  }
}

export function makeTtsProvider(): TtsProvider {
  const provider = (speechConfig().TTS_PROVIDER ?? 'google').toLowerCase()
  switch (provider) {
    case 'elevenlabs':
      return new ElevenLabsTtsProvider()
    case 'google':
      return new GoogleTtsProvider()
    default:
      throw new Error(`Unknown TTS_PROVIDER '${provider}' — expected 'google' or 'elevenlabs'`)
  }
}

// ---- WAV container helpers ----

// Gemini TTS reports its PCM rate in the mimeType, e.g. "audio/L16;codec=pcm;rate=24000".
// Pull the rate out so the WAV header is correct even if Google changes the default.
function parseSampleRate(mimeType?: string): number | undefined {
  if (!mimeType) return undefined
  const m = /rate=(\d+)/i.exec(mimeType)
  return m ? Number(m[1]) : undefined
}

// Wrap raw little-endian PCM in a minimal 44-byte RIFF/WAVE header (no transcoding library).
// Defaults match Gemini TTS output: signed 16-bit LE, mono, 24000 Hz.
function pcmToWav(
  pcm: Buffer,
  opts: { sampleRate: number; channels: number; bitsPerSample: number },
): Buffer {
  const { sampleRate, channels, bitsPerSample } = opts
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length

  const header = Buffer.alloc(44)
  header.write('RIFF', 0) // ChunkID
  header.writeUInt32LE(36 + dataSize, 4) // ChunkSize = 36 + Subchunk2Size
  header.write('WAVE', 8) // Format
  header.write('fmt ', 12) // Subchunk1ID
  header.writeUInt32LE(16, 16) // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20) // AudioFormat (1 = PCM)
  header.writeUInt16LE(channels, 22) // NumChannels
  header.writeUInt32LE(sampleRate, 24) // SampleRate
  header.writeUInt32LE(byteRate, 28) // ByteRate
  header.writeUInt16LE(blockAlign, 32) // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34) // BitsPerSample
  header.write('data', 36) // Subchunk2ID
  header.writeUInt32LE(dataSize, 40) // Subchunk2Size

  return Buffer.concat([header, pcm])
}
