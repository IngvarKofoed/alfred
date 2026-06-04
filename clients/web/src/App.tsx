import { useState } from 'react'
import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import Chat from './Chat'
import Debug from './Debug'

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

  const newConversation = () => {
    const id = crypto.randomUUID()
    localStorage.setItem(CONVERSATION_KEY, id)
    setConversationId(id)
  }

  return (
    <BrowserRouter>
      <div className="flex h-full flex-col">
        <Header onNew={newConversation} />
        <main className="flex min-h-0 flex-1 flex-col">
          <Routes>
            {/* key remounts Chat on a fresh id, so its state starts clean. */}
            <Route path="/" element={<Chat key={conversationId} conversationId={conversationId} />} />
            <Route path="/debug" element={<Debug />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

function Header({ onNew }: { onNew: () => void }) {
  const onChat = useLocation().pathname === '/'
  return (
    <header className="flex items-center gap-5 border-b border-line px-5 py-4">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight text-ink">Alfred</span>
        <span className="hidden text-xs text-muted sm:inline">at your service</span>
      </div>
      <nav className="flex gap-4 text-sm">
        <NavLink
          to="/"
          className={({ isActive }) =>
            isActive ? 'text-brass' : 'text-muted transition-colors hover:text-ink'
          }
        >
          Chat
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
        <button
          type="button"
          onClick={onNew}
          className="ml-auto rounded-full border border-line px-3 py-1.5 text-sm text-ink-dim transition-colors hover:border-brass hover:text-brass"
        >
          + New conversation
        </button>
      )}
    </header>
  )
}
