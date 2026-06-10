# Alfred — services/

Long-running Node/TypeScript backend processes, all supervised by pm2 and pulling shared code from `packages/`. See `docs/DEPLOYMENT.md` §5 (process topology), `docs/ARCHITECTURE.md` §9 (ingresses), and `docs/RUNTIME.md` §10 (runtime flows) + §7.6 (concurrency/crash model), for the broader context.

Contents: `worker/` (agent execution loop; also hosts the **embedded browser bridge** in `worker/src/browser/` — the WebSocket server the Chrome extension connects to, §8 Option C; there is no separate `browser-bridge` process) and `webserver/` (Hono — PWA API + SSE). **Built today: only those two.** The post-MVP ingresses — `discord-bot/` (discord.js), `voice/` (orchestrator), `triggers/` (scheduler / event-source) — are reserved in the architecture (`docs/DEPLOYMENT.md` §5/§14, `docs/INGRESSES.md`) but **not yet created** as directories.

## Required tools

- **`LSP`** — required for TypeScript symbol navigation, references, and hover across these services. Deferred; load with `ToolSearch` → `select:LSP` before use.

## Testing

Tests use **Vitest** (the conventional default for this pnpm/TS workspace — `ARCHITECTURE.md` does not yet pin a framework; pin it there once the worker lands). Do not introduce a different test framework without updating the architecture doc.

## Subtree-scoped rules

- **Run/tool/interaction status is a state machine.** Any code that writes `agent_runs.status`, `tool_calls.status`, or `user_interactions.status` must respect the legal transitions and invariants in `docs/RUNTIME.md` §10.9 — no illegal transition, no zombie left by a missed cascade. The single transition guard those rules describe is **not yet built** (`run.ts`/`boss.ts` write `status` directly today), so for now honour §10.9 by hand on every write; if you add the guard, route all writes through it. Never set a status field ad hoc that §10.9 doesn't sanction.
- **Fail-and-restart, not durable resume.** This is a single-user system: a crashed run is abandoned and swept to `failed` on startup (§7.6, §10.5). Do not add mid-run recovery, fencing tokens, or lease-reclaim machinery without revisiting that decision in the architecture doc.
- **Postgres is the only stateful infra** — state, queue (pg-boss), and pub/sub (LISTEN/NOTIFY). Do not introduce Redis or another broker (§6).
