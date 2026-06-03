import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import Chat from './Chat'
import Debug from './Debug'

export default function App() {
  return (
    <BrowserRouter>
      <div className="mx-auto flex h-screen max-w-2xl flex-col bg-zinc-950 text-zinc-100">
        <header className="flex items-center gap-4 border-b border-zinc-800 px-4 py-3">
          <span className="text-lg font-semibold">Alfred</span>
          <nav className="flex gap-3 text-sm text-zinc-400">
            <Link to="/" className="hover:text-zinc-100">
              Chat
            </Link>
            <Link to="/debug" className="hover:text-zinc-100">
              Debug
            </Link>
          </nav>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          <Routes>
            <Route path="/" element={<Chat />} />
            <Route path="/debug" element={<Debug />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  )
}
