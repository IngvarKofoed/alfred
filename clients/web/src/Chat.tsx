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

function textOf(content: ContentPart[]): string {
  return content.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('')
}

export default function Chat({ conversationId }: { conversationId: string }) {
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [approval, setApproval] = useState<{ interactionId: string; prompt: ApprovalPrompt } | null>(
    null,
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether to keep pinning to the bottom; false once the user scrolls up to read.
  const stick = useRef(true)

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

  // Keep the latest turn in view as messages arrive and tokens stream in.
  // Instant (not smooth) so it reliably tracks fast token updates; only pins
  // when the user is already at the bottom, so scrolling up to read isn't fought.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [history, streaming, busy, approval])

  const onScroll = () => {
    const el = scrollRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    stick.current = true // sending implies wanting to follow the new turn

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

  const empty = history.length === 0 && !streaming

  return (
    <>
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-5 py-6">
        {empty && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-2xl font-medium text-ink-dim">Good day, Ingvar.</p>
            <p className="mt-2 text-sm text-muted">How may I be of service?</p>
          </div>
        )}
        <div className="mx-auto flex max-w-xl flex-col gap-5">
          {history.map((m, i) => (
            <Bubble key={m.id ?? i} role={m.role} text={textOf(m.content)} />
          ))}
          {streaming ? (
            <Bubble role="assistant" text={streaming} />
          ) : (
            busy && <Thinking />
          )}
        </div>
      </div>

      {approval && (
        <div className="px-5 pb-3">
          <div className="mx-auto max-w-xl rounded-2xl border border-brass/40 bg-paper-raised p-4 shadow-lg">
            <p className="text-base font-medium text-ink">{approval.prompt?.summary ?? 'Approve action'}</p>
            {approval.prompt?.tool && (
              <p className="mt-1 text-sm text-muted">
                Tool: <span className="font-mono text-brass">{approval.prompt.tool}</span>
              </p>
            )}
            <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-paper p-3 font-mono text-xs text-ink-dim">
              {JSON.stringify(approval.prompt?.args ?? {}, null, 2)}
            </pre>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => void resolveApproval(true)}
                className="rounded-full bg-brass px-5 py-2 font-medium text-paper transition-colors hover:bg-brass-soft"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => void resolveApproval(false)}
                className="rounded-full border border-line px-5 py-2 font-medium text-ink-dim transition-colors hover:border-ink-dim hover:text-ink"
              >
                Decline
              </button>
            </div>
          </div>
        </div>
      )}

      <form
        className="border-t border-line px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <div className="mx-auto flex max-w-xl items-center gap-2 rounded-full border border-line bg-paper-raised px-2 py-1 transition-colors focus-within:border-brass/60">
          <input
            className="flex-1 bg-transparent px-3 py-2 text-ink outline-none placeholder:text-muted"
            placeholder={busy ? 'Alfred is attending to this…' : 'Message Alfred…'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-full bg-brass px-4 py-2 text-sm font-medium text-paper transition-colors hover:bg-brass-soft disabled:opacity-30"
          >
            Send
          </button>
        </div>
      </form>
    </>
  )
}

function Bubble({ role, text }: { role: string; text: string }) {
  const isUser = role === 'user'
  if (isUser) {
    return (
      <div className="flex justify-end" style={{ animation: 'alfred-rise 0.25s ease-out' }}>
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-surface px-4 py-2.5 text-ink">
          {text}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1" style={{ animation: 'alfred-rise 0.25s ease-out' }}>
      <span className="text-xs font-semibold uppercase tracking-[0.2em] text-brass">Alfred</span>
      <div className="max-w-[92%] whitespace-pre-wrap leading-relaxed text-ink">
        {text}
      </div>
    </div>
  )
}

function Thinking() {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-[0.2em] text-brass">Alfred</span>
      <div className="flex gap-1 py-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-brass"
            style={{ animation: `alfred-blink 1.2s ease-in-out ${i * 0.18}s infinite` }}
          />
        ))}
      </div>
    </div>
  )
}
