# Alfred — Post-MVP Ingresses

Reference for the three post-MVP ingresses (Discord, voice, autonomous triggers). Split out of `ARCHITECTURE.md` §9 (which keeps the ingress contract and the built web ingress, §9.1) so the always-loaded boot context stays small — read this when building one of these surfaces.

All ingresses follow the same shape (§9): receive input → look up/create the conversation row → enqueue a job (pg-boss) → `LISTEN` on the conversation channel → forward `NOTIFY` payloads back → finalize on job complete. Section numbers reference `ARCHITECTURE.md`; the headings retain their original §9 numbers.

---

## 9.2 Discord bot (`alfred-discord`) — post-MVP

**Library**: **discord.js**. Persistent gateway WebSocket; auth = filter by the owner's Discord user ID (drop everything else); DMs + mentions. Streaming edits the reply message as tokens arrive (throttled ~1 edit/sec); responses >2000 chars split or attach as files; attachments land in a temp store the agent reads via a tool call; reactions are the approval UI.

## 9.3 Voice (`alfred-voice`) — native app only, post-MVP

Hands-free is required and **only the native app** is a voice surface (the PWA is chat-only). All components are **cloud APIs** (likely ElevenLabs/Google TTS, Deepgram/Google STT — final choice deferred), so the orchestrator just routes audio+text streams: `app mic → WS → STT → agent worker (pg-boss + NOTIFY) → TTS → WS → app speaker`. Key points: API keys live **server-side, never in the client** (or anyone could spend the owner's budget); the agent core stays the brain (no lock-in to a realtime voice API); wake word runs **on-device** (Picovoice Porcupine or openWakeWord) and only then opens the upstream WS. Native platform deferred — its only contract is "WebSocket with bidirectional audio + a control channel."

**Built (Approach B — voice as an I/O modality on the text pipeline, not a WS orchestrator):** the iOS text-chat client now has hands-free voice without any of the above — no `services/voice` process, no WebSocket. STT is a request/response REST route (`POST /api/conversations/:id/audio`, ARCHITECTURE §9.1) that posts the transcript as a normal user message + a `speak` run; TTS is synthesized server-side by the worker as the run streams (sentence-chunked) and pushed back over the **existing SSE channel** as `tts_audio` events referencing `/media` audio clips (ARCHITECTURE §6.2). Provider-swappable (Google/ElevenLabs) via the agent-core `SttProvider`/`TtsProvider` abstractions (§7.2), keys server-side. On-device capture/AEC/VAD/barge-in live in the app's `VoiceController`. Spec: `docs/specs/2026-06-14-voice-stt-tts.md`. The WebSocket orchestrator above remains the **deferred Approach C** upgrade path if sentence-granular latency ever proves inadequate.

## 9.4 Autonomous triggers (`alfred-triggers`) — post-MVP

**Not built in v1**, reserved so the seams are right. Triggers are ingresses with **no human at the other end** — they enqueue jobs on time/events; results are logged or pushed as a notification through an interactive ingress. Categories: **scheduled** (cron-style, e.g. "8am inbox summary"), **event-driven** (inbox watchers, webhooks, FS watchers — normalize the event, enqueue), **agent-initiated** (the agent schedules a future trigger; a Postgres row picked up by the scheduler). All share the same `enqueue + LISTEN + optionally notify` *transport* as human ingresses; the *execution lifecycle* differs (§7.7 / RUNTIME.md) so adding triggers is wiring, not a redesign.
