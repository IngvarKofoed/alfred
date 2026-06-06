import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.js'

// Per-conversation working directory: <WORKSPACE_ROOT>/<conversationId>/. Files live on
// disk, referenced by a workspace-relative path; Postgres stays blob-free (the spec's
// Approach A). Every file op (tools, upload, serving) MUST resolve its path through
// resolveInWorkspace so confinement is enforced in exactly one place — the seam that lets a
// future "shared" scope change only what root a path resolves against, not every call site.

// Resolve `relPath` inside the conversation's workspace dir and assert it can't escape.
// Throws on an absolute input, a `..` traversal out of the dir, or a symlink pointing
// outside it. Returns an absolute path. The conversation dir need not exist yet (created
// lazily on first write); symlink confinement is checked against the deepest existing
// ancestor of the resolved path.
export function resolveInWorkspace(conversationId: string, relPath: string): string {
  if (!conversationId || conversationId.includes('/') || conversationId.includes('\\') || conversationId.includes('..')) {
    throw new Error(`invalid conversationId: ${conversationId}`)
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`path escapes the conversation workspace (absolute): ${relPath}`)
  }

  const root = path.resolve(loadConfig().WORKSPACE_ROOT)
  const convDir = path.join(root, conversationId)
  const resolved = path.resolve(convDir, relPath)

  // Lexical confinement: the resolved path must be the conversation dir itself or under it.
  const rel = path.relative(convDir, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes the conversation workspace: ${relPath}`)
  }

  // Symlink confinement: realpath the deepest existing ancestor of both the resolved path
  // and the conversation dir, then re-check containment — so a symlink anywhere along the
  // path can't redirect outside the dir. Realpathing both sides (not just the resolved
  // path) keeps a symlinked ancestor of the root itself (e.g. macOS /var -> /private/var)
  // from reading as an escape.
  const realConvDir = realpathDeepest(convDir)
  const realExisting = realpathDeepest(resolved)
  const realRel = path.relative(realConvDir, realExisting)
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new Error(`path escapes the conversation workspace (symlink): ${relPath}`)
  }

  return resolved
}

// realpath of `p` if it exists, else the realpath of its deepest existing ancestor with the
// non-existing tail re-appended. Lets confinement be checked before a path is created.
function realpathDeepest(p: string): string {
  let existing = p
  const tail: string[] = []
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) return p // no existing ancestor (shouldn't happen)
    tail.unshift(path.basename(existing))
    existing = parent
  }
  return path.join(fs.realpathSync(existing), ...tail)
}
