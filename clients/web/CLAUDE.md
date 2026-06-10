# Alfred — clients/web/

The chat PWA: a single-page, chat-only web client behind Tailscale auth. See `docs/ARCHITECTURE.md` §11 (web frontend) and §9.1 (webserver API/SSE) for context. No voice here — voice lives only in the native app (§9.3).

Contents: Vite + React + TypeScript SPA. Tailwind v4 with hand-rolled components (shadcn/Radix *not adopted* — too small to earn it); SSE streaming via a hand-rolled `EventSource` (no `@ai-sdk/react`); chat state in plain `useState`, non-chat fetches via plain `fetch` (no TanStack Query); `react-router-dom`; self-hosted Hanken Grotesk (no CDN). PWA (`vite-plugin-pwa`) is planned but **not yet installed** — a plain HTTPS SPA today (§11).

## Required tools

- **`LSP`** — required for TypeScript/TSX symbol navigation and references. Deferred; load with `ToolSearch` → `select:LSP` before use.

## Required skills

- **`frontend-design`** — invoke for any UI work (new screens, components, layout). Produces distinctive, non-generic interfaces; keep the chat PWA polished, not AI-template-generic.
- **`verify`** — invoke to drive the changed UI in a real browser and confirm it works before reporting the change complete.

## Testing

Tests use **Vitest + React Testing Library** (conventional default for this Vite/React workspace — not yet pinned in `ARCHITECTURE.md`; pin it there when the client gains coverage). Do not introduce a different test framework without updating the architecture doc.

## Verification workflow

For UI changes, the test suite is not enough — confirm behavior in a real browser:

1. Start the dev server (`pnpm --filter web dev`).
2. Drive the changed feature in a real browser (via the `verify` skill / chrome browser MCP tools).
3. Check console messages and network requests for errors.
4. Only then report the change as complete.
