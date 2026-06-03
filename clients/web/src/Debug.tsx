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
  error: string | null
}

type LlmCall = {
  id: string
  model: string
  request: unknown
  responseText: string
  promptTokens: number
  completionTokens: number
  finishReason: string | null
  latencyMs: number
  error: string | null
}

type RunDetail = { run: RunRow; calls: LlmCall[] }

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
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-zinc-500">
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
          {detail.calls.map((call) => (
            <div key={call.id} className="rounded-md bg-zinc-900 p-3">
              <div className="text-zinc-400">
                {call.model} · {call.latencyMs}ms · {call.promptTokens}+{call.completionTokens} tok
                {call.finishReason ? ` · ${call.finishReason}` : ''}
              </div>
              {call.error && <div className="mt-1 text-red-400">{call.error}</div>}
              <details className="mt-2">
                <summary className="cursor-pointer text-zinc-400">request</summary>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-zinc-300">
                  {JSON.stringify(call.request, null, 2)}
                </pre>
              </details>
              <details className="mt-1">
                <summary className="cursor-pointer text-zinc-400">response</summary>
                <pre className="mt-1 whitespace-pre-wrap text-xs text-zinc-300">{call.responseText}</pre>
              </details>
            </div>
          ))}
          {detail.calls.length === 0 && <p className="text-zinc-500">No LLM calls recorded.</p>}
        </section>
      )}
    </div>
  )
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
