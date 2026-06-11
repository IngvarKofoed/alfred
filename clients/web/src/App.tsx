import { useEffect, useState } from 'react'
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom'
import Chat from './Chat'
import Debug from './Debug'
import Sidebar from './Sidebar'
import Tools from './Tools'

const CONVERSATION_KEY = 'alfred.conversationId'

// Mirrors the server's uuid validation — used to vet the localStorage redirect hint before
// trusting it as a route target.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/conversation/:id" element={<ChatPage />} />
        <Route path="/tools" element={<Shell nav="tools" body={<Tools />} />} />
        <Route path="/debug" element={<Shell nav="debug" body={<Debug />} />} />
        {/* Catch-all behaves like `/`: redirect to a resolved conversation. */}
        <Route path="*" element={<RootRedirect />} />
      </Routes>
    </BrowserRouter>
  )
}

// `/` (and the catch-all) is redirect-only. Target, in order: (1) a valid localStorage hint —
// checked synchronously so there's no flicker; (2) the newest conversation from the list; (3) a
// freshly minted uuid. We only hit the network when the synchronous hint is absent/invalid.
function RootRedirect() {
  const [target, setTarget] = useState<string | null>(() => {
    const hint = localStorage.getItem(CONVERSATION_KEY)
    return hint && UUID_RE.test(hint) ? hint : null
  })

  useEffect(() => {
    if (target) return
    let ignore = false
    fetch('/api/conversations')
      .then((r) => r.json() as Promise<{ conversations: { id: string }[] }>)
      .then((d) => {
        if (ignore) return
        setTarget(d.conversations?.[0]?.id ?? crypto.randomUUID())
      })
      .catch(() => {
        if (!ignore) setTarget(crypto.randomUUID())
      })
    return () => {
      ignore = true
    }
  }, [target])

  if (!target) return <main className="flex min-h-0 flex-1 flex-col" />
  return <Navigate to={`/conversation/${target}`} replace />
}

// The chat surface: header + sidebar + Chat, all keyed on the route param. Owns the title
// state and a numeric list-reload signal the Sidebar watches.
function ChatPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [title, setTitle] = useState<string | null>(null)
  // Bumped on a successful /rename so the sidebar refetches its list (and picks up the new
  // title). Also re-fetched by the sidebar on id change and mount.
  const [listReload, setListReload] = useState(0)
  // Mobile drawer open/close, lifted here so the header button can toggle the Sidebar overlay.
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Record the active conversation as the redirect hint for `/`.
  useEffect(() => {
    if (id) localStorage.setItem(CONVERSATION_KEY, id)
  }, [id])

  // The route changed — start the title blank and close any open drawer.
  useEffect(() => {
    setTitle(null)
    setDrawerOpen(false)
  }, [id])

  // Fetch the active conversation's title on id change. Race-safe: a stale response (the id
  // changed before this fetch resolved) is dropped via the ignore flag.
  useEffect(() => {
    if (!id) return
    let ignore = false
    fetch(`/api/conversations/${id}`)
      .then((r) => r.json() as Promise<{ title: string | null }>)
      .then((d) => {
        if (!ignore) setTitle(d.title ?? null)
      })
      .catch(() => {})
    return () => {
      ignore = true
    }
  }, [id])

  const newConversation = () => {
    const next = crypto.randomUUID()
    localStorage.setItem(CONVERSATION_KEY, next)
    navigate(`/conversation/${next}`)
  }

  // A successful /rename updates the header in place and signals the sidebar to refetch.
  const onTitleChange = (t: string) => {
    setTitle(t)
    setListReload((n) => n + 1)
  }

  return (
    <div className="flex h-full flex-col">
      <Header
        nav="chat"
        title={title}
        onNew={newConversation}
        onToggleSidebar={() => setDrawerOpen((v) => !v)}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          activeId={id}
          activeTitle={title}
          reloadKey={listReload}
          drawerOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* key remounts Chat on a fresh id, so its state starts clean. */}
          <Chat key={id} conversationId={id} onTitleChange={onTitleChange} />
        </main>
      </div>
    </div>
  )
}

// Non-chat routes (/tools, /debug): header + page, no sidebar.
function Shell({ nav, body }: { nav: NavKey; body: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <Header nav={nav} />
      <main className="flex min-h-0 flex-1 flex-col">{body}</main>
    </div>
  )
}

type NavKey = 'chat' | 'tools' | 'debug'

function Header({
  nav,
  title,
  onNew,
  onToggleSidebar,
}: {
  nav: NavKey
  title?: string | null
  onNew?: () => void
  onToggleSidebar?: () => void
}) {
  const onChat = nav === 'chat'
  // NavLink can't drive the active style here (the chat lives at /conversation/:id, not /),
  // so the active route is passed in explicitly.
  const linkClass = (active: boolean) =>
    active ? 'text-brass' : 'text-muted transition-colors hover:text-ink'

  return (
    <header className="flex items-center gap-5 border-b border-line px-5 py-4">
      {onChat && (
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Toggle conversations"
          className="shrink-0 text-muted transition-colors hover:text-ink md:hidden"
        >
          ☰
        </button>
      )}
      <div className="flex shrink-0 items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight text-ink">Alfred</span>
        <span className="hidden text-xs text-muted sm:inline">at your service</span>
      </div>
      <nav className="flex shrink-0 gap-4 text-sm">
        <NavLink to="/" className={linkClass(nav === 'chat')}>
          Chat
        </NavLink>
        <NavLink to="/tools" className={linkClass(nav === 'tools')}>
          Tools
        </NavLink>
        <NavLink to="/debug" className={linkClass(nav === 'debug')}>
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
