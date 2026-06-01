# Alfred — chrome-extension/

The MV3 browser-automation extension. It runs inside the owner's real Chrome (real logins) and is the transparent helper that lets Alfred drive the browser undetectably — not a user-facing client. See `docs/ARCHITECTURE.md` §8 (browser integration) for context. Conceptually a peer of `services/browser-bridge`, just running in Chrome instead of Node.

Contents: MV3 extension in TypeScript (Vite + `@crxjs/vite-plugin` or similar). Service worker holds the outbound WebSocket to the bridge; content scripts synthesize real DOM events. Shares protocol message types with `services/browser-bridge`.

## Required tools

- **`LSP`** — required for TypeScript symbol navigation and references. Deferred; load with `ToolSearch` → `select:LSP` before use.

## Required skills

- **`verify`** — invoke to load the extension in a real Chrome and exercise the changed behavior before reporting it complete (MV3 service-worker suspension and content-script injection don't show up in unit tests).

## Testing

Unit-testable logic uses **Vitest** (not yet pinned in `ARCHITECTURE.md`; pin it there when the extension lands). DOM/automation behavior is verified manually in a real Chrome (see `verify` above) — there is no headless substitute that reproduces the MV3 lifecycle. Do not introduce a different test framework without updating the architecture doc.

## Subtree-scoped rules

- **High-sensitivity surface.** This extension carries the bridge auth token (in `chrome.storage.local`) and injects content scripts into authenticated banking/email pages. Treat the auth token and any page-data handling with care; never log secrets or page contents.
- **Protocol types are shared with `services/browser-bridge`** — change them in one place and keep both sides in sync.
- **MV3 service-worker suspension is a fact of life** — keep the `chrome.alarms` heartbeat and reconnect-with-backoff logic intact (§8).
