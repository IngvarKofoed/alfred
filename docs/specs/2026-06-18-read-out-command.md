# Speak command — read out the last reply on demand

A user-invoked `/speak` command that takes the **last assistant message** in a conversation, runs it through Alfred's configured TTS voice, and plays the audio. Synthesis is **sentence-chunked** for fast first-audio and factored into ingress-agnostic helpers, so the same core serves the web app now and Discord / future clients (e.g. WhatsApp) later — each differing only in how it *delivers* the resulting clips. It runs **without an agent run** (no pg-boss job, no LLM loop): the webserver synthesizes chunks and streams the clip references back as they're ready. v1 is **web only**; Discord is a fast-follow on the same helpers.

## Key decisions

- **No agent run; streamed chunk synthesis** (diverges). The command re-speaks an *existing* message, so it does **not** go through the run-coupled, `agent_runs.speak` → worker-loop → `tts_audio` pipeline the iOS voice client uses. The webserver synthesizes the message's sentences itself (it already depends on `@alfred/agent-core` for STT) and streams clip references back as each is ready — no run row, no pg-boss job, no one-active-run-index conflict.
- **Sentence-chunked, streamed delivery** (extends). v1 chunks the reply into sentences and plays clip 0 while later clips synthesize — the same first-audio-latency trick as the live voice pipeline, but over the complete (not streaming) message text. `POST /api/conversations/:id/speak` responds with a **stream** of `{ seq, path, mimeType }` clip refs, self-contained on its own response body (`fetch` + `response.body` reader) so there's no cross-surface bleed — the reuse-`tts_audio`-over-SSE alternative is in Alternatives considered. The web client plays them through an ordered queue.
- **Three ingress-agnostic helpers** (new). The portable core, callable by any ingress/process:
  - `readLastAssistantText(db, conversationId) → string | null` — `@alfred/db`. Most recent `role:'assistant'` message with a non-empty text part (skips tool-only / empty turns, like `Chat.tsx`'s `showName`). `null` ⇒ nothing to read.
  - `splitIntoSpeechChunks(text) → string[]` — `agent-core`. Sentence split with the worker's min-length merge (so "Hi." doesn't make a tiny clip). For complete text; the worker's *incremental* flush stays separate.
  - `synthesizeToClip(conversationId, text) → { path, mimeType, usage? }` — `agent-core`. `stripMarkdownForSpeech` → `makeTtsProvider().synthesize` → workspace clip. The clip (path + mime) is the unit `/media` serves and Discord later uploads.
- **`stripMarkdownForSpeech` → agent-core, `writeBytesToWorkspace` → `@alfred/shared`** (extends). Both are currently worker-local (`run.ts:40`, `workspace-files.ts`); the helpers need them, and the worker keeps using them from their new homes (mechanical import updates).
- **`speak` registry command returning an `action` directive** (extends). A new `speak` command (alias `read`) joins the `@alfred/commands` registry → web palette + (later) Discord slash. Its `run()` does **no** synthesis — it checks `readLastAssistantText` and returns `{ action: 'speak' }` (a new optional field on `CommandResult`) or `{ error }`. The ingress interprets the directive, so `@alfred/commands` stays a pure `@alfred/db`-only package.
- **Cost attributed to the conversation's most recent run** (extends). The per-chunk `usage` accumulates into one aggregated `'tts'` synthetic `tool_calls` + `llm_calls` row via `recordOutOfLoopLlmCall` (the CHANGELOG-76 pattern), anchored on the conversation's latest `agent_run` (there's no `message → run` FK, so "latest run" is the pragmatic anchor). Visible per-call on `/debug`; it will **not** re-sum into that run's already-rolled-up `agent_runs.cost_usd`.
- **New web audio playback + play queue** (new). The web client has *no* audio today (`tts_audio` is typed but ignored — `Chat.tsx:52-54`). The command adds an ordered `HTMLAudioElement` queue (play next on `ended`, by `seq`) plus a "🔊 Speaking…" system note; re-invoking stops the current queue and starts fresh.

## Goals

- A `/speak` command (web palette) that reads the conversation's last assistant reply in Alfred's configured voice, with audio starting at the first sentence.
- Factor synthesis so adding the feature to another client is "call the helpers + deliver the clips."

## Non-goals

- **Discord** — a fast-follow on the same helpers (single concatenated clip + attachment upload, the `index.ts:378` path); deliberately not in this increment.
- iOS read-out (near-free later — iOS already has a clip queue — but out of scope here).
- A per-message 🔊 button (v1 is the command; the button is a clean follow-on).
- Discord voice-channel playback (`@discordjs/voice`); auto-reading every reply; a cost cap.

## Design

### Web flow

1. The user types `/speak`; `Chat.tsx` forwards the `/`-line to `POST /api/conversations/:id/commands`.
2. `executeCommand` dispatches `speak` → `{ action: 'speak' }` (or `{ error: 'Nothing to read out yet.' }` when `readLastAssistantText` is null).
3. On `action: 'speak'`, the client shows the system note and opens `POST /api/conversations/:id/speak`, reading its streamed body.
4. The route: `text = readLastAssistantText`; `chunks = splitIntoSpeechChunks(text)`; for each chunk in order, `synthesizeToClip` then emit `{ seq, path, mimeType }` on the response stream; accumulate `usage`. After the last chunk, `recordOutOfLoopLlmCall` writes the aggregated `'tts'` row against the conversation's most recent run (best-effort — a failure never fails the read-out).
5. The client enqueues each clip ref and plays `GET /media/<id>/<path>` in `seq` order, advancing on `ended`.

A missing/failed TTS provider key surfaces as a thrown error in `synthesizeToClip` (mirroring STT in `/audio`), returned as a clean 503 — never a boot failure. No hard length cap in v1 (a reply is a few sentences); revisit if a long message proves slow.

**Fail-and-restart:** the synthesis loop lives in the webserver request; if the process restarts mid-read, remaining clips are lost and the owner re-issues — consistent with §7.6.

### What stays the same

`agent_runs.speak`, the worker's live sentence-chunked TTS, the `tts_audio` SSE event, and the iOS playback queue are untouched. The command is a parallel, run-free path that shares only the `TtsProvider` + workspace-clip + `/media` primitives (and, later, the same helpers for Discord).

## Alternatives considered

- **Approach A — a "speak-only" agent run.** Enqueue a run that skips the LLM and emits `tts_audio` over SSE, reusing the worker pipeline + cost rollup. Tempting now that we want chunked streaming (A's machinery is built for exactly that), but rejected: it conflicts with the one-active-run index, needs worker + pg-boss changes, is a "run that doesn't think," and its SSE reuse doesn't travel to non-SSE clients (Discord/WhatsApp). The webserver-streams-chunks design keeps the latency benefit without the run machinery.
- **Approach C — browser Web Speech API (`speechSynthesis`).** Client-only, zero server, instant. Rejected: OS voices (not Alfred's configured voice), nothing for Discord/WhatsApp, ignores the existing pipeline.
- **One clip instead of chunked.** Simpler and the most portable unit, but no first-audio-latency benefit (a long reply is one slow synth before anything plays). Chosen against per the granularity decision; Discord's fast-follow may still use a single clip since multiple attachments are awkward.
- **Reuse `tts_audio` NOTIFY/SSE for delivery** instead of a self-contained response stream. More reuse (and it'd reach iOS), but a web client merely *viewing* a conversation with an active iOS `speak` run would start playing that run's clips unless the event were marked. Rejected for v1 to keep the command fully self-contained.
