# Alfred — services/

Long-running Node/TypeScript backend processes, all supervised by pm2 and pulling shared code from `packages/`. See `docs/ARCHITECTURE.md` §5 (process topology), §9 (ingresses), and §10 (runtime flows) for the broader context.

Contents: `worker/` (agent execution loop; also hosts the **embedded browser bridge** in `worker/src/browser/` — the WebSocket server the Chrome extension connects to, §8 Option C; there is no separate `browser-bridge` process), `webserver/` (Hono — PWA API + SSE), `discord-bot/` (discord.js ingress), `voice/` (voice orchestrator, post-MVP), `triggers/` (scheduler / event-source ingress, post-MVP).

## Required tools

- **`LSP`** — required for TypeScript symbol navigation, references, and hover across these services. Deferred; load with `ToolSearch` → `select:LSP` before use.

## Testing

Tests use **Vitest** (the conventional default for this pnpm/TS workspace — `ARCHITECTURE.md` does not yet pin a framework; pin it there once the worker lands). Do not introduce a different test framework without updating the architecture doc.

## Subtree-scoped rules

- **Run/tool/interaction status is a state machine.** Any code that writes `agent_runs.status`, `tool_calls.status`, or `user_interactions.status` must go through the single transition guard and respect the legal transitions and invariants in `docs/ARCHITECTURE.md` §10.9. Never set a status field ad hoc.
- **Fail-and-restart, not durable resume.** This is a single-user system: a crashed run is abandoned and swept to `failed` on startup (§7.6, §10.5). Do not add mid-run recovery, fencing tokens, or lease-reclaim machinery without revisiting that decision in the architecture doc.
- **Postgres is the only stateful infra** — state, queue (pg-boss), and pub/sub (LISTEN/NOTIFY). Do not introduce Redis or another broker (§6).
