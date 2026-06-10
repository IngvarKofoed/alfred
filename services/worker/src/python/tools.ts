import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { type Tool } from '@alfred/agent-core'
import { resolveInWorkspace } from '@alfred/shared'
import { capResult, MAX_RESULT_CHARS } from '../cap.js'
import { ensureVenv } from './venv.js'

const DEFAULT_TIMEOUT_S = 60
const MAX_TIMEOUT_S = 300
const PIP_TIMEOUT_MS = 300_000

// A runaway `while True: print(...)` must not balloon worker memory while waiting for the
// timeout — past this combined in-flight size the process is killed outright. The per-stream
// 100k capResult only bounds what reaches the model, not what we buffer.
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024

// Strict requirement-specifier shape: a package name, optional [extras], optional
// operator+version pin. Anything else — pip flags (--index-url, -e), URLs (git+https…),
// local paths, whitespace — fails, so the args can never smuggle pip options. The name must
// START alphanumeric (PEP 508): without that anchor a bare flag like '--pre' or '-U' is
// all name-class characters and sails through.
const PACKAGE_SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9_,. -]*\])?((==|>=|<=|~=|!=|<|>)[A-Za-z0-9.*+!_-]+)?$/

export function validatePackageSpec(spec: string): boolean {
  return PACKAGE_SPEC_RE.test(spec)
}

// The subprocess env is CONSTRUCTED, never a spread of process.env: loadConfig() runs
// dotenv.config(), so the worker's process.env holds GEMINI_API_KEY / POSTGRES_URL / DEPLOY_*
// — secrets a spawned script must never inherit (spec key decision). Only what Python and
// pip actually need: the venv on PATH, VIRTUAL_ENV, a home dir (some stdlib needs it),
// locale passthrough, and the Windows essentials.
function minimalEnv(venvPython: string): NodeJS.ProcessEnv {
  const binDir = path.dirname(venvPython)
  const venvDir = path.dirname(binDir)
  const env: NodeJS.ProcessEnv = {
    PATH: binDir + path.delimiter + (process.env.PATH ?? ''),
    VIRTUAL_ENV: venvDir,
  }
  if (process.platform === 'win32') {
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
    if (process.env.TEMP) env.TEMP = process.env.TEMP
    if (process.env.TMP) env.TMP = process.env.TMP
  } else if (process.env.HOME) {
    env.HOME = process.env.HOME
  }
  if (process.env.LANG) env.LANG = process.env.LANG
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL
  return env
}

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut?: true
  outputLimitExceeded?: true
}

// How long after 'exit' to keep draining stdio before settling anyway. 'close' (exit + all
// stdio drained) is the normal settle, but a grandchild inheriting our pipes (a daemon the
// script started) can hold 'close' open indefinitely — without this grace the invoke promise
// would hang for the grandchild's lifetime (forever, on Windows where only the direct child
// is killed). Post-exit pipe residue is bounded by the OS pipe buffer, so a short grace
// loses nothing in practice.
const STDIO_DRAIN_GRACE_MS = 500

// Retain at most this many bytes per stream — generously past what capResult keeps (100k
// chars ≤ 4 bytes each). The total byte counter still sees the full volume for the 5MB kill;
// retention just stops, so a runaway script can't make us buffer megabytes it will never see.
const RETAINED_BYTES_PER_STREAM = MAX_RESULT_CHARS * 4

// Spawn `bin args`, optionally feeding stdin, buffering stdout/stderr with the in-flight
// byte limit and a hard timeout. Never throws on a non-zero exit — the exit code is part of
// the result the model reads (§10.7 philosophy: the agent sees the error and adapts).
function execCapture(
  bin: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string; gracefulKillMs?: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // detached on POSIX puts the child in its own process group, so the timeout kill can
    // take down its grandchildren too (negative-PID kill). No equivalent on Windows —
    // orphaned grandchildren are an accepted limitation there (spec).
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, detached: process.platform !== 'win32' })

    // Chunks are kept as raw Buffers and decoded ONCE at settle: per-chunk toString() splits
    // multibyte UTF-8 at pipe-chunk boundaries, corrupting non-ASCII output with U+FFFD.
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let bytes = 0
    let timedOut = false
    let outputLimitExceeded = false
    let settled = false
    let killed = false
    let exitGrace: NodeJS.Timeout | undefined
    let killEscalation: NodeJS.Timeout | undefined

    const signalTree = (signal: NodeJS.Signals): void => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal) // whole process group
          return
        } catch {
          // group already gone or not a leader — fall through to the plain kill
        }
      }
      child.kill(signal)
    }

    const kill = (): void => {
      if (killed) return
      killed = true
      if (opts.gracefulKillMs) {
        // SIGTERM first, SIGKILL only if the process lingers: pip cleans up on SIGTERM, so a
        // timed-out install doesn't leave a half-copied package in the one shared venv. (On
        // Windows child.kill is unconditional regardless of signal name — no graceful stage.)
        signalTree('SIGTERM')
        killEscalation = setTimeout(() => signalTree('SIGKILL'), opts.gracefulKillMs)
      } else {
        signalTree('SIGKILL')
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs)

    const cleanup = (): void => {
      clearTimeout(timer)
      if (exitGrace) clearTimeout(exitGrace)
      if (killEscalation) clearTimeout(killEscalation)
    }

    const settle = (code: number | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: code,
        ...(timedOut ? { timedOut: true as const } : {}),
        ...(outputLimitExceeded ? { outputLimitExceeded: true as const } : {}),
      })
    }

    const makeOnData = (chunks: Buffer[]) => {
      let retained = 0
      return (chunk: Buffer): void => {
        if (settled) return // late post-settle stragglers are discarded, not accumulated
        bytes += chunk.byteLength
        if (retained < RETAINED_BYTES_PER_STREAM) {
          chunks.push(chunk)
          retained += chunk.byteLength
        }
        if (bytes > MAX_OUTPUT_BYTES && !outputLimitExceeded) {
          outputLimitExceeded = true
          kill()
        }
      }
    }
    child.stdout.on('data', makeOnData(stdoutChunks))
    child.stderr.on('data', makeOnData(stderrChunks))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    })
    // 'exit' arms the drain grace; 'close' (the normal case) settles first and wins.
    child.on('exit', (code) => {
      exitGrace = setTimeout(() => settle(code), STDIO_DRAIN_GRACE_MS)
    })
    child.on('close', (code) => settle(code))

    if (opts.stdin !== undefined) {
      // A script that exits without reading stdin yields EPIPE on the write — swallow it
      // (the close handler still resolves with the script's real outcome).
      child.stdin.on('error', () => {})
      child.stdin.write(opts.stdin)
      child.stdin.end()
    } else {
      child.stdin.end()
    }
  })
}

// pip runs are serialized through this module-level chain: two concurrent installs into the
// one shared venv can corrupt it. run_python is deliberately NOT serialized — concurrent
// reads of site-packages are fine.
let pipChain: Promise<unknown> = Promise.resolve()

// The python tools (spec docs/specs/2026-06-10-python-execution-sandbox.md): run_python
// executes agent code with cwd = this conversation's workspace; pip_install grows the one
// shared venv. Both write-tier, group 'python' — one approval covers a task's runs+installs.
export function makePythonTools(conversationId: string): Tool[] {
  return [
    {
      name: 'run_python',
      description:
        "Run Python code in this conversation's working directory (the same files list_files/read_file/write_file see). " +
        'The code is executed with a shared virtualenv — install packages first with pip_install if needed. ' +
        'Returns stdout, stderr, and the exit code.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python source to execute' },
          timeoutSeconds: {
            type: 'number',
            description: `Max run time in seconds, 1–${MAX_TIMEOUT_S} (default ${DEFAULT_TIMEOUT_S})`,
          },
        },
        required: ['code'],
      },
      trustTier: 'write',
      group: 'python',
      async invoke(args: unknown): Promise<unknown> {
        const { code, timeoutSeconds } = (args ?? {}) as { code?: unknown; timeoutSeconds?: unknown }
        if (typeof code !== 'string' || !code) throw new Error('run_python requires non-empty code')
        const requested = typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds)
          ? timeoutSeconds
          : DEFAULT_TIMEOUT_S
        const timeoutMs = Math.min(Math.max(requested, 1), MAX_TIMEOUT_S) * 1000

        const dir = resolveInWorkspace(conversationId, '.')
        fs.mkdirSync(dir, { recursive: true }) // same lazy creation as write_file
        const py = await ensureVenv()

        // Code via stdin (`python -`), not a temp file: nothing to name, collide, or clean
        // up, and the code is preserved in tool_calls.args for audit anyway.
        const result = await execCapture(py, ['-'], { cwd: dir, env: minimalEnv(py), timeoutMs, stdin: code })
        return {
          ...result,
          stdout: capResult(result.stdout),
          stderr: capResult(result.stderr),
        }
      },
    },
    {
      name: 'pip_install',
      description:
        'Install Python packages into the shared virtualenv used by run_python (shared across conversations). ' +
        'Takes package names with optional extras and version pins, e.g. "requests" or "pandas==2.2.*"; ' +
        'pip flags, URLs, and paths are rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          packages: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Requirement specifiers, e.g. ["requests", "pandas==2.2.*"]',
          },
        },
        required: ['packages'],
      },
      trustTier: 'write',
      group: 'python',
      async invoke(args: unknown): Promise<unknown> {
        const { packages } = (args ?? {}) as { packages?: unknown }
        if (!Array.isArray(packages) || packages.length === 0) {
          throw new Error('pip_install requires a non-empty packages array')
        }
        const specs = packages.map((p) => String(p))
        for (const spec of specs) {
          if (!validatePackageSpec(spec)) {
            throw new Error(`invalid package specifier: "${spec}" — package names with optional extras/version pins only (no pip flags, URLs, or paths)`)
          }
        }

        const py = await ensureVenv()
        // gracefulKillMs: a timeout mid-install gets SIGTERM (pip cleans up) before SIGKILL,
        // so the shared venv isn't left with a half-copied site-packages.
        const run = (): Promise<ExecResult> =>
          execCapture(py, ['-m', 'pip', 'install', ...specs], { env: minimalEnv(py), timeoutMs: PIP_TIMEOUT_MS, gracefulKillMs: 10_000 })
        // Append to the chain regardless of the previous run's outcome (a failed install
        // must not block all future ones).
        const result = await (pipChain = pipChain.then(run, run))
        return {
          ...result,
          stdout: capResult(result.stdout),
          stderr: capResult(result.stderr),
        }
      },
    },
  ]
}
