# Native iOS app — text-chat MVP (voice-ready)

The first build of `clients/ios`: a SwiftUI iPhone app that is a thin native client of the
**existing `alfred-webserver` REST + SSE API** — the same endpoints the web PWA uses. It does
text chat (streaming replies, conversation list, in-app approvals/questions, Stop/cancel) with
**no backend changes**. It is deliberately structured so that the *soon-to-come* voice
increment — **server-side STT/TTS** (INGRESSES §9.3) with **on-device Apple audio processing**
(acoustic echo cancellation + noise suppression for full-duplex "listen while speaking") —
slots in behind a transport seam without reshaping the app.

## Key decisions

- **Reuse the existing webserver API; no backend work** (reuses). The app talks to
  `alfred-webserver` over HTTP + SSE — `POST/GET …/messages`, `GET …/stream`,
  `POST …/cancel`, `GET /api/conversations`, `GET /api/conversations/:id`,
  `GET/POST /api/interactions/:id` (`services/webserver/src/app.ts`). Text chat ships with
  zero changes to `services/`. This **corrects `clients/ios/CLAUDE.md`**, which says "the app's
  only contract with the backend is the voice WebSocket" — true later, but the text MVP's
  contract is the REST+SSE webserver API.
- **Voice is server-side STT/TTS + on-device AEC** (extends §9.3). Confirms INGRESSES §9.3
  (cloud STT/TTS, server-side keys), and **adds** that the iOS app owns an `AVAudioEngine`
  pipeline with `inputNode.setVoiceProcessingEnabled(true)` — Apple's echo cancellation +
  noise suppression — so Alfred's TTS playback is cancelled from the captured mic and the user
  can interrupt mid-speech (barge-in). None of this is built now; the seams are reserved.
- **Text stays REST+SSE even after voice lands** (new). Voice adds a *parallel* WebSocket to a
  future `services/voice` for the audio leg only; the conversation/run/message model stays
  shared in Postgres, and text chat keeps using REST+SSE. Audio needs a socket; text doesn't —
  so we don't fold text into a WS just because voice needs one.
- **SwiftUI + Swift Concurrency, no third-party dependencies; iOS 26 baseline** (new).
  `@Observable` view models, `async`/`await`, `AsyncStream` for the event stream; XCTest (per
  `clients/ios/CLAUDE.md`). Matches the project's hand-rolled, minimal-deps ethos. The iOS 26
  floor isn't needed for the text MVP, but keeps on-device `SpeechAnalyzer` available should
  voice ever want an on-device path alongside the server-side one.
- **Image upload from the device** (reuses). A `PhotosPicker` / camera picker uploads via the
  existing `POST /api/conversations/:id/files` (multipart) and sends the returned
  `{ path, mimeType }` as the message's `attachments` — exactly the web client's two-step flow
  (`clients/web/src/Chat.tsx`). Still no backend change (the route exists). Needs `Info.plist`
  camera/photo-library usage strings.
- **Local notification on backgrounded approvals** (new). The app requests
  `UserNotifications` permission and, on an `interaction_required` event while backgrounded,
  fires a local notification so the owner can reopen and answer before the 1h timeout (§10.4).
  Remote/push notifications stay out of scope.
- **Hand-rolled SSE client over `URLSession.bytes`** (new; mirrors web). iOS has no native
  `EventSource`; parse `data:` lines off the byte stream into `RunEvent`s, handle `ping`
  keep-alives, and reconnect-on-drop — the same shape as the web client's hand-rolled
  `EventSource` (`clients/web/src/Chat.tsx`).
- **One transport seam feeds one conversation view model** (new — the load-bearing voice seam).
  `ConversationViewModel` consumes an `AsyncStream<RunEvent>` and renders the transcript
  *regardless of source*. Today the source is REST+SSE; later a `VoiceSession` (WS to
  `services/voice`) emits the same events into the same view model. The send path is
  source-agnostic: keyboard text now, server-produced transcript later.
- **In-app approvals & questions** (reuses). Render minimal approve/decline and `ask_user`
  question cards from `GET /api/interactions/:id`, resolve via `POST` — the §16 trust flow.
  Without this, any run that hits a write/browser tool would hang on iOS until timeout.
- **Conversation list + new + open** (reuses). `GET /api/conversations` backs a list screen;
  tap to open, "+ new" mints a UUIDv7 client-side (as the web client does).
- **Connection via a Settings base URL; no auth** (new). The server has no login (network
  position is the auth, §12). The app stores a base URL — the Tailscale MagicDNS HTTPS host
  from `tailscale serve` — in `UserDefaults`; the iPhone reaches it over the tailnet.

## Goals

- A usable native chat client: open/start conversations, send text and images, watch Alfred's
  reply stream in, stop a run, answer approvals and questions — all over the existing API.
- Don't strand a run that needs approval while the app is backgrounded — surface it as a local
  notification.
- Structure the app so the server-side-voice increment is *additive*: a new transport + an
  audio layer, not a rewrite.
- No backend changes. Ship against the running stack as-is.

## Non-goals

- **Voice itself** — no audio capture, no STT/TTS, no `services/voice`, no WebSocket in this
  increment. Only the seams.
- **Wake word**, **remote/push notifications**, background runs (all later). Local
  notifications for backgrounded approvals *are* in scope (above); remote push is not.
- **Slash-command autocomplete**, the Tools page, the Debug ledger — web-only for now.
- iPad layout, macOS, multi-user, offline/local persistence beyond what the API returns.

## Design

### Modules (under `clients/ios/Alfred/`)

- `Networking/AlfredClient.swift` — the transport. Async methods over `URLSession`:
  `messages(conversationId)`, `send(conversationId, text:, attachments:)`,
  `upload(conversationId, image:) -> { path, mimeType }`, `cancel(conversationId)`,
  `conversations()`, `conversation(id)`, `interaction(id)`, `resolve(interaction:…)`, and
  `events(conversationId) -> AsyncStream<RunEvent>` (the SSE reader). Holds the base URL.
- `Networking/SSEClient.swift` — line-oriented reader over `URLSession.bytes(for:)`; yields
  decoded `RunEvent`s; ignores `event: ping`; reconnects with backoff on drop.
- `Model/` — `Codable` mirrors of the wire shapes (below).
- `Conversation/ConversationViewModel.swift` — `@Observable`; holds the message list + live
  turn, drives send/cancel, consumes the event stream, owns approval/question state.
- `Conversation/ConversationView.swift`, `MessageView.swift`, `ApprovalCard.swift`,
  `QuestionCard.swift` — SwiftUI views.
- `Conversation/ImagePicker.swift` — `PhotosPicker` + camera capture, feeding `upload(…)`.
- `List/ConversationListView.swift` + view model — the history/list screen.
- `Settings/SettingsView.swift` — base-URL field.
- `Notifications/NotificationManager.swift` — `UserNotifications` permission + the
  backgrounded-approval local notification.
- `Voice/` — **empty placeholder for the voice increment** (`VoiceSession`, `AudioEngine`).

### Wire model (mirror, don't reinvent)

Decode `messages[].content` as a `[ContentPart]` where `ContentPart` covers
`text` / `image` (`path`, `mimeType`) / `tool_use` (`id`, `name`, `args`) / `tool_result`,
matching `messages.content` jsonb (DATABASE.md). `RunEvent` is the SSE payload enum from
ARCHITECTURE §6.2 / `clients/web/src/Chat.tsx`: `token`, `tool_call_start`, `tool_call_end`,
`done`, `cancelled`, `error`, `interaction_required` (`kind: approval|question`),
`interaction_resolved`, `title`. Interaction prompt/response shapes are the two from
DATABASE.md ("Interaction prompt/response shapes").

### Chat flow

Mirrors the web client without its most defensive edge-cases:

1. On open: `GET …/messages` to load history, then open the SSE stream; `GET …/:id` to read
   the title and `activeRun` (refresh-proof busy → show Stop if a run is already in flight).
2. Send: optimistically append the user message, `POST …/messages`; on `409` show "Alfred is
   already working on this conversation". Attaching images first uploads each via
   `POST …/files`, then sends their `{ path, mimeType }` list as `attachments` (web flow).
3. Stream: `token` grows the live reply (rendered as it arrives); `done`/`cancelled` finalize
   by reloading history (the durable turn replaces the live text); `error` appends a ⚠️ line;
   `title` updates the header + list; `tool_call_start/end` show a quiet "used <tool>" chip.
4. Stop: `POST …/cancel`; the route owns the terminal write and NOTIFYs `cancelled`, which the
   stream delivers — the app reacts to the event, never optimistically (matches §10.6).

Markdown: render assistant text with the built-in `AttributedString(markdown:)` (inline
emphasis/links/code); block constructs degrade to text for MVP — richer rendering is a
follow-up, not a design decision.

### Approvals & questions

On `interaction_required`, `GET /api/interactions/:id`; if still `pending`, present a card.
Approval → `POST { approved, note?, remember? }` (the "don't ask again" checkbox writes
`remember`, with the destructive-tool confirm the web client uses). Question → `POST
{ selected_labels, freeform_text }`. `interaction_resolved` (from any ingress) dismisses the
card — first-writer-wins is already enforced server-side. If the app is backgrounded when
`interaction_required` arrives, `NotificationManager` fires a local notification; tapping it
reopens the conversation to the card.

### Designed for voice (seams only — nothing built here)

When the voice increment lands: a `VoiceSession` opens a WebSocket to `services/voice` and
streams mic audio up / receives TTS audio + transcript events down, emitting the **same**
`RunEvent`s into the **same** `ConversationViewModel` — so the transcript UI is unchanged. The
`AudioEngine` wraps `AVAudioEngine` with `inputNode.setVoiceProcessingEnabled(true)` for
Apple's AEC + noise suppression, which cancels Alfred's playback from the captured mic and
makes "listen while speaking" (barge-in) work. Server-side STT/TTS keep the heavy models off
the device and provider-swappable (§9.3). The two facts the text MVP must respect so this is
additive: (a) the view model never assumes its events came from SSE, and (b) `send` is just
one producer of user input, not the only one.

## Alternatives considered

- **On-device Apple STT/TTS** (the app stays pure REST+SSE, voice is a client-only feature,
  zero backend). Rejected by choice: server-side keeps the speech models swappable and
  off-device, at the cost of building `services/voice` later. The on-device piece is retained
  only for *audio processing* (AEC/noise suppression), not recognition/synthesis — though the
  iOS 26 floor leaves `SpeechAnalyzer` available if an on-device path is ever wanted too.
- **Text over the future voice WebSocket too** (one transport for everything). Rejected: text
  needs no audio socket, and routing it through a WS would couple the text MVP to an unbuilt
  service and forfeit the zero-backend-change win.
