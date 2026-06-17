import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

type ConversationRow = {
  id: string
  title: string | null
  ingress: string | null
  lastActiveAt: string | null
}

// The conversation rail on the chat surface. Fetches GET /api/conversations and refetches on
// mount, active-conversation change, and a parent-driven `reloadKey` bump (after a /rename).
// No SSE / no live reorder — slight staleness between sends is accepted (spec Non-goals).
export default function Sidebar({
  activeId,
  activeTitle,
  reloadKey,
  drawerOpen,
  onClose,
}: {
  // The conversation currently open (the route param) — its row is highlighted.
  activeId: string
  // The active conversation's title, used to render the transient top entry for a brand-new,
  // not-yet-saved conversation (one with no DB row yet, so absent from the fetched list).
  activeTitle: string | null
  // Bumped by the parent to force a refetch (e.g. after a successful /rename).
  reloadKey: number
  // Mobile drawer open/close, owned by the parent (header toggles it).
  drawerOpen: boolean
  onClose: () => void
}) {
  const [conversations, setConversations] = useState<ConversationRow[]>([])

  // Refetch on mount, active-conversation change, and reloadKey bump. Race-safe: a stale
  // response is dropped via the ignore flag (matches App's title effect).
  useEffect(() => {
    let ignore = false
    fetch('/api/conversations')
      .then((r) => r.json() as Promise<{ conversations: ConversationRow[] }>)
      .then((d) => {
        if (!ignore) setConversations(d.conversations ?? [])
      })
      .catch(() => {})
    return () => {
      ignore = true
    }
  }, [activeId, reloadKey])

  // A brand-new conversation has no DB row until its first message, so it's absent from the
  // list. Show it as a transient highlighted entry pinned at the top while it's the active id.
  const activeInList = conversations.some((c) => c.id === activeId)
  const transient: ConversationRow | null = activeInList
    ? null
    : { id: activeId, title: activeTitle, ingress: 'web', lastActiveAt: null }

  const rows = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {transient && (
        <Row key={transient.id} conversation={transient} active onNavigate={onClose} />
      )}
      {conversations.map((cv) => (
        <Row
          key={cv.id}
          conversation={cv}
          active={cv.id === activeId}
          onNavigate={onClose}
        />
      ))}
      {conversations.length === 0 && !transient && (
        <p className="px-4 py-6 text-center text-muted">No conversations yet.</p>
      )}
    </div>
  )

  const header = (
    <div className="flex items-center justify-between border-b border-line px-4 py-3">
      <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">
        Conversations
      </h2>
      <button
        onClick={onClose}
        aria-label="Close conversations"
        className="text-muted transition-colors hover:text-ink md:hidden"
      >
        ✕
      </button>
    </div>
  )

  return (
    <>
      {/* Persistent rail on md+ screens. */}
      <aside className="hidden w-72 min-h-0 shrink-0 flex-col border-r border-line bg-paper md:flex">
        {header}
        {rows}
      </aside>

      {/* Mobile overlay drawer. */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={onClose}
            aria-hidden="true"
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[80%] min-h-0 flex-col border-r border-line bg-paper shadow-xl">
            {header}
            {rows}
          </aside>
        </div>
      )}
    </>
  )
}

function Row({
  conversation,
  active,
  onNavigate,
}: {
  conversation: ConversationRow
  active: boolean
  // Called on click — closes the mobile drawer after navigating.
  onNavigate: () => void
}) {
  return (
    <Link
      to={`/conversation/${conversation.id}`}
      onClick={onNavigate}
      className={`block w-full border-b border-line/60 px-4 py-3 text-left transition-colors ${
        active
          ? 'border-l-2 border-l-brass bg-surface'
          : 'border-l-2 border-l-transparent hover:bg-paper-raised'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`truncate ${
            conversation.title ? 'font-medium' : 'italic'
          } ${active ? 'text-ink' : 'text-ink-dim'}`}
        >
          {conversation.title ?? 'New conversation'}
        </span>
        <span className="shrink-0 text-xs text-muted">{relTime(conversation.lastActiveAt)}</span>
      </div>
      {badgeLabel(conversation.ingress) && (
        <span className="mt-1 inline-block rounded-sm bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-brass">
          {badgeLabel(conversation.ingress)}
        </span>
      )}
    </Link>
  )
}

// A small tag so a watcher / voice thread is distinguishable in the unified list. 'discord' shows
// NO badge by owner request — Discord conversations belong in the list but don't need a "discord"
// tag. 'web' (and the transient new-chat row) shows none either.
function badgeLabel(ingress: string | null): string | null {
  switch (ingress) {
    case 'trigger':
      return 'watcher'
    case 'voice':
      return 'voice'
    default:
      return null
  }
}

// Compact relative time ("3m", "2h", "5d"), falling back to a date. Mirrors Debug's relTime
// shape (kept local — Debug.tsx is not refactored).
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
