import { Hono } from 'hono'

// The Hono app, kept separate from the server bootstrap (index.ts) so it can be
// exercised in tests via `app.request(...)` without opening a socket.
export const app = new Hono()

// Proof endpoint: confirms the SPA can reach its backend (ARCHITECTURE/spec).
app.get('/api/health', (c) => c.json({ ok: true }))

export default app
