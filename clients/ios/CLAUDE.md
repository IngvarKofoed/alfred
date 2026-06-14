# Alfred — clients/ios/

The native iOS app. **Built today: the text-chat MVP + hands-free voice** — a SwiftUI iPhone app that is a thin REST+SSE client of the existing `alfred-webserver` (the same API the web PWA uses). Text chat: spec `docs/specs/2026-06-14-ios-text-chat-mvp.md`. **Voice is built (Approach B: REST+SSE, no WebSocket)** — server-side STT/TTS as an I/O modality on the existing run/message/SSE pipeline, not a new transport: the app uploads captured audio to `POST /api/conversations/:id/audio` (STT → message + `speak` run) and plays back TTS clips pushed over the existing SSE stream as `tts_audio` events. On-device capture/AEC/VAD/barge-in live in `Alfred/Voice/VoiceController` (`AVAudioEngine` + `setVoiceProcessingEnabled`). Spec: `docs/specs/2026-06-14-voice-stt-tts.md`. The voice-WebSocket orchestrator (INGRESSES §9.3) is the **deferred Approach C** upgrade path, not the contract. See `docs/INGRESSES.md` §9.3 and `docs/DEPLOYMENT.md` §14.2 (polyglot handling).

Contents: a SwiftUI + Swift Concurrency app at `clients/ios/Alfred/` (`Alfred.xcodeproj`, target `Alfred`, deployment iOS 26, Swift 5 language mode), **no third-party dependencies** (Foundation/SwiftUI/PhotosUI/UserNotifications/UIKit only). The project uses **file-system synchronized groups** — a `.swift` file added under the source root (`clients/ios/Alfred/Alfred/`) automatically joins the target, so do **not** hand-edit `Alfred.xcodeproj/project.pbxproj`. **Not** a pnpm workspace member — its toolchain is separate from the Node/TS stack; `pnpm install` from the root ignores it.

## Required tools

None mandated beyond Xcode's own toolchain (`xcodebuild` / Xcode). There is no Swift LSP wired into this environment; use Xcode for navigation. Editor SourceKit diagnostics can show stale cross-file "cannot find … in scope" errors before a build index exists — `xcodebuild … build` is authoritative.

## Testing

Tests use **Swift Testing** (`import Testing`) — Apple's default for new Xcode projects — run via Xcode / `xcodebuild test`. This supersedes the earlier XCTest-only mandate (owner decision, 2026-06-14); the generated `AlfredUITests` template still uses XCTest, which is fine to keep alongside. Do not introduce a third test framework without updating this doc.

## Build / verify

- Build (simulator, no signing): `xcodebuild -project clients/ios/Alfred/Alfred.xcodeproj -scheme Alfred -destination 'generic/platform=iOS Simulator' -configuration Debug build CODE_SIGNING_ALLOWED=NO`.
- The app needs a server base URL (Settings) reachable over the tailnet; an end-to-end run requires the webserver + worker stack up.

## Subtree-scoped rules

- **The backend contract is the `alfred-webserver` REST + SSE API** (text chat — the built MVP). The voice WebSocket (§9.3) is an **additional, later** contract for the audio leg only — not the sole contract. API keys for STT/TTS live server-side, never in the client.
- **Keep the transport seam.** The conversation logic consumes an `AsyncStream<RunEvent>` (plus side-channel REST) through a transport abstraction, so a future `VoiceSession` can emit the same events into the same view model. Don't bake SSE-only assumptions into the view layer.
- **Cross-protocol changes are atomic.** A change to the (future) voice WebSocket protocol lands in one commit touching both `services/voice/` and `clients/ios/` — that atomicity is the point of the single repo (§14.2).
