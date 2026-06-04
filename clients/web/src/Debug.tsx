import { useEffect, useState } from 'react'

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
  const [detail, setDetail] = useState<RunDetail | null>(null)

  const loadRuns = () =>
    fetch('/api/debug/runs')
      .then((r) => r.json() as Promise<{ runs: RunRow[] }>)
      .then((d) => setRuns(d.runs ?? []))
      .catch(() => {})

  useEffect(() => {
    void loadRuns()
  }, [])

  const openRun = (id: string) =>
    fetch(`/api/debug/runs/${id}`)
      .then((r) => r.json() as Promise<RunDetail>)
      .then(setDetail)
      .catch(() => {})

  return (
    <div className="flex-1 space-y-6 overflow-y-auto p-4 text-sm">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">Recent runs</h2>
          <button onClick={() => void loadRuns()} className="text-zinc-400 hover:text-zinc-100">
            Refresh
          </button>
        </div>
        <table className="w-full">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="py-1">When</th>
              <th>Status</th>
              <th>Model</th>
              <th className="text-right">Tokens</th>
              <th className="text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.id}
                onClick={() => void openRun(r.id)}
                className="cursor-pointer border-t border-zinc-900 hover:bg-zinc-900"
              >
                <td className="py-1">{when(r)}</td>
                <td className={statusColor(r.status)}>{r.status}</td>
                <td className="text-zinc-400">{r.model ?? '—'}</td>
                <td className="text-right text-zinc-400">{r.promptTokens + r.completionTokens}</td>
                <td className="text-right text-zinc-400">{usd(r.costUsd)}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-zinc-500">
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {detail && (
        <section className="space-y-3">
          <h2 className="font-semibold">
            Run {detail.run.id.slice(0, 8)} · <span className={statusColor(detail.run.status)}>{detail.run.status}</span>
          </h2>
          {detail.run.error && <p className="text-red-400">{detail.run.error}</p>}
          {detail.calls.map((call) => {
            const system = systemTextOf(call.request)
            const toolCalls = call.responseToolCalls ?? []
            return (
              <div key={call.id} className="rounded-md bg-zinc-900 p-3">
                <div className="text-zinc-400">
                  {call.model} · {call.latencyMs}ms · {call.promptTokens}+{call.completionTokens} tok
                  {' · '}
                  {usd(call.costUsd)}
                  {call.finishReason ? ` · ${call.finishReason}` : ''}
                </div>
                {call.error && <div className="mt-1 text-red-400">{call.error}</div>}

                {system && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-zinc-400">system instruction</summary>
                    <pre className="mt-1 whitespace-pre-wrap text-xs text-zinc-300">{system}</pre>
                  </details>
                )}

                <details className="mt-1">
                  <summary className="cursor-pointer text-zinc-400">
                    tools offered{call.tools ? ` (${call.tools.length})` : ''}
                  </summary>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-zinc-300">
                    {(call.tools ?? [])
                      .map((t) => `${t.name} — ${t.description}\n${JSON.stringify(t.parameters)}`)
                      .join('\n\n') || '—'}
                  </pre>
                </details>

                <details className="mt-1">
                  <summary className="cursor-pointer text-zinc-400">request (messages)</summary>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-zinc-300">
                    {JSON.stringify(call.request, null, 2)}
                  </pre>
                </details>

                <details className="mt-1" open={!call.responseText && toolCalls.length > 0}>
                  <summary className="cursor-pointer text-zinc-400">
                    response{toolCalls.length ? ` · ${toolCalls.length} tool call${toolCalls.length > 1 ? 's' : ''}` : ''}
                  </summary>
                  {call.responseText && (
                    <pre className="mt-1 whitespace-pre-wrap text-xs text-zinc-300">{call.responseText}</pre>
                  )}
                  {toolCalls.map((tc) => (
                    <pre key={tc.id} className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-sky-300">
                      → {tc.name}({JSON.stringify(tc.args)})
                    </pre>
                  ))}
                  {!call.responseText && toolCalls.length === 0 && (
                    <pre className="mt-1 text-xs text-zinc-500">(empty)</pre>
                  )}
                </details>
              </div>
            )
          })}
          {detail.calls.length === 0 && <p className="text-zinc-500">No LLM calls recorded.</p>}

          {(detail.toolCalls ?? []).length > 0 && (
            <div>
              <h3 className="mb-2 font-semibold">Tool calls</h3>
              <div className="space-y-2">
                {(detail.toolCalls ?? []).map((tc) => (
                  <div key={tc.id} className="rounded-md bg-zinc-900 p-3 text-xs">
                    <div className="text-zinc-300">
                      <span className="text-sky-300">{tc.toolName}</span>
                      <span className="text-zinc-500"> · {tc.trustTier} · </span>
                      <span className={toolStatusColor(tc.status)}>{tc.status}</span>
                    </div>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-zinc-400">
                      args: {JSON.stringify(tc.args)}
                    </pre>
                    {tc.result != null && (
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-zinc-400">
                        result: {JSON.stringify(tc.result)}
                      </pre>
                    )}
                    {tc.error && <div className="mt-1 text-red-400">{tc.error}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
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
  if (status === 'failed') return 'text-red-400'
  if (status === 'running' || status === 'pending') return 'text-amber-400'
  return 'text-zinc-400'
}

function toolStatusColor(status: string): string {
  if (status === 'done') return 'text-emerald-400'
  if (status === 'failed' || status === 'rejected') return 'text-red-400'
  if (status === 'awaiting_user') return 'text-amber-400'
  return 'text-zinc-400'
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
