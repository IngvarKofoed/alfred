import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { z } from 'zod'

// The monorepo root (where pnpm-workspace.yaml lives), or null if not inside the workspace.
// Used to anchor cwd-independent paths: each process has a different cwd under
// `pnpm --filter <pkg> dev`, so anything that must be shared across processes (the .env, the
// conversation workspace root) is resolved against this, not process.cwd().
function findRepoRoot(): string | null {
  let dir = process.cwd()
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Load the repo-root .env regardless of the process's cwd. `dotenv.config()` only looks in
// cwd, which breaks `pnpm --filter <pkg> dev`. dotenv never overrides already-set env vars,
// so exported vars still win.
function loadDotenv(): void {
  const root = findRepoRoot()
  dotenv.config(root ? { path: path.join(root, '.env') } : undefined) // missing file is a no-op
}

loadDotenv()

// The typed-config pattern (ARCHITECTURE §13): every process imports loadConfig(),
// validates the subset it needs with zod, and fails fast at boot. This slice needs
// only the webserver port; later steps extend the schema.
const schema = z.object({
  WEBSERVER_PORT: z.coerce.number().int().positive().default(3000),
  // Optional so non-DB processes (e.g. the webserver) still boot without a database.
  // packages/db enforces presence when a client is actually created.
  POSTGRES_URL: z.string().url().optional(),
  // Optional like POSTGRES_URL: agent-core's GeminiProvider fails fast if it's missing
  // when constructed, but non-LLM processes still boot without it.
  GEMINI_API_KEY: z.string().optional(),
  // Provider-scoped so other providers can add their own (OPENAI_MODEL, etc.).
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  // Port the embedded browser bridge's WebSocket server listens on (127.0.0.1 only). The
  // Chrome extension connects here. No auth token / extension-ID needed — the bridge binds
  // to loopback and gates on a chrome-extension:// Origin (ARCHITECTURE §8).
  BRIDGE_WS_PORT: z.coerce.number().int().positive().default(7865),
  // Root directory for per-conversation working directories
  // (<WORKSPACE_ROOT>/<conversation_id>/). Holds uploaded/generated images and files; kept
  // off Postgres (ARCHITECTURE §6.5). Resolved via resolveInWorkspace, which confines every
  // path under one conversation's dir.
  WORKSPACE_ROOT: z.string().default('./data/conversations'),
  // Interpreter used to create the shared venv for the worker's Python tools (run_python /
  // pip_install). Per-OS default: the python.org installer registers `python` on Windows,
  // while POSIX systems conventionally ship `python3`.
  PYTHON_BIN: z.string().default(process.platform === 'win32' ? 'python' : 'python3'),
  // The shared venv backing run_python/pip_install (one venv across conversations, created
  // lazily on first use). Like WORKSPACE_ROOT, a relative value is anchored at the repo
  // root, not process.cwd().
  PYTHON_VENV_DIR: z.string().default('./data/python-venv'),
  // Auto-deploy updater (services/updater) — only that process reads these. DEPLOY_ENABLED is
  // parsed explicitly (not z.coerce.boolean(), which coerces the string "false" to true).
  DEPLOY_ENABLED: z.string().default('false').transform((v) => v.toLowerCase() === 'true'),
  DEPLOY_BRANCH: z.string().default('main'),
  DEPLOY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  DEPLOY_APPS: z.string().default('alfred-webserver,alfred-worker'),
})

export type Config = z.infer<typeof schema>

let cached: Config | null = null

export function loadConfig(): Config {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    console.error('Invalid configuration:\n' + parsed.error.toString())
    process.exit(1)
  }
  // Anchor relative cross-process paths (WORKSPACE_ROOT, PYTHON_VENV_DIR) at the repo root,
  // not process.cwd() — otherwise the worker (cwd services/worker) and webserver (cwd
  // services/webserver) resolve them to different physical dirs, and an image one writes the
  // other can't serve. An absolute override is honored as-is.
  const data = parsed.data
  if (!path.isAbsolute(data.WORKSPACE_ROOT)) {
    data.WORKSPACE_ROOT = path.resolve(findRepoRoot() ?? process.cwd(), data.WORKSPACE_ROOT)
  }
  if (!path.isAbsolute(data.PYTHON_VENV_DIR)) {
    data.PYTHON_VENV_DIR = path.resolve(findRepoRoot() ?? process.cwd(), data.PYTHON_VENV_DIR)
  }
  cached = data
  return cached
}
