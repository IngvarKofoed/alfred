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

type ConversationRow = {
  id: string
  title: string | null
  ingress: string | null
  lastActiveAt: string | null
  // Aggregates over ALL of the conversation's runs (computed server-side), independent
  // of the capped `runs` list below which only feeds the sparkline/timeline.
  runCount: number
  promptTokens: number
  completionTokens: number
  costUsd: string | null
  runs: RunRow[]
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
  const [conversations, setConversations] = useState<ConversationRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const loadConversations = () =>
    fetch('/api/debug/conversations')
      .then((r) => r.json() as Promise<{ conversations: ConversationRow[] }>)
      .then((d) => setConversations(d.conversations ?? []))
      .catch(() => {})

  useEffect(() => {
    void loadConversations()
  }, [])

  // Responsive master-detail: on md+ the rail and ledger sit side by side; on a phone
  // they swap — the rail fills the view until a conversation is picked, then the ledger
  // takes over (with a Back affordance).
  // Derive hasSelection from `selected` (not from selectedId) so the two panes can never
  // disagree — e.g. if a Refresh drops the selected conversation from the list, the rail
  // reappears instead of stranding the mobile view on an empty detail with no Back.
  const selected = conversations.find((c) => c.id === selectedId) ?? null
  const hasSelection = selected != null

  return (
    <div className="flex h-full min-h-0 text-sm">
      <aside
        className={`${hasSelection ? 'hidden md:flex' : 'flex'} w-full min-h-0 shrink-0 flex-col border-r border-line md:w-80`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">
            Conversations
          </h2>
          <button
            onClick={() => void loadConversations()}
            className="text-xs text-muted transition-colors hover:text-ink"
          >
            Refresh
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {conversations.map((cv) => (
            <ConversationItem
              key={cv.id}
              conversation={cv}
              active={cv.id === selectedId}
              onClick={() => setSelectedId(cv.id)}
            />
          ))}
          {conversations.length === 0 && (
            <p className="px-4 py-6 text-center text-muted">No conversations yet.</p>
          )}
        </div>
      </aside>

      <section
        className={`${hasSelection ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col`}
      >
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-muted">
            Select a conversation to inspect its runs.
          </div>
        ) : (
          <ConversationLedger
            key={selected.id}
            conversation={selected}
            onBack={() => setSelectedId(null)}
          />
        )}
      </section>
    </div>
  )
}

// --- Rail: one entry per conversation, with a glanceable run-status sparkline ---

function ConversationItem({
  conversation,
  active,
  onClick,
}: {
  conversation: ConversationRow
  active: boolean
  onClick: () => void
}) {
  const { runs } = conversation
  // Sparkline reads chronologically left→right (runs arrive newest-first), capped so a
  // long conversation stays one tidy row.
  const sparkRuns = runs.slice(0, 18).reverse()

  return (
    <button
      onClick={onClick}
      className={`block w-full border-b border-line/60 px-4 py-3 text-left transition-colors ${
        active
          ? 'border-l-2 border-l-brass bg-surface'
          : 'border-l-2 border-l-transparent hover:bg-paper-raised'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={`truncate font-medium ${active ? 'text-ink' : 'text-ink-dim'}`}>
          {conversation.title ?? `Conversation ${conversation.id.slice(0, 8)}`}
        </span>
        <span className="shrink-0 text-xs text-muted">{relTime(lastTime(conversation))}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        {sparkRuns.map((r) => (
          <span
            key={r.id}
            title={r.status}
            className={`h-1.5 w-1.5 rounded-full ${statusDot(r.status)}`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted">
        <span>
          {conversation.runCount} run{conversation.runCount === 1 ? '' : 's'}
        </span>
        <span className="shrink-0 tabular-nums">
          {conversation.promptTokens + conversation.completionTokens} tok · {usd(conversation.costUsd)}
        </span>
      </div>
    </button>
  )
}

// --- Detail: the conversation's runs as a vertical timeline on a brass spine ---

function ConversationLedger({
  conversation,
  onBack,
}: {
  conversation: ConversationRow
  onBack: () => void
}) {
  const { runs } = conversation

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <button
          onClick={onBack}
          className="text-muted transition-colors hover:text-ink md:hidden"
          aria-label="Back to conversations"
        >
          ←
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-ink">
            {conversation.title ?? `Conversation ${conversation.id.slice(0, 8)}`}
          </h2>
          <p className="font-mono text-xs text-muted">
            {conversation.id}
            {conversation.ingress ? ` · ${conversation.ingress}` : ''}
          </p>
        </div>
        <span className="ml-auto shrink-0 text-right text-xs text-muted tabular-nums">
          {conversation.runCount} run{conversation.runCount === 1 ? '' : 's'} ·{' '}
          {conversation.promptTokens + conversation.completionTokens} tok
          <br />
          <span className="text-ink">{usd(conversation.costUsd)}</span>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {runs.length === 0 ? (
          <p className="text-muted">No runs recorded.</p>
        ) : (
          <ol className="space-y-0">
            {runs.map((run, i) => (
              <RunEntry key={run.id} run={run} last={i === runs.length - 1} defaultOpen={i === 0} />
            ))}
          </ol>
        )}
      </div>
    </>
  )
}

function RunEntry({
  run,
  last,
  defaultOpen,
}: {
  run: RunRow
  last: boolean
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  // Manual retry counter — bumping it re-runs the fetch effect after a failure.
  const [reloadKey, setReloadKey] = useState(0)
  // The run.status we last successfully loaded detail at. A status change (e.g.
  // running→done after a Refresh) refetches; a failed fetch leaves this null so
  // re-expanding (or Retry) tries again — neither loops, since the effect only re-runs
  // when its deps change.
  const loadedStatus = useRef<string | null>(null)

  // Lazy-load the heavy per-run detail when the entry is expanded (or its status moves).
  useEffect(() => {
    if (!open || loadedStatus.current === run.status) return
    let ignore = false
    setLoading(true)
    setError(false)
    fetch(`/api/debug/runs/${run.id}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<RunDetail>
      })
      .then((d) => {
        if (ignore) return
        setDetail(d)
        loadedStatus.current = run.status
      })
      .catch(() => {
        if (!ignore) setError(true)
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
  }, [open, run.id, run.status, reloadKey])

  return (
    <li className="flex gap-3">
      {/* Timeline gutter: status node + connector to the next run. */}
      <div className="flex flex-col items-center pt-3">
        <span
          className={`h-3 w-3 shrink-0 rounded-full ring-4 ring-paper ${statusDot(run.status)}`}
        />
        {!last && <span className="mt-1 w-px flex-1 bg-line" />}
      </div>

      <div className="min-w-0 flex-1 pb-4">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded-lg border border-line bg-paper-raised px-3 py-2 text-left transition-colors hover:border-brass/40"
        >
          <span className={`text-muted transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
          <span className="text-ink-dim">{clockTime(run)}</span>
          <span className={`text-xs font-medium ${statusColor(run.status)}`}>{run.status}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted">
            <span className="hidden font-mono sm:inline">{run.model ?? '—'}</span>
            <span className="tabular-nums">
              {run.promptTokens + run.completionTokens} tok · {usd(run.costUsd)}
            </span>
          </span>
        </button>

        {open && (
          <div className="mt-2 space-y-3">
            {loading && <p className="text-muted">Loading…</p>}
            {error && !loading && (
              <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-300">
                Couldn’t load run detail.{' '}
                <button
                  onClick={() => setReloadKey((k) => k + 1)}
                  className="underline transition-colors hover:text-ink"
                >
                  Retry
                </button>
              </p>
            )}
            {(detail?.run.error ?? run.error) && (
              <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-300">
                {detail?.run.error ?? run.error}
              </p>
            )}
            {detail && detail.calls.length > 0 && <CostBreakdown detail={detail} />}
            {detail?.calls.map((call) => (
              <CallCard key={call.id} call={call} />
            ))}
            {detail && detail.calls.length === 0 && !loading && (
              <p className="text-muted">No LLM calls recorded.</p>
            )}
            {(detail?.toolCalls ?? []).length > 0 && (
              <div className="pt-1">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-brass">
                  Tool calls
                </h3>
                <div className="space-y-2">
                  {(detail?.toolCalls ?? []).map((tc) => (
                    <ToolCallCard key={tc.id} tc={tc} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

function CallCard({ call }: { call: LlmCall }) {
  const system = systemTextOf(call.request)
  const toolCalls = call.responseToolCalls ?? []
  return (
    <div className="rounded-lg border border-line bg-paper-raised p-3">
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
}

function ToolCallCard({ tc }: { tc: ToolCallRow }) {
  return (
    <div className="rounded-lg border border-line bg-paper-raised p-3 text-xs">
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
            <span className="text-ink-dim">
              {' '}
              · {loopCalls.length} call{loopCalls.length === 1 ? '' : 's'}
            </span>
          </span>
          <span className="tabular-nums text-ink-dim">{usd(String(loopCost))}</span>
        </div>
        {toolBuckets.map((b, i) => (
          <div key={i} className="flex items-center justify-between gap-2">
            <span className="truncate">
              <span className="font-mono text-brass">{b.label}</span>
              <span className="text-ink-dim">
                {' '}
                · {b.count} call{b.count === 1 ? '' : 's'}
              </span>
            </span>
            <span className="tabular-nums text-ink-dim">{usd(String(b.cost))}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// --- helpers ---

function lastTime(cv: ConversationRow): string | null {
  if (cv.lastActiveAt) return cv.lastActiveAt
  const r = cv.runs[0]
  return r?.startedAt ?? r?.finishedAt ?? null
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

function clockTime(r: RunRow): string {
  const t = r.startedAt ?? r.finishedAt
  return t ? new Date(t).toLocaleTimeString() : '—'
}

// Compact relative time for the rail ("3m", "2h", "5d"), falling back to a date.
function relTime(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return '—'
  const s = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (s < 60) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString()
}

function statusColor(status: string): string {
  if (status === 'done') return 'text-emerald-400'
  if (status === 'failed') return 'text-red-300'
  if (status === 'running' || status === 'pending') return 'text-brass-soft'
  return 'text-muted'
}

// Background colour for the status dots (rail sparkline + timeline nodes).
function statusDot(status: string): string {
  if (status === 'done') return 'bg-emerald-400'
  if (status === 'failed') return 'bg-red-400'
  if (status === 'running' || status === 'pending') return 'bg-brass-soft'
  if (status === 'awaiting_approval') return 'bg-brass'
  return 'bg-muted'
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
