import { useEffect, useState } from 'react'

type ToolRow = {
  name: string
  toolGroup: string | null
  trustTier: string
  description: string
  requireApproval: boolean | null
}

// Effective approval state shown by the toggle: an explicit setting wins, else the
// trust-tier default (write/destructive ask, read runs free). Mirrors the worker predicate.
const effectiveApproval = (t: ToolRow): boolean => t.requireApproval ?? t.trustTier !== 'read'

export default function Tools() {
  const [tools, setTools] = useState<ToolRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = () =>
    fetch('/api/tools')
      .then((r) => r.json() as Promise<{ tools: ToolRow[] }>)
      .then((d) => setTools(d.tools ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))

  useEffect(() => {
    void load()
  }, [])

  // Persist an explicit true/false for the given tools, optimistically. On failure, restore
  // the rows as they were before this change so the toggles don't show a state the server
  // never accepted.
  const patch = (names: string[], requireApproval: boolean) => {
    const nameSet = new Set(names)
    const snapshot = tools
    setTools((prev) => prev.map((t) => (nameSet.has(t.name) ? { ...t, requireApproval } : t)))
    void fetch('/api/tools', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names, requireApproval }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`PATCH /api/tools ${r.status}`)
      })
      .catch(() => setTools(snapshot))
  }

  const setOne = (t: ToolRow, next: boolean) => {
    // The one guard rail after the §16 divergence: confirm before letting a destructive
    // tool run without asking.
    if (t.trustTier === 'destructive' && !next) {
      const ok = window.confirm(
        `Disable approval for "${t.name}"? It can take irreversible actions without asking first.`,
      )
      if (!ok) return
    }
    patch([t.name], next)
  }

  const toggleGroup = (rows: ToolRow[]) => {
    const next = !rows.every(effectiveApproval) // all on → turn off; otherwise turn on
    if (!next) {
      const destructive = rows.filter((t) => t.trustTier === 'destructive')
      if (destructive.length > 0) {
        const ok = window.confirm(
          `Disable approval for ${destructive.length} destructive tool(s)? They can take irreversible actions without asking first.`,
        )
        if (!ok) return
      }
    }
    patch(
      rows.map((t) => t.name),
      next,
    )
  }

  // Group by tool_group, preserving the server's ordering; ungrouped tools fall under "Other".
  const groups = new Map<string, ToolRow[]>()
  for (const t of tools) {
    const key = t.toolGroup ?? 'Other'
    const list = groups.get(key) ?? []
    list.push(t)
    groups.set(key, list)
  }

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-5 py-6">
      <h1 className="text-xl font-semibold text-ink">Tools</h1>
      <p className="mt-1 text-sm text-muted">
        Choose which tools require your approval before Alfred runs them. Turning approval off
        lets a tool run without asking.
      </p>

      {loading && <p className="mt-8 text-sm text-muted">Loading…</p>}
      {!loading && tools.length === 0 && (
        <p className="mt-8 text-sm text-muted">
          No tools published yet — is the worker running? It publishes its catalog on boot.
        </p>
      )}

      <div className="mt-6 space-y-6">
        {[...groups.entries()].map(([group, rows]) => (
          <section
            key={group}
            className="overflow-hidden rounded-2xl border border-line bg-paper-raised"
          >
            <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <div>
                <h2 className="font-medium capitalize text-ink">{group}</h2>
                <p className="text-xs text-muted">
                  {rows.length} tool{rows.length === 1 ? '' : 's'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => toggleGroup(rows)}
                className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-dim transition-colors hover:border-brass hover:text-brass"
              >
                {rows.every(effectiveApproval)
                  ? 'Turn all off'
                  : rows.some(effectiveApproval)
                    ? 'Require approval for all'
                    : 'Turn all on'}
              </button>
            </header>
            <ul className="divide-y divide-line">
              {rows.map((t) => (
                <li key={t.name} className="flex items-center gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-ink">{t.name}</span>
                      <TierChip tier={t.trustTier} />
                    </div>
                    {t.description && (
                      <p className="mt-0.5 truncate text-xs text-muted">{t.description}</p>
                    )}
                  </div>
                  <Toggle
                    on={effectiveApproval(t)}
                    onChange={(next) => setOne(t, next)}
                    label={`Require approval for ${t.name}`}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

function TierChip({ tier }: { tier: string }) {
  const tone =
    tier === 'destructive'
      ? 'border-red-400/50 text-red-400'
      : tier === 'write'
        ? 'border-brass/50 text-brass'
        : 'border-line text-muted'
  return (
    <span className={`rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${tone}`}>
      {tier}
    </span>
  )
}

// A switch where ON = "asks for approval". Both states must read clearly on the espresso
// ground, so the track is always bordered (a control even when off) and the knob is a
// constant cream disc — never a dark-on-dark blob. A small caption spells out the effect,
// since a bare switch can't say what on/off means.
function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean
  onChange: (next: boolean) => void
  label?: string
}) {
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <span
        className={`w-16 text-right text-[11px] tracking-wide tabular-nums transition-colors ${
          on ? 'text-brass-soft' : 'text-muted'
        }`}
      >
        {on ? 'Asks first' : 'Runs free'}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label ?? 'Require approval'}
        onClick={() => onChange(!on)}
        className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-brass/60 focus-visible:ring-offset-2 focus-visible:ring-offset-paper-raised ${
          on
            ? 'border-brass bg-brass/85 shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]'
            : 'border-line bg-surface hover:border-brass/40'
        }`}
      >
        <span
          className={`absolute left-0.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full bg-ink shadow-[0_1px_2px_rgba(0,0,0,0.45)] transition-transform duration-200 ease-out ${
            on ? 'translate-x-[20px]' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}
