# Auto-deploy updater

A supervised process that keeps the home-server deployment in sync with the git remote
with no manual intervention. Every ~5 minutes it checks whether the deploy branch is
behind `origin`; when it is, it stops the Alfred apps, hard-resets the working tree to
`origin`, reinstalls/rebuilds/migrates, and starts the apps again. It is a new pm2-supervised Node
process (`alfred-updater`) that automates the existing manual deploy command
(`git pull && pnpm install && pnpm build && pm2 reload ecosystem.config.cjs`, DEPLOYMENT.md §5)
and lives *outside* the blast radius of the restarts it triggers.

## Key decisions

- **Dedicated pm2 process, not a scheduler or a queue job** (new). A new `services/updater`
  workspace member, compiled to `dist/index.js` like the other services and added to
  `ecosystem.config.cjs`. Reason: matches the existing "native Node process under pm2,
  OS-agnostic" topology (DEPLOYMENT.md §5), survives reboot via `pm2 save`/`pm2 startup`,
  self-restarts on crash, and is decoupled from the apps it restarts — the updater *must
  outlive* what it restarts, which rules out a worker-hosted pg-boss job.
- **In-process `setInterval` poll with an in-flight guard** (new). One process, one timer,
  one boolean "deploy in progress" flag — overlapping ticks are skipped. No external
  lockfile/flock needed because there is exactly one updater process (pm2-supervised).
- **Stop-first deploy ordering** (new). `pm2 stop` the managed apps *before* pulling, so
  `pnpm install` never swaps `node_modules` under a live process and migrations never run
  against old code. Brief downtime (tens of seconds) is acceptable for a single user, and
  fail-and-restart (RUNTIME §7.6/§10.5) already makes a mid-run stop an honest `failed`.
- **Restart an explicit app-name list, never itself** (new). The updater manages a
  configured set of pm2 names (default `alfred-webserver`, `alfred-worker`); it never
  targets `alfred-updater`. Adding a new long-running service means adding its name to that
  list (one config line) — auto-discovering new topology is a non-goal.
- **Hard-reset to origin** (new). Update via `git reset --hard origin/<branch>` after
  `git fetch`. The deploy box is a pure deploy target with no local edits, so matching
  `origin` exactly is the reliable choice — a dirty or diverged tree is overwritten rather
  than blocking deploys. Nothing on the box is treated as precious.
- **Production-only, opt-in via `DEPLOY_ENABLED`** (new). The updater polls/deploys only when
  `DEPLOY_ENABLED=true` (default `false`); otherwise it boots and idles. `dev` / `dev:up`
  use `concurrently` (not pm2) and never start it, so local development never auto-deploys —
  the updater exists solely on the pm2-supervised deploy box where the flag is set.
- **A `pnpm deploy:up` convenience script enables it without editing `.env`** (new). The
  updater app in `ecosystem.config.cjs` gets a pm2 deploy-env block —
  `env_deploy: { DEPLOY_ENABLED: 'true' }` — and a new root script
  `"deploy:up": "pm2 start ecosystem.config.cjs --env deploy"` brings the whole stack up
  with the updater enabled. Cross-platform (no shell `VAR=val` syntax, which the Windows box
  can't use); a plain `pm2 start ecosystem.config.cjs` still leaves the updater idle, and a
  box can instead set `DEPLOY_ENABLED=true` in its `.env` permanently. (pm2's injected env
  wins over `.env` since `dotenv` doesn't override already-set vars — CHANGELOG #11.)
- **Reuse the documented deploy steps verbatim** (reuses). The sequence is exactly
  `pnpm install` → `pnpm -r build` → `pnpm db:migrate` — the existing root/`@alfred/db`
  scripts, shelled out via `child_process`. No new build logic.
- **Config via the shared loader** (extends). New `DEPLOY_*` keys added to
  `packages/shared/config.ts` (zod-validated, DEPLOYMENT.md §13): `DEPLOY_ENABLED`
  (default `false`), `DEPLOY_BRANCH` (default `main`), `DEPLOY_POLL_INTERVAL_MS`
  (default `300000`), `DEPLOY_APPS` (default `alfred-webserver,alfred-worker`).
- **Fail loudly into logs; always leave the box up** (extends CONCEPT principle 5). Any
  failed step logs the captured stdout/stderr and the failing step, then the updater
  *still* attempts to start the managed apps so a failed deploy never leaves Alfred down.
  HEAD is not advanced past the failed commit on the next tick is fine — it retries; it
  does not auto-rollback.

## Goals

- Keep the deploy box on the latest `origin/<branch>` automatically, within ~5 min of a push.
- Run the full, correct deploy sequence (install, build incl. web + extension, migrate).
- Be OS-agnostic — Node + `git`/`pnpm`/`pm2` CLIs, no OS-specific scheduler or shell.
- Never leave the box down after a failed deploy; surface failures, don't swallow them.
- Never run during local development — `dev`/`dev:up` never start it, and it idles unless
  `DEPLOY_ENABLED=true`.

## Non-goals

- **Zero-downtime / rolling deploys.** A brief stop is fine for one user.
- **Auto-rollback** on a bad build or failed migration. The updater fails loudly and stops
  there; the owner intervenes (revert on origin → next tick deploys the revert).
- **Draining in-flight runs** before deploying. Fail-and-restart already covers this — the
  worker's startup sweep marks abandoned runs `failed` (RUNTIME §10.5).
- **Auto-discovering new pm2 processes** added to `ecosystem.config.cjs`. Managed apps are
  an explicit configured list.
- **Self-updating the updater mid-run.** A change to `services/updater` is built but takes
  effect only when `alfred-updater` is next restarted (manual `pm2 restart`, or reboot).
- **Notifications / chat surfacing of deploy results.** Logs only for now (see Open Qs).

## Design

### Process

`services/updater/src/index.ts`, compiled to `dist/index.js`, added to
`ecosystem.config.cjs` as `alfred-updater` (`autorestart: true`, `cwd: __dirname`). At boot it loads config; if
`DEPLOY_ENABLED` is not `true` it logs "deploy disabled" and idles (no timer) — so it is
inert on any box that hasn't opted in, and `dev`/`dev:up` (which use `concurrently`, never
pm2) never start it at all. When enabled it runs `setInterval(tick, DEPLOY_POLL_INTERVAL_MS)`
(also once at boot). A module-level `deploying` flag makes an overlapping tick a no-op.

Three start paths, by intent: `pnpm dev:up` → dev stack, no updater (concurrently); plain
`pm2 start ecosystem.config.cjs` → prod stack with the updater present but idle; `pnpm
deploy:up` (`--env deploy`) → prod stack with the updater enabled.

### Tick

```
if (deploying) return
git fetch origin <branch>
local  = git rev-parse HEAD
remote = git rev-parse origin/<branch>
if (local === remote) return            // up to date — cheap, the common case
deploy()                                 // local differs from origin → sync to it
```

### deploy()

Stop-first, each step shelled via `child_process` with captured output. On any non-zero
exit the sequence aborts to the `finally` recovery (start apps), logs the step + output:

```
1. pm2 stop <DEPLOY_APPS>                 // stop only the managed apps, not alfred-updater
2. git reset --hard origin/<branch>       // match origin exactly; local edits overwritten
3. pnpm install --frozen-lockfile         // deps (lockfile is the source of truth)
4. pnpm -r build                          // db, shared, agent-core, worker, webserver, web, extension
5. pnpm db:migrate                         // drizzle-kit migrate — on failure, log loud but DON'T block step 6
6. pm2 start <DEPLOY_APPS>                 // bring the apps back on the new build
finally: ensure <DEPLOY_APPS> are started — a failure at any step must not leave them down
```

The chrome extension reconnects to the worker's bridge on its own across the restart (§8),
and the rebuilt web SPA is picked up by the restarted webserver — nothing else to restart.
Postgres is OS-managed and untouched.

### What gets restarted

Only the pm2 apps in `DEPLOY_APPS`. The updater is never in that list. `pm2 reload
ecosystem.config.cjs` is deliberately *not* used (it would reload `alfred-updater` too,
killing the in-progress deploy) — targeted by-name stop/start instead.

## Resolved decisions

These were open during drafting and are now settled (recorded so the reasoning isn't lost):

- **Dirty/diverged tree → `git reset --hard`.** The box is a pure deploy target; matching
  `origin` beats blocking deploys on a stray local edit.
- **Step 6 → `pm2 start`, falling back to `restart`** if pm2 reports an app already online
  (robust to a partial prior failure). One small helper.
- **`migrate` failure does not block the app start.** Apps come back up on whatever code is
  present and the error is logged loudly — a down box is worse than a logged error.
- **Failures surface via pm2-captured logs only** for MVP; a notification/chat hook lands
  when notifications are built (ARCHITECTURE §11).
- **Deploy branch defaults to `main`** (`DEPLOY_BRANCH`, overridable per box).

## Alternatives considered

- **B — `pnpm deploy:check` driven by the OS scheduler** (cron/launchd/Task Scheduler).
  No new long-running process, but scheduling and overlap-locking become OS-specific —
  directly against the OS-agnostic goal — and it re-implements the supervision pm2 already
  provides. Rejected.
- **C — recurring pg-boss job inside the worker.** Reuses the queue, but the worker would
  restart *itself* as part of the deploy; it cannot reliably orchestrate its own
  stop/build/start, and a crash mid-build leaves it down. The updater must outlive what it
  restarts. Rejected as architecturally unsound.
