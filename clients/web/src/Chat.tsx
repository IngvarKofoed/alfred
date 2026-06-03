import { useEffect, useRef, useState } from 'react'

type ContentPart = { type: string; text?: string }
type ChatMessage = { id?: string; role: string; content: ContentPart[] }
type ApprovalPrompt = { summary?: string; tool: string; args: unknown; trust_tier?: string }
type RunEvent =
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'interaction_required'; interactionId: string; kind: 'approval' }
  | { type: 'interaction_resolved'; interactionId: string }

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

export default function Chat() {
  const conversationId = useRef(getConversationId()).current
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [approval, setApproval] = useState<{ interactionId: string; prompt: ApprovalPrompt } | null>(
    null,
  )

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
      } else if (ev.type === 'interaction_required') {
        const interactionId = ev.interactionId
        fetch(`/api/interactions/${interactionId}`)
          .then((r) => r.json() as Promise<{ interaction: { prompt: ApprovalPrompt } }>)
          .then((d) => setApproval({ interactionId, prompt: d.interaction.prompt }))
          .catch(() => {})
      } else if (ev.type === 'interaction_resolved') {
        setApproval(null)
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

  const resolveApproval = async (approved: boolean) => {
    if (!approval) return
    const { interactionId } = approval
    setApproval(null)
    await fetch(`/api/interactions/${interactionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved }),
    }).catch(() => {})
  }

  return (
    <>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {history.length === 0 && !streaming && (
          <p className="pt-8 text-center text-zinc-500">Say hello to Alfred.</p>
        )}
        {history.map((m, i) => (
          <Bubble key={m.id ?? i} role={m.role} text={textOf(m.content)} />
        ))}
        {streaming && <Bubble role="assistant" text={streaming} />}
      </div>
      {approval && (
        <div className="border-t border-zinc-800 p-3">
          <div className="rounded-xl border border-emerald-700/50 bg-zinc-900 p-4">
            <p className="font-medium text-zinc-100">
              {approval.prompt?.summary ?? 'Approve action'}
            </p>
            {approval.prompt?.tool && (
              <p className="mt-1 text-sm text-zinc-400">
                Tool: <span className="font-mono text-emerald-400">{approval.prompt.tool}</span>
              </p>
            )}
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-300">
              {JSON.stringify(approval.prompt?.args ?? {}, null, 2)}
            </pre>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void resolveApproval(true)}
                className="rounded-md bg-emerald-600 px-4 py-2 font-medium hover:bg-emerald-500"
              >
                ✅ Approve
              </button>
              <button
                type="button"
                onClick={() => void resolveApproval(false)}
                className="rounded-md bg-zinc-700 px-4 py-2 font-medium hover:bg-zinc-600"
              >
                ❌ Reject
              </button>
            </div>
          </div>
        </div>
      )}
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
    </>
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
