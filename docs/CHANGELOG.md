# Changelog

Each entry is numbered with a monotonically increasing integer. Append new entries to the end. Never reuse or reorder numbers. Numbers are globally unique across this file and any future `CHANGELOG-archive.md` — never reused.

1. Scaffolded CLAUDE.md guidance (root + services/, packages/, clients/web/, clients/ios/, chrome-extension/) and split the column-level schema out of ARCHITECTURE.md §6.1 into docs/DATABASE.md.
2. Wrote docs/specs/2026-06-01-foundation-web-ingress.md — spec for the first implementation increment (repo foundation + web ingress).
3. Corrected ARCHITECTURE.md to be OS-agnostic: dropped the Windows-first framing and all WSL2 assumptions (§3/§4/§4.1/§5/§8/§18), and simplified §12 auth to "network position is the authentication" (single user, no per-request identity).
4. Implemented the foundation + web ingress: pnpm workspace + tooling (tsconfig/eslint/prettier/vitest), packages/shared typed loadConfig(), services/webserver (Hono, /api/health, serves the SPA, loopback bind), clients/web (Vite + React + Tailwind stub showing "Alfred is reachable ✓"), and ecosystem.config.cjs. Builds, tests, lint all green.
5. Wrote docs/specs/2026-06-02-postgres-drizzle.md — spec for build-order step 2 (Postgres + Drizzle).
6. Implemented build-order step 2: packages/db with the Drizzle schema (users/conversations/messages), a drizzle-kit migration, a typed node-postgres client, and app-side UUIDv7 IDs. Added POSTGRES_URL (optional) to the shared config. Integration test round-trips user→conversation→message in a rolled-back transaction (skips without POSTGRES_URL); verified end-to-end against a local Postgres 17.
7. Wrote docs/specs/2026-06-02-agent-core-gemini.md — spec for build-order step 3 (agent core with a Gemini provider, built as a library).
8. Implemented build-order step 3 (agent core, as a library): packages/agent-core with the hand-rolled loop, the LlmProvider streaming abstraction, a GeminiProvider on @google/genai (streaming + function-calling), and the Tool interface + a built-in echo tool. Added GEMINI_API_KEY (optional) + DEFAULT_MODEL (gemini-2.5-flash) to the shared config. A fake-provider unit test covers the full tool-call round-trip offline; a live Gemini integration test + CLI runner are gated on GEMINI_API_KEY. Build/lint/offline tests green; the worker/pg-boss/NOTIFY/SSE/web pipeline is deferred to the next step.

