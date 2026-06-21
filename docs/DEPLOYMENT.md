# Alfred — Deployment, Hosting & Project Layout

The operational reference for Alfred: where it runs (the home server), how it's deployed across OSes, how its processes are supervised, how it's configured, where secrets live, and how the repo is laid out. Split out of `ARCHITECTURE.md` (which keeps the conceptual "what it is") so the always-loaded boot context stays small — read this when deploying, configuring, or finding your way around the tree, not when reasoning about the design.

Section numbers reference `ARCHITECTURE.md`; the headings here retain their original `ARCHITECTURE` numbers (3, 4, 5, 13, 14) so cross-references stay intact.

---

## 3. The Home Server

**Hardware**: any always-on box at home (Mac mini, NUC, repurposed PC/laptop) — OS-agnostic, only the supervisor registration + a few paths differ by OS. (Owner's box is Windows, developed against from a Mac.)

**Why a home box (not a VPS):** same home IP as the owner's daily browsing → far fewer "new device" challenges; trivial 2FA (phone nearby); browser sessions persist for months; sensitive credentials never leave the house; pays for itself vs. a VPS in ~12 months.

**Remote access**: **Tailscale** — no public exposure; client devices join the tailnet and reach the server over encrypted private IPs.

---

## 4. Deployment & OS

OS-agnostic — the same code runs on three targets, OS choice being practical not architectural. The stack (Node, Postgres, pg-boss, apps) is identical; only the supervisor config + a few paths differ:

| Target | Supervisor | Browser host | Notes |
|--------|-----------|--------------|-------|
| **Linux** (NUC, mini-PC, laptop) | pm2 (or systemd) | native Chrome | Cleanest; no FS boundaries. |
| **macOS** (Mac mini, old iMac) | pm2 (or launchd) | native Chrome | Quiet, low-power "appliance". |
| **Windows** | pm2 (or Task Scheduler) | native Chrome | Native — no WSL2. See §4.1. |

### 4.1 Windows-as-server notes

If the box is Windows: the stack runs **natively** (Node + pnpm + pm2 — no WSL2, no DrvFS boundary). Develop anywhere (owner's is a Mac), deploy the built stack to the Windows box. Desktop-OS-as-server settings: sleep "Never" on AC; auto-login (the later Chrome session needs a logged-in desktop); no idle lock screen; Update active hours that never reboot mid-day; Defender exclusions for the project + Chrome dirs.

---

## 5. Process Topology

All processes are native (no Docker). Managed by **pm2** — the same process supervisor on Linux, macOS, and Windows. One config file (`ecosystem.config.cjs`) defines every process; one command (`pm2 start ecosystem.config.cjs`) brings everything up; `pm2 startup` registers pm2 itself with the host's init system (systemd on Linux, launchd on macOS, Task Scheduler on Windows) so everything survives reboot.

| Process | Language | Role | Restart policy |
|---------|----------|------|----------------|
| `postgres` | — | State, job queue, pub/sub | Auto-start via OS package manager; not under pm2 |
| `alfred-webserver` | Node/TS | Browser ingress, serves PWA, SSE | Restart on failure |
| `alfred-worker` | Node/TS | Agent execution loop + **embedded browser bridge** (WS server for the Chrome extension) | Restart on failure |
| `alfred-updater` | Node/TS | Auto-deploy: polls git, rebuilds + restarts the managed apps; opt-in via `DEPLOY_ENABLED` | Restart on failure |
| `alfred-discord` | Node/TS | Discord ingress (discord.js) — second interactive ingress; direct-to-Postgres, inert unless `DISCORD_BOT_TOKEN`/`ALLOWED_DISCORD_USER_ID` set (§9.2) | Restart on failure |
| `alfred-voice` | Node/TS | Voice orchestrator (native-app surface, post-MVP) | Restart on failure |
| `alfred-triggers` | Node/TS | Autonomous-watcher scheduler — computes due triggers + enqueues `trigger-detect` jobs (timing only; all tool execution stays in the worker, §9.4) | Restart on failure |

**Built today:** `alfred-webserver`, `alfred-worker`, `alfred-updater`, `alfred-triggers` (the autonomous-watcher scheduler, §9.4), and now `alfred-discord` (the second interactive ingress, discord.js, §9.2 — inert unless its token + owner-id are set) are in `ecosystem.config.cjs`; the `voice` row is the reserved post-MVP shape (so the topology is whole, not because it exists — §15). `alfred-triggers` is a **pure scheduler** — it owns timing only (recurring crons via an in-process cron clock, **Croner**, + a periodic sweep for one-shot `timer` automations) and never imports the tool layer. (It does *not* use pg-boss's `schedule()`: pg-boss v10 keys a schedule by queue name and requires that queue to exist, which doesn't fit "N automations → one shared `trigger-detect` consumer.") The updater is **inert unless `DEPLOY_ENABLED=true`** (a plain `pm2 start ecosystem.config.cjs` boots it idle); `pnpm deploy:up` (`pm2 start ecosystem.config.cjs --env deploy`) brings the stack up with it enabled. Each is its own pm2 process so one crash doesn't take down the others. The browser bridge was originally a separate `alfred-browser-bridge` process but is instead **embedded in `alfred-worker`** (§8) — the extension's own auto-reconnect covers restarts for one user.

Deploy: automated by `alfred-updater` — the authoritative sequence is stop-first: `pm2 stop <apps>` → `git checkout -f <branch>` + `git reset --hard origin/<branch>` → `pnpm install --frozen-lockfile` → `pnpm -r build` → `pnpm db:migrate` → `pm2 start <apps>` (with a `finally` that always brings the apps back up). Deploying by hand means running that same sequence manually. Postgres is installed via the host's package manager and managed by the OS, not pm2. **Alternative** if pm2 ever stops fitting: each target's native supervisor (systemd/launchd), which is what pm2 delegates to anyway.

**App versioning (git-describe).** The running stack reports its version from git, not a hand-bumped number. `scripts/gen-version.mjs` resolves `git describe --tags --long --always --dirty` (e.g. `v0.1.0-12-g98af7ae`, `-dirty` on an unclean tree) **once at build time** and writes the gitignored `packages/shared/src/version.ts`; `@alfred/shared` re-exports it as `APP_VERSION`. The bake is wired into `@alfred/shared`'s own `build` script (so the deploy's `pnpm -r build` step always refreshes it, shared being built first), and into the root `predev` for local runs. The running app never shells out to git — it reads the baked constant (`"0.0.0-unknown"` if the bake never ran). Surfaced on `GET /api/health` (`version`) and the `alfred-worker` boot log. A new release is just a new annotated tag (`git tag -a v0.2.0 -m …`) — no code change. (The home-box deploy has full git history, so the shallow-CI-clone caveat that bites tag-based versioning elsewhere doesn't apply here.)

---

## 13. Configuration & Secrets

Three layers, increasing specificity: **(1) defaults in code** (`packages/shared/config.ts` fallbacks — the app boots without an env file, limited); **(2) environment variables** (`.env` at the project root, zod-validated at startup, all secrets here); **(3) DB runtime config** (post-MVP `runtime_config` table for restart-free changes — model, cost caps, persona; reserved, not in MVP).

### 13.1 .env layout

The *target* layout. Only the built keys are in the zod schema today (`WEBSERVER_PORT`, `WEBSERVER_HOST`, `POSTGRES_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `BRIDGE_WS_PORT`, `WORKSPACE_ROOT`, `PYTHON_BIN`, `PYTHON_VENV_DIR`, `DEPLOY_ENABLED`, `DEPLOY_BRANCH`, `DEPLOY_POLL_INTERVAL_MS`, `DEPLOY_APPS`, `IMAP_*`/`SMTP_*`/`EMAIL_FROM`, `STT_PROVIDER`/`TTS_PROVIDER`/`GOOGLE_SPEECH_API_KEY`/`ELEVENLABS_API_KEY`/`TTS_VOICE`, `DETECTION_MODEL`, `AUTONOMOUS_APPROVAL_TIMEOUT_MS`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`, and (the Discord ingress, §9.2) `DISCORD_BOT_TOKEN`/`ALLOWED_DISCORD_USER_ID`/`DISCORD_GUILD_ID`); `TRIGGER_TZ` is built too but read via `process.env` in the triggers scheduler, **not** the zod schema; the rest are **reserved for post-MVP ingresses**, documented here so the layout is whole.

```
# Built
POSTGRES_URL=postgres://alfred:...@localhost:5432/alfred
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash    # provider-scoped; a future provider adds OPENAI_MODEL/etc.
BRIDGE_WS_PORT=7865              # loopback-only WS for the extension; no token/MCP (127.0.0.1 + Origin guard)
WEBSERVER_PORT=3000
WEBSERVER_HOST=0.0.0.0           # bind interface; default 0.0.0.0 = LAN/tailnet-reachable (iOS app); set 127.0.0.1 for loopback-only (§12). No auth — network position is the auth; the browser bridge stays loopback (§8)
WORKSPACE_ROOT=./data/conversations  # per-conversation working dirs (§6.5); optional — defaults here, relative paths anchored at the repo root
PYTHON_BIN=python3               # interpreter used to create the shared venv for run_python/pip_install (§7.3); default python3 (POSIX) / python (Windows)
PYTHON_VENV_DIR=./data/python-venv  # shared venv for the worker's Python tools; lazily created; relative paths anchored at the repo root
DEPLOY_ENABLED=false            # auto-deploy updater (alfred-updater, §5); default false — only the deploy box opts in
DEPLOY_BRANCH=main              # branch the updater syncs to origin/<branch>
DEPLOY_POLL_INTERVAL_MS=300000  # how often the updater checks origin (~5 min)
DEPLOY_APPS=alfred-webserver,alfred-worker,alfred-triggers,alfred-discord  # pm2 app names the updater stops/builds/restarts (never itself); tracks ecosystem's long-running set
IMAP_HOST=imap.example.com       # mailbox for the worker's email tools (§7.3); optional — tools return "email not configured" if unset
IMAP_PORT=993                    # IMAP port (TLS)
IMAP_USER=alfred@example.com     # IMAP login
IMAP_PASSWORD=...                # IMAP password (Gmail/Fastmail: an app password, not the account password)
IMAP_SECURE=true                 # implicit TLS
SMTP_HOST=smtp.example.com       # SMTP host for send_email/save_draft MIME
SMTP_PORT=465                    # SMTP port (TLS)
SMTP_USER=alfred@example.com     # SMTP login
SMTP_PASSWORD=...                # SMTP password (app password)
SMTP_SECURE=true                 # implicit TLS
EMAIL_FROM=alfred@example.com    # From header on outgoing mail; default: SMTP_USER
STT_PROVIDER=google              # speech-to-text provider for iOS voice (§7.2): 'google' | 'elevenlabs'
TTS_PROVIDER=google              # text-to-speech provider for iOS voice: 'google' | 'elevenlabs'
GOOGLE_SPEECH_API_KEY=...        # optional; Google Cloud Speech REST fallback if Gemini-native audio is unavailable
ELEVENLABS_API_KEY=...           # optional; required only when STT_PROVIDER/TTS_PROVIDER=elevenlabs
TTS_VOICE=...                    # optional; provider-specific default voice id
DETECTION_MODEL=gemini-2.5-flash-lite  # optional; cheap Tier-1 triage model for autonomous watchers (§9.4 / §7.4 routing seam); unset ⇒ falls back to GEMINI_MODEL
AUTONOMOUS_APPROVAL_TIMEOUT_MS=86400000  # approval timeout for unattended (human_in_loop=false) runs; default 24h (longer than the 1h interactive APPROVAL_TIMEOUT_MS)
VAPID_PUBLIC_KEY=...             # Web Push VAPID public key (§9.4); optional — Web Push inert if any VAPID_* is unset (makeNotifier() → null)
VAPID_PRIVATE_KEY=...            # Web Push VAPID private key
VAPID_SUBJECT=mailto:you@example.com  # VAPID contact (mailto:/https:), required by the Web Push spec
TRIGGER_TZ=Europe/Copenhagen     # optional; IANA zone cron triggers evaluate in (so "8am" is local). Read via process.env in the triggers scheduler, NOT the zod schema; defaults to the host's resolved zone
DISCORD_BOT_TOKEN=<from the Discord developer portal>  # optional; the bot idles (logs + stays alive) if this or ALLOWED_DISCORD_USER_ID is unset. Needs the privileged Message Content Intent enabled in the portal (§9.2)
ALLOWED_DISCORD_USER_ID=<owner's Discord user id>      # owner-only: every message/interaction from anyone else is dropped (§12)
# Observability is in-Postgres (llm_calls + /debug) — no keys.

# Reserved (post-MVP)
TAILSCALE_USER_HEADER=Tailscale-User-Login    # not read today (§12)
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
```

### 13.2 Loading and validation

Each process imports a typed `loadConfig()` from `packages/shared/config.ts`: `dotenv.config()` at boot, validates via **zod** (helpful errors), returns a typed object (no `process.env.X` elsewhere), and **fails fast** if anything required is missing. *Intended:* each process declares only the subset it needs, minimizing blast radius. *Today:* a single shared schema all processes validate against; optionality (`POSTGRES_URL`, `GEMINI_API_KEY`) lets a process boot without keys it doesn't use — the per-process split isn't built yet.

### 13.3 File permissions and storage

`.env` lives at the repo root, mode `0600`, `.gitignored`; `.env.example` is committed with placeholders. Backups **must** include `.env` separately from the DB dump — without it, restoring the database is useless (no process can boot).

### 13.4 Rotation

Manual for MVP: edit `.env`, `pm2 reload all` (Gemini key from Google AI Studio; Discord token from the developer portal). Post-MVP option: OS keychain (macOS Keychain / libsecret / Windows Credential Manager) — worth doing the day backups land off-box.

---

## 14. Project Structure

Single git repo. **pnpm workspaces** owns the TypeScript stack; non-TS sub-projects (iOS) sit alongside in their own toolchain corners — polyglot by **colocation**, not by tooling integration.

```
alfred/
├─ services/                ← backend processes (Node/TS, pnpm workspace members)
│  ├─ webserver/            ← Hono (API + static serving)
│  ├─ worker/               ← agent worker (+ embedded browser bridge: src/browser/)
│  ├─ updater/              ← auto-deploy: git poll → rebuild → restart
│  ├─ triggers/             ← autonomous-watcher scheduler (built; §9.4)
│  ├─ discord/              ← Discord ingress (built; discord.js, §9.2)
│  └─ voice/                ← voice orchestrator (post-MVP)
├─ clients/                 ← user-facing apps
│  ├─ web/                  ← Vite + React PWA (chat-only; pnpm workspace member)
│  └─ ios/                  ← native iOS app (Swift + Xcode, post-MVP; NOT in pnpm workspace)
├─ packages/                ← shared TS libraries (pnpm workspace members)
│  ├─ db/                   ← Drizzle schema + migrations, query helpers
│  ├─ shared/               ← TS types shared between services and web client
│  ├─ agent-core/           ← agent loop, provider abstraction, tool interface
│  └─ commands/             ← shared chat-command registry (rename/help); used by the webserver + Discord bot
├─ chrome-extension/        ← MV3 extension (pnpm workspace member; built with esbuild; talks to the worker's embedded bridge)
├─ ecosystem.config.cjs     ← pm2 process definitions for services/*
├─ pnpm-workspace.yaml      ← lists services/*, clients/web, packages/*, chrome-extension
├─ package.json             ← root scripts (build, dev, lint)
└─ README.md
```

### 14.1 services/ vs clients/

`services/` — long-running backend processes, all pm2-supervised, none human-facing, sharing the TS toolchain and `packages/`; named for what they *do*. `clients/` — anything a person interacts with (web + iOS colocated so cross-surface changes are visible in the tree, despite different stacks). Only `clients/web` is opened directly by an end user; everything in `services/` is plumbing.

### 14.2 Polyglot handling (iOS specifically)

iOS uses **Swift + SPM + Xcode**, ignored from pnpm's perspective (`pnpm-workspace.yaml` excludes `clients/ios/**`; Xcode opens `Alfred.xcworkspace` with its own SPM deps; CI runs TS and iOS as independent pipelines). The one-repo payoff: a cross-cutting change (e.g. a voice WS protocol field) lands in **one atomic commit** across `services/voice/` + `clients/ios/`. Splitting iOS out later is easy; merging two repos back is hard.

### 14.3 chrome-extension/ placement

The extension is TS but lives at the **repo root**, not `clients/`: not user-facing (the human uses Chrome; it's a transparent helper), its own esbuild build (`build.js`), and it shares the wire-protocol types (`WebSocketRequest`/`WebSocketResponse`) with the worker's bridge **duplicated, not imported** (a browser/esbuild build can't pull in a Node package), synced by hand. Conceptually a peer of the embedded bridge, in Chrome instead of Node.

### 14.4 Day-to-day commands

```
pnpm install                          # workspace setup
pnpm --filter "./services/*" build    # build all services
pnpm --filter web dev                 # web dev server
pm2 start ecosystem.config.cjs        # bring services up  (pm2 reload all = post-deploy)
pnpm deploy:up                        # bring the stack up with auto-deploy enabled (pm2 --env deploy)
open clients/ios/Alfred.xcworkspace   # iOS, post-MVP — Xcode does the rest
```
