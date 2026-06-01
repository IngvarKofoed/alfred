import { useEffect, useState } from 'react'

type Status = 'checking' | 'ok' | 'error'

export default function App() {
  const [status, setStatus] = useState<Status>('checking')

  useEffect(() => {
    fetch('/api/health')
      .then((res) => (res.ok ? (res.json() as Promise<{ ok: boolean }>) : Promise.reject()))
      .then((body) => setStatus(body.ok ? 'ok' : 'error'))
      .catch(() => setStatus('error'))
  }, [])

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100">
      <div className="space-y-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Alfred</h1>
        {status === 'checking' && <p className="text-zinc-400">Checking…</p>}
        {status === 'ok' && <p className="text-emerald-400">Alfred is reachable ✓</p>}
        {status === 'error' && <p className="text-red-400">Can’t reach the server.</p>}
      </div>
    </main>
  )
}
