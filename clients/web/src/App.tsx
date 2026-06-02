import { useEffect, useRef, useState } from 'react'

type ContentPart = { type: string; text?: string }
type ChatMessage = { id?: string; role: string; content: ContentPart[] }
type RunEvent =
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

function getConversationId(): string {
  const KEY = 'alfred.conversationId'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(KEY, id)
  }
  return id
}

function textOf(content: ContentPart[]): string {
  return content.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('')
}

export default function App() {
  const conversationId = useRef(getConversationId()).current
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')

  const loadHistory = () =>
    fetch(`/api/conversations/${conversationId}/messages`)
      .then((r) => r.json() as Promise<{ messages: ChatMessage[] }>)
      .then((d) => setHistory(d.messages ?? []))
      .catch(() => {})

  useEffect(() => {
    void loadHistory()
    const es = new EventSource(`/api/conversations/${conversationId}/stream`)
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as RunEvent
      if (ev.type === 'token') {
        setStreaming((s) => s + ev.text)
      } else if (ev.type === 'done') {
        setStreaming('')
        setBusy(false)
        void loadHistory()
      } else if (ev.type === 'error') {
        setStreaming('')
        setBusy(false)
        setHistory((h) => [...h, { role: 'assistant', content: [{ type: 'text', text: `⚠️ ${ev.message}` }] }])
      }
    }
    return () => es.close()
  }, [conversationId])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    setHistory((h) => [...h, { role: 'user', content: [{ type: 'text', text }] }])
    const res = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      setBusy(false)
      const { error } = (await res.json().catch(() => ({ error: 'request failed' }))) as {
        error?: string
      }
      setHistory((h) => [
        ...h,
        { role: 'assistant', content: [{ type: 'text', text: `⚠️ ${error ?? 'request failed'}` }] },
      ])
    }
  }

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-4 py-3 text-lg font-semibold">Alfred</header>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {history.length === 0 && !streaming && (
          <p className="pt-8 text-center text-zinc-500">Say hello to Alfred.</p>
        )}
        {history.map((m, i) => (
          <Bubble key={m.id ?? i} role={m.role} text={textOf(m.content)} />
        ))}
        {streaming && <Bubble role="assistant" text={streaming} />}
      </div>
      <form
        className="flex gap-2 border-t border-zinc-800 p-3"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input
          className="flex-1 rounded-md bg-zinc-900 px-3 py-2 outline-none placeholder:text-zinc-500"
          placeholder={busy ? 'Alfred is thinking…' : 'Message Alfred…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-md bg-emerald-600 px-4 py-2 font-medium disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </main>
  )
}

function Bubble({ role, text }: { role: string; text: string }) {
  const isUser = role === 'user'
  return (
    <div className={isUser ? 'text-right' : 'text-left'}>
      <span
        className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-left ${
          isUser ? 'bg-emerald-700' : 'bg-zinc-800'
        }`}
      >
        {text}
      </span>
    </div>
  )
}
