# Voice bugs — 2026-06-15

Reported from on-device voice use. All three diagnosed (multi-agent diagnose + adversarial-verify
run) and addressed; see CHANGELOG entry 77. Live on-device re-test still pending.

1. **I can't interrupt the speaking, neither by saying stop or by pressing the stop button.**
   - **Fixed (Stop button).** `done` and `cancelled` were merged and both called the parameterless
     `runCompleted()`, which on a cancel *drained* the already-buffered TTS clips instead of
     stopping them — so several seconds of speech played out after Stop. Cancel/error now calls
     `runCompleted(cancelled: true)` → `stopPlayback()` (halt the player node + bump the epoch so
     in-flight downloads no-op) and resume listening. The Stop button is now the reliable interrupt.
   - **Improved (saying "stop" = barge-in).** Barge-in via the mic during playback is inherently
     acoustic; the detector was hardened (see bug 3) so it still fires on real over-Alfred speech
     while no longer false-triggering. Thresholds need on-device calibration via the mic-level meter.

2. **The voice changes to different females, even for English.**
   - **Root cause: a documented Gemini limitation.** Each sentence is a separate
     `gemini-2.5-flash-preview-tts` call, and that model drifts its speaker identity per request
     even with the same prebuilt voice. The full fix (synthesize the whole reply in one call) was
     declined to keep low-latency sentence streaming. Added a defensive guard so a blank `TTS_VOICE`
     can never send an empty voiceName (which would make every clip random). Real fix path:
     ElevenLabs (deterministic voice ids; needs `ELEVENLABS_API_KEY`), or revisit one-call synthesis.

3. **A long sentence's clip gets cut off when the next clip starts.**
   - **Fixed.** Confirmed false barge-in: Alfred's own playback leaked past the AEC, crossed the low
     `0.012` energy threshold during `.speaking`, and a *single* frame tripped barge-in →
     `stopPlayback()` cut the playing clip; the next clip then started fresh. The `.speaking`
     barge-in detector now requires energy over a higher threshold *sustained* (~0.25s), with a
     short post-playback-start grace window — so residual echo no longer self-interrupts while
     genuine speech still triggers. Constants flagged for on-device tuning.
