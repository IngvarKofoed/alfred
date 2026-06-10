# Python execution sandbox

Give Alfred the ability to run Python code: a `run_python` built-in tool that executes agent-written code in a subprocess whose cwd is the per-conversation workspace (§6.5), through a single **shared venv** lazily created under `data/`, plus a `pip_install` tool so the agent can add packages on demand. Both are approval-gated (`write` tier, group `python`). "Sandbox" is the TODO's word, not a security claim — on an OS-agnostic, no-Docker stack a subprocess cannot be truly jailed, so containment follows the browser's §16 model: approval gate + audit trail, with the workspace cwd as convention, not a wall.

## Key decisions

- **Subprocess + shared venv (B1), not per-conversation venvs or WASM** (new). One venv at `data/python-venv/`, created lazily on first use (`<PYTHON_BIN> -m venv`). Packages are shared across conversations deliberately — single-user, behaves like the owner's own machine; every install is approval-gated so growth stays visible. Files do *not* overflow between conversations (cwd is still per-conversation). Rejected: per-conversation venvs (latency + repeated installs for cross-talk that doesn't bite a single user) and Pyodide (true sandbox, but heavy and capability-capped). See Alternatives.
- **Containment is procedural, not structural** (reuses — §16 browser precedent). A spawned Python can read any file the worker's OS user can (including `.env`). We don't pretend otherwise: both tools are `write`-tier so each run pauses for approval by default, every execution lands in `tool_calls` with full args, and the owner can tighten/loosen per tool from the Tools page like everything else.
- **Worker env is never inherited** (new, load-bearing). `loadConfig()` runs `dotenv.config()`, so the worker's `process.env` contains `GEMINI_API_KEY` and `POSTGRES_URL`. The subprocess gets an explicit minimal env (venv `PATH`, `VIRTUAL_ENV`, platform essentials like `SystemRoot` on Windows) — never a spread of `process.env`. This closes the *accidental* leak; the file-read path stays open per the previous bullet.
- **cwd = the conversation workspace** (reuses). `resolveInWorkspace(conversationId, '.')` — same helper, same closure-at-construction pattern as `makeFileTools` (`services/worker/src/tools.ts`), so `run_python` composes with the file trio: agent writes `analyze.py` + a CSV with `write_file`, runs it, reads outputs back.
- **Code via stdin (`python -`), not temp files** (new). No artifact to name, collide, or clean up; no argv length limits. The code is fully preserved in `tool_calls.args` for audit/debug anyway.
- **Group `python` for task-scoped approval** (reuses). Both tools share `group: 'python'`, so the first approval in a run covers the rest of that run's Python work (run → tweak → re-run without three prompts), same as the browser group.
- **Output capping reuses the browser pattern** (extends). The 100k-char `capResult` helper moves from `services/worker/src/browser/tools.ts` into a shared worker util, applied per stream; a hard in-flight buffer limit kills a runaway-output process rather than ballooning worker memory.

## Goals

- Alfred can write and execute Python for data wrangling, file transforms, calculations, scraping-adjacent fetch-and-parse — operating on workspace files.
- A usable dependency story: `pip_install` into the shared venv, approval-gated.
- Honest blast-radius posture, consistent with §16.

## Non-goals

- **A real security boundary.** No containers, no OS-specific jails (`firejail`/`sandbox-exec`), no syscall filtering — all conflict with the OS-agnostic/no-Docker constraints. Revisit only alongside the browser's deferred structural containment.
- Per-conversation package isolation (B2 / `pip --target` hybrid — see Alternatives; the venv path is one function, so flipping later is cheap).
- Other languages, Jupyter/notebook semantics, persistent interpreter sessions (each run is a fresh process), or streaming output mid-execution.
- The other TODO item ("agent generated code running in the context of the tools") — that's about code calling *Alfred's tools*, a different increment that can build on this one.

## Design

### New module: `services/worker/src/python/`

`venv.ts` — venv lifecycle:

- `ensureVenv(): Promise<string>` — returns the venv's python binary path; on first call creates the venv (`spawn(PYTHON_BIN, ['-m', 'venv', VENV_DIR])`). Guarded by an in-process promise (concurrent first-uses await the same creation) plus an existence check (survives restarts). A half-created venv (crash mid-create) is detected by a missing python binary → directory removed and recreated.
- Platform paths: `<venv>/bin/python` (POSIX) vs `<venv>\Scripts\python.exe` (Windows). pip is always invoked as `<venvPython> -m pip` — never a separate pip binary.
- `VENV_DIR` from new config key `PYTHON_VENV_DIR` (default `./data/python-venv`, relative paths anchored at the repo root exactly like `WORKSPACE_ROOT`). `PYTHON_BIN` config key, default `python3` on POSIX / `python` on Windows. Both optional in the zod schema; if Python isn't installed, the tools fail loudly at invoke with a clear message ("Python not found at …"), not at boot.

`tools.ts` — `makePythonTools(conversationId): Tool[]`, added to `buildRunTools` in `catalog.ts` (published to the `tools` table at boot like everything else):

**`run_python`** — `write` tier, group `python`.

```ts
args:   { code: string; timeoutSeconds?: number }   // timeout default 60, max 300
result: { stdout: string; stderr: string; exitCode: number | null; timedOut?: true }
```

- `spawn(venvPython, ['-'], { cwd: workspaceDir, env: minimalEnv })`, code written to stdin. The workspace dir is created if absent (same lazy semantics as `write_file`).
- Non-zero exit is a *result*, not a thrown error — the agent reads `stderr`/`exitCode` next turn and adapts (matches the §10.7 tool-error philosophy, but cheaper: no synthetic `{error}` wrapping for ordinary script bugs).
- Timeout: `SIGKILL` on expiry, result carries `timedOut: true` plus whatever output accumulated. Best-effort process-tree kill (`detached` + negative-PID kill on POSIX; plain `child.kill()` on Windows — orphaned grandchildren accepted, noted limitation).
- Output: stdout/stderr buffered separately, each truncated head-first at 100k chars via the shared cap helper; a 5MB combined in-flight limit kills the process (“output limit exceeded”) so an infinite `print` loop can't eat the worker.

**`pip_install`** — `write` tier, group `python`.

```ts
args:   { packages: string[] }                      // e.g. ["requests", "pandas==2.2.*"]
result: { stdout: string; stderr: string; exitCode: number | null }
```

- Each entry must match a strict requirement-specifier shape (`^[A-Za-z0-9._-]+(\[[A-Za-z0-9_,-]+\])?(==|>=|<=|~=|!=|<|>)?[A-Za-z0-9.*+!_-]*$`) — names + version pins only, **no pip flags** (`--index-url`, `-e`, URLs, local paths are rejected before spawn). Runs `<venvPython> -m pip install <specs...>`, 300s timeout.
- Installs are serialized through a module-level promise chain (concurrent pip runs into one venv can corrupt it); `run_python` is not serialized — concurrent reads of site-packages are fine.

### Minimal subprocess env

Constructed, not filtered: `PATH` (venv bin dir + `path.delimiter` + system `PATH`), `VIRTUAL_ENV`, `HOME`/`USERPROFILE` (some stdlib needs it), `LANG`/`LC_ALL` passthrough, `SystemRoot` + `TEMP` on Windows. Nothing else — no `GEMINI_API_KEY`, no `POSTGRES_URL`, no `DEPLOY_*`.

### What doesn't change

No schema migration (tools self-publish to the `tools` catalog at boot). No agent-core change — these are plain built-in `Tool`s; no `ToolContext.recordLlmCall` (no AI calls inside). No webserver/web change — approval cards, tool chips, Tools-page toggles, and `/debug` all work on the existing generic machinery. `SYSTEM_PROMPT` gains a sentence telling Alfred the workspace files and Python tools compose.

## Resolved questions

All resolved with the owner (2026-06-10): the venv is created **empty** (no preset seed — packages arrive on demand via `pip_install`, one approval away); `run_python` is **`write`** tier (`destructive` would exempt it from group auto-approval and re-prompt every re-run for no extra safety today); timeout is **60s default / 300s max** via `timeoutSeconds`; and `pip_install` **shares the `python` approval group** with `run_python` (one approval covers a task's runs and installs; every install still lands in `tool_calls`).

## Alternatives considered

- **A: bare subprocess, system Python, no venv.** Smallest, but dead-ends on the first `import requests`; and installing into the *system* Python from an agent is worse than owning a venv.
- **B2: per-conversation venv.** Cleanest isolation; keeps the workspace a self-contained deletable unit. Rejected for now: venv-creation latency + repeated installs solve a cross-contamination problem a single user doesn't really have. The venv path is one function — flipping to B2 later is cheap.
- **B1 + `pip install --target` per-conversation overlay.** Shared base + isolated additions, but `--target` quirks (missing console scripts, broken upgrades-in-place) make it the fiddliest option.
- **C: Pyodide (WASM).** The only true sandbox, but ~200MB resident, pure-wheel-only packages, no real sockets/subprocess — the safety is real, the capability ceiling too low for the jobs this tool exists for.
