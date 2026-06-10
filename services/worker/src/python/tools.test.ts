import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Tool } from '@alfred/agent-core'

// loadConfig() in @alfred/shared caches process.env on first call, and static ESM imports
// hoist above any statement — so the env MUST be set here, before the module under test is
// loaded via the dynamic import below. tmpRoot holds both the venv and the workspace so one
// rm cleans up everything.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-python-test-'))
// A not-yet-existing subdir, so the test also covers lazy creation (not "dir already there").
const venvDir = path.join(tmpRoot, 'venv')
const workspaceRoot = path.join(tmpRoot, 'workspaces')
process.env.PYTHON_VENV_DIR = venvDir
process.env.WORKSPACE_ROOT = workspaceRoot
// Sentinel secret: the subprocess env is constructed minimal (never a spread of
// process.env), so this must never be visible to the spawned Python.
process.env.GEMINI_API_KEY = 'test-secret-do-not-leak'

const { makePythonTools, validatePackageSpec } = await import('./tools.js')

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// Contract result shape of run_python: non-zero exit RESOLVES with this, never rejects.
interface RunPythonResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut?: true
  outputLimitExceeded?: true
}

function toolByName(conversationId: string, name: string): Tool {
  const tool = makePythonTools(conversationId).find((t) => t.name === name)
  if (!tool) throw new Error(`makePythonTools did not return a tool named ${name}`)
  return tool
}

describe('makePythonTools catalog shape', () => {
  it('exposes run_python and pip_install, both write-tier in the python group', () => {
    const tools = makePythonTools('conv-shape')
    const names = tools.map((t) => t.name)
    expect(names).toContain('run_python')
    expect(names).toContain('pip_install')
    for (const name of ['run_python', 'pip_install']) {
      const tool = toolByName('conv-shape', name)
      expect(tool.trustTier).toBe('write')
      expect(tool.group).toBe('python')
    }
  })
})

describe('validatePackageSpec', () => {
  it.each(['requests', 'pandas==2.2.*', 'foo[extra]>=1.0', 'A.b_c-d'])(
    'accepts %j',
    (spec) => {
      expect(validatePackageSpec(spec)).toBe(true)
    },
  )

  // Anything that could smuggle a pip flag, URL, path, or shell metacharacters past the
  // approval card must be rejected before spawn — this is pip_install's only guard.
  it.each([
    '--index-url=https://evil',
    // Bare (value-less) flags are pure name-class characters — only the leading-alphanumeric
    // anchor rejects them. Passed as separate array entries they would reach pip's argv intact.
    '--index-url',
    '--pre',
    '-U',
    '-e',
    '.',
    '-e .',
    'git+https://github.com/x/y',
    './local',
    '../escape',
    'pkg && rm -rf /',
    'pkg extra',
    '',
  ])('rejects %j', (spec) => {
    expect(validatePackageSpec(spec)).toBe(false)
  })
})

// Live execution needs a real Python on the box. Detected the same way the implementation
// picks its interpreter; skipped when absent so `pnpm test` stays green elsewhere — the
// same gating pattern as the POSTGRES_URL / GEMINI_API_KEY suites.
const pythonBin =
  process.env.PYTHON_BIN ?? (process.platform === 'win32' ? 'python' : 'python3')
const pythonCheck = spawnSync(pythonBin, ['--version'])
const havePython = !pythonCheck.error && pythonCheck.status === 0

// Generous timeouts: the first invoke lazily creates the shared venv, which can take a while.
const VENV_TIMEOUT = 120_000

describe.skipIf(!havePython)('run_python (live, needs Python)', () => {
  it(
    'runs code and resolves stdout/exitCode; the venv is created lazily under PYTHON_VENV_DIR',
    async () => {
      const tool = toolByName('py-conv-happy', 'run_python')
      const result = (await tool.invoke({ code: 'print(2+2)' })) as RunPythonResult

      expect(result.stdout).toContain('4')
      expect(result.exitCode).toBe(0)
      expect(result.timedOut).toBeUndefined()

      // The shared venv materialized where PYTHON_VENV_DIR points (platform binary layout).
      const venvPython =
        process.platform === 'win32'
          ? path.join(venvDir, 'Scripts', 'python.exe')
          : path.join(venvDir, 'bin', 'python')
      expect(fs.existsSync(venvPython)).toBe(true)
    },
    VENV_TIMEOUT,
  )

  it(
    'resolves (not rejects) on a non-zero exit, reporting the exit code',
    async () => {
      const tool = toolByName('py-conv-exit', 'run_python')
      const result = (await tool.invoke({
        code: 'import sys; sys.exit(3)',
      })) as RunPythonResult
      expect(result.exitCode).toBe(3)
    },
    VENV_TIMEOUT,
  )

  it(
    'kills a long-running script at timeoutSeconds and flags timedOut',
    async () => {
      const tool = toolByName('py-conv-timeout', 'run_python')
      const result = (await tool.invoke({
        code: 'import time\ntime.sleep(30)',
        timeoutSeconds: 1,
      })) as RunPythonResult
      expect(result.timedOut).toBe(true)
    },
    VENV_TIMEOUT,
  )

  it(
    'does not leak the worker env into the subprocess',
    async () => {
      const tool = toolByName('py-conv-env', 'run_python')
      const result = (await tool.invoke({
        code: 'import os; print(os.environ.get("GEMINI_API_KEY"))',
      })) as RunPythonResult
      // The constructed env carries no worker secrets: the lookup misses ('None'), and the
      // sentinel value set at module top never appears anywhere in the output.
      expect(result.stdout).toContain('None')
      expect(result.stdout).not.toContain('test-secret-do-not-leak')
      expect(result.stderr).not.toContain('test-secret-do-not-leak')
    },
    VENV_TIMEOUT,
  )

  it(
    'executes with cwd = the per-conversation workspace',
    async () => {
      const conversationId = 'py-conv-cwd'
      const tool = toolByName(conversationId, 'run_python')
      const result = (await tool.invoke({
        code: "with open('out.txt', 'w') as f:\n    f.write('hi')\n",
      })) as RunPythonResult
      expect(result.exitCode).toBe(0)

      const written = path.join(workspaceRoot, conversationId, 'out.txt')
      expect(fs.existsSync(written)).toBe(true)
      expect(fs.readFileSync(written, 'utf8')).toBe('hi')
    },
    VENV_TIMEOUT,
  )
})
