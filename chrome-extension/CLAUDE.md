# Alfred — chrome-extension/

The MV3 browser-automation extension. It runs inside the owner's real Chrome (real logins) and is the transparent helper that lets Alfred drive the browser undetectably — not a user-facing client. See `docs/ARCHITECTURE.md` §8 (browser integration) for context. Conceptually a peer of the worker's **embedded** browser bridge (`services/worker/src/browser/`), just running in Chrome instead of Node — there is no separate bridge process.

Contents: MV3 extension in TypeScript, bundled with **esbuild** (`build.js`; `pnpm --filter @alfred/chrome-extension build` → `dist/background.js`). Service worker (`background.ts`) holds the outbound WebSocket to the worker's bridge; content-script functions (`content.ts`) are injected on demand via `chrome.scripting.executeScript`. The wire-protocol types (`types.ts`) are duplicated from the worker's bridge and kept in sync by hand. Ported from the owner's `chrome-mcp` project; `tsc` is not run in CI (esbuild bundles without type-checking), so the upstream's latent strict-type annotations are tolerated — validate behavior with `verify` in a real Chrome.

## Required tools

- **`LSP`** — required for TypeScript symbol navigation and references. Deferred; load with `ToolSearch` → `select:LSP` before use.

## Required skills

- **`verify`** — invoke to load the extension in a real Chrome and exercise the changed behavior before reporting it complete (MV3 service-worker suspension and content-script injection don't show up in unit tests).

## Testing

Unit-testable logic uses **Vitest** (not yet pinned in `ARCHITECTURE.md`; pin it there when the extension lands). DOM/automation behavior is verified manually in a real Chrome (see `verify` above) — there is no headless substitute that reproduces the MV3 lifecycle. Do not introduce a different test framework without updating the architecture doc.

## Subtree-scoped rules

- **High-sensitivity surface.** This extension injects content scripts into authenticated banking/email pages. Treat any page-data handling with care; never log page contents. (There is no bridge auth token — containment is the worker bridge's loopback bind + `chrome-extension://` Origin guard, §8.)
- **Protocol types are duplicated in the worker's bridge** (`services/worker/src/browser/types.ts`) — change them in both places and keep them in sync.
- **MV3 service-worker suspension is a fact of life** — keep the keepalive ping and reconnect-with-backoff logic intact (§8).
