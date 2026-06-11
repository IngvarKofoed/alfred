# Conversation list / history view (web)

Give the web client a way to browse and reopen past conversations. Today the client
remembers a single `alfred.conversationId` in localStorage and opens it at `/`, with no
way back to anything older. This adds a `GET /api/conversations` list endpoint, a
persistent (collapsible) conversation sidebar on the chat surface, and **URL-based
conversation routing** (`/conversation/:id`) so conversations are linkable, refresh-stable, and
navigable with the browser back button. Ordering is by `last_active_at` — the column the
schema already indexes for this and which we start maintaining as part of this change.

## Key decisions

- **URL routing `/conversation/:id`** (new). Conversations become routes; `/` turns into a
  redirect. This is what makes back/forward switch conversations, refresh stay put, and a
  conversation linkable. The SPA fallback (`index.ts` `app.get('*', …index.html)`) already
  serves deep links, so refresh on `/conversation/:id` works with no server change. The path
  string is cosmetic — any path resolves through the SPA fallback — so the self-documenting
  `/conversation/:id` is preferred over a terser `/c/:id`.
- **Chat reads its id from `useParams`** (extends). `Chat` already takes `conversationId`
  as a prop and remounts on key change; App stops sourcing that id from its own state and
  sources it from the route param instead. The component body is unchanged.
- **localStorage demoted to a "last opened" hint** (diverges). It stops being the source of
  truth for the active conversation (the URL is) and becomes only the value `/` redirects to
  when present and valid. Written whenever a `/conversation/:id` route mounts.
- **`GET /api/conversations`** (new). Lists the owner's recent `web` conversations
  (`id`, `title`, `lastActiveAt`) ordered `last_active_at desc`, `limit 100`.
- **Resurrect `last_active_at`** (extends / diverges). The column is set at creation and
  never updated today; the message-post route starts bumping it to `now()`. This activates
  the existing `conversations_user_last_active_idx` and is deliberately *not* the
  `max(run id::text)` workaround the `/debug` endpoint uses — we fix the column instead of
  copying the hack.
- **Conversation sidebar** (new). A persistent left rail on the chat surface only
  (`/` and `/conversation/:id`), collapsible to a drawer on narrow screens. Not shown on `/tools` or
  `/debug` (Debug has its own conversation rail).
- **Untitled fallback = "New conversation" label** (new). A conversation with a null `title`
  lists under a flat "New conversation" label, never a raw uuid. No first-message snippet,
  which keeps the list query to a plain `(id, title, last_active_at)` select.
- **List scope = `ingress = 'web'`** (new). The chat UI is built around the web conversation
  model (`channel_key = conversationId`); post-MVP ingress conversations are excluded.

## Goals

- See past conversations and reopen any of them from the web client.
- Surviving a refresh and using the browser back button both land on the right conversation.
- Conversations are ordered most-recently-active first, with a legible label.

## Non-goals

- Search / filter over conversations.
- Delete / archive / rename *from the list* (rename already exists via `/rename` and the
  `set_conversation_title` tool).
- Pagination / infinite scroll (a single user accrues conversations slowly; `limit 100`).
- Live, SSE-driven reordering of the list as messages stream.
- Listing non-`web` conversations (Discord/voice/trigger are post-MVP).

## Design

### Backend — `GET /api/conversations`

A new route in `services/webserver/src/app.ts`, beside the existing
`GET /api/conversations/:id`:

```
GET /api/conversations  →  { conversations: [
  { id, title, lastActiveAt }   // newest-active first, max 100
] }
```

- `WHERE ingress = 'web'`, `ORDER BY last_active_at DESC`, `LIMIT 100`.
- Selects `(id, title, last_active_at)` only — no message join. Untitled rows (`title` null)
  are labelled "New conversation" by the client.

### Backend — maintaining `last_active_at`

The message-post route (`POST /api/conversations/:id/messages`) already opens a transaction
that calls `ensureConversation(tx, conversationId)`. Make that path also set
`last_active_at = now()` on the existing row, so every user message bumps recency. The
cleanest seam is to extend `ensureConversation` with a `touch?: boolean` opt that switches
its no-title conflict branch from `onConflictDoNothing` to an `onConflictDoUpdate` setting
`last_active_at` — keeping the "one place the conversation upsert lives" property (queries.ts
comment). `/rename` keeps its title-only upsert and does **not** bump recency.

No backfill needed: existing rows keep their creation-time `last_active_at` until their next
message, which is acceptable ordering for history that predates this feature.

### Frontend — routing

`clients/web/src/App.tsx` moves the active-conversation id from React state to the URL:

- Add route `/conversation/:id` rendering `<Chat key={id} conversationId={id} … />`, where
  `id` comes from `useParams`. `Chat` is otherwise untouched.
- `/` becomes a redirect-only route: navigate to the localStorage "last opened" id if present
  and a valid uuid, else the most-recent conversation from the list, else a freshly minted
  uuid — all to `/conversation/:id`.
- "+ New conversation" navigates to `/conversation/<new uuid>` and writes localStorage. A
  fresh id has no DB row until its first message, so it won't appear in the sidebar yet — the
  rail shows it as a transient "New conversation" entry at the top while it's the
  active-but-unsaved id.
- Mounting any `/conversation/:id` writes `localStorage['alfred.conversationId'] = id` (the
  redirect hint).
- The header title + "New conversation" button stay, now driven by the route param.

### Frontend — sidebar

A new `Sidebar` component, rendered in the App shell alongside `<main>` on the chat surface
only:

- Fetches `GET /api/conversations` on mount, on conversation switch, and after a title change
  (reuses the existing `onTitleChange` signal lifted into App). No SSE — slight staleness
  between sends is accepted (Non-goals).
- Each row: the title (or "New conversation" when untitled), and a relative last-active
  time. The active conversation (route param) is highlighted.
- Desktop: a persistent rail (the chat content keeps its centered `max-w-2xl` column to the
  right). Narrow screens: collapsed by default, opened as an overlay drawer via a menu button
  in the header. Styled on the espresso/brass tokens, consistent with the Debug rail.

## Alternatives considered

- **Approach B — sidebar that swaps the active id in place** (no URL change), keeping
  localStorage as the source of truth. Smaller diff (App's model untouched), but no
  deep-linking, the back button doesn't switch conversations, and refresh always lands on the
  localStorage id regardless of what you navigated to. Rejected — the routing payoff is the
  point of a history view.
- **Approach C — a separate `/history` page** mirroring the Debug master-detail rail; click a
  row to open the chat. Smallest new surface, but it's a context-switch page rather than an
  always-present rail, so browsing is more clicks. Rejected in favour of the persistent
  sidebar.
- **Ordering by `max(run id::text)`** (the `/debug` endpoint's approach) instead of
  resurrecting `last_active_at`. Avoids a write-path change but copies a workaround into a
  second place and leaves the purpose-built index dead. Rejected — fix the column.
