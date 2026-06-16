import { type Tool } from '@alfred/agent-core'
import { type Db, getTrigger, updateTriggerSignal } from '@alfred/db'
import { toolCatalog } from '../catalog.js'

// Tier 0 — the deterministic gate (autonomous-watchers spec, "Tiered detection ladder").
// FREE, no LLM: pick the named read-tier Tool, invoke it directly, reduce its result to a
// comparable signal, and diff against triggers.last_seen_signal. A change persists the new
// signal and escalates; no change is the silent free path (an idle watcher costs nothing).
//
// Calling Tool.invoke() here bypasses the loop's approval gate — SAFE ONLY because the gate
// is restricted to read-tier tools (detection is read-only by construction). A non-read
// gate.tool is a config error and is refused (spec safety/blast-radius §16).

// The declarative gate config stored on triggers.gate (jsonb). null ⇒ always-escalate (e.g. a
// fixed briefing). `signal` names one of a CLOSED set of reducers — never eval arbitrary config
// (untrusted-config injection surface), so an unknown reducer is refused. Pick by intent:
//   - 'maxUid' — MONOTONIC high-water mark (highest item uid). Fires only on NEW arrivals; reading
//                or removing items never lowers it, so it never re-fires on a shrink. The right
//                choice for "notify me of new mail/items".
//   - 'count'  — item quantity. Diffs in BOTH directions, so it ALSO fires when the count drops
//                (e.g. you read a mail). Use it only when a decrease is itself worth a fire — NOT
//                for "new arrivals" (use maxUid).
//   - 'hash'   — content fingerprint. Fires whenever the result content changes at all (e.g. a
//                watched page).
// Whichever reducer, the FIRST poll establishes the baseline silently (it never fires on the
// pre-existing state) — see decideSignalChange.
interface GateConfig {
  tool: string
  args?: unknown
  signal?: 'maxUid' | 'count' | 'hash'
}

export interface GateResult {
  changed: boolean
  // The reduced item the gate observed (the tool result), passed to Tier-1 triage on a change.
  item?: unknown
}

// The closed set of signal reducers (spec: "maxUid | count | hash only — never eval arbitrary
// config"). Each maps a tool result to a comparable JSON value stored as last_seen_signal.
// Exported for offline unit tests (no live tool/db).
export function reduceSignal(reducer: 'maxUid' | 'count' | 'hash', result: unknown): unknown {
  switch (reducer) {
    case 'maxUid':
      return maxUid(result)
    case 'count':
      return count(result)
    case 'hash':
      return hash(result)
  }
}

// Walk a named-array tool result (CHANGELOG 34: every tool result is a named object, never a
// bare array) and return the highest numeric `uid` across any array of objects it contains, or
// null when none. Tolerant of the exact wrapper key (e.g. { messages: [{ uid }] }). MONOTONIC:
// it only rises, so it diffs only on NEW arrivals — reading/removing items never lowers it and
// never re-fires (unlike count). The signal of choice for "new mail/items".
function maxUid(result: unknown): number | null {
  let max: number | null = null
  for (const item of arraysIn(result)) {
    const uid = (item as { uid?: unknown }).uid
    if (typeof uid === 'number' && Number.isFinite(uid) && (max === null || uid > max)) max = uid
  }
  return max
}

// Count the items across the named array(s) in the result — "how many unread", etc. NOTE: this
// diffs in BOTH directions, so a removal/read lowers it and re-fires; prefer maxUid for "new
// arrivals" and use count only when a decrease is itself worth firing on.
function count(result: unknown): number {
  return [...arraysIn(result)].length
}

// A stable hash over the result's canonical JSON — for text/page watchers where "did anything
// change" is the whole signal. Stable because JSON.stringify walks keys in insertion order and
// the tool results are constructed deterministically; a 32-bit FNV-1a is plenty to diff equality.
function hash(result: unknown): string {
  const json = stableStringify(result)
  let h = 0x811c9dc5
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

// Yield every object element of every array value found one level into the named result object
// (the documented { key: [...] } shape). Keeps the reducers tolerant of the wrapper key name.
function* arraysIn(result: unknown): Iterable<unknown> {
  if (result === null || typeof result !== 'object') return
  for (const value of Object.values(result as Record<string, unknown>)) {
    if (Array.isArray(value)) yield* value
  }
}

// Canonical JSON with object keys sorted recursively, so hash() is order-insensitive to key
// ordering (insertion order can vary across tool runs even when the data is equal). Exported for
// offline unit tests.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

// Look up the gate's read-tier Tool by name from the worker's catalog. Throws on an unknown tool
// or a non-read tool (the config invariant). The catalog metadata is conversation-independent, so
// toolCatalog()'s placeholder-conversation instances are fine for the lookup AND for invoke()
// here — every gate tool (e.g. list_emails, get_page_text) acts on the mailbox/page, not a
// per-conversation workspace, so a placeholder conversation id never reaches them.
function lookupGateTool(toolName: string): Tool {
  const tool = toolCatalog().find((t) => t.name === toolName)
  if (!tool) throw new Error(`gate tool "${toolName}" is not a known tool`)
  if (tool.trustTier !== 'read') {
    // Tier-0 invoke() bypasses the approval gate; only read-tier is safe here (spec invariant).
    throw new Error(`gate tool "${toolName}" is ${tool.trustTier}-tier; only read-tier tools may gate`)
  }
  return tool
}

// Run the Tier-0 gate for a trigger row. A null gate ⇒ always-changed (escalate every fire,
// e.g. a fixed briefing). Otherwise invoke the read-tier tool, reduce, diff vs last_seen_signal,
// and on a change persist the new signal + return { changed:true, item }. The item is the raw
// tool result, handed to Tier-1 triage.
export async function runGate(db: Db, trigger: Awaited<ReturnType<typeof getTrigger>>): Promise<GateResult> {
  if (!trigger) throw new Error('runGate: trigger is undefined')
  const gate = trigger.gate as GateConfig | null

  // No gate ⇒ always escalate (no item to triage; Tier-1/2 work from the objective alone).
  if (gate == null) return { changed: true }

  if (!gate.tool || typeof gate.tool !== 'string') {
    throw new Error(`gate for trigger ${trigger.id} has no tool`)
  }
  const tool = lookupGateTool(gate.tool)
  const result = await tool.invoke(gate.args ?? {})

  // No reducer named ⇒ treat every fire as changed (the tool ran, escalate on its result).
  const reducer = gate.signal
  if (reducer !== 'maxUid' && reducer !== 'count' && reducer !== 'hash') {
    if (reducer != null) {
      // A reducer was named but isn't in the closed set — refuse rather than silently always-fire.
      throw new Error(`gate for trigger ${trigger.id} has unknown signal reducer "${String(reducer)}"`)
    }
    return { changed: true, item: result }
  }

  const signal = reduceSignal(reducer, result)
  // Monotonic-signal guard: a degenerate reduction (a gate tool that returned an error-shaped or
  // empty result instead of throwing) must NEVER clobber a good high-water mark. maxUid returns
  // null when no uid was found, and count returns 0 on an empty/absent result — both are "saw
  // nothing", not a real change. Short-circuit to { changed:false } WITHOUT persisting, so the
  // next poll diffs against the last *good* signal rather than a spurious 0/null. (hash always
  // yields a string, so it's never degenerate here.)
  if (isDegenerateSignal(reducer, signal)) {
    return { changed: false }
  }
  const { changed, persist } = decideSignalChange(signal, trigger.lastSeenSignal)
  if (persist) await updateTriggerSignal(db, trigger.id, signal)
  return changed ? { changed: true, item: result } : { changed: false }
}

// The pure baseline+diff decision: given the freshly-reduced (non-degenerate) signal and the
// previously-stored one, decide whether to escalate (`changed`) and whether to persist the new
// signal. Two rules:
//   - FIRST observation (previous == null) ⇒ establish the baseline SILENTLY: persist, don't
//     escalate. A watcher notifies on what's NEW after it's set up, not the pre-existing backlog
//     (the mail/items you already had). `previous == null` reliably means "never baselined":
//     degenerate (null/0) signals are short-circuited before this is reached and are never
//     persisted, so a stored last_seen_signal is always a real value.
//   - otherwise ⇒ escalate iff the signal differs (canonical-JSON compare so number/string/hash
//     signals diff structurally), persisting only then.
// Exported for offline unit tests.
export function decideSignalChange(
  signal: unknown,
  previous: unknown,
): { changed: boolean; persist: boolean } {
  if (previous == null) return { changed: false, persist: true }
  if (stableStringify(signal) === stableStringify(previous)) return { changed: false, persist: false }
  return { changed: true, persist: true }
}

// A reduced signal that carries no real observation. maxUid → null (no numeric uid found),
// count → 0 (empty/absent). These never overwrite last_seen_signal (fix: a transient empty/error
// gate result was diffing as a change and triggering a spurious double escalation next poll).
// Exported for offline unit tests.
export function isDegenerateSignal(reducer: 'maxUid' | 'count' | 'hash', signal: unknown): boolean {
  if (reducer === 'maxUid') return signal === null
  if (reducer === 'count') return signal === 0
  return false
}
