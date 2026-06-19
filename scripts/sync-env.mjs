#!/usr/bin/env node
// Syncs the gitignored .env to the committed .env.example. Cross-platform (pure Node, no deps).
//
//   • keys ADDED to .env.example are added to .env (carrying the example's placeholder + inline docs)
//   • keys REMOVED from .env.example are removed from .env — but only after you confirm each one
//   • the result mirrors .env.example's line order, comments, and section headers, substituting
//     your existing values for any key that already exists in .env
//
// Your secrets are never printed — only key NAMES appear in prompts and summaries — and the previous
// .env is copied to .env.bak before anything is written.
//
// Limitations (the rewrite mirrors .env.example's structure, by design):
//   • comments / blank lines that exist ONLY in your .env are replaced by the example's layout —
//     your VALUES are preserved, but recover any .env-only annotations from the .env.bak backup.
//   • values are assumed single-line; a quoted value spanning multiple newlines is not supported
//     (not a concern for this repo — every secret here is single-line).
//
// Usage:
//   node scripts/sync-env.mjs              # interactive (confirm each stale key)
//   node scripts/sync-env.mjs --dry-run    # show the plan, write nothing
//   node scripts/sync-env.mjs --yes        # non-interactive: delete every stale key
//   node scripts/sync-env.mjs --no-delete  # keep stale keys (append them), never prompt
//   node scripts/sync-env.mjs --example <path> --env <path>
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, relative } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

// Matches `KEY=`, `export KEY=`, with optional leading whitespace. Group 1 is the key name.
const KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

const args = process.argv.slice(2)
const has = (...names) => names.some((n) => args.includes(n))
const flagVal = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

if (has('-h', '--help')) {
  printHelp()
  process.exit(0)
}

const dryRun = has('-n', '--dry-run')
const assumeYes = has('-y', '--yes')
const noDelete = has('--no-delete')

// Defaults resolved relative to this script's location (repo root), like scripts/gen-version.mjs,
// so they work regardless of the cwd the package manager invokes from. A user-supplied --example /
// --env path is resolved against the current cwd.
const examplePath = resolve(flagVal('--example') ?? fileURLToPath(new URL('../.env.example', import.meta.url)))
const envPath = resolve(flagVal('--env') ?? fileURLToPath(new URL('../.env', import.meta.url)))

const rel = (p) => relative(process.cwd(), p) || p

if (!existsSync(examplePath)) {
  console.error(`error: example file not found: ${rel(examplePath)}`)
  process.exit(1)
}

const exampleText = readFileSync(examplePath, 'utf8')
const exampleEntries = parse(exampleText)
const exampleKeys = new Set(exampleEntries.filter((e) => e.type === 'kv').map((e) => e.key))

// First run: no .env yet — it's simply a copy of the example (every key is "added"), nothing to delete.
if (!existsSync(envPath)) {
  if (dryRun) {
    console.log(`[dry-run] would create ${rel(envPath)} from ${rel(examplePath)} (${exampleKeys.size} keys)`)
    process.exit(0)
  }
  writeFileSync(envPath, exampleText)
  console.log(`Created ${rel(envPath)} from ${rel(examplePath)} (${exampleKeys.size} keys). Fill in the blanks.`)
  process.exit(0)
}

const envText = readFileSync(envPath, 'utf8')
// Preserve the target file's own line endings (fall back to LF). Deriving eol from .env — not the
// example — also keeps the no-op guard (finalText === envText) honest when the two files differ in
// EOL style, so a run with no key changes doesn't needlessly back up + rewrite.
const eol = envText.includes('\r\n') ? '\r\n' : '\n'
const envMap = buildMap(parse(envText)) // key -> raw line (first occurrence wins, matching dotenv)

// Walk the example in order: this is what makes .env's final line order mirror .env.example's.
const added = [] // { key, raw } present in example, missing from .env
const output = []
for (const e of exampleEntries) {
  if (e.type !== 'kv') {
    output.push(e.raw) // comment / blank / section header — copied verbatim from the example
  } else if (envMap.has(e.key)) {
    output.push(envMap.get(e.key)) // keep the user's existing line (their value), in the example's position
  } else {
    output.push(e.raw) // new key — the example's line carries the placeholder + inline docs
    added.push({ key: e.key, raw: e.raw })
  }
}

// Stale = keys present in .env but no longer in .env.example.
const staleKeys = [...envMap.keys()].filter((k) => !exampleKeys.has(k))

// ---- decide what to do with stale keys ----
let toDelete = []
let toKeep = []
if (dryRun) {
  // Don't prompt or write; classify everything as "would prompt" for the report below.
} else if (staleKeys.length === 0) {
  // nothing to decide
} else if (noDelete) {
  toKeep = staleKeys
} else if (assumeYes) {
  toDelete = staleKeys
} else {
  const decided = await promptStale(staleKeys)
  toDelete = decided.toDelete
  toKeep = decided.toKeep
}

// Kept stale keys are appended (they have no home in the example's order).
if (toKeep.length) {
  output.push('')
  output.push('# === Not in .env.example (kept by sync-env) ===')
  for (const key of toKeep) output.push(envMap.get(key))
}

const finalText = output.join(eol) + eol

// ---- dry run: report the plan and stop ----
if (dryRun) {
  console.log(`[dry-run] plan for ${rel(envPath)} (mirroring ${rel(examplePath)}):`)
  reportAdded(added)
  if (staleKeys.length) console.log(`  ? ${staleKeys.length} stale (in .env, not in example) — would prompt: ${staleKeys.join(', ')}`)
  if (!added.length && !staleKeys.length && finalText === envText) console.log('  already in sync — no changes')
  console.log('[dry-run] nothing written.')
  process.exit(0)
}

// ---- nothing changed: skip the backup + write churn ----
// A real add/delete would alter finalText, so a byte-identical rebuild means there's nothing to do
// (e.g. a stale key the user keeps every run — confirmed but unchanged).
if (finalText === envText) {
  console.log(`${rel(envPath)} already in sync with ${rel(examplePath)}.`)
  process.exit(0)
}

// ---- back up, then write ----
const backupPath = envPath + '.bak'
copyFileSync(envPath, backupPath)
writeFileSync(envPath, finalText)

console.log(`Synced ${rel(envPath)} to ${rel(examplePath)}:`)
reportAdded(added)
if (toDelete.length) console.log(`  - ${toDelete.length} removed: ${toDelete.join(', ')}`)
if (toKeep.length) console.log(`  = ${toKeep.length} kept (not in example): ${toKeep.join(', ')}`)
console.log(`  backup: ${rel(backupPath)}`)

// ---------------------------------------------------------------------------

function parse(text) {
  const lines = text.split(/\r?\n/)
  // A file ending in a newline yields a trailing '' — drop it so the line count doesn't grow each run.
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.map((raw) => {
    const m = raw.match(KEY_RE)
    return m ? { type: 'kv', key: m[1], raw } : { type: 'other', raw }
  })
}

function buildMap(entries) {
  const map = new Map()
  for (const e of entries) if (e.type === 'kv' && !map.has(e.key)) map.set(e.key, e.raw)
  return map
}

async function promptStale(keys) {
  // Abort a pending question if stdin ends (EOF / piped / non-interactive) so we never hang;
  // an unanswered key is then KEPT (we never delete without an explicit confirmation).
  const ac = new AbortController()
  const rl = createInterface({ input: stdin, output: stdout })
  rl.once('close', () => ac.abort())
  const toDelete = []
  const toKeep = []
  let mode = null // 'all' = delete the rest, 'keepall' = keep the rest
  try {
    for (const key of keys) {
      if (mode === 'all') {
        toDelete.push(key)
        continue
      }
      if (mode === 'keepall') {
        toKeep.push(key)
        continue
      }
      let ans
      try {
        ans = (
          await rl.question(`Delete "${key}" (in .env, not in .env.example)? [y]es / [N]o / [a]ll / [q]uit-keep-rest: `, {
            signal: ac.signal,
          })
        )
          .trim()
          .toLowerCase()
      } catch (err) {
        if (err?.name === 'AbortError') {
          mode = 'keepall' // input ended — keep this key and all remaining
          toKeep.push(key)
          continue
        }
        throw err
      }
      if (ans === 'a' || ans === 'all') {
        mode = 'all'
        toDelete.push(key)
      } else if (ans === 'q' || ans === 'quit') {
        mode = 'keepall'
        toKeep.push(key)
      } else if (ans === 'y' || ans === 'yes') {
        toDelete.push(key)
      } else {
        toKeep.push(key)
      }
    }
  } finally {
    rl.close()
  }
  return { toDelete, toKeep }
}

function reportAdded(addedList) {
  if (!addedList.length) return
  const needValue = addedList.filter((a) => isBlankValue(a.raw)).map((a) => a.key)
  console.log(`  + ${addedList.length} added: ${addedList.map((a) => a.key).join(', ')}`)
  if (needValue.length) console.log(`    ↳ fill in: ${needValue.join(', ')}`)
}

// True when the example line has no real value (empty or a `...` placeholder), ignoring an inline comment.
function isBlankValue(raw) {
  const after = raw.slice(raw.indexOf('=') + 1).replace(/\s+#.*$/, '').trim()
  return after === '' || after === '...'
}

function printHelp() {
  console.log(`sync-env — reconcile .env with .env.example (cross-platform, no deps)

Adds keys new to .env.example, removes keys dropped from it (with per-key confirmation),
and rewrites .env in .env.example's line order while preserving your existing values.
Secrets are never printed; the prior .env is backed up to .env.bak.

Usage:
  node scripts/sync-env.mjs              interactive
  node scripts/sync-env.mjs --dry-run    show the plan, write nothing
  node scripts/sync-env.mjs --yes        delete every stale key without asking
  node scripts/sync-env.mjs --no-delete  keep stale keys (append them), never prompt
  node scripts/sync-env.mjs --example <path> --env <path>
  node scripts/sync-env.mjs --help`)
}
