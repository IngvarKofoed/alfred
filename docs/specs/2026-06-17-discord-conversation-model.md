# Discord conversation model — guild threads

Make Discord a self-sufficient surface (the owner will not use the web app) by moving the
conversation model from "one DM = one ever-growing conversation" to **a private Alfred guild where
a forum post is a conversation**. A forum post is a thread with its own channel id, and the bot
already keys conversations on `message.channelId` — so post-per-conversation drops onto the
existing `(ingress, channel_key)` model with **no schema change**. The DM is retired (it just
redirects to the guild). Each recurring watcher becomes its own forum post too, which collapses the
notification problem: a watcher posts into its thread, Discord's native push *is* the alert, and
approvals are the same in-thread buttons — no separate notifier, no leaving Discord. Builds directly
on the shipped Discord bot (CHANGELOG 95).

## Key decisions

- **Thread = conversation, zero schema change** (reuses). A Discord thread is a channel with its
  own id; `getOrCreateConversationByChannel({ ingress:'discord', channelKey: message.channelId })`
  already runs per `message.channelId`, so a message in a thread already resolves to its own
  conversation. The thread list becomes the conversation "sidebar" the web app has — natively.
- **A private Alfred guild is the only surface** (new). A single-owner Discord server (just the
  owner + the bot) with two **forum** channels: `Conversations` (each post = a conversation) and
  `Watchers` (one post per watcher). A forum post *is* a thread (it has a channel id), so the
  keying below is unchanged. The forum's post list + native archive/tags is the conversation
  sidebar the web app has. (Forum channels require a **Community-enabled** guild — a one-time toggle
  in server settings.)
- **Fully guild — the DM is retired as a conversation surface** (diverges). A DM to the bot gets a
  one-line "let's talk in your Alfred server" pointer and creates **no** conversation or run. All
  real interaction lives in the guild's forum posts.
- **Mention-less responses inside the Alfred guild** (diverges). The current filter is
  `if (!isDM && !mentionsBot) return` — a guild message needs an `@`-mention. In the Alfred guild
  (gated on a new `DISCORD_GUILD_ID`) the bot answers **every** owner message inside a
  Conversations/Watchers post, no mention needed. A DM is redirected (above); any other server it's
  added to keeps the existing DM-or-mention filter, so it stays quiet where it shouldn't speak.
- **A watcher's conversation IS its Discord thread** (extends — the load-bearing seam). A recurring
  watcher's persistent conversation moves from `ingress='trigger', channel_key=trigger.id` to a
  Discord thread (`ingress='discord', channel_key=thread.id`), with `triggers.conversation_id`
  pointing at it. `run.ts` resolves the watcher's scratchpad today via
  `getTrigger(conv.channelKey)` (keyed on `channel_key = trigger.id`); that changes to a lookup by
  `triggers.conversation_id` (a new `getTriggerByConversation(conv.id)`) in `run.ts`, plus
  `detect.ts` routing each escalation through that same `conversation_id` — so scratchpad +
  bounded-history continuity survive while the conversation lives in Discord. Result: watcher
  output + approvals ride the bot's **existing** streaming + button paths — no mirroring, and a
  reply in the thread continues the watcher (it's the same conversation).
- **The bot proactively listens on its threads** (new). Today the bot opens a `LISTEN` on a
  conversation channel only *after* an owner message (in `onMessageCreate`). A watcher-initiated
  run has no preceding message, so the bot must subscribe up front: a **watcher-reconcile** step
  (at boot + periodically, mirroring how `alfred-triggers` reconciles cron) ensures every enabled
  watcher has a thread (creating it + setting `triggers.conversation_id` when missing) and `LISTEN`s
  its conversation channel, so the streamed run posts into the thread.
- **Notifications become Discord-native** (diverges). With watcher output landing in its thread,
  Discord's own push notifies the owner and the in-thread Approve/Reject buttons action it. The
  Web Push outbox/dispatcher + a hypothetical `DiscordNotifier` are **not needed** for the
  Discord-primary owner (Web Push stays for the web PWA, untouched).
- **`DISCORD_GUILD_ID` config** (new). Optional; gates all guild-home behavior. Unset ⇒ today's
  DM-or-mention bot, byte-for-byte unchanged — so this is additive, not a rewrite.

## Goals

- A Discord-only owner can run many bounded conversations (start, separate by topic, revisit) via
  threads — no infinite single-thread, no web app.
- Watcher results + approvals appear and are actionable **entirely in Discord**, with native push.
- Minimal new surface: reuse the existing conversation keying, streaming, and approval machinery;
  no schema change; the unconfigured bot is unchanged.
- Preserve "one Alfred": long-term memory is independent of conversation boundaries and is recalled
  into every run, so splitting into threads doesn't fragment what Alfred knows about the owner.

## Non-goals

- **Context compaction / summarization** — orthogonal and ingress-agnostic (it applies to web too),
  and threads make it far less urgent; its own spec. A single thread can still overflow (fails
  loudly, as today); the answer is "start a new thread," not in-thread summarization, for v1.
- **Migrating the existing DM conversation's history** into the guild — the old DM conversation is
  left as-is (and the DM now just redirects); the guild is the home going forward.
- **Auto topic-segmentation** — the owner starts threads (`/new`); no ML topic detection.
- **Removing Web Push** — it remains for the web PWA; this only makes it unnecessary *for Discord*.
- **Multi-user / shared guild** — the guild is private to the single owner (§12 still applies:
  owner-id filter on every event).

## Design

### Guild layout & onboarding
The owner creates a private server, **enables Community** on it (one-time, required for forum
channels), adds two forum channels — `Conversations` and `Watchers` — invites the bot (the existing
OAuth2 flow), and sets `DISCORD_GUILD_ID` to that guild's id. The bot can create the forums if
missing on boot. `Conversations` holds interactive conversation posts; `Watchers` holds one post
per watcher.

### Forum post = conversation
No keying change — `onMessageCreate` already calls `getOrCreateConversationByChannel` with
`message.channelId`, which for a message inside a forum post is that post's thread id. So each post
is its own conversation with its own history, runs, auto-title, and token/cost rollup. Starting a
conversation is Discord-native: the **New Post** button in `Conversations` (no command needed), or
`/new [title]` which creates a post and posts a greeting so it isn't empty. The forum post list +
archive/tags is the navigation. Because a forum has no message path *outside* a post, the
"bare message" case can't occur there; a **catch-all** conversation is kept only as a safety net,
for any owner message that lands in the guild but outside a Conversations/Watchers post, so a stray
message still gets a reply rather than being dropped.

### Mention-less filter & DM redirect
`onMessageCreate` becomes: drop non-owner/bot messages as today; if it's a **DM** (no `guildId`),
reply once with a pointer to the Alfred guild and return (no run); if `guildId === DISCORD_GUILD_ID`,
answer **every** owner message inside a forum post with no `@`-mention required (the mention-strip
is a no-op there); any other guild keeps the existing mention requirement. So the bot speaks only
inside the Alfred guild's posts.

### Watchers as threads (the seam)
- **Creation/reconcile (bot-side):** the worker/`alfred-triggers` stay Discord-agnostic. The bot
  runs a watcher-reconcile (boot + on a timer, and/or woken by a lightweight NOTIFY): for each
  enabled watcher lacking a live Discord post, it creates a post in the `Watchers` forum (named from
  the watcher), creates/points its conversation (`ingress='discord'`, `channel_key=post.id`) and
  sets `triggers.conversation_id`, then `LISTEN`s that conversation channel.
- **Routing change (`detect.ts`):** today `resolveConversationId` *derives* a recurring watcher's
  conversation id as `trigger.id` (ensuring it `ingress='trigger'`) and **ignores**
  `triggers.conversation_id`. It changes to: use `triggers.conversation_id` when set (the Discord
  post conversation the bot created), else fall back to today's `trigger.id`/`ingress='trigger'`
  default. So the bot's repoint actually routes the next escalation's `createTriggerRun` into the
  post. Backward-compatible — a watcher with no `conversation_id` is unchanged.
- **Resolution change (`run.ts`):** replace `getTrigger(conv.channelKey)` with
  `getTriggerByConversation(db, conv.id)` (new query: `triggers WHERE conversation_id = $`), so a
  watcher run on a Discord-post conversation still finds its trigger → scratchpad scope
  (`trigger:<id>`, keyed on the trigger id, so it survives the repoint) + bounded-history. Keep the
  `isTrigger` gate and the `kind !== 'self'` guard, so interactive runs and `'self'` one-shots are
  unaffected. `human_in_loop=false` (set by `createTriggerRun`) keeps `isTrigger` true regardless of
  ingress, so the autonomous run lifecycle (§7.7) is intact.
- **Output + approvals:** a watcher run streams over `conversation:<id>` exactly like an interactive
  run; because the bot already `LISTEN`s the thread (reconcile), it renders the streamed reply and
  any Approve/Reject buttons into the thread — the **same** code paths as a DM turn. A reply in the
  thread is a normal turn in the watcher's own conversation, so follow-ups continue in context.

### What this retires
The `notifications` outbox + dispatcher + the `Notifier`/Web-Push path are no longer on the critical
path for a Discord-primary owner — a watcher posting into its thread is the notification. They stay
in place for the web PWA; no removal.

## Alternatives considered

- **Sessionized DM** (codex/gemini brainstorm #1): keep the DM but rotate `channel_key` into
  `dm:<id>:session:<n>` with `/new`/`/resume`, auto-rotation, per-session summaries. Lowest setup,
  but it's a "fake sidebar" — chat, watchers, topics still interleave in one linear stream, and it
  needs an active-session pointer + summarization to bound context. Rejected in favour of native
  threads, which Discord already renders as a sidebar.
- **Doorbell `DiscordNotifier`** (the earlier fallback): a watcher DMs a short alert + a link to the
  web app. Rejected — the owner explicitly won't use the web app, and threads make the watcher's
  full context + approvals live natively in Discord anyway.
- **Mirror seam** (rejected for the watcher→thread delivery): keep watcher conversations as
  `ingress='trigger'` and have the bot *mirror* their output into a mapped Discord post, leaving
  `run.ts`/the trigger core untouched. Rejected because the post is then a read-only mirror —
  replying to it doesn't continue the watcher, reintroducing the cross-conversation disconnect this
  whole design exists to remove.
- **Text channels + threads** (rejected for layout): avoids the Community-enable step, but forum
  channels give native per-conversation posts, archive, and tags, which is the better sidebar
  replacement for a Discord-only owner.
