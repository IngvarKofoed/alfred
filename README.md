# Alfred

A personal, self-hosted AI agent. See `docs/CONCEPT.md` for what Alfred is and `docs/ARCHITECTURE.md` for how it's built.

This README covers **getting the stack running on a fresh box**. Everything else lives under `docs/`.

---

## Prerequisites

Not auto-installed by `pnpm install` — install these on the host first:

| Tool | Why | Install |
|------|-----|---------|
| **Node.js ≥ 22** | Runtime for all services | https://nodejs.org or `winget install OpenJS.NodeJS` |
| **pnpm 10.x** | Workspace package manager | `npm install -g pnpm` (or https://pnpm.io/installation) |
| **pm2** | Process supervisor (`deploy:up`/`deploy:down`) — global, not a devDep | `pnpm add -g pm2` (or `npm install -g pm2`) |
| **PostgreSQL 17** | State, job queue, pub/sub (DEPLOYMENT §3–5) — runs as a host service, not under pm2 | Windows: `winget install PostgreSQL.PostgreSQL.17` · macOS: `brew install postgresql@17` |
| **Google Chrome** | Browser bridge target (ARCHITECTURE §8) — agent drives the owner's real Chrome | https://www.google.com/chrome |

Verify after install:

```powershell
node --version    # >= 22
pnpm --version    # 10.x
pm2 --version
psql --version    # may need 'C:\Program Files\PostgreSQL\17\bin\' on PATH
```

---

## First-time setup

```powershell
# 1. Install workspace dependencies
pnpm install

# 2. Create .env at the repo root from the template
copy .env.example .env
# Then edit .env — at minimum:
#   POSTGRES_URL   — on Windows, include creds: postgres://postgres:<password>@localhost:5432/alfred
#   GEMINI_API_KEY — from https://aistudio.google.com/apikey

# 3. Create the alfred database (one-time)
& "C:\Program Files\PostgreSQL\17\bin\createdb.exe" -U postgres alfred
# Note: winget installs PostgreSQL unattended and sets a RANDOM `postgres`
# password (no prompt). If you don't know it, reset it: stop the service, edit
# C:\Program Files\PostgreSQL\17\data\pg_hba.conf to use `trust` on local
# lines, restart, `psql -U postgres` → `ALTER USER postgres PASSWORD '...';`,
# then revert pg_hba.conf back to `scram-sha-256` and restart.

# 4. Apply Drizzle migrations
pnpm db:migrate

# 5. Build all workspace packages (pm2 runs dist/index.js)
pnpm -r build
```

---

## Running the stack

**Production (pm2-supervised, with auto-deploy):**

```powershell
pnpm deploy:up      # start webserver + worker + updater (DEPLOY_ENABLED=true)
pm2 status          # one-line per app
pm2 logs            # tail all logs (Ctrl+C to detach)
pnpm deploy:down    # stop everything and shut down the pm2 daemon
```

`pnpm deploy:up` enables the **auto-deploy updater** (polls `origin/main` ~every 5 min, runs the documented stop→pull→build→migrate→start sequence). Use plain `pm2 start ecosystem.config.cjs` if you want the stack up without auto-deploy.

**Dev (Mac — concurrently, no pm2):**

```powershell
pnpm dev:up         # start Postgres (brew), migrate, then run worker + server + web in parallel
pnpm dev            # same, without the Postgres-start step
```

`db:start`/`db:stop` use bash + brew paths and are macOS-only. On Windows, manage the Postgres service through `services.msc` or `Get-Service postgres* | Start-Service`.

---

## Reaching it

- **Web UI** — http://localhost:3000 (default `WEBSERVER_PORT`)
- **From the LAN / Tailscale** — same port; `WEBSERVER_HOST=0.0.0.0` by default so the iOS app and other devices on your tailnet can connect (DEPLOYMENT §13.1, ARCHITECTURE §12). Set `127.0.0.1` to restrict to loopback.
- **Browser bridge** — `ws://127.0.0.1:7865` (loopback-only by design — ARCHITECTURE §8). The Chrome extension under `chrome-extension/` connects to this.

---

## Things to install for specific features

| Feature | Extra setup |
|---------|-------------|
| **Browser automation** | Load the unpacked extension in Chrome from `chrome-extension/dist/` after `pnpm --filter alfred-extension build`. |
| **Python tools** (`run_python`, `pip_install`) | Python 3 on PATH. Override with `PYTHON_BIN` in `.env` if your interpreter isn't `python3`/`python`. The shared venv is auto-created on first use. |
| **Email tools** | Set the `IMAP_*` / `SMTP_*` / `EMAIL_FROM` keys in `.env`. Gmail/Fastmail need an **app password**, not the account password. |
| **iOS app** | Open `clients/ios/Alfred.xcodeproj` in Xcode 16+. ATS allows cleartext HTTP so the app can reach `http://<tailscale-ip>:3000` directly; long-term path is fronting the webserver with `tailscale serve` (HTTPS). |
| **Voice (iOS)** | Set `STT_PROVIDER` / `TTS_PROVIDER` (default `google`) and the corresponding API key (`GEMINI_API_KEY` for Google, `ELEVENLABS_API_KEY` for ElevenLabs). |

---

## Where to look next

- `docs/CONCEPT.md` — what Alfred is.
- `docs/ARCHITECTURE.md` — how it's built. Start here for design questions.
- `docs/DEPLOYMENT.md` — hosting, pm2, configuration, repo layout.
- `docs/RUNTIME.md` — run lifecycle, state machines, security model.
- `docs/DATABASE.md` — column-level schema.
- `docs/CHANGELOG.md` — running log of every change.
- `CLAUDE.md` — guidance for AI assistants working in this repo.
