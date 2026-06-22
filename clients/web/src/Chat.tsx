import { memo, useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fmtTokens, usd } from './format'

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
// A slash command from GET /api/commands — used to render the autocomplete suggestions.
type CommandInfo = { name: string; aliases: string[]; description: string; usage: string }
type ApprovalPrompt = {
  summary?: string
  tool: string
  args: unknown
  trust_tier?: string
  // 'group' ⇒ approving covers every action in the tool group for the rest of the run,
  // not just the call shown below (ARCHITECTURE §16). Absent / 'call' ⇒ single-call approval.
  scope?: 'group' | 'call'
}
// An agent-initiated question (ask_user, §7.3) — the structured shape from DATABASE.md.
// options omitted ⇒ free-form question; allow_freeform defaults to true.
type QuestionPrompt = {
  question: string
  options?: { label: string; description?: string }[]
  multi_select?: boolean
  allow_freeform?: boolean
}
type RunEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call_start'; id: string; toolName: string; args?: unknown }
  | { type: 'tool_call_end'; id: string }
  | { type: 'done' }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }
  | { type: 'interaction_required'; interactionId: string; kind: 'approval' | 'question' }
  | { type: 'interaction_resolved'; interactionId: string }
  | { type: 'title'; title: string }
  // Server-pushed TTS clip (voice, spec 2026-06-14). The web client is chat-only (voice lives
  // only in the native app, §9.3), so it carries the type for completeness but ignores the
  // event — the handler's if/else chain has no branch for it, so it falls through.
  | { type: 'tts_audio'; seq: number; path: string; mimeType: string }
  // Cumulative token/cost snapshot for the CURRENT run (a full snapshot per emit, not a delta —
  // a missed event self-corrects, last-wins). Unlike tts_audio above, this IS handled: it drives
  // the live overlay in the cost footer (spec 2026-06-15).
  | { type: 'usage'; promptTokens: number; completionTokens: number; costUsd: number }

// One ordered segment per thing the in-flight run has produced, in the order things actually
// happened: a 'text' segment grows as tokens stream; a 'tool' segment is a chip that accumulates
// (never removed) and stops pulsing when its tool_call_end arrives. This preserves real
// interleaving (text → tool → more text) in a single live Alfred block, and is replaced wholesale
// by durable history on the done/cancelled handoff (loadHistory clears it in the same render).
type LiveSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args?: unknown; done: boolean }

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

export default function Chat({
  conversationId,
  onTitleChange,
}: {
  conversationId: string
  onTitleChange: (title: string) => void
}) {
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  // Stop-button request (POST …/cancel) in flight — disables the button so a double-click
  // can't fire two cancels. The actual teardown is never optimistic: it comes from the SSE
  // 'cancelled' event (200) or the 409 self-heal in cancelRun.
  const [cancelling, setCancelling] = useState(false)
  // Set when a 'cancelled' SSE event lands: the worker's NOTIFY chain may flush a few straggler
  // token / tool_call_* events after the route's cancel, and they must not resurrect the live
  // block. Cleared once the post-cancel history reload settles (stragglers flush within the same
  // tick as the cancel NOTIFY, so by then they're gone) and again when this tab starts a run
  // (send()) — belt and braces. Time-bounding matters: a run started later from ANOTHER
  // tab/device must stream normally here, not be dropped forever.
  const cancelledRef = useRef(false)
  // Set when this stream delivers a terminal event (done/cancelled/error) — gates the
  // mount-time activeRun fetch so its stale snapshot can't re-set busy after the run ended.
  const terminalSeenRef = useRef(false)
  const [input, setInput] = useState('')
  const [approval, setApproval] = useState<{
    interactionId: string
    prompt: ApprovalPrompt
  } | null>(null)
  // "Don't ask again" — when approving, also persist require_approval=false (same store the
  // Tools page writes) so this decision survives future runs and restarts. Reset per card.
  const [remember, setRemember] = useState(false)
  // An agent-initiated question (ask_user, §7.3) — sibling to the approval card. The form
  // state (selected option labels + free-form text) is reset whenever a new question opens.
  const [question, setQuestion] = useState<{
    interactionId: string
    prompt: QuestionPrompt
  } | null>(null)
  const [qSelected, setQSelected] = useState<string[]>([])
  const [qFreeform, setQFreeform] = useState('')
  // When the question offers options AND free text, the free-text box is its own choice
  // ("Other"). qOther tracks whether it's selected — mutually exclusive with the options in
  // single-select, so an answer is never both a picked option and stray free text.
  const [qOther, setQOther] = useState(false)
  // The in-flight run's live output as one ordered block (streamed text + accumulating tool
  // chips, in real order). Cleared when history reloads (it then carries the turn durably) or
  // on error. See LiveSegment.
  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([])
  // Cost footer (spec 2026-06-15): baseUsage is the cumulative total across the conversation's
  // already-rolled-up runs (from GET /api/conversations/:id meta); runUsage is the in-flight
  // run's live overlay (from the `usage` SSE event). Footer total = base + overlay; on any
  // terminal event the overlay clears and the baseline re-fetches (now incl. the finished run),
  // so the two never double-count.
  const [baseUsage, setBaseUsage] = useState<{ tokens: number; costUsd: number }>({
    tokens: 0,
    costUsd: 0,
  })
  // The footer renders only the combined token total, so the overlay stores the sum (not the split).
  const [runUsage, setRunUsage] = useState<{ tokens: number; costUsd: number } | null>(null)
  // Images uploaded for the message being composed; cleared once sent.
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Slash-command autocomplete: the catalog (fetched once) and the highlighted row. Whether the
  // menu shows is derived from the input being a bare `/command` token (see cmdMatches below) —
  // cmdDismissed is the one piece of explicit state, set when the user dismisses (Esc / blur /
  // accept) and cleared on the next keystroke, so there's no second "is this a command" regex
  // to drift from cmdMatch.
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [cmdDismissed, setCmdDismissed] = useState(false)
  const [cmdIndex, setCmdIndex] = useState(0)
  const messageInputRef = useRef<HTMLInputElement>(null)
  // Full-size image overlay: holds the /media src of the clicked image, or null when closed.
  const [lightbox, setLightbox] = useState<string | null>(null)
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])
  // Fetch the slash-command catalog once for autocomplete (static, conversation-independent).
  useEffect(() => {
    let ignore = false
    fetch('/api/commands')
      .then((r) => r.json() as Promise<{ commands: CommandInfo[] }>)
      .then((d) => {
        if (!ignore) setCommands(d.commands ?? [])
      })
      .catch(() => {})
    return () => {
      ignore = true
    }
  }, [])

  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether to keep pinning to the bottom; false once the user scrolls up to read.
  const stick = useRef(true)

  // /speak playback: a single HTMLAudioElement plays the streamed clips in seq order, advancing
  // on 'ended'. speakAudioRef holds the element currently playing; speakEpochRef bumps on each
  // fresh /speak so a stale stream's late clips (and the prior audio) are abandoned. Stop the
  // current audio + invalidate any in-flight stream when the conversation changes or unmounts.
  const speakAudioRef = useRef<HTMLAudioElement | null>(null)
  const speakEpochRef = useRef(0)
  useEffect(
    () => () => {
      speakEpochRef.current++
      speakAudioRef.current?.pause()
      speakAudioRef.current = null
    },
    [conversationId],
  )

  const loadHistory = () =>
    fetch(`/api/conversations/${conversationId}/messages`)
      .then((r) => r.json() as Promise<{ messages: ChatMessage[] }>)
      .then((d) => {
        // Set history and drop the transient live segments in one render: the reloaded
        // turns carry the streamed text + tool chips durably, so there's no gap (cleared too
        // early) and no overlap (cleared too late, live + history both showing).
        setHistory(d.messages ?? [])
        setLiveSegments([])
      })
      // A failed reload after a run must still drop the live block (which is now kept
      // mounted until liveSegments clears), else it lingers visibly with no durable turn.
      .catch(() => setLiveSegments([]))

  // Fetch GET /api/conversations/:id meta: the cumulative token/cost baseline for the footer,
  // plus the refresh-proof busy restore (set busy only if a run is active AND this stream hasn't
  // already seen its terminal event — terminalSeenRef gates a stale "active" snapshot). Called on
  // mount and again after each terminal event to reconcile the just-finished run's rollup.
  const loadMeta = useCallback(
    (signal?: AbortSignal) =>
      fetch(`/api/conversations/${conversationId}`, { signal })
        .then(
          (r) =>
            r.json() as Promise<{ activeRun?: boolean; tokens?: number; costUsd?: string }>,
        )
        .then((d) => {
          // Race guard: a fetch still in flight when the conversation switched (the mount caller
          // aborts on unmount) must not seed this conversation's footer with the previous one's.
          if (signal?.aborted) return
          setBaseUsage({ tokens: d.tokens ?? 0, costUsd: Number(d.costUsd ?? 0) })
          if (d.activeRun && !terminalSeenRef.current) setBusy(true)
        })
        .catch(() => {}),
    [conversationId],
  )

  // On a terminal event the finished run's cost has moved into the agent_runs rollup: drop the
  // live overlay and re-fetch the baseline (now incl. the finished run). The overlay clear is
  // synchronous ON PURPOSE — a brief footer dip until meta lands is preferable to clearing it
  // only after the async fetch, which would clobber the overlay of a run started in the meantime.
  const reconcileUsage = useCallback(() => {
    setRunUsage(null)
    void loadMeta()
  }, [loadMeta])

  useEffect(() => {
    void loadHistory()
    const es = new EventSource(`/api/conversations/${conversationId}/stream`)
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as RunEvent
      // Straggler guard: after a cancel, the worker keeps flushing whatever its NOTIFY chain
      // already queued — ignore those live-output events so they can't resurrect the live block.
      // interaction_required is included because a straggler would re-open an approval card for
      // an interaction the cancel cascade already resolved (§10.9 invariant 4); title because a
      // post-cancel auto-title must not land out of band.
      if (
        cancelledRef.current &&
        (ev.type === 'token' ||
          ev.type === 'tool_call_start' ||
          ev.type === 'tool_call_end' ||
          ev.type === 'interaction_required' ||
          ev.type === 'title' ||
          // usage included so a straggler can't bump the footer past the reconciled total.
          ev.type === 'usage')
      ) {
        return
      }
      if (ev.type === 'token') {
        // Extend the trailing text segment, or open a new one if the last segment is a tool —
        // so text arriving after a tool starts a fresh segment below that chip (real order).
        setLiveSegments((segs) => {
          const last = segs[segs.length - 1]
          if (last && last.kind === 'text') {
            return [...segs.slice(0, -1), { ...last, text: last.text + ev.text }]
          }
          return [...segs, { kind: 'text', text: ev.text }]
        })
      } else if (ev.type === 'tool_call_start') {
        setLiveSegments((segs) => [
          ...segs,
          { kind: 'tool', id: ev.id, name: ev.toolName, args: ev.args, done: false },
        ])
      } else if (ev.type === 'tool_call_end') {
        // Mark the matching chip done (it stays — just stops pulsing). Unknown id → no-op.
        setLiveSegments((segs) =>
          segs.map((s) => (s.kind === 'tool' && s.id === ev.id ? { ...s, done: true } : s)),
        )
      } else if (ev.type === 'usage') {
        // Cumulative snapshot for the in-flight run — overlay the climbing total on the baseline.
        setRunUsage({ tokens: ev.promptTokens + ev.completionTokens, costUsd: ev.costUsd })
      } else if (ev.type === 'done' || ev.type === 'cancelled') {
        terminalSeenRef.current = true
        if (ev.type === 'cancelled') {
          // The cancel route's cascade already resolved any pending interaction (§10.9
          // invariant 4), so an open approval/question card must not linger; and any straggler
          // events the worker flushes after this are dropped (see the guard above).
          cancelledRef.current = true
          setApproval(null)
          setQuestion(null)
          setQSelected([])
          setQFreeform('')
          setQOther(false)
          // loadHistory clears the live segments once the durable turns arrive (one render).
          setBusy(false)
          // Time-bound the straggler guard: stragglers flush within the same tick as the cancel
          // NOTIFY, so by the time this reload round-trips they're gone — and a run started
          // afterwards from another tab/device must stream normally in this tab.
          void loadHistory().then(() => {
            cancelledRef.current = false
          })
        } else {
          setBusy(false)
          void loadHistory()
        }
        reconcileUsage()
      } else if (ev.type === 'title') {
        // The worker's auto-generated title (sent after the first run names an untitled
        // conversation) — same path /rename uses: updates the header + bumps the sidebar reload.
        onTitleChange(ev.title)
      } else if (ev.type === 'error') {
        terminalSeenRef.current = true
        setLiveSegments([])
        setBusy(false)
        setHistory((h) => [
          ...h,
          { role: 'assistant', content: [{ type: 'text', text: `⚠️ ${ev.message}` }] },
        ])
        // A failed run may still have made (and rolled up) paid calls before erroring.
        reconcileUsage()
      } else if (ev.type === 'interaction_required') {
        // Same fetch for both kinds (the row carries the prompt); branch only on what state
        // the resolved prompt populates — approval card vs question card.
        const { interactionId, kind } = ev
        fetch(`/api/interactions/${interactionId}`)
          .then(
            (r) =>
              r.json() as Promise<{
                interaction: { prompt: QuestionPrompt | ApprovalPrompt; status: string }
              }>,
          )
          .then((d) => {
            // A late NOTIFY (cancel cascade, timeout, another ingress answering first) can land
            // after the row is already terminal — never render a card for a non-pending row.
            if (d.interaction.status !== 'pending') return
            if (kind === 'question') {
              setQuestion({ interactionId, prompt: d.interaction.prompt as QuestionPrompt })
              setQSelected([])
              setQFreeform('')
              setQOther(false)
            } else {
              setApproval({ interactionId, prompt: d.interaction.prompt as ApprovalPrompt })
              setRemember(false)
            }
          })
          .catch(() => {})
      } else if (ev.type === 'interaction_resolved') {
        setApproval(null)
        setQuestion(null)
        setQSelected([])
        setQFreeform('')
        setQOther(false)
      }
    }
    return () => es.close()
  }, [conversationId])

  // Refresh-proof busy + footer baseline: if the conversation already has an active run (the page
  // was refreshed mid-run), restore the busy state — the disabled composer, the thinking
  // placeholder, and crucially the Stop button, the owner's only way to free a conversation stuck
  // behind the one-active-run index. The same meta fetch seeds baseUsage. Mount-time is enough
  // (the component remounts per conversation via key); a run that finished between this fetch and
  // the EventSource opening (a missed 'done') self-heals via Stop's 409 path. loadMeta's busy
  // restore is itself terminalSeenRef-guarded so a stale "active" snapshot can't re-set busy.
  useEffect(() => {
    const ac = new AbortController()
    void loadMeta(ac.signal)
    return () => ac.abort()
  }, [loadMeta])

  // Keep the latest turn in view as messages arrive and tokens stream in. Instant (not smooth)
  // so it reliably tracks fast token updates; only pins when the user is already at the bottom,
  // so scrolling up to read isn't fought. Shared with ChatImage.onSettled (below) so an image
  // that grows the content after layout re-pins too — stick is a ref, so it always reads live.
  const pinToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [])
  useEffect(pinToBottom, [history, liveSegments, busy, approval, question, pending, pinToBottom])

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

  // Append a transient, local-only system line (e.g. command feedback). Never persisted —
  // gone on reload, matching how ⚠️ errors are pushed locally today.
  const pushSystemNote = (text: string) =>
    setHistory((h) => [...h, { role: 'system', content: [{ type: 'text', text }] }])

  const send = async () => {
    const text = input.trim()
    // A leading-/ line is a command: forward the raw line to the central command endpoint,
    // render the feedback as a transient system note, and never create a message or run.
    if (text.startsWith('/')) {
      setInput('')
      const res = await fetch(`/api/conversations/${conversationId}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: text }),
      })
      const r = (await res.json().catch(() => ({}))) as {
        note?: string
        error?: string
        conversation?: { title: string }
        action?: 'speak'
      }
      if (r.conversation?.title) onTitleChange(r.conversation.title)
      // The `speak` command returns an action directive instead of a note: open the read-out
      // stream (don't also push note/error — the directive IS the result). The "🔊 Speaking…" /
      // "nothing to read" feedback is pushed inside speakLastReply once the route responds.
      if (r.action === 'speak') {
        void speakLastReply()
        return
      }
      pushSystemNote(r.note ?? r.error ?? 'Command failed')
      return
    }
    const attachments = pending
    if ((!text && attachments.length === 0) || busy) return
    setInput('')
    setPending([])
    cancelledRef.current = false // a fresh run — its live events count again
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

  // Read out the last assistant reply (the /speak command). POSTs to the streaming route, reads
  // its NDJSON body, and plays the returned clips through ONE ordered HTMLAudioElement queue (next
  // clip plays on the previous one's 'ended'). Clips arrive in seq order on the stream, so they're
  // enqueued and played in arrival order. A fresh /speak bumps the epoch, stopping the prior
  // playback before this one starts; an { error } line surfaces a system note and stops.
  const speakLastReply = async () => {
    const epoch = ++speakEpochRef.current
    // Stop any audio still playing from a prior /speak in this conversation.
    speakAudioRef.current?.pause()
    speakAudioRef.current = null

    // FIFO queue of clip paths + a single advancing player. playNext pulls the head and plays it;
    // 'ended'/'error' advances. `playing` guards against starting a second element while one is
    // active. `gotClip` tracks whether anything actually played, so an error reports honestly.
    const queue: string[] = []
    let playing = false
    let gotClip = false
    const advance = (audio: HTMLAudioElement) => {
      // Drop both listeners off the finished element before moving on, so a read-out (especially
      // one with failing clips) doesn't accumulate dangling listeners holding the closure alive.
      audio.removeEventListener('ended', onClipDone)
      audio.removeEventListener('error', onClipDone)
      playNext()
    }
    function onClipDone(this: HTMLAudioElement) {
      advance(this)
    }
    const playNext = () => {
      if (epoch !== speakEpochRef.current) return // a newer /speak superseded this one
      const path = queue.shift()
      if (!path) {
        playing = false
        speakAudioRef.current = null
        return
      }
      playing = true
      const audio = new Audio(`/media/${conversationId}/${path}`)
      speakAudioRef.current = audio
      audio.addEventListener('ended', onClipDone)
      // A clip that fails to load/play shouldn't stall the queue — advance past it.
      audio.addEventListener('error', onClipDone)
      void audio.play().catch(() => {})
    }
    const enqueue = (path: string) => {
      gotClip = true
      queue.push(path)
      if (!playing) playNext()
    }

    try {
      const res = await fetch(`/api/conversations/${conversationId}/speak`, { method: 'POST' })
      if (!res.ok || !res.body) {
        // 422 = nothing to read out (a neutral note, not an error); anything else is a failure.
        const { error } = (await res.json().catch(() => ({}))) as { error?: string }
        if (epoch === speakEpochRef.current) {
          pushSystemNote(res.status === 422 ? (error ?? 'Nothing to read out yet.') : `⚠️ ${error ?? 'Could not read that out.'}`)
        }
        return
      }
      if (epoch === speakEpochRef.current) pushSystemNote('🔊 Speaking…')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      // Parse newline-delimited JSON: accumulate, split on '\n', handle each complete line, keep
      // the trailing partial in the buffer for the next chunk; flush whatever remains at EOF.
      const handleLine = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let msg: { seq?: number; path?: string; mimeType?: string; error?: string }
        try {
          msg = JSON.parse(trimmed)
        } catch {
          return // a malformed line shouldn't abort the read-out
        }
        if (msg.error) {
          // "Some of that" only if at least one clip played; otherwise nothing was read out.
          if (epoch === speakEpochRef.current) {
            pushSystemNote(gotClip ? '⚠️ Some of that could not be read out.' : '⚠️ Could not read that out.')
          }
          return
        }
        if (msg.path) enqueue(msg.path)
      }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (epoch !== speakEpochRef.current) {
          // A newer /speak superseded this one — stop reading and let it own playback.
          void reader.cancel().catch(() => {})
          return
        }
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
        }
      }
      handleLine(buf)
    } catch {
      if (epoch === speakEpochRef.current) pushSystemNote('⚠️ Could not read that out.')
    }
  }

  // Stop button: cancel the conversation's active run via the route (which owns the
  // `cancelled` transition + cascade). On 200 nothing is cleared here — the SSE
  // { type: 'cancelled' } event does the teardown, so every connected client converges the
  // same way. On 409 the run finished (or failed) just before the click: self-heal by
  // clearing busy + reloading, which also rescues a stuck-busy state (e.g. a 'done' missed
  // between the mount-time activeRun fetch and the EventSource opening).
  const cancelRun = async () => {
    if (cancelling) return
    setCancelling(true)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/cancel`, { method: 'POST' })
      if (res.status === 409) {
        setBusy(false)
        void loadHistory()
      }
    } catch {
      // Network failure: leave state as-is — the Stop button re-enables for another try.
    } finally {
      setCancelling(false)
    }
  }

  const resolveApproval = async (approved: boolean) => {
    if (!approval) return
    const { interactionId, prompt } = approval
    // Mirror the Tools page's guard before persisting "never ask" on a destructive tool.
    if (approved && remember && prompt?.trust_tier === 'destructive') {
      const ok = window.confirm(
        `Stop asking for approval on "${prompt.tool}"? It can take destructive actions, and Alfred will run it without checking from now on.`,
      )
      if (!ok) return
    }
    const rememberChoice = approved && remember
    setApproval(null)
    setRemember(false)
    await fetch(`/api/interactions/${interactionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved, remember: rememberChoice }),
    }).catch(() => {})
  }

  // Pick a listed option. Single-select replaces the selection and clears the "Other" choice
  // (they're mutually exclusive); multi-select adds/removes and leaves "Other" alone.
  const toggleQOption = (label: string, multi: boolean) => {
    setQSelected((s) =>
      multi ? (s.includes(label) ? s.filter((l) => l !== label) : [...s, label]) : [label],
    )
    if (!multi) setQOther(false)
  }

  // The "Other" checkbox/radio: single-select makes it exclusive (clears any picked option);
  // multi-select toggles it alongside the options.
  const toggleQOther = (multi: boolean) => {
    setQOther((o) => (multi ? !o : true))
    if (!multi) setQSelected([])
  }
  // Typing in the free-text box selects "Other" (never deselects, so a keystroke can't toggle
  // it off); single-select clears any picked option.
  const ensureQOther = (multi: boolean) => {
    setQOther(true)
    if (!multi) setQSelected([])
  }

  const resolveQuestion = async () => {
    if (!question) return
    const { interactionId, prompt } = question
    // The free text counts only when it's the active choice: a pure free-form question (no
    // options) or the "Other" option is selected. Otherwise the answer is the picked option(s).
    const otherActive = (prompt.options ?? []).length === 0 || qOther
    const selected_labels = qSelected
    const freeform_text = otherActive ? qFreeform.trim() : ''
    setQuestion(null)
    setQSelected([])
    setQFreeform('')
    setQOther(false)
    await fetch(`/api/interactions/${interactionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selected_labels, freeform_text }),
    }).catch(() => {})
  }

  // --- Slash-command autocomplete (derived from the live input) ---
  // The leading `/command` token, or null when the input isn't a bare command (no `/`, or a
  // space has been typed → now composing args). An empty token (input === '/') matches all.
  const cmdMatch = input.match(/^\/(\S*)$/)
  const cmdToken = cmdMatch ? (cmdMatch[1] ?? '').toLowerCase() : null
  const cmdMatches =
    cmdToken === null
      ? []
      : commands.filter(
          (c) => c.name.startsWith(cmdToken) || c.aliases.some((a) => a.startsWith(cmdToken)),
        )
  const showCommands = !cmdDismissed && !busy && cmdMatches.length > 0
  const activeCmd = Math.min(cmdIndex, cmdMatches.length - 1)

  // Replace the input with the chosen command, leaving a trailing space when it takes args
  // (its usage shows a `<placeholder>`) so the caret lands ready to type them; close the menu.
  const acceptCommand = (cmd: CommandInfo) => {
    setInput(`/${cmd.name}${cmd.usage.includes('<') ? ' ' : ''}`)
    setCmdDismissed(true)
    setCmdIndex(0)
    messageInputRef.current?.focus()
  }

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showCommands) return // no menu → let Enter submit and Tab move focus normally
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCmdIndex((i) => (Math.min(i, cmdMatches.length - 1) + 1) % cmdMatches.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCmdIndex(
        (i) => (Math.min(i, cmdMatches.length - 1) - 1 + cmdMatches.length) % cmdMatches.length,
      )
    } else if (e.key === 'Enter') {
      e.preventDefault() // accept the highlighted command rather than submitting the form
      acceptCommand(cmdMatches[activeCmd]!)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setCmdDismissed(true)
    }
    // Tab is intentionally NOT intercepted: it falls through to normal focus movement so a
    // keyboard user can always tab out of the composer (the resulting blur closes the menu).
  }

  const empty = history.length === 0 && liveSegments.length === 0

  // Footer total = the rolled-up baseline (completed runs) + the in-flight run's live overlay.
  // Hidden when both are 0 (a brand-new conversation shows nothing).
  const totalTokens = baseUsage.tokens + (runUsage?.tokens ?? 0)
  const totalCost = baseUsage.costUsd + (runUsage?.costUsd ?? 0)

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
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          style={{ animation: 'alfred-rise 0.15s ease-out' }}
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
        >
          <img
            src={lightbox}
            alt="attachment full size"
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="Close"
            className="absolute right-5 top-5 rounded-full bg-surface/90 px-3 py-1.5 text-sm text-ink transition-colors hover:bg-surface"
          >
            ✕ Esc
          </button>
        </div>
      )}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-5 py-6">
        {empty && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-2xl font-medium text-ink-dim">Good day, Ingvar.</p>
            <p className="mt-2 text-sm text-muted">How may I be of service?</p>
          </div>
        )}
        <div className="mx-auto flex max-w-xl flex-col gap-5">
          {history.map((m, i) =>
            // A transient command note (local-only, never persisted) — a quiet, centered
            // system line, not an Alfred bubble (it isn't Alfred talking).
            m.role === 'system' ? (
              <p
                key={m.id ?? i}
                className="whitespace-pre-wrap text-center text-xs text-muted"
                style={{ animation: 'alfred-rise 0.25s ease-out' }}
              >
                {textOf(m.content)}
              </p>
            ) : // Tool-result messages are shown only when they carry an image (a screenshot /
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
                onOpenImage={setLightbox}
                onImageSettled={pinToBottom}
              />
            ),
          )}
          {/* One cohesive live Alfred block while the run is working: a single ALFRED header,
              then the ordered segments (streamed text + accumulating tool chips, finished chips
              just stop pulsing), then the 3 dots always last. Stays mounted until loadHistory
              clears liveSegments in one render (done/cancelled) — gating on busy alone would
              blank the block during the async reload, so the durable bubbles swap in with no gap.
              The dots are gated on busy so they stop the instant the run ends. */}
          {(busy || liveSegments.length > 0) && (
            <div className="flex flex-col gap-1" style={{ animation: 'alfred-rise 0.25s ease-out' }}>
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-brass">
                Alfred
              </span>
              {liveSegments.map((seg, i) =>
                seg.kind === 'text' ? (
                  seg.text && (
                    <div key={`t${i}`} className="max-w-[92%]">
                      <Markdown
                        text={seg.text}
                        onImageSettled={pinToBottom}
                        onOpenImage={setLightbox}
                      />
                    </div>
                  )
                ) : (
                  <div key={seg.id} className="flex flex-wrap gap-1.5 pt-0.5">
                    <ToolChip name={seg.name} args={seg.args} live={!seg.done} />
                  </div>
                ),
              )}
              {/* Dots are always the last element while the run is still working; they stop
                  the moment busy clears (done/cancelled), while the content above stays put
                  until loadHistory swaps in the durable bubbles. */}
              {busy && (
                <div className="flex gap-1 py-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="h-1.5 w-1.5 rounded-full bg-brass"
                      style={{ animation: `alfred-blink 1.2s ease-in-out ${i * 0.18}s infinite` }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
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
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink-dim">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 accent-brass"
              />
              {approval.prompt?.scope === 'group'
                ? "Don't ask again for these actions (remembered until you change it on the Tools page)"
                : `Don't ask again for ${approval.prompt?.tool ?? 'this tool'} (remembered until you change it on the Tools page)`}
            </label>
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

      {question &&
        (() => {
          const multi = question.prompt.multi_select === true
          const options = question.prompt.options ?? []
          const allowFreeform = question.prompt.allow_freeform !== false
          const hasOptions = options.length > 0
          // With options present, the free text is the "Other" choice (qOther gates it); with
          // no options it IS the answer. Free text only counts toward canSubmit when active.
          const otherActive = !hasOptions || qOther
          const canSubmit =
            qSelected.length > 0 || (otherActive && qFreeform.trim().length > 0)
          return (
            <form
              className="px-5 pb-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (canSubmit) void resolveQuestion()
              }}
            >
              <div className="mx-auto max-w-xl rounded-2xl border border-brass/40 bg-paper-raised p-4 shadow-lg">
                <p className="text-base font-medium text-ink">{question.prompt.question}</p>
                {hasOptions && (
                  <div className="mt-3 flex flex-col gap-2">
                    {options.map((opt) => (
                      <label
                        key={opt.label}
                        className="flex cursor-pointer items-start gap-2 text-sm text-ink-dim"
                      >
                        <input
                          type={multi ? 'checkbox' : 'radio'}
                          name="question-option"
                          checked={qSelected.includes(opt.label)}
                          onChange={() => toggleQOption(opt.label, multi)}
                          className="mt-0.5 h-4 w-4 accent-brass"
                        />
                        <span>
                          <span className="text-ink">{opt.label}</span>
                          {opt.description && (
                            <span className="block text-xs text-muted">{opt.description}</span>
                          )}
                        </span>
                      </label>
                    ))}
                    {/* The free text as an explicit "Other" choice: its radio/checkbox shares
                        the option group, and typing selects it (single-select clears any option). */}
                    {allowFreeform && (
                      <div className="flex items-start gap-2 text-sm text-ink-dim">
                        <input
                          type={multi ? 'checkbox' : 'radio'}
                          name="question-option"
                          checked={qOther}
                          onChange={() => toggleQOther(multi)}
                          className="mt-0.5 h-4 w-4 accent-brass"
                          aria-label="Other"
                        />
                        <input
                          className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-muted focus:border-brass/60"
                          placeholder="Type your own answer…"
                          value={qFreeform}
                          onChange={(e) => {
                            setQFreeform(e.target.value)
                            ensureQOther(multi)
                          }}
                          onFocus={() => ensureQOther(multi)}
                        />
                      </div>
                    )}
                  </div>
                )}
                {!hasOptions && allowFreeform && (
                  <input
                    className="mt-3 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-muted focus:border-brass/60"
                    placeholder="Type an answer…"
                    value={qFreeform}
                    onChange={(e) => setQFreeform(e.target.value)}
                  />
                )}
                <div className="mt-4 flex gap-2">
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="rounded-full bg-brass px-5 py-2 font-medium text-paper transition-colors hover:bg-brass-soft disabled:opacity-30"
                  >
                    Submit
                  </button>
                </div>
              </div>
            </form>
          )
        })()}

      {/* A thin muted status row above the composer showing the cumulative token + USD cost footer
          (climbing live during a run), right-aligned. Hidden until there's something to show. */}
      {(totalTokens > 0 || totalCost > 0) && (
        <div className="px-5">
          <div className="mx-auto flex max-w-xl items-center justify-end gap-3 text-xs text-muted">
            <span className="tabular-nums">
              {fmtTokens(totalTokens)} tokens · {usd(totalCost)}
            </span>
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
        <div className="relative mx-auto flex max-w-xl flex-col gap-2">
          {/* Slash-command autocomplete: floats above the composer (bottom-full) so it grows
              upward without shifting the input. The ul's mousedown is prevented so pressing a
              suggestion doesn't blur the input, and each row selects on mousedown (below) rather
              than click — so the action fires before any blur, closing the desktop+touch race. */}
          {showCommands && (
            <ul
              id="command-suggestions"
              role="listbox"
              onMouseDown={(e) => e.preventDefault()}
              className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-2xl border border-line bg-paper-raised py-1 shadow-lg"
              style={{ animation: 'alfred-rise 0.12s ease-out' }}
            >
              {cmdMatches.map((cmd, i) => (
                <li
                  key={cmd.name}
                  role="option"
                  aria-selected={i === activeCmd}
                  onMouseEnter={() => setCmdIndex(i)}
                  onMouseDown={() => acceptCommand(cmd)}
                  className={`flex cursor-pointer items-baseline gap-2 px-4 py-2 ${
                    i === activeCmd ? 'bg-surface' : ''
                  }`}
                >
                  <span className="font-mono text-sm text-brass">{cmd.usage}</span>
                  {cmd.aliases.length > 0 && (
                    <span className="font-mono text-xs text-muted">
                      /{cmd.aliases.join(', /')}
                    </span>
                  )}
                  <span className="ml-auto truncate pl-3 text-xs text-muted">
                    {cmd.description}
                  </span>
                </li>
              ))}
            </ul>
          )}
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
              ref={messageInputRef}
              className="flex-1 bg-transparent px-1 py-2 text-ink outline-none placeholder:text-muted"
              placeholder={busy ? 'Alfred is attending to this…' : 'Message Alfred…'}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                // Un-dismiss so the menu can show again (it only actually shows when the value is
                // a bare `/command` token — see cmdMatches), and reset the highlight to the top so
                // filtering always starts from the first match.
                setCmdDismissed(false)
                setCmdIndex(0)
              }}
              onKeyDown={onInputKeyDown}
              onBlur={() => setCmdDismissed(true)}
              disabled={busy}
              autoComplete="off"
              role="combobox"
              aria-expanded={showCommands}
              aria-controls="command-suggestions"
            />
            {busy ? (
              /* While a run is active the composer's action is Stop — type="button" so it
                 never submits the form. Disabled only while the cancel POST is in flight. */
              <button
                type="button"
                onClick={() => void cancelRun()}
                disabled={cancelling}
                className="rounded-full bg-brass px-4 py-2 text-sm font-medium text-paper transition-colors hover:bg-brass-soft disabled:opacity-30"
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() && pending.length === 0}
                className="rounded-full bg-brass px-4 py-2 text-sm font-medium text-paper transition-colors hover:bg-brass-soft disabled:opacity-30"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </form>
    </>
  )
}

// A markdown-embedded image (`![](url)`). NOT auto-loaded: the URL is shown as a click-to-load
// chip first, so an assistant message carrying email/web-sourced content (ARCHITECTURE §16)
// can't silently beacon a tracking pixel to an attacker-chosen host on render. Once loaded it's
// width-constrained, lightbox-clickable, and fires onSettled so a late-laying-out image re-pins
// the scroll (the markdown <img> otherwise bypasses ChatImage's onSettled wiring).
function MarkdownImage({
  src,
  alt,
  onSettled,
  onOpen,
}: {
  src?: string
  alt?: string
  onSettled?: () => void
  onOpen?: (src: string) => void
}) {
  const [loaded, setLoaded] = useState(false)
  if (!src) return null
  if (!loaded) {
    let host = src
    try {
      host = new URL(src).host
    } catch {
      /* keep the raw src if it isn't a parseable URL */
    }
    return (
      <button
        type="button"
        onClick={() => setLoaded(true)}
        className="my-2 inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-dim transition-colors hover:border-brass/40 hover:text-ink"
      >
        <span aria-hidden>🖼</span>
        <span className="truncate">Load image{alt ? `: ${alt}` : ''}</span>
        <span className="shrink-0 text-muted">{host}</span>
      </button>
    )
  }
  return (
    <img
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      onLoad={onSettled}
      onError={onSettled}
      onClick={onOpen ? () => onOpen(src) : undefined}
      className={`my-2 max-h-72 max-w-full rounded-xl border border-line object-contain${
        onOpen ? ' cursor-zoom-in transition-opacity hover:opacity-90' : ''
      }`}
    />
  )
}

// Renders Alfred's message text as GitHub-flavored markdown (lists, tables, code, links, …),
// themed to the espresso/brass palette. react-markdown never renders raw HTML (no rehype-raw),
// so model/email-sourced content can't inject markup — XSS-safe by construction. Block elements
// carry their own vertical margins; the wrapper zeroes the first/last so spacing is tight. Used
// for assistant text only (user + system lines stay plain). Streaming partial markdown renders
// fine — react-markdown emits what it can parse so far. memo'd so an unchanged text segment
// (an earlier finished segment, or any durable bubble) doesn't re-parse when the parent
// re-renders — only the actively-streaming trailing segment re-parses per token.
const Markdown = memo(function Markdown({
  text,
  onImageSettled,
  onOpenImage,
}: {
  text: string
  onImageSettled?: () => void
  onOpenImage?: (src: string) => void
}) {
  return (
    <div className="leading-relaxed text-ink [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brass underline decoration-brass/40 underline-offset-2 transition-colors hover:decoration-brass"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          // GFM task-list items carry a `task-list-item` class and render a checkbox; drop the
          // disc marker on those so the bullet doesn't double up with the checkbox.
          li: ({ children, className }) => (
            <li
              className={`pl-0.5 marker:text-muted${
                className?.includes('task-list-item') ? ' list-none' : ''
              }`}
            >
              {children}
            </li>
          ),
          // GFM task-list checkbox — themed to the brass accent (it's disabled/read-only, just a marker).
          input: ({ type, checked }) =>
            type === 'checkbox' ? (
              <input
                type="checkbox"
                checked={!!checked}
                readOnly
                disabled
                className="mr-1.5 align-middle accent-brass"
                aria-hidden
              />
            ) : null,
          h1: ({ children }) => <h1 className="my-3 text-xl font-semibold text-ink">{children}</h1>,
          h2: ({ children }) => <h2 className="my-3 text-lg font-semibold text-ink">{children}</h2>,
          h3: ({ children }) => (
            <h3 className="my-2 text-base font-semibold text-ink">{children}</h3>
          ),
          h4: ({ children }) => <h4 className="my-2 font-semibold text-ink">{children}</h4>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-brass/40 pl-3 text-ink-dim">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-line" />,
          // Inline code; block code (inside <pre>) gets bg/padding/color reset by the <pre> below,
          // and `[&>code]:text-xs` there restores a readable size (else 0.85em × text-xs ≈ 10px).
          code: ({ children }) => (
            <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-[0.85em] text-brass-soft">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-lg bg-surface p-3 font-mono text-xs text-ink-dim [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-xs [&>code]:text-ink-dim">
              {children}
            </pre>
          ),
          img: ({ src, alt }) => (
            <MarkdownImage
              src={typeof src === 'string' ? src : undefined}
              alt={alt}
              onSettled={onImageSettled}
              onOpen={onOpenImage}
            />
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-line bg-surface px-2 py-1 text-left font-semibold text-ink">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-line px-2 py-1 text-ink-dim">{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

function Bubble({
  role,
  conversationId,
  text,
  images = [],
  toolUses = [],
  showName = true,
  onOpenImage,
  onImageSettled,
}: {
  role: string
  conversationId: string
  text: string
  images?: ImagePart[]
  toolUses?: ToolUse[]
  showName?: boolean
  onOpenImage?: (src: string) => void
  onImageSettled?: () => void
}) {
  const isUser = role === 'user'
  if (isUser) {
    return (
      <div className="flex justify-end" style={{ animation: 'alfred-rise 0.25s ease-out' }}>
        <div className="flex max-w-[85%] flex-col items-end gap-2">
          {images.map((img) => (
            <ChatImage
              key={img.path}
              conversationId={conversationId}
              path={img.path}
              onOpen={onOpenImage}
              onSettled={onImageSettled}
            />
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
        <div className="max-w-[92%]">
          <Markdown text={text} onImageSettled={onImageSettled} onOpenImage={onOpenImage} />
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-0.5">
          {images.map((img) => (
            <ChatImage
              key={img.path}
              conversationId={conversationId}
              path={img.path}
              onOpen={onOpenImage}
              onSettled={onImageSettled}
            />
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

// An image served from the conversation workspace via the webserver's /media route. Click to
// open it full-size in the lightbox (onOpen lifted to Chat so the overlay covers the viewport).
function ChatImage({
  conversationId,
  path,
  onOpen,
  onSettled,
}: {
  conversationId: string
  path: string
  onOpen?: (src: string) => void
  // Fired once the image has laid out (load or error) so a late-growing image can re-pin
  // the scroll to the bottom (the handler itself honors the stick guard — no yank if scrolled up).
  onSettled?: () => void
}) {
  const src = `/media/${conversationId}/${path}`
  return (
    <img
      src={src}
      alt="attachment"
      loading="lazy"
      onLoad={onSettled}
      onError={onSettled}
      onClick={onOpen ? () => onOpen(src) : undefined}
      className={`max-h-72 max-w-full rounded-xl border border-line object-contain${
        onOpen ? ' cursor-zoom-in transition-opacity hover:opacity-90' : ''
      }`}
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
