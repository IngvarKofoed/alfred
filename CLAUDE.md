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
- Write each entry as **durable project memory, not a recap of the diff**: record what is now *true that wasn't before* — new behavior, state, or rule — plus, in a clause and only when it isn't obvious, the *why*, the alternative you rejected (so a future agent doesn't re-introduce it), or a known limit / deferred follow-up. Skip filenames, mechanical edits, and refactors with no behavior change; the diff and commit already hold those. Self-check: *if a future agent reads this entry before the code, does it learn what changed, why it matters, or what's now safe to assume?* If not, it's noise.
- Keep each entry to **1–5 lines, ~20 words per line at most**. The changelog is read at session start to orient — that only works if it stays scannable. The failure mode to avoid is cramming everything onto one unbroken line: a 40-word run-on isn't a short entry, it just hides the bulk on a single line. Break it into a few short lines instead; and if it sprawls past ~5 lines, that's a signal it's really several changes — give each its own numbered entry.
- Write the entry as part of the same change. Do not batch multiple changes into one entry, and do not skip entries.
- When a phase/increment completes, its per-task entries move to `docs/CHANGELOG-archive.md`, leaving only the milestone summary in `docs/CHANGELOG.md`. Numbers are globally unique across both files — never reuse one that already appears in either.

Same change, bad vs. good entry:

- **Bad** (short, but just recaps the diff — zero orientation value): `42. Updated auth files, reworked middleware, added tests, renamed AuthHelper.`
- **Good** (states what's now true, with the why in a clause):
  ```
  42. Auth now rejects expired refresh tokens before session lookup; stale sessions can no longer silently renew.
      Validated at the middleware boundary so handlers can assume requests are current.
  ```

## Nested guidance

Each major subtree has its own `CLAUDE.md` with scoped tool/skill rules — read the relevant one before working in that area:

- `services/CLAUDE.md` — Node/TS backend processes: agent worker, browser-bridge, webserver, Discord/voice/trigger ingresses.
- `packages/CLAUDE.md` — shared TS libraries: `db` (Drizzle), `shared` (types), `agent-core` (the agent loop, provider abstraction, tool interface).
- `clients/web/CLAUDE.md` — Vite + React + TypeScript chat PWA.
- `clients/ios/CLAUDE.md` — Swift + Xcode native app (post-MVP).
- `chrome-extension/CLAUDE.md` — MV3 browser-automation extension (shares protocol types with `services/browser-bridge`).

## After making changes

After a non-trivial edit, invoke the **`code-review`** skill with the `high --fix` arguments to review the touched code for correctness, reuse, clarity, and efficiency, then apply every finding to the working tree automatically. It does not auto-trigger — you must invoke it explicitly.

Once the fixes are applied, report what changed:

1. **Group the applied fixes by severity** — blockers (correctness bugs, data loss, security), should-fix (clear improvements, missed reuse), nits (style, naming, minor clarity).
2. **Summarize each bucket in one line** so the user can see what was fixed without expanding every finding.
3. Do not stop to ask which to fix — all findings are fixed by default. The user can review the diff and revert anything they disagree with.

## Git workflow

**Direct to `main`** — when you commit, commit straight to `main`; don't open branches or PRs unless asked. Leave pushing to the user unless you're asked to push.

**This setting only chooses *where* commits go — not *when* to make them.** Commit only when the user asks; finishing a change is not a cue to commit it. When you do commit, each commit is one complete change including its `docs/CHANGELOG.md` entry — never leave the tree half-committed.

<!-- Add additional sections below as the project develops:
  - Project-specific forcing rules (e.g., "Check in with the user before making CSS / layout / UX changes")
  - Destructive-operation guidance if the agent's defaults aren't enough
  - Naming conventions, code-organization rules
-->
