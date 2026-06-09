import { useEffect, useState } from 'react'
import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import Chat from './Chat'
import Debug from './Debug'
import Tools from './Tools'

const CONVERSATION_KEY = 'alfred.conversationId'

function currentConversationId(): string {
  let id = localStorage.getItem(CONVERSATION_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(CONVERSATION_KEY, id)
  }
  return id
}

export default function App() {
  // Lifted so the header's "New" button can swap the active conversation.
  const [conversationId, setConversationId] = useState(currentConversationId)
  // The active conversation's title, shown in the header. Fetched on id change and updated
  // in place by a successful /rename (via Chat's onTitleChange) — no refetch.
  const [title, setTitle] = useState<string | null>(null)

  // Fetch the title whenever the conversation changes. Race-safe: a stale response (the id
  // changed before this fetch resolved) is dropped via the ignore flag.
  useEffect(() => {
    let ignore = false
    fetch(`/api/conversations/${conversationId}`)
      .then((r) => r.json() as Promise<{ title: string | null }>)
      .then((d) => {
        if (!ignore) setTitle(d.title ?? null)
      })
      .catch(() => {})
    return () => {
      ignore = true
    }
  }, [conversationId])

  const newConversation = () => {
    const id = crypto.randomUUID()
    localStorage.setItem(CONVERSATION_KEY, id)
    setConversationId(id)
    setTitle(null)
  }

  return (
    <BrowserRouter>
      <div className="flex h-full flex-col">
        <Header onNew={newConversation} title={title} />
        <main className="flex min-h-0 flex-1 flex-col">
          <Routes>
            {/* key remounts Chat on a fresh id, so its state starts clean. */}
            <Route
              path="/"
              element={
                <Chat key={conversationId} conversationId={conversationId} onTitleChange={setTitle} />
              }
            />
            <Route path="/tools" element={<Tools />} />
            <Route path="/debug" element={<Debug />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

function Header({ onNew, title }: { onNew: () => void; title: string | null }) {
  const onChat = useLocation().pathname === '/'
  return (
    <header className="flex items-center gap-5 border-b border-line px-5 py-4">
      <div className="flex shrink-0 items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight text-ink">Alfred</span>
        <span className="hidden text-xs text-muted sm:inline">at your service</span>
      </div>
      <nav className="flex shrink-0 gap-4 text-sm">
        <NavLink
          to="/"
          className={({ isActive }) =>
            isActive ? 'text-brass' : 'text-muted transition-colors hover:text-ink'
          }
        >
          Chat
        </NavLink>
        <NavLink
          to="/tools"
          className={({ isActive }) =>
            isActive ? 'text-brass' : 'text-muted transition-colors hover:text-ink'
          }
        >
          Tools
        </NavLink>
        <NavLink
          to="/debug"
          className={({ isActive }) =>
            isActive ? 'text-brass' : 'text-muted transition-colors hover:text-ink'
          }
        >
          Debug
        </NavLink>
      </nav>
      {onChat && (
        <span className={`min-w-0 flex-1 truncate text-sm ${title ? 'text-muted' : 'text-muted/60'}`}>
          {title ?? 'New conversation'}
        </span>
      )}
      {onChat && (
        <button
          type="button"
          onClick={onNew}
          className="shrink-0 rounded-full border border-line px-3 py-1.5 text-sm text-ink-dim transition-colors hover:border-brass hover:text-brass"
        >
          + New conversation
        </button>
      )}
    </header>
  )
}
