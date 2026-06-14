//
//  VoicePlaceholder.swift
//  Alfred
//
//  RESERVED SEAM — no functional code yet. This file marks the place where the
//  voice increment lands. Nothing here is imported or instantiated by the text
//  MVP; it exists so the structure is whole and the design intent is recorded
//  next to where it will be built.
//
//  Why voice is purely additive (the load-bearing decision, spec
//  docs/specs/2026-06-14-ios-text-chat-mvp.md, INGRESSES §9.3):
//
//  • `ConversationViewModel` already consumes an `AsyncStream<RunEvent>` and renders
//    the transcript REGARDLESS of source. Today that source is the REST+SSE
//    `AlfredClient.events(conversationId:)`. Voice does not reshape the view model.
//
//  • A future `VoiceSession` opens a *parallel* WebSocket to a future `services/voice`
//    for the AUDIO leg only — mic audio up, server-produced TTS audio + transcript
//    events down — and emits the SAME `RunEvent`s (token / tool_call_* / done /
//    interaction_required / …) into the SAME `ConversationViewModel`. The transcript
//    UI, approval cards, and question cards are unchanged. The conversation / run /
//    message model stays shared in Postgres; text chat keeps using REST+SSE (audio
//    needs a socket, text does not — so text is not folded into the WS).
//
//      // (sketch, not built)
//      // final class VoiceSession {
//      //     init(url: URL, conversationId: String)
//      //     func events() -> AsyncStream<RunEvent>   // same enum the SSE reader yields
//      //     func sendAudio(_ pcm: Data)              // user input is just another producer
//      // }
//
//  • A future `AudioEngine` wraps `AVAudioEngine` and enables Apple's on-device voice
//    processing on the input node:
//
//      // (sketch, not built)
//      // try engine.inputNode.setVoiceProcessingEnabled(true)
//
//    `setVoiceProcessingEnabled(true)` turns on Apple's acoustic echo cancellation
//    (AEC) + noise suppression, so Alfred's TTS playback is cancelled out of the
//    captured mic. That is what makes "listen while speaking" / barge-in work: the
//    user can interrupt mid-utterance because the engine no longer hears Alfred's own
//    voice as user speech.
//
//  • STT/TTS run SERVER-SIDE (INGRESSES §9.3): the heavy speech models stay off the
//    device and provider-swappable, with API keys held server-side. The iOS app owns
//    only the audio I/O + on-device AEC/noise suppression, not recognition/synthesis.
//    (The iOS 26 floor keeps `SpeechAnalyzer` available should an on-device path ever
//    be wanted alongside the server-side one — not planned.)
//
//  The two facts the text MVP must keep true so this stays additive — both already
//  hold:
//    (a) `ConversationViewModel` never assumes its events came from SSE, and
//    (b) `send` is just one producer of user input, not the only one.
//
