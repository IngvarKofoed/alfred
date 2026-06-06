import { useEffect, useRef, useState } from 'react'

type ContentPart = {
  type: string
  text?: string
  name?: string
  id?: string
  args?: unknown
  path?: string
  mimeType?: string
}
type ToolUse = { id: string; name: string; args?: unknown }
type ImagePart = { path: string; mimeType: string }
// An image uploaded but not yet sent — kept in local state and POSTed with the next message.
type PendingAttachment = { path: string; mimeType: string }
type ChatMessage = { id?: string; role: string; content: ContentPart[] }
type ApprovalPrompt = {
  summary?: string
  tool: string
  args: unknown
  trust_tier?: string
  // 'group' ⇒ approving covers every action in the tool group for the rest of the run,
  // not just the call shown below (ARCHITECTURE §16). Absent / 'call' ⇒ single-call approval.
  scope?: 'group' | 'call'
}
type RunEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call_start'; id: string; toolName: string; args?: unknown }
  | { type: 'tool_call_end'; id: string }
  | { type: 'done' }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }
  | { type: 'interaction_required'; interactionId: string; kind: 'approval' }
  | { type: 'interaction_resolved'; interactionId: string }

function textOf(content: ContentPart[]): string {
  return content.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('')
}

function imagesOf(content: ContentPart[]): ImagePart[] {
  return content
    .filter((p) => p.type === 'image' && p.path)
    .map((p) => ({ path: p.path as string, mimeType: p.mimeType ?? 'image/png' }))
}

function toolUsesOf(content: ContentPart[]): ToolUse[] {
  return content
    .filter((p) => p.type === 'tool_use' && p.name)
    .map((p) => ({ id: p.id ?? (p.name as string), name: p.name as string, args: p.args }))
}

// A compact single-line `key: value, …` rendering of a tool call's args for the chip.
// CSS truncates the visible width; this just caps the string so the DOM stays small.
function argSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const parts = Object.entries(args as Record<string, unknown>).map(([k, v]) => {
    const val = typeof v === 'string' ? v : JSON.stringify(v)
    return `${k}: ${val}`
  })
  const s = parts.join(', ').replace(/\s+/g, ' ').trim()
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}

export default function Chat({ conversationId }: { conversationId: string }) {
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [approval, setApproval] = useState<{
    interactionId: string
    prompt: ApprovalPrompt
  } | null>(null)
  // Tools currently running this turn — drives the subtle live tool chip, keyed by
  // call id. Cleared when history reloads (it then carries the calls durably) or on error.
  const [activeTools, setActiveTools] = useState<ToolUse[]>([])
  // Images uploaded for the message being composed; cleared once sent.
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether to keep pinning to the bottom; false once the user scrolls up to read.
  const stick = useRef(true)

  const loadHistory = () =>
    fetch(`/api/conversations/${conversationId}/messages`)
      .then((r) => r.json() as Promise<{ messages: ChatMessage[] }>)
      .then((d) => {
        // Set history and drop the transient live chips in one render: the reloaded
        // turns carry the tool chips durably, so there's no gap (cleared too early)
        // and no overlap (cleared too late, live + history chips both showing).
        setHistory(d.messages ?? [])
        setActiveTools([])
      })
      .catch(() => {})

  useEffect(() => {
    void loadHistory()
    const es = new EventSource(`/api/conversations/${conversationId}/stream`)
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as RunEvent
      if (ev.type === 'token') {
        setStreaming((s) => s + ev.text)
      } else if (ev.type === 'tool_call_start') {
        setActiveTools((t) => [...t, { id: ev.id, name: ev.toolName, args: ev.args }])
      } else if (ev.type === 'tool_call_end') {
        setActiveTools((t) => t.filter((c) => c.id !== ev.id))
      } else if (ev.type === 'done' || ev.type === 'cancelled') {
        // loadHistory clears the live chips once the durable ones arrive.
        setStreaming('')
        setBusy(false)
        void loadHistory()
      } else if (ev.type === 'error') {
        setStreaming('')
        setActiveTools([])
        setBusy(false)
        setHistory((h) => [
          ...h,
          { role: 'assistant', content: [{ type: 'text', text: `⚠️ ${ev.message}` }] },
        ])
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
  }, [history, streaming, busy, approval, activeTools, pending])

  const onScroll = () => {
    const el = scrollRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file || busy || uploading) return
    setUploading(true)
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await fetch(`/api/conversations/${conversationId}/files`, {
        method: 'POST',
        body,
      })
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(error ?? 'upload failed')
      }
      const att = (await res.json()) as { path: string; mimeType: string }
      setPending((p) => [...p, att])
    } catch {
      // Surface a quiet inline failure rather than crashing the composer.
      setHistory((h) => [
        ...h,
        { role: 'assistant', content: [{ type: 'text', text: '⚠️ image upload failed' }] },
      ])
    } finally {
      setUploading(false)
    }
  }

  const send = async () => {
    const text = input.trim()
    const attachments = pending
    if ((!text && attachments.length === 0) || busy) return
    setInput('')
    setPending([])
    setBusy(true)
    stick.current = true // sending implies wanting to follow the new turn

    const content: ContentPart[] = []
    if (text) content.push({ type: 'text', text })
    for (const a of attachments) content.push({ type: 'image', path: a.path, mimeType: a.mimeType })
    setHistory((h) => [...h, { role: 'user', content }])
    const res = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(attachments.length > 0 ? { text, attachments } : { text }),
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
  // Nothing to render yet (no streamed text, no running tool) but the run is live.
  const showThinking = busy && !streaming && activeTools.length === 0

  // The "Alfred" label appears only on the first assistant bubble in a contiguous
  // run of Alfred output, so a sequence of tool-call + text turns isn't labeled
  // over and over. Tool-result messages and empty assistant turns (which render
  // nothing) don't break the run.
  const rendersNothing = (m: ChatMessage) =>
    m.role === 'assistant' &&
    !textOf(m.content) &&
    toolUsesOf(m.content).length === 0 &&
    imagesOf(m.content).length === 0
  const showName = (i: number) => {
    for (let j = i - 1; j >= 0; j--) {
      const prev = history[j]
      if (!prev || prev.role === 'tool' || rendersNothing(prev)) continue
      return prev.role !== 'assistant'
    }
    return true
  }

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
          {history.map((m, i) =>
            // Tool-result messages are shown only when they carry an image (a screenshot /
            // generated image, rendered as a thumbnail); a text-only tool result is still
            // suppressed — its call is surfaced via the assistant's tool chip (full results
            // live on /debug).
            m.role === 'tool' && imagesOf(m.content).length === 0 ? null : (
              <Bubble
                key={m.id ?? i}
                role={m.role}
                conversationId={conversationId}
                text={textOf(m.content)}
                images={imagesOf(m.content)}
                toolUses={toolUsesOf(m.content)}
                showName={showName(i)}
              />
            ),
          )}
          {streaming && (
            <Bubble role="assistant" conversationId={conversationId} text={streaming} />
          )}
          {activeTools.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {activeTools.map((t) => (
                <ToolChip key={t.id} name={t.name} args={t.args} live />
              ))}
            </div>
          )}
          {showThinking && <Thinking />}
        </div>
      </div>

      {approval && (
        <div className="px-5 pb-3">
          <div className="mx-auto max-w-xl rounded-2xl border border-brass/40 bg-paper-raised p-4 shadow-lg">
            <p className="text-base font-medium text-ink">
              {approval.prompt?.summary ?? 'Approve action'}
            </p>
            {approval.prompt?.scope === 'group' && (
              <p className="mt-1 text-sm text-muted">
                Covers all of this task&apos;s actions — you won&apos;t be asked again until the run
                finishes. First action shown below.
              </p>
            )}
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
        <div className="mx-auto flex max-w-xl flex-col gap-2">
          {(pending.length > 0 || uploading) && (
            <div className="flex flex-wrap gap-2 px-1">
              {pending.map((a) => (
                <div key={a.path} className="relative">
                  <img
                    src={`/media/${conversationId}/${a.path}`}
                    alt="pending attachment"
                    className="h-16 w-16 rounded-lg border border-line object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setPending((p) => p.filter((x) => x.path !== a.path))}
                    aria-label="Remove attachment"
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-paper-raised text-xs text-ink-dim transition-colors hover:text-ink"
                  >
                    ×
                  </button>
                </div>
              ))}
              {uploading && (
                <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-line text-xs text-muted">
                  …
                </div>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 rounded-full border border-line bg-paper-raised px-2 py-1 transition-colors focus-within:border-brass/60">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => void onPickFile(e)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || uploading}
              aria-label="Attach image"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-dim transition-colors hover:bg-surface hover:text-ink disabled:opacity-30"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              className="flex-1 bg-transparent px-1 py-2 text-ink outline-none placeholder:text-muted"
              placeholder={busy ? 'Alfred is attending to this…' : 'Message Alfred…'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || (!input.trim() && pending.length === 0)}
              className="rounded-full bg-brass px-4 py-2 text-sm font-medium text-paper transition-colors hover:bg-brass-soft disabled:opacity-30"
            >
              Send
            </button>
          </div>
        </div>
      </form>
    </>
  )
}

function Bubble({
  role,
  conversationId,
  text,
  images = [],
  toolUses = [],
  showName = true,
}: {
  role: string
  conversationId: string
  text: string
  images?: ImagePart[]
  toolUses?: ToolUse[]
  showName?: boolean
}) {
  const isUser = role === 'user'
  if (isUser) {
    return (
      <div className="flex justify-end" style={{ animation: 'alfred-rise 0.25s ease-out' }}>
        <div className="flex max-w-[85%] flex-col items-end gap-2">
          {images.map((img) => (
            <ChatImage key={img.path} conversationId={conversationId} path={img.path} />
          ))}
          {text && (
            <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-surface px-4 py-2.5 text-ink">
              {text}
            </div>
          )}
        </div>
      </div>
    )
  }
  // A turn may be text-only, tool-only, image-only, or a mix — render nothing for an empty turn.
  if (!text && toolUses.length === 0 && images.length === 0) return null
  return (
    <div className="flex flex-col gap-1" style={{ animation: 'alfred-rise 0.25s ease-out' }}>
      {showName && (
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-brass">Alfred</span>
      )}
      {text && (
        <div className="max-w-[92%] whitespace-pre-wrap leading-relaxed text-ink">{text}</div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-0.5">
          {images.map((img) => (
            <ChatImage key={img.path} conversationId={conversationId} path={img.path} />
          ))}
        </div>
      )}
      {toolUses.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {toolUses.map((t) => (
            <ToolChip key={t.id} name={t.name} args={t.args} />
          ))}
        </div>
      )}
    </div>
  )
}

// An image served from the conversation workspace via the webserver's /media route.
function ChatImage({ conversationId, path }: { conversationId: string; path: string }) {
  return (
    <img
      src={`/media/${conversationId}/${path}`}
      alt="attachment"
      loading="lazy"
      className="max-h-72 max-w-full rounded-xl border border-line object-contain"
    />
  )
}

// A quiet pill marking a tool the agent used (history) or is using now (live → pulse).
// Shows the tool name and a single-line, CSS-truncated summary of its args.
function ToolChip({ name, args, live = false }: { name: string; args?: unknown; live?: boolean }) {
  const summary = argSummary(args)
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full bg-brass ${live ? 'animate-pulse' : ''}`}
        aria-hidden
      />
      <span className="shrink-0 font-mono text-ink-dim">{name}</span>
      {summary && <span className="min-w-0 truncate font-mono text-muted">{summary}</span>}
      {live && (
        <span className="shrink-0" aria-hidden>
          …
        </span>
      )}
    </span>
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
