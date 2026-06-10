# Alfred — clients/ios/

The native iOS app (post-MVP): the only voice surface — chat + hands-free voice with on-device wake word. See `docs/INGRESSES.md` §9.3 (voice pipeline) and `docs/DEPLOYMENT.md` §14.2 (polyglot handling) for context.

Contents: Swift + SPM, opened via `Alfred.xcworkspace`. **Not** a pnpm workspace member — its toolchain is entirely separate from the Node/TS stack; `pnpm install` from the root ignores it.

## Required tools

None mandated beyond Xcode's own toolchain (`xcodebuild` / Xcode). There is no Swift LSP wired into this environment; use Xcode for navigation.

## Testing

Tests use **XCTest** via Xcode / `xcodebuild test`. Do not introduce a different test framework without updating the architecture doc.

## Subtree-scoped rules

- **Post-MVP — do not start here.** This subtree is built only when the voice orchestrator (`services/voice`) is the active target (build-order step 8, §15).
- **The app's only contract with the backend is the voice WebSocket** — bidirectional audio + a control channel (§9.3). API keys for STT/TTS live server-side, never in the client.
- **Cross-protocol changes are atomic.** A change to the voice WebSocket protocol lands in one commit touching both `services/voice/` and `clients/ios/` — that atomicity is the whole point of the single repo (§14.2).
