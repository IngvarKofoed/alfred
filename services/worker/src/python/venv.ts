import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '@alfred/shared'

// One shared venv for all conversations (spec B1): created lazily at PYTHON_VENV_DIR on the
// first python tool use, never at boot — the worker must come up fine on a box with no
// Python installed, failing loudly only when the tools are actually invoked.

// Platform-specific location of the venv's python binary. pip is always invoked as
// `<venvPython> -m pip`, never a separate pip binary, so this is the only path that matters.
export function venvPythonPath(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python')
}

// In-flight creation guard: concurrent first-uses (parallel runs) await the same creation
// instead of racing two `python -m venv` invocations into one directory.
let creating: Promise<string> | null = null

// Return the venv's python binary path, creating the venv first if needed. Config is read
// at call time (not module load) so booting the worker never depends on Python existing.
export async function ensureVenv(): Promise<string> {
  // An in-flight creation wins over the binary fast path below: `python -m venv` materializes
  // the binary in its first ~50ms but spends seconds bootstrapping pip, so "binary exists"
  // does NOT mean "venv ready" while creation is running — a caller taking the fast path in
  // that window would hit "No module named pip" or race ensurepip's site-packages writes.
  if (creating) return creating

  const cfg = loadConfig()
  const venvDir = path.resolve(cfg.PYTHON_VENV_DIR)
  const py = venvPythonPath(venvDir)
  if (fs.existsSync(py)) return py

  creating = createVenv(cfg.PYTHON_BIN, venvDir, py).finally(() => {
    // Reset so a failed creation (e.g. Python not installed) can be retried on the next
    // invoke after the owner fixes PYTHON_BIN.
    creating = null
  })
  return creating
}

// A PYTHON_BIN that spawns but never exits (the Windows Store `python` app-execution alias
// stub is the canonical case) must not park the shared `creating` promise — and with it every
// python tool call in every conversation — forever. Creating a venv takes ~2s; 120s is ample.
const CREATE_TIMEOUT_MS = 120_000

async function createVenv(pythonBin: string, venvDir: string, py: string): Promise<string> {
  // Half-created venv (dir exists but the binary doesn't — a crash mid-create): wipe and
  // recreate rather than leaving `python -m venv` to "repair" an unknown state.
  if (fs.existsSync(venvDir)) {
    fs.rmSync(venvDir, { recursive: true, force: true })
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(pythonBin, ['-m', 'venv', venvDir])
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, CREATE_TIMEOUT_MS)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (err.code === 'ENOENT') {
        reject(new Error(`Python not found at "${pythonBin}" — install Python 3 or set PYTHON_BIN in .env`))
      } else {
        reject(err)
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`creating the Python venv timed out after ${CREATE_TIMEOUT_MS / 1000}s — check PYTHON_BIN points at a real Python 3`))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(`creating the Python venv failed (exit ${code}): ${stderr.trim()}`))
      }
    })
  })

  if (!fs.existsSync(py)) {
    throw new Error(`venv created at ${venvDir} but its python binary is missing at ${py}`)
  }
  return py
}
