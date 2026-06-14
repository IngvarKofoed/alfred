# iOS voice — always-on STT + server-pushed TTS

Add hands-free voice to the native iOS app: a single toggle that makes the app **listen
continuously**, detect when an utterance ends **on-device**, send that audio to a backend
**STT** route, and post the transcript as a normal message — then **speak Alfred's reply** as
it streams, synthesized **server-side** sentence-by-sentence and pushed back over the existing
SSE channel. This is the "middle way" (Approach B): STT is a request/response route, TTS is
produced by the worker as the run streams and delivered as `tts_audio` SSE events referencing
`/media` audio clips. No new process, no WebSocket — voice is an *input/output modality* on the
existing run/message/SSE pipeline, not a new ingress.

## Key decisions

- **Voice rides the existing pipeline, not a new ingress** (reuses). STT output is posted as a
  normal user message → the existing run + NOTIFY/SSE path; the iOS voice layer drives the
  existing `ConversationTransport`. This **diverges** from INGRESSES §9.3's voice-WebSocket
  framing and the text-MVP spec's `VoiceSession` WS seam (`clients/ios/.../Voice/VoicePlaceholder.swift`)
  — those become the still-available Approach C upgrade path if latency ever demands it.
- **Server-pushed TTS over SSE** (extends). The worker sentence-chunks its own streamed output
  in `run.ts`'s `onText`, synthesizes each sentence via a `TtsProvider`, writes the clip to the
  conversation workspace, and emits a new `tts_audio` event. Reuses NOTIFY→SSE→`/media`; audio
  bytes never ride NOTIFY (8000-byte cap) — the event carries only a workspace path + seq.
- **New `tts_audio` RunEvent** (extends). Added to `services/worker/src/events.ts`, mirrored in
  the iOS and web `RunEvent` shapes. The web client ignores it (its if/else event chain falls
  through unknown types); iOS routes it to the voice player.
- **`SttProvider` + `TtsProvider` abstractions in agent-core** (new). Siblings of `LlmProvider`
  / `ImageProvider` in `packages/agent-core/src/speech-provider.ts`, with Google and ElevenLabs
  impls selected by config. The **webserver** uses STT (its first `@alfred/agent-core`
  dependency — today it imports only db/shared/hono/pg); the **worker** uses TTS.
- **Per-run `speak` flag** (extends; schema migration). A new `agent_runs.speak boolean default
  false`, set true *only* by the audio route; the worker reads `run.speak` to decide whether to
  synthesize TTS at all. Typed `/messages` runs stay silent and cost nothing extra. New
  migration `0008`.
- **Combined `POST /api/conversations/:id/audio`** (new). One call: STT the uploaded audio →
  insert the user message (text = transcript) + a `speak` run in the same transaction shape as
  `/messages` → return `{ runId, transcript }`. Saves a round-trip over a standalone `/api/stt`,
  and returns the transcript so the app can show what it heard.
- **On-device capture, AEC, and endpointing; server-side recognition/synthesis** (extends §9.3).
  `AVAudioEngine` + `setVoiceProcessingEnabled(true)` (Apple acoustic echo cancellation + noise
  suppression) and a VAD/endpointer run in the app; the heavy speech models stay server-side
  and provider-swappable, keys server-side.
- **Barge-in stops playback, not the run** (reuses). The mic stays open with AEC during
  playback; detected user speech stops *local* playback and starts capturing, but the in-flight
  run finishes server-side and the transcript still completes. Because runs serialize per
  conversation (§7.6), the captured utterance is posted once that run reaches `done` — usually
  immediate, as barge-in lands near the end of a reply. No new server mechanism; explicit Stop
  stays the `POST …/cancel` path (§10.6).

## Goals

- One toggle: speech on ⇒ always listening; on-device end-of-utterance detection auto-sends;
  Alfred's reply is spoken; then it loops back to listening.
- Reply audio starts as soon as the **first sentence** is ready server-side, played in order —
  the "as fast as possible" goal, met by pipelining sentence-TTS against the still-streaming
  token feed.
- Barge-in: the owner can interrupt Alfred mid-reply.
- Reuse the run/message/SSE pipeline and the iOS transport seam — no new process or protocol.
- STT/TTS provider-swappable (Google / ElevenLabs), API keys server-side only.

## Non-goals

- **A `services/voice` process or WebSocket** — that's Approach C, deferred. Audio uses REST +
  SSE + `/media`.
- **Streaming STT** (whole-utterance batch only) and **true token-level streaming TTS**
  (sentence-granular clips only).
- **Wake word** — listening is gated by the in-app toggle, not a hotword (later, on-device).
- **Voice on the web PWA** — chat-only by design (§9.3); `tts_audio` is simply ignored there.
- **STT/TTS cost accounting** in `llm_calls` — these are out-of-loop (STT has no run yet);
  deferred alongside the §7.7 budget work.
- **Voice/language selection UI** — a config-level default voice for MVP, no in-app picker.

## Design

### Backend

**Provider abstractions** (`packages/agent-core/src/speech-provider.ts`, mirroring
`image-provider.ts`):

```ts
interface SttProvider {  // audio in, text out
  transcribe(audio: Buffer, opts: { mimeType: string }): Promise<{ text: string }>
}
interface TtsProvider {  // text in, audio out
  synthesize(text: string, opts?: { signal?: AbortSignal }): Promise<{ audio: Buffer; mimeType: string }>
}
```

Concrete impls `GoogleSttProvider`/`GoogleTtsProvider` and `ElevenLabsSttProvider`/
`ElevenLabsTtsProvider`, chosen by new config keys. **Default: `STT_PROVIDER=google`,
`TTS_PROVIDER=google`** — one Google credential, both mature. The Google impls reuse the
existing `@google/genai` SDK + `GEMINI_API_KEY` via Gemini's native audio (transcription +
the Gemini TTS models), the choice consistent with `image-provider.ts`; a dedicated
`GOOGLE_SPEECH_API_KEY` for Google Cloud Speech-to-Text / Text-to-Speech is the fallback if
quality or latency require it. `ELEVENLABS_API_KEY` is a one-key swap for higher-quality TTS;
`TTS_VOICE` selects the default voice. Like the email/Gemini keys, all optional: a route that
needs an unconfigured provider returns a clear error, never a boot failure.

**STT + run creation** — `POST /api/conversations/:id/audio` (`services/webserver/src/app.ts`),
multipart like `/files`: validate size/type, `SttProvider.transcribe(...)`, then — in the same
transaction shape the `/messages` route uses (`ensureConversation` → insert `user` message with
`text = transcript` → insert a `pending` run with `speak = true`) — enqueue the job and return
`{ runId, transcript }`. A 409 on the one-active-run index maps to "busy" exactly as `/messages`
does. An empty transcript (silence/noise) returns 422 so the app can resume listening without a
ghost message.

**Worker TTS** (`services/worker/src/run.ts`): when `run.speak`, an accumulator in `onText`
appends streamed deltas and, on a sentence boundary (`.`/`!`/`?`/newline past a small min
length), flushes the sentence through a `ttsChain` (serialized like `notifyChain`): strip light
markdown → `TtsProvider.synthesize` → write the clip to the workspace
(`writeAudioToWorkspace`, sibling of `writeImageToWorkspace`) → `notifyRun(..., { type:
'tts_audio', seq, path, mimeType })`. The remaining buffer is flushed as a final clip after the
loop. `seq` increments per clip so the app plays in order even if a synthesis returns
out-of-order. TTS is **best-effort**: a synthesis/write failure logs and drops that clip, never
failing the run (mirrors auto-title and image persistence). `done` is emitted after `ttsChain`
settles, so every clip is sent before the terminal event. The abort signal threads into
`synthesize` so a cancel kills in-flight TTS.

Clips are synthesized in the provider's native format, carried on the event's explicit
`mimeType` (so the format is provider-driven, not assumed): the default Google (Gemini-native)
provider returns **WAV (`audio/wav`)** — Gemini TTS emits raw PCM, which the provider wraps in a
WAV header rather than pulling in a transcoding dependency to make MP3 — while ElevenLabs returns
**MP3 (`audio/mpeg`)**. Both are natively playable by `AVPlayer`.
**New event** (`events.ts`): `{ type: 'tts_audio'; seq: number; path: string; mimeType: string }`
— tiny, well under the NOTIFY cap. **`/media` serving** gains audio MIME types: `contentTypeFor`
(app.ts) / the shared `imageMimeForExt` helper learns `.mp3 → audio/mpeg`, or a small
audio-aware branch is added.

**Schema** (`packages/db/src/schema.ts` + migration `0008`): `agentRuns.speak boolean not null
default false`. The pg-boss payload stays `{ runId }` — the flag lives on the row, read at
pickup, consistent with §6.3.

### iOS (`clients/ios/Alfred/Alfred/Voice/`)

A `VoiceController` (`@Observable`, `@MainActor`) realizes the reserved `Voice/` seam — but as
an audio layer *on top of* the existing `ConversationTransport`, **not** a replacement WS
transport. It owns:

- **Audio session**: `AVAudioSession` `.playAndRecord` + `AVAudioEngine` with
  `inputNode.setVoiceProcessingEnabled(true)` (AEC + noise suppression), so Alfred's playback is
  cancelled from the mic and the VAD doesn't trip on his own voice (the prerequisite for
  barge-in).
- **Endpointing (VAD)**: on the input tap, detect speech start (energy over threshold) and end
  (≈1–1.5 s trailing silence) — energy-based, no on-device recognition. Buffer PCM between start
  and end, encode as **16 kHz mono LINEAR16 WAV** (Google STT's preferred input; ElevenLabs
  accepts it too), upload to `/audio`.
- **State machine**: `off → listening → capturing → thinking → speaking → listening`. `thinking`
  spans the `/audio` round-trip + the run until the first `tts_audio`; `speaking` plays the clip
  queue (an `AVQueuePlayer` / player node fed in `seq` order, fetching each `/media` URL);
  draining the queue after `done` returns to `listening`.
- **Barge-in**: while `speaking`, the mic stays open; detected speech → stop *playback* and
  transition to `capturing`. The in-flight run is **not** cancelled — it finishes server-side
  and the transcript completes. Since runs serialize per conversation (§7.6), the captured
  utterance is posted once the active run's terminal event (`done`) arrives (usually immediate,
  as barge-in lands near the end of a reply); explicit Stop remains `POST …/cancel`.
- **Transcript stays in sync**: because voice posts a normal message and the run streams as
  usual, the existing `ConversationViewModel` renders the spoken exchange like any text turn —
  one identity, one continuous conversation (CONCEPT). The `tts_audio` events are consumed by
  `VoiceController` for playback and are invisible to the transcript view.

**UI**: a mic/speech toggle on the conversation screen (and a clear listening/speaking
indicator). `Info.plist` gains `NSMicrophoneUsageDescription`. The existing ATS exception
(CHANGELOG 70) already permits plain-HTTP `/media` fetches over the tailnet.

### Wire/contract summary (the only cross-surface changes)

- New route `POST /api/conversations/:id/audio` → `{ runId, transcript }`.
- New `RunEvent` case `tts_audio` (worker emits; iOS plays; web ignores).
- New column `agent_runs.speak`.
- New config keys for provider selection + the ElevenLabs key / default voice.

## Alternatives considered

- **Approach A — REST-minimal, client-pulled TTS.** Same STT route, but the app accumulates the
  SSE `token` text itself and calls a stateless `POST /api/tts` per sentence. Smallest (the
  worker never touches TTS, no `speak` flag, no new event), but pushes all chunking/ordering
  into the client and adds a client→server round-trip per sentence. Rejected as too thin for the
  "fast, server-driven" goal — though it shares this spec's on-device audio layer verbatim.
- **Approach C — streaming voice WebSocket service (§9.3).** A new `services/voice` process
  streaming PCM up to streaming STT and TTS audio back down one socket. Lowest latency and true
  full-duplex, but a whole new process + wire protocol + audio framing. Deferred; remains the
  upgrade path behind the same on-device audio layer if sentence-granular latency proves
  inadequate.
