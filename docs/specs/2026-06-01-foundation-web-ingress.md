# Foundation + web ingress (build-order step 0–1)

The first implementation increment: stand up the repo foundation (pnpm workspace, tooling, typed config) and the thinnest end-to-end web ingress — a Hono server serving a built React stub, reachable from the owner's phone over the tailnet via `tailscale serve`. This proves exactly one seam — *tailnet → served page that can call its own API* — and nothing else (no Postgres, agent, streaming, auth, or identity).

Grounded in `docs/ARCHITECTURE.md` §4 (deployment), §5 (topology), §11 (web), §12 (auth), §13 (config), §14 (layout), §15 (build order) and `docs/CONCEPT.md`.

## Key decisions

- **Thin-slice foundation** (new). Stand up only the three workspace members this slice needs — `services/webserver`, `clients/web`, `packages/shared` — plus root tooling. Other `services/*` and `packages/*` are created when their §15 step arrives, per the architecture's incremental ethos. Empty members are noise.
- **Build once, run anywhere** (new). No platform-specific build. The stack is plain Node + pnpm, supervised by `pm2` on whatever always-on box the owner runs (today a Windows machine, but nothing is built *for* Windows — no WSL2, no Windows-specific steps). Develop on macOS, deploy to the box: the simplest path.
- **Pinned runtime** (new). Node 22 LTS (matches installed 22.18) via `engines` + `.nvmrc`; pnpm 10 via the `packageManager` field. Postgres version deferred (unused this slice).
- **Exposed over the tailnet via `tailscale serve`** (new). One command exposes Hono on the tailnet with HTTPS — a real cert for the `*.ts.net` name, which the PWA's secure context needs later. Hono binds loopback behind it; no extra supervised process. There is **no auth or identity layer**: a single-user box with no public network path (§12) has nothing to gate and no "who" to compute, and this slice holds nothing sensitive anyway. Caddy-with-Tailscale is the documented fallback if more control is ever needed.
- **Typed config via zod in `packages/shared`** (reuses §13). A `loadConfig()` that validates the required subset and fails fast at boot; no raw `process.env` access elsewhere.
- **Dev serves via Vite, prod serves via Hono** (new). Local dev runs the Vite dev server (HMR) proxying `/api` to Hono; production builds `clients/web` to `dist/` and Hono serves it statically behind one port. Standard split.

## Goals

- A reproducible monorepo foundation later steps inherit: pnpm workspaces, a base `tsconfig`, lint/format, and a test runner wired once.
- One round-trip proven end to end: phone (tailnet) → `tailscale serve` → Hono → a served page that successfully calls its own API (`/api/health`).
- A frictionless dev loop on macOS that doesn't require the tailnet proxy.

## Non-goals

- Any database, queue, pub/sub, agent loop, or streaming. (Step 2+.)
- Real chat UI or conversation persistence — the page is a stub that confirms reachability.
- Discord/voice/trigger ingresses, the browser bridge, MCP.
- Any authentication or identity. Single user, no public network path (§12) — nothing to gate, no "who" to compute. Per-user auth (e.g. for family) is a later §12 swap.

## Design

### Layout (thin slice)

```
alfred/
├─ package.json            root: scripts (build/dev/lint/test), tooling devDeps, packageManager
├─ pnpm-workspace.yaml     globs: services/*, clients/web, packages/*
├─ tsconfig.base.json      shared compiler options; each member extends it
├─ eslint + prettier       flat config + .prettierrc at root
├─ ecosystem.config.js     one app: alfred-webserver
├─ .env.example            documents every key; real .env is gitignored, mode 0600
├─ services/webserver/     Hono process
├─ clients/web/            Vite + React stub
└─ packages/shared/        zod loadConfig() + shared types
```

### `packages/shared` — config

`loadConfig()` calls `dotenv.config()`, validates with zod, returns a typed object, throws on missing/malformed required values. This slice needs only:

- `WEBSERVER_PORT` (default `3000`)

A thin payload, but it establishes the typed-config pattern (§13) that every later step extends.

### `services/webserver` — Hono

- Binds `127.0.0.1:${WEBSERVER_PORT}` — it sits behind `tailscale serve`.
- `GET /api/health` → `{ ok: true }`. The proof endpoint — confirms the SPA can reach its backend (same-origin in prod, via the Vite proxy in dev). No auth middleware (single-user box, §12).
- `GET /*` → serves `clients/web/dist` (prod). In dev this route is unused; Vite serves the page and proxies `/api`.

### `clients/web` — Vite + React stub

A single page: on load, `fetch('/api/health')` and render *"Alfred is reachable ✓"* on success, or a clear error state on failure. No identity, no router, no chat. Tailwind is wired into the Vite build now (foundation toolchain); shadcn/ui is deferred until real components exist.

### Dev vs. prod

- **Dev (Mac):** `pnpm --filter web dev` (Vite, HMR) + `pnpm --filter webserver dev` (tsx watch). Vite proxies `/api` → Hono, so the page's `/api/health` call works with no proxy in front.
- **Prod (run host):** `pnpm build` → `clients/web/dist`; `pm2 start ecosystem.config.js` runs `alfred-webserver`; `tailscale serve` exposes it over the tailnet with HTTPS. Same code path as dev — there is no platform-specific build.

### Acceptance (definition of done)

1. On the run host: client built, `alfred-webserver` up under pm2, `tailscale serve` pointed at it.
2. From the phone on the tailnet: opening the host's `*.ts.net` HTTPS URL shows *"Alfred is reachable ✓"* (the page loaded and its `/api/health` call succeeded).
3. `GET /api/health` returns `{ ok: true }`.
4. **Sanity:** a device not on the tailnet can't reach it — confirms it's exposed only via `tailscale serve`, not accidentally public.

## Open questions

None — resolved during review: Tailwind wired in now (shadcn/ui later); Node 22 LTS + pnpm 10; run target is OS-agnostic (plain Node + pm2, no platform-specific build, no WSL2); no identity in this slice (single user; access is the network path).

## Architecture doc edits this spec assumes

This spec is written as if these `docs/ARCHITECTURE.md` corrections are already in place; they'll be applied alongside the build:

- §3 / §4 / §4.1 — drop the "Windows is the chosen target" framing and the WSL2 assumption. Reframe as OS-agnostic: build once, run the simplest way (plain Node + pm2) on whatever always-on box; no platform-specific build, no WSL2 seam.
- §8 — the extension↔bridge WebSocket is plain `localhost` (bridge runs on the same box as Chrome); drop the WSL relay / wildcard-bind machinery.
- §12 — simplify auth: the control is "no public network path" (tailnet + firewall). For a single user there is no per-request identity at all; the Tailscale identity header becomes an optional, much-later concern, not the mechanism.
- §5 / §18 — remove residual WSL2 mentions.

## Alternatives considered

- **Full monorepo skeleton up front.** Scaffold every service/package now. Rejected — §15 says the seams don't change between steps, so empty members are maintenance with no payoff.
- **Caddy-with-Tailscale as the front door.** More routing/cert control at the cost of an extra supervised process and config from day one. Rejected for the first slice; kept as the documented fallback (§12) and the escape hatch if Tailscale is dropped.
