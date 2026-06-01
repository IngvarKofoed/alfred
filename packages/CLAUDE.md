# Alfred — packages/

Shared TypeScript libraries consumed by `services/` and `clients/web`. See `docs/ARCHITECTURE.md` §6 (data layer) and §7 (agent core) for context.

Contents: `db/` (Drizzle schema + migrations + query helpers), `shared/` (TS types shared across the stack), `agent-core/` (the hand-rolled agent loop, LLM provider abstraction, and unified tool interface).

## Required tools

- **`LSP`** — required for TypeScript symbol navigation, references, and hover. Deferred; load with `ToolSearch` → `select:LSP` before use.

## Testing

Tests use **Vitest** (conventional default for this pnpm/TS workspace — not yet pinned in `ARCHITECTURE.md`; pin it there when these packages get real coverage). Do not introduce a different test framework without updating the architecture doc.

## Subtree-scoped rules

- **`db/` is downstream of `docs/DATABASE.md`.** That doc is the authoritative column-level schema; the Drizzle schema must match it, and schema changes are made via Drizzle Kit migrations. If the code and `DATABASE.md` disagree, flag it rather than guessing.
- **`agent-core/` is framework-free by decision.** The agent loop is hand-rolled — no Vercel AI SDK or other framework wrapping the model client (§7.1, §17). Keep streaming, tool-call parsing, history management, retries, and cancellation explicit in our own code.
- **The tool interface is the single abstraction.** MCP-sourced and built-in tools both implement the one `Tool` interface (§7.3); the agent loop must never see MCP directly.
