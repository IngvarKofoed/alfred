import { useEffect, useRef, useState } from 'react'

type RunRow = {
  id: string
  conversationId: string
  status: string
  model: string | null
  startedAt: string | null
  finishedAt: string | null
  promptTokens: number
  completionTokens: number
  costUsd: string | null
  error: string | null
}

type TracedTool = { name: string; description: string; parameters: unknown }
type TracedToolCall = { id: string; name: string; args: unknown }

type LlmCall = {
  id: string
  model: string
  toolCallId: string | null
  request: unknown
  tools: TracedTool[] | null
  responseText: string
  responseToolCalls: TracedToolCall[] | null
  promptTokens: number
  completionTokens: number
  costUsd: string | null
  finishReason: string | null
  latencyMs: number
  error: string | null
}

type ToolCallRow = {
  id: string
  toolName: string
  args: unknown
  result: unknown
  trustTier: string
  status: string
  error: string | null
}

type RunDetail = { run: RunRow; calls: LlmCall[]; toolCalls?: ToolCallRow[] }

export default function Debug() {
  const [runs, setRuns] = useState<RunRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  // Tracks the most recently requested run so an out-of-order fetch response
  // (click A, then quickly B; A resolves last) can't clobber the newer selection.
  const latestRequest = useRef<string | null>(null)

  const loadRuns = () =>
    fetch('/api/debug/runs')
      .then((r) => r.json() as Promise<{ runs: RunRow[] }>)
      .then((d) => setRuns(d.runs ?? []))
      .catch(() => {})

  useEffect(() => {
    void loadRuns()
  }, [])

  const openRun = (id: string) => {
    setSelectedId(id)
    setDetail(null)
    setLoadingDetail(true)
    latestRequest.current = id
    fetch(`/api/debug/runs/${id}`)
      .then((r) => r.json() as Promise<RunDetail>)
      .then((d) => {
        if (latestRequest.current === id) setDetail(d)
      })
      .catch(() => {})
      .finally(() => {
        if (latestRequest.current === id) setLoadingDetail(false)
      })
  }

  const closeDetail = () => {
    setSelectedId(null)
    setDetail(null)
    latestRequest.current = null
  }

  // Responsive master-detail: on md+ the rail and detail sit side by side; on a
  // phone they swap — the rail fills the view until a run is picked, then the
  // detail takes over (with a Back affordance). Either way the detail is in view
  // the instant it's selected, never buried below a long list.
  const hasSelection = selectedId != null

  return (
    <div className="flex h-full min-h-0 text-sm">
      <aside
        className={`${hasSelection ? 'hidden md:flex' : 'flex'} w-full min-h-0 shrink-0 flex-col border-r border-line md:w-80`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">Recent runs</h2>
          <button
            onClick={() => void loadRuns()}
            className="text-xs text-muted transition-colors hover:text-ink"
          >
            Refresh
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {runs.map((r) => {
            const active = r.id === selectedId
            return (
              <button
                key={r.id}
                onClick={() => openRun(r.id)}
                className={`block w-full border-b border-line/60 px-4 py-2.5 text-left transition-colors ${
                  active
                    ? 'border-l-2 border-l-brass bg-surface'
                    : 'border-l-2 border-l-transparent hover:bg-paper-raised'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={active ? 'text-ink' : 'text-ink-dim'}>{when(r)}</span>
                  <span className={`text-xs font-medium ${statusColor(r.status)}`}>{r.status}</span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted">
                  <span className="truncate font-mono">{r.model ?? '—'}</span>
                  <span className="shrink-0 tabular-nums">
                    {r.promptTokens + r.completionTokens} tok · {usd(r.costUsd)}
                  </span>
                </div>
              </button>
            )
          })}
          {runs.length === 0 && <p className="px-4 py-6 text-center text-muted">No runs yet.</p>}
        </div>
      </aside>

      <section
        className={`${hasSelection ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col`}
      >
        {!hasSelection ? (
          <div className="flex flex-1 items-center justify-center text-muted">
            Select a run to inspect its exchange.
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-line px-4 py-3">
              <button
                onClick={closeDetail}
                className="text-muted transition-colors hover:text-ink md:hidden"
                aria-label="Back to runs"
              >
                ←
              </button>
              <h2 className="font-mono text-ink">
                Run {selectedId?.slice(0, 8)}
                {detail && (
                  <>
                    {' · '}
                    <span className={statusColor(detail.run.status)}>{detail.run.status}</span>
                  </>
                )}
              </h2>
              {detail && (
                <span className="ml-auto text-xs text-muted tabular-nums">
                  {detail.run.promptTokens + detail.run.completionTokens} tok · {usd(detail.run.costUsd)}
                </span>
              )}
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {loadingDetail && <p className="text-muted">Loading…</p>}
              {detail?.run.error && (
                <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-300">
                  {detail.run.error}
                </p>
              )}

              {detail && detail.calls.length > 0 && <CostBreakdown detail={detail} />}

              {detail?.calls.map((call) => {
                const system = systemTextOf(call.request)
                const toolCalls = call.responseToolCalls ?? []
                return (
                  <div key={call.id} className="rounded-lg border border-line bg-paper-raised p-3">
                    <div className="text-muted">
                      <span className="font-mono text-ink-dim">{call.model}</span> · {call.latencyMs}ms ·{' '}
                      {call.promptTokens}+{call.completionTokens} tok · {usd(call.costUsd)}
                      {call.finishReason ? ` · ${call.finishReason}` : ''}
                    </div>
                    {call.error && <div className="mt-1 text-red-300">{call.error}</div>}

                    {system && (
                      <details className="mt-2">
                        <summary className="cursor-pointer select-none text-muted hover:text-ink">
                          system instruction
                        </summary>
                        <pre className="mt-1 whitespace-pre-wrap rounded-md bg-paper p-2 text-xs text-ink-dim">
                          {system}
                        </pre>
                      </details>
                    )}

                    <details className="mt-1">
                      <summary className="cursor-pointer select-none text-muted hover:text-ink">
                        tools offered{call.tools ? ` (${call.tools.length})` : ''}
                      </summary>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-paper p-2 text-xs text-ink-dim">
                        {(call.tools ?? [])
                          .map((t) => `${t.name} — ${t.description}\n${JSON.stringify(t.parameters)}`)
                          .join('\n\n') || '—'}
                      </pre>
                    </details>

                    <details className="mt-1">
                      <summary className="cursor-pointer select-none text-muted hover:text-ink">
                        request ({call.toolCallId == null ? 'messages' : 'tool call'})
                      </summary>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-paper p-2 text-xs text-ink-dim">
                        {JSON.stringify(call.request, null, 2)}
                      </pre>
                    </details>

                    <details className="mt-1" open={!call.responseText && toolCalls.length > 0}>
                      <summary className="cursor-pointer select-none text-muted hover:text-ink">
                        response
                        {toolCalls.length
                          ? ` · ${toolCalls.length} tool call${toolCalls.length > 1 ? 's' : ''}`
                          : ''}
                      </summary>
                      {call.responseText && (
                        <pre className="mt-1 whitespace-pre-wrap rounded-md bg-paper p-2 text-xs text-ink-dim">
                          {call.responseText}
                        </pre>
                      )}
                      {toolCalls.map((tc) => (
                        <pre
                          key={tc.id}
                          className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-paper p-2 text-xs text-brass-soft"
                        >
                          → {tc.name}({JSON.stringify(tc.args)})
                        </pre>
                      ))}
                      {!call.responseText && toolCalls.length === 0 && (
                        <pre className="mt-1 text-xs text-muted">(empty)</pre>
                      )}
                    </details>
                  </div>
                )
              })}
              {detail && detail.calls.length === 0 && <p className="text-muted">No LLM calls recorded.</p>}

              {(detail?.toolCalls ?? []).length > 0 && (
                <div className="pt-1">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-brass">
                    Tool calls
                  </h3>
                  <div className="space-y-2">
                    {(detail?.toolCalls ?? []).map((tc) => (
                      <div key={tc.id} className="rounded-lg border border-line bg-paper-raised p-3 text-xs">
                        <div>
                          <span className="font-mono text-brass">{tc.toolName}</span>
                          <span className="text-muted"> · {tc.trustTier} · </span>
                          <span className={toolStatusColor(tc.status)}>{tc.status}</span>
                        </div>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-paper p-2 text-ink-dim">
                          args: {JSON.stringify(tc.args)}
                        </pre>
                        {tc.result != null && (
                          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-paper p-2 text-ink-dim">
                            result: {JSON.stringify(tc.result)}
                          </pre>
                        )}
                        {tc.error && <div className="mt-1 text-red-300">{tc.error}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

// Per-tool cost breakdown, derived client-side from the already-fetched calls + toolCalls.
// Loop calls (tool_call_id == null) are the conversation; the rest are grouped by the
// tool_call that spawned them (labelled from the matching toolCalls row's name). Only
// buckets that actually cost something are shown.
function CostBreakdown({ detail }: { detail: RunDetail }) {
  const calls = detail.calls
  const loopCalls = calls.filter((c) => c.toolCallId == null)
  const loopCost = loopCalls.reduce((sum, c) => sum + Number(c.costUsd ?? 0), 0)

  const nameById = new Map((detail.toolCalls ?? []).map((tc) => [tc.id, tc.toolName]))
  const byTool = new Map<string, { label: string; cost: number; count: number }>()
  for (const c of calls) {
    if (c.toolCallId == null) continue
    const bucket = byTool.get(c.toolCallId) ?? {
      label: nameById.get(c.toolCallId) ?? c.toolCallId,
      cost: 0,
      count: 0,
    }
    bucket.cost += Number(c.costUsd ?? 0)
    bucket.count += 1
    byTool.set(c.toolCallId, bucket)
  }
  const toolBuckets = [...byTool.values()].filter((b) => b.cost > 0)

  return (
    <div className="rounded-lg border border-line bg-paper-raised p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold uppercase tracking-[0.18em] text-brass">Cost</span>
        <span className="tabular-nums text-ink">{usd(detail.run.costUsd)}</span>
      </div>
      <div className="space-y-1 text-muted">
        <div className="flex items-center justify-between gap-2">
          <span>
            Conversation (LLM loop)
            <span className="text-ink-dim"> · {loopCalls.length} call{loopCalls.length === 1 ? '' : 's'}</span>
          </span>
          <span className="tabular-nums text-ink-dim">{usd(String(loopCost))}</span>
        </div>
        {toolBuckets.map((b, i) => (
          <div key={i} className="flex items-center justify-between gap-2">
            <span className="truncate">
              <span className="font-mono text-brass">{b.label}</span>
              <span className="text-ink-dim"> · {b.count} call{b.count === 1 ? '' : 's'}</span>
            </span>
            <span className="tabular-nums text-ink-dim">{usd(String(b.cost))}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// cost_usd arrives as a numeric string. Trim trailing zeros so sub-cent costs stay
// legible (e.g. $0.0012) without padding every value to 6 decimals.
function usd(v: string | null): string {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '$0'
  return '$' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

function when(r: RunRow): string {
  const t = r.startedAt ?? r.finishedAt
  return t ? new Date(t).toLocaleTimeString() : '—'
}

function statusColor(status: string): string {
  if (status === 'done') return 'text-emerald-400'
  if (status === 'failed') return 'text-red-300'
  if (status === 'running' || status === 'pending') return 'text-brass-soft'
  return 'text-muted'
}

function toolStatusColor(status: string): string {
  if (status === 'done') return 'text-emerald-400'
  if (status === 'failed' || status === 'rejected') return 'text-red-300'
  if (status === 'awaiting_user') return 'text-brass-soft'
  return 'text-muted'
}

// Pull the system-prompt text out of the logged request (the first system-role message).
// The request is the provider-agnostic Message[]; shape-guard since it's typed unknown.
function systemTextOf(request: unknown): string {
  if (!Array.isArray(request)) return ''
  return request
    .filter((m): m is { role: string; content: unknown } => !!m && typeof m === 'object' && 'role' in m)
    .filter((m) => m.role === 'system')
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .map((p: unknown) =>
      p && typeof p === 'object' && 'type' in p && (p as { type: string }).type === 'text'
        ? ((p as { text?: string }).text ?? '')
        : '',
    )
    .join('\n')
    .trim()
}
