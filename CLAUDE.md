# Alfred

A personal, self-hosted AI agent: one agent identity reachable from many devices (web PWA, Discord, voice), with access to a real browser carrying the owner's real logins and a tool ecosystem that grows over time.

## Always read first

Before doing any work in this repo, **always read all** of these:

- @docs/CONCEPT.md — what Alfred is at the domain level: the single agent identity, the interactive + autonomous ingresses, conversations/runs, and the human-in-the-loop trust model.
- @docs/ARCHITECTURE.md — how it's built: Postgres-only data layer (pg-boss + LISTEN/NOTIFY), hand-rolled agent loop, MCP + built-in tools, Chrome-extension browser automation, fail-and-restart run model, pnpm-monorepo layout.
- @docs/CHANGELOG.md — running log of changes to this project.

When your work touches the database or schema, also read **@docs/DATABASE.md** — the authoritative column-level data model (split out of ARCHITECTURE so this set stays readable at session start).

When your work touches the worker, the agent loop, the interaction/approval flow, or run state, also read **@docs/RUNTIME.md** — the run-lifecycle reference (runtime flows §10, state machines & invariants §10.9, concurrency/crash model §7.6, autonomous-run seams §7.7, and the security/blast-radius model §16), likewise split out of ARCHITECTURE for session-start readability.

When your work touches a post-MVP ingress (Discord, voice, or autonomous triggers), also read **@docs/INGRESSES.md** — the detail for ARCHITECTURE §9.2–9.4, split out for the same reason (§9.1, the built web ingress, stays in ARCHITECTURE).

When your work touches deployment, hosting, process supervision, configuration/secrets, or the repo layout, also read **@docs/DEPLOYMENT.md** — the operational reference for ARCHITECTURE §3 (home server), §4 (deployment & OS), §5 (process topology), §13 (configuration & secrets), and §14 (project structure), split out for the same reason.

`CONCEPT.md` and `ARCHITECTURE.md` are the source of truth for *what* we're building, what we've built, and *how* it's structured. If something in the code contradicts them, either the code or the doc is wrong — flag it rather than guessing.

## Changelog discipline

Every change you make to this repository must be recorded in `docs/CHANGELOG.md`.

- Each entry is numbered with a monotonically increasing integer (1, 2, 3, ...). Never reuse or reorder numbers.
- Append new entries to the end of the file.
- Keep entries short and to the point — one line where possible, a few lines at most. Focus on *what* changed, not how.
- Write the entry as part of the same change. Do not batch multiple changes into one entry, and do not skip entries.
- When a phase/increment completes, its per-task entries move to `docs/CHANGELOG-archive.md`, leaving only the milestone summary in `docs/CHANGELOG.md`. Numbers are globally unique across both files — never reuse one that already appears in either.

## Nested guidance

Each major subtree has its own `CLAUDE.md` with scoped tool/skill rules — read the relevant one before working in that area:

- `services/CLAUDE.md` — Node/TS backend processes: agent worker, browser-bridge, webserver, Discord/voice/trigger ingresses.
- `packages/CLAUDE.md` — shared TS libraries: `db` (Drizzle), `shared` (types), `agent-core` (the agent loop, provider abstraction, tool interface).
- `clients/web/CLAUDE.md` — Vite + React + TypeScript chat PWA.
- `clients/ios/CLAUDE.md` — Swift + Xcode native app (post-MVP).
- `chrome-extension/CLAUDE.md` — MV3 browser-automation extension (shares protocol types with `services/browser-bridge`).

## After making changes

After a non-trivial edit, invoke the **`code-review`** skill with the `high` argument to review the touched code for correctness, reuse, clarity, and efficiency. It does not auto-trigger — you must invoke it explicitly.

Once the review returns, do not start fixing findings immediately. Instead:

1. **Group findings by severity** — blockers (correctness bugs, data loss, security), should-fix (clear improvements, missed reuse), nits (style, naming, minor clarity).
2. **Summarize each bucket in one line** so the user can see what's in it without expanding every finding.
3. **Ask the user which to fix** via `AskUserQuestion` with `multiSelect: true`. Options are the severity buckets ("Blockers (N)", "Should-fix (N)", "Nits (N)"), plus a "None — leave as is" option. Skip buckets that are empty.
4. If a single bucket has more findings than fit cleanly into one label, list each finding as its own option (up to 4 per question; chunk into follow-up questions if more).
5. Apply only the selected fixes. Re-run `code-review` only if the user asks.

<!-- Add additional sections below as the project develops:
  - Project-specific forcing rules (e.g., "Check in with the user before making CSS / layout / UX changes")
  - Destructive-operation guidance if the agent's defaults aren't enough
  - Naming conventions, code-organization rules
-->
