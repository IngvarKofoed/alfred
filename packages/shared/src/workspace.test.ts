import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveInWorkspace } from './workspace.js'

// Point WORKSPACE_ROOT at a temp dir before loadConfig() caches it.
let root: string
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-ws-'))
  process.env.WORKSPACE_ROOT = root
})
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('resolveInWorkspace', () => {
  it('resolves a normal relative path under the conversation dir', () => {
    const resolved = resolveInWorkspace('conv-1', 'images/a.png')
    expect(resolved).toBe(path.join(root, 'conv-1', 'images', 'a.png'))
  })

  it('rejects a parent-traversal escape', () => {
    expect(() => resolveInWorkspace('conv-1', '../conv-2/secret.txt')).toThrow(/escapes the conversation workspace/)
  })

  it('rejects an absolute path', () => {
    expect(() => resolveInWorkspace('conv-1', '/etc/passwd')).toThrow(/absolute/)
  })

  it('rejects a symlink that points outside the conversation dir', () => {
    const convDir = path.join(root, 'conv-3')
    fs.mkdirSync(convDir, { recursive: true })
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-outside-'))
    fs.symlinkSync(outside, path.join(convDir, 'link'))
    expect(() => resolveInWorkspace('conv-3', 'link/escape.txt')).toThrow(/symlink/)
    fs.rmSync(outside, { recursive: true, force: true })
  })
})
