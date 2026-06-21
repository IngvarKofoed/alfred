// alfred-discord — Alfred's second interactive ingress (spec docs/specs/2026-06-16-discord-bot.md;
// build-order step 6, end of MVP). A discord.js bot the owner DMs (or @-mentions) to reach the
// SAME Alfred — one identity, one memory, one tool set — from Discord. It is a DIRECT-TO-POSTGRES
// peer ingress (§9), modelled on the webserver: it creates runs + resolves interactions against the
// DB itself and LISTENs the conversation channel for streamed output, with NO dependency on
// alfred-webserver being up.
//
// Fail-and-restart (§7.6): the bot holds no durable state. On a restart mid-run the in-flight render
// state is lost — the run still completes server-side (visible in the web app), but that Discord
// placeholder is never updated again. Accepted for v1; no boot reconciliation.
//
// Guild conversation model (spec docs/specs/2026-06-17-discord-conversation-model.md), GATED on
// DISCORD_GUILD_ID. When set, the owner's private Alfred guild becomes the home surface: two FORUM
// channels (`conversations`, `watchers`), where a forum POST is a conversation (it's a thread with
// its own channel id, so the existing channel_key=message.channelId keying is unchanged). Inside
// that guild the bot answers EVERY owner message in a post (no @-mention) and a DM just redirects.
//
// Per-fire watcher conversations (spec docs/specs/2026-06-20-watcher-conversation-per-fire.md). The
// "one persistent watcher post" model is RETIRED: each Tier-2 escalation now lands in its OWN fresh
// conversation (created by the worker, ingress='trigger', conversations.automation_id set), and the
// notifications outbox is the cross-surface fan-out. The bot is a SECOND consumer of the 'notifications'
// channel (alongside the worker's Web Push dispatcher — LISTEN/NOTIFY broadcasts to both): on the FIRST
// notification for a watcher conversation (a mid-run approval/question OR the final result/error), it
// creates a NEW post in the `watchers` forum (a new thread = a real Discord ping), repoints the
// conversation to (ingress='discord', channel_key=<post id>), and renders the content read FROM THE DB
// (post-final, no token streaming — watcher reports are async, the new post is itself the alert). A reply
// IN that post is then an ordinary ingress='discord' message handled by the normal onMessageCreate path,
// so no standing LISTEN / proactive reconcile is needed. When DISCORD_GUILD_ID is UNSET, none of the
// guild model runs — the bot is byte-for-byte today's DM-or-mention bot.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  conversations as conversationsTable,
  createUserMessageRun,
  enqueueAgentRun,
  getDb,
  getOrCreateConversationByChannel,
  messages,
  notifications as notificationsTable,
  readLastAssistantText,
  repointConversationChannel,
  resolveInteraction,
  userInteractions,
} from '@alfred/db'
import { executeCommand, listCommands } from '@alfred/commands'
import { extForImageMime, imageMimeForExt, loadConfig, resolveInWorkspace } from '@alfred/shared'
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm'
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ForumChannel,
  type Guild,
  type Interaction,
  type Message as DiscordMessage,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js'
import pg from 'pg'
import {
  assembleCommandArgs,
  buildCustomId,
  chunkMessage,
  DISCORD_MESSAGE_LIMIT,
  isOwner,
  parseCustomId,
  stripLeadingMention,
} from './helpers.js'

const config = loadConfig()
const { DISCORD_BOT_TOKEN, ALLOWED_DISCORD_USER_ID, POSTGRES_URL, DISCORD_GUILD_ID } = config

// Inert-unless-configured (mirrors the updater's DEPLOY_ENABLED shape): with no token or owner id
// there is nothing to connect to, but EXITING would make pm2 autorestart crash-loop us. So log once
// and keep the event loop alive doing nothing.
if (!DISCORD_BOT_TOKEN || !ALLOWED_DISCORD_USER_ID) {
  console.log('discord not configured; idling')
  // Keep the process alive without busy-looping (an unref'd timer would let Node exit). A bare
  // never-resolving promise holds the event loop open until SIGTERM kills the process.
  await new Promise<void>(() => {})
}
// Past the guard both are defined; narrow for the rest of the module.
const botToken = DISCORD_BOT_TOKEN!
const ownerId = ALLOWED_DISCORD_USER_ID!
if (!POSTGRES_URL) throw new Error('POSTGRES_URL is not set — required by alfred-discord')

const db = getDb()

// 10 MB inbound image cap, matching POST /files (the webserver's MAX_UPLOAD_BYTES).
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

// A persisted image reference (the DB/wire form — Postgres stays blob-free). The worker stores
// assistant/tool image parts as { type:'image', path, mimeType }; we read them back for outbound.
interface ImageRef {
  type: 'image'
  path: string
  mimeType: string
}
function isImageRef(part: unknown): part is ImageRef {
  if (part === null || typeof part !== 'object') return false
  const p = part as { type?: unknown; path?: unknown; mimeType?: unknown }
  return p.type === 'image' && typeof p.path === 'string' && typeof p.mimeType === 'string'
}

// MessageContent is a PRIVILEGED gateway intent — it must be enabled in the Discord developer
// portal (Bot → Privileged Gateway Intents → Message Content Intent) or the gateway rejects login.
// Partials.Channel is required to receive DMs (a DM channel arrives uncached / partial).
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

// --- Per-conversation streaming render state ---------------------------------------------------

// One shared pg.Client LISTENs every active run's conversation channel; NOTIFY payloads are
// dispatched by channel name to the matching render state. The state owns the buffer being typed,
// the Discord messages it has emitted (we edit the trailing one, sealing + continuing past 2000
// chars), a trailing-edge edit throttle, and the bookkeeping the done path needs (the message id
// captured before enqueue, for the outbound-image select). One active run per conversation, so one
// render state per conversation at a time.
interface RenderState {
  conversationId: string
  // The Discord messages this run has emitted, in order. We always edit the LAST one; when a delta
  // would overflow it we seal it and push a fresh continuation message (the new edit target).
  emitted: DiscordMessage[]
  // The full streamed text so far, across all sealed + the active message.
  buffer: string
  // Length of `buffer` already committed to sealed (non-trailing) messages — the trailing message
  // renders buffer.slice(sealedLen).
  sealedLen: number
  editTimer: NodeJS.Timeout | undefined
  // Whether an edit is in flight (so the trailing-edge throttle coalesces rather than overlapping).
  editing: boolean
  // Set when a flush is requested while one is already in flight — re-run once it settles.
  pendingFlush: boolean
  // The in-flight flushRender promise (undefined when idle). drainRender awaits this so a terminal
  // handler can wait for the buffer to be fully rendered before uploading images / tearing down.
  flushPromise: Promise<void> | undefined
  // The latest messages.id BEFORE enqueue, so the done path selects only THIS run's new
  // assistant/tool messages for outbound images.
  sinceMessageId: string | null
  // Open interaction (approval/question) component messages, keyed by interactionId, so an
  // `interaction_resolved` NOTIFY from ANOTHER surface (the owner answered on web, or a timeout)
  // can disable our buttons/select here too — not just the click we handle locally.
  pendingComponents: Map<string, DiscordMessage>
  // Serializes async event handling per conversation so two NOTIFYs (e.g. a token edit and a
  // done teardown) don't interleave their Discord calls. Chained like the worker's notifyChain.
  eventChain: Promise<void>
}

// channel name (`conversation:<id>`) -> render state for the active run on that conversation.
const renderByChannel = new Map<string, RenderState>()

// Edit at most ~1x/1.5s per channel (well under Discord's ~5 edits / 5s / channel limit), always
// flushing the final state on `done`/`error`/`cancelled`.
const EDIT_THROTTLE_MS = 1500

// --- Guild conversation model (gated on DISCORD_GUILD_ID) --------------------------------------

// The two forum channels we own in the Alfred guild, resolved at boot (find-or-create). Null until
// resolved, and stays null if the guild isn't reachable / not Community-enabled / we lack Manage
// Channels — every guild-home feature degrades gracefully on null rather than crashing.
let conversationsForum: ForumChannel | null = null
let watchersForum: ForumChannel | null = null

// The catch-all conversation's channel_key: a stable per-guild key (NOT a real channel) for the
// rare owner message that lands in the guild but outside any forum post, so a stray message still
// gets a reply instead of being dropped. Keyed off the guild id so it's deterministic across boots.
function catchAllChannelKey(guildId: string): string {
  return `guild:${guildId}:catch-all`
}

const notifyClient = new pg.Client({ connectionString: POSTGRES_URL })

// Set before the deliberate notifyClient.end() in the SIGINT/SIGTERM handler, so the 'end' listener
// below can tell an intended shutdown from a dropped socket (which must exit-for-restart, #3).
let shuttingDown = false

// --- Streaming render ---------------------------------------------------------------------------

// Render the current buffer into the trailing Discord message, sealing + continuing when it grows
// past the soft limit. Best-effort: a Discord edit failure is logged, never thrown (we don't crash
// the bot over one failed edit). `final` forces a flush regardless of the throttle.
async function flushRender(state: RenderState): Promise<void> {
  if (state.editing) {
    state.pendingFlush = true
    return
  }
  state.editing = true
  // Track this pass so drainRender (terminal handlers) can await the buffer being fully rendered.
  const pass = doFlush(state)
  state.flushPromise = pass
  await pass
}

async function doFlush(state: RenderState): Promise<void> {
  try {
    // Text not yet committed to a sealed message lives in the trailing message.
    let tail = state.buffer.slice(state.sealedLen)

    // Seal + continue only while the trailing text actually OVERFLOWS the hard limit: keep a sealed
    // message at <=DISCORD_MESSAGE_LIMIT and start a new continuation message for the overflow.
    // chunkMessage gives line-boundary-aware cuts; we seal all but the last chunk and keep typing
    // into the last. The guard is the HARD limit, not the soft one: chunkMessage(tail, 2000) returns
    // the whole tail as a single chunk whenever tail.length <= 2000, so guarding on the soft 1900
    // would (for a 1901–2000-char tail) seal the entire tail, open an empty continuation, and leave
    // a bare dangling "…" message. The soft limit governs nothing here — it stays a doc constant for
    // a future pre-emptive split, but the seal must only trigger on true overflow.
    while (tail.length > DISCORD_MESSAGE_LIMIT) {
      const chunks = chunkMessage(tail, DISCORD_MESSAGE_LIMIT)
      const sealedChunk = chunks[0]!
      // Edit the trailing message to its final sealed content, then advance sealedLen past it.
      await editTrailing(state, sealedChunk)
      state.sealedLen += sealedChunk.length
      tail = state.buffer.slice(state.sealedLen)
      // Open a fresh continuation message as the new edit target (placeholder until the next edit).
      const cont = await sendTo(state, '…')
      if (cont) state.emitted.push(cont)
    }

    await editTrailing(state, tail.length > 0 ? tail : '…')
  } catch (err) {
    console.error(`[discord ${state.conversationId}] render flush failed:`, err)
  } finally {
    state.editing = false
    // A flush requested while we were busy: re-run once, coalescing all of them into this pass.
    // Chain the re-run onto state.flushPromise so drainRender awaits the COALESCED final pass, not
    // just the first; only clear flushPromise when nothing more is queued (truly idle).
    if (state.pendingFlush) {
      state.pendingFlush = false
      const next = doFlush(state)
      state.flushPromise = next
      void next
    } else {
      state.flushPromise = undefined
    }
  }
}

// Wait until the buffer is fully rendered into Discord: loop awaiting the in-flight flush (and any
// re-run it coalesced) until no edit is in flight and no flush is pending. Terminal handlers call
// this before uploading images / tearing down, so the FINAL token state always renders first (an
// in-flight throttled edit can't be skipped past by the done/error/cancelled teardown, and the tail
// isn't dropped by a SIGTERM that races the throttle). Bounded — the buffer stops growing once the
// terminal event arrives, so there is a finite amount left to render.
async function drainRender(state: RenderState): Promise<void> {
  // Force a final pass for the current buffer, then drain whatever's in flight + coalesced.
  await flushRender(state)
  while (state.editing || state.pendingFlush) {
    await state.flushPromise
  }
}

// Edit the trailing emitted message to `content`. If nothing's been emitted yet (shouldn't happen —
// a placeholder is sent before LISTEN), no-op.
async function editTrailing(state: RenderState, content: string): Promise<void> {
  const target = state.emitted.at(-1)
  if (!target) return
  await target.edit(content.slice(0, DISCORD_MESSAGE_LIMIT))
}

// Send a new message into the same channel as the run's first emitted message (a continuation, or
// an attachment follow-up). Returns the sent message or null on failure (logged, never thrown).
async function sendTo(
  state: RenderState,
  content: string,
  files?: AttachmentBuilder[],
): Promise<DiscordMessage | null> {
  const channel = state.emitted[0]?.channel
  if (!channel || !channel.isSendable()) return null
  try {
    return await channel.send({ content: content.slice(0, DISCORD_MESSAGE_LIMIT), files })
  } catch (err) {
    console.error(`[discord ${state.conversationId}] send failed:`, err)
    return null
  }
}

// Schedule a trailing-edge throttled flush: coalesce a burst of tokens into one edit ~every
// EDIT_THROTTLE_MS, and always flush the final state when the timer fires.
function scheduleFlush(state: RenderState): void {
  if (state.editTimer) return // a flush is already pending within this window
  state.editTimer = setTimeout(() => {
    state.editTimer = undefined
    void flushRender(state)
  }, EDIT_THROTTLE_MS)
}

// Disable + drop every still-open interaction component tracked on a render state. A tracked
// component is an interaction that never got a local resolve nor an `interaction_resolved` — most
// importantly a TIMEOUT (the worker resolves it to `timed_out` but emits NO interaction_resolved),
// or a cross-surface resolve the bot couldn't observe (a watcher post is not LISTENed, so a
// web-side approval never reaches it). Leaving them live would keep buttons/select clickable
// forever against a terminal interaction. Disable with a brief terminal note. Best-effort, parallel.
async function disablePendingComponents(state: RenderState): Promise<void> {
  if (state.pendingComponents.size === 0) return
  await Promise.all(
    [...state.pendingComponents.values()].map((compMsg) =>
      compMsg.edit({ content: `${compMsg.content}\n\n_No longer available._`, components: [] }).catch(() => {}),
    ),
  )
  state.pendingComponents.clear()
}

// Tear down a finished run's render state: disable any still-open interaction components, clear its
// timer, drop it from the dispatch map, and UNLISTEN its channel (the shared client no longer needs
// notifications for it). Idempotent.
async function teardownRender(channel: string): Promise<void> {
  const state = renderByChannel.get(channel)
  if (!state) return
  await disablePendingComponents(state)
  if (state.editTimer) {
    clearTimeout(state.editTimer)
    state.editTimer = undefined
  }
  renderByChannel.delete(channel)
  // The per-conversation LISTEN was opened for THIS run (onMessageCreate, an interactive turn); the
  // run is terminal, so UNLISTEN it. There are no standing watcher subscriptions anymore — a watcher
  // run never streams into Discord (its report is posted post-final from the notifications consumer),
  // so the only conversation:<id> channels we LISTEN are interactive turns, all torn down here.
  await notifyClient.query(`UNLISTEN "${channel}"`).catch(() => {})
}

// --- Outbound images ----------------------------------------------------------------------------

// On `done`, upload any images the run produced. The run appended assistant/tool turns to `messages`
// with image parts in REFERENCE form ({ type:'image', path, mimeType }); select this conversation's
// newer assistant/tool rows (id > the captured sinceMessageId), read each referenced file off the
// workspace, and upload them as Discord attachments in a follow-up message. Best-effort.
//
// The role filter is load-bearing: sinceMessageId is captured BEFORE createUserMessageRun inserts
// this turn's role='user' message, and that user row carries the owner's INBOUND image parts in the
// exact { type:'image', path, mimeType } shape isImageRef matches. Its uuidv7 id sorts > sinceMessageId,
// so without the role filter we'd re-upload the owner's own image straight back at them every turn.
async function uploadRunImages(state: RenderState): Promise<void> {
  try {
    const rows = await db
      .select({ id: messages.id, content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, state.conversationId),
          inArray(messages.role, ['assistant', 'tool']),
          state.sinceMessageId ? gt(messages.id, state.sinceMessageId) : undefined,
        ),
      )
      .orderBy(asc(messages.id))

    const files: AttachmentBuilder[] = []
    for (const row of rows) {
      const parts = Array.isArray(row.content) ? (row.content as unknown[]) : []
      for (const part of parts) {
        if (!isImageRef(part)) continue
        try {
          const abs = resolveInWorkspace(state.conversationId, part.path)
          const bytes = await readFile(abs)
          // Name the attachment with the canonical extension for its mime so Discord previews it.
          const ext = extForImageMime(part.mimeType) ?? 'png'
          files.push(new AttachmentBuilder(bytes, { name: `${path.basename(part.path, path.extname(part.path))}.${ext}` }))
        } catch (err) {
          console.error(`[discord ${state.conversationId}] outbound image read failed (${part.path}):`, err)
        }
      }
    }
    if (files.length === 0) return
    // Discord caps attachments at 10 per message; chunk if a run somehow produced more.
    for (let i = 0; i < files.length; i += 10) {
      await sendTo(state, '', files.slice(i, i + 10))
    }
  } catch (err) {
    console.error(`[discord ${state.conversationId}] outbound image upload failed:`, err)
  }
}

// --- Approvals & questions ----------------------------------------------------------------------

// Render an approval (kind 'approval'): post a message with the proposed action + Approve/Reject
// buttons. The customId carries the interactionId so the shared dispatcher routes the click back.
async function renderApproval(state: RenderState, interactionId: string): Promise<void> {
  const [row] = await db
    .select({ prompt: userInteractions.prompt })
    .from(userInteractions)
    .where(eq(userInteractions.id, interactionId))
  if (!row) return
  const prompt = row.prompt as {
    summary?: string
    tool?: string
    args?: unknown
    scope?: 'group' | 'call'
  }

  const lines = [
    `**Approval needed**${prompt.summary ? `: ${prompt.summary}` : ''}`,
    prompt.tool ? `Tool: \`${prompt.tool}\`` : undefined,
    prompt.args !== undefined ? `Args: \`\`\`json\n${compactArgs(prompt.args)}\n\`\`\`` : undefined,
    prompt.scope === 'group'
      ? '_Approving covers every action in this task, not just this one._'
      : undefined,
  ].filter((l): l is string => l !== undefined)

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('approve', interactionId))
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(buildCustomId('reject', interactionId))
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  )

  const sent = await sendComponents(state, lines.join('\n'), [buttons])
  if (sent) state.pendingComponents.set(interactionId, sent)
}

// Render a question (kind 'question'): a StringSelectMenu for the options (single/multi per
// `multi_select`), and/or an "Other…" button opening a freeform modal (per `allow_freeform`).
async function renderQuestion(state: RenderState, interactionId: string): Promise<void> {
  const [row] = await db
    .select({ prompt: userInteractions.prompt })
    .from(userInteractions)
    .where(eq(userInteractions.id, interactionId))
  if (!row) return
  const prompt = row.prompt as {
    question?: string
    options?: { label: string; description?: string }[]
    multi_select?: boolean
    allow_freeform?: boolean
  }
  const options = Array.isArray(prompt.options) ? prompt.options : []

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = []
  if (options.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(buildCustomId('answer', interactionId))
      .setMinValues(1)
      // maxValues must not exceed the number of RENDERED options (Discord rejects it otherwise) —
      // and options are capped at Discord's hard 25-option limit below, so clamp to both. Without
      // this clamp a multi_select question with >25 options sets maxValues above 25, Discord rejects
      // the message, it never posts, and the run parks on the unanswerable interaction until timeout.
      .setMaxValues(prompt.multi_select ? Math.min(options.length, 25) : 1)
      .addOptions(
        // The option VALUE is its index (String(i)), not the label: Discord caps an option value at
        // 100 chars, so a >100-char label would be truncated and the resolved selected_labels could
        // mismatch the agent's exact label. selectedLabels() maps the index back to the full label on
        // resolve. (The displayed label is still truncated to Discord's 100-char display cap.)
        options.slice(0, 25).map((o, i) => ({
          label: o.label.slice(0, 100),
          value: String(i),
          ...(o.description ? { description: o.description.slice(0, 100) } : {}),
        })),
      )
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select))
  }
  if (prompt.allow_freeform) {
    const other = new ButtonBuilder()
      .setCustomId(buildCustomId('freeform', interactionId))
      .setLabel(options.length > 0 ? 'Other…' : 'Answer…')
      .setStyle(ButtonStyle.Secondary)
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(other))
  }

  const sent = await sendComponents(state, `**${prompt.question ?? 'Alfred has a question'}**`, rows)
  if (sent) state.pendingComponents.set(interactionId, sent)
}

// Send a components message (approval buttons / question select) into the run's channel. Like
// sendTo but typed for component rows. Returns the sent message (so the caller can track it for
// later disabling) or null on failure (logged, never thrown).
async function sendComponents(
  state: RenderState,
  content: string,
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[],
): Promise<DiscordMessage | null> {
  const channel = state.emitted[0]?.channel
  if (!channel || !channel.isSendable()) return null
  try {
    return await channel.send({ content: content.slice(0, DISCORD_MESSAGE_LIMIT), components })
  } catch (err) {
    console.error(`[discord ${state.conversationId}] components send failed:`, err)
    return null
  }
}

// A short, single-line summary of a tool call's args for the inline tool chip (≤80 chars, whitespace
// collapsed). '' when there's nothing useful (null / empty object), so the chip is just the name.
// Kept tiny so a chip never bloats the streamed message.
function summarizeToolArgs(args: unknown): string {
  if (args == null) return ''
  if (typeof args === 'object' && !Array.isArray(args) && Object.keys(args as object).length === 0) return ''
  let s: string
  try {
    s = typeof args === 'string' ? args : JSON.stringify(args)
  } catch {
    s = String(args)
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

// Compact, length-bounded JSON for an approval's args (so a huge arg can't blow past Discord's
// message limit). Code-fenced by the caller.
function compactArgs(args: unknown): string {
  let s: string
  try {
    s = JSON.stringify(args)
  } catch {
    s = String(args)
  }
  return s.length > 1500 ? `${s.slice(0, 1500)}…` : s
}

// --- NOTIFY dispatch ----------------------------------------------------------------------------

// Handle one RunEvent for a conversation's active render state. Mirrors the SSE consumer the web
// client uses, translated to Discord message edits. Unknown / no-Discord-surface events
// (title/usage/tts_audio) are ignored; tool_call_* could drive a typing indicator but are otherwise
// silent.
async function handleEvent(state: RenderState, event: { type?: string; [k: string]: unknown }): Promise<void> {
  switch (event.type) {
    case 'token': {
      state.buffer += String(event.text ?? '')
      scheduleFlush(state)
      break
    }
    case 'tool_call_start': {
      // Show tool usage as a quiet inline "chip" woven into the streamed message, in event order
      // (mirrors the web client's chips). Discord subtext (`-#`) renders small + muted. Args are
      // shown only when present (the worker omits large ones to stay under the NOTIFY cap) and
      // truncated, so a chip can never bloat the message. The chip stays in the transcript.
      const tool = String(event.toolName ?? 'tool')
      const summary = summarizeToolArgs(event.args)
      const sep = state.buffer.length > 0 && !state.buffer.endsWith('\n') ? '\n' : ''
      state.buffer += `${sep}-# 🔧 \`${tool}\`${summary ? ` ${summary}` : ''}\n`
      scheduleFlush(state)
      break
    }
    case 'tool_call_end':
      break // the start chip already rendered; nothing to update on end
    case 'interaction_required': {
      const interactionId = String(event.interactionId ?? '')
      if (!interactionId) break
      if (event.kind === 'question') await renderQuestion(state, interactionId)
      else await renderApproval(state, interactionId)
      break
    }
    case 'interaction_resolved': {
      // The interaction was resolved — by our own click (the dispatcher already disabled the
      // components and we dropped the tracking entry), OR by another surface (the owner answered on
      // web, or it timed out). For the latter, disable the buttons/select here too so they can't be
      // clicked into an already-resolved row. Best-effort.
      const interactionId = String(event.interactionId ?? '')
      const compMsg = state.pendingComponents.get(interactionId)
      if (compMsg) {
        state.pendingComponents.delete(interactionId)
        await compMsg
          .edit({ content: `${compMsg.content}\n\n_Resolved elsewhere._`, components: [] })
          .catch(() => {})
      }
      break
    }
    case 'done': {
      // Drain (not just request) the final flush so an in-flight throttled edit can't be skipped
      // past — the final token state renders BEFORE the image follow-up and before teardown.
      await drainRender(state)
      await uploadRunImages(state)
      await teardownRender(`conversation:${state.conversationId}`)
      break
    }
    case 'error': {
      const message = String(event.message ?? 'Something went wrong.')
      state.buffer = state.buffer.length > 0 ? `${state.buffer}\n\n_Error: ${message}_` : `_Error: ${message}_`
      await drainRender(state)
      await teardownRender(`conversation:${state.conversationId}`)
      break
    }
    case 'cancelled': {
      state.buffer = state.buffer.length > 0 ? `${state.buffer}\n\n_Cancelled._` : '_Cancelled._'
      await drainRender(state)
      await teardownRender(`conversation:${state.conversationId}`)
      break
    }
    default:
      break // title / usage / tts_audio — no Discord surface
  }
}

notifyClient.on('notification', (msg) => {
  if (!msg.channel || !msg.payload) return
  let event: { type?: string; [k: string]: unknown }
  try {
    event = JSON.parse(msg.payload)
  } catch {
    return // ignore malformed payloads
  }

  const state = renderByChannel.get(msg.channel)
  // No render state for this channel ⇒ a stale NOTIFY for a torn-down (or never-rendered) run —
  // ignore it. Watcher runs no longer stream into Discord: their report is posted post-final by the
  // notifications consumer (below), not over the conversation channel, so the only conversation:<id>
  // channels with state are interactive turns the owner started via onMessageCreate.
  if (!state) return
  // Serialize per-channel handling so two events don't interleave their Discord calls (a token
  // edit racing the done teardown); chained on a per-state promise, preserving NOTIFY order. A
  // handler throw is swallowed so the chain never wedges.
  state.eventChain = state.eventChain.then(() =>
    handleEvent(state, event).catch((err) =>
      console.error(`[discord ${state.conversationId}] event handling failed:`, err),
    ),
  )
})
// node-postgres pg.Client does NOT auto-reconnect: once this shared LISTEN socket drops (a Postgres
// restart/blip), every conversation's LISTEN is dead and ALL streaming silently stops forever, with
// runs still completing server-side but no Discord ever updating again. We can't tell that apart
// from a live connection, so rather than degrade invisibly we exit — pm2 restarts the bot, which
// reconnects + re-LISTENs on the next inbound message (fail-and-restart, §7.6). This turns silent
// degradation into a visible restart. The exit guards are reached only after notifyClient.connect()
// in the configured path; the unconfigured idle path never connects this client, so it never exits.
notifyClient.on('error', (err) => {
  console.error('[discord] NOTIFY connection error — exiting for pm2 restart:', err)
  process.exit(1)
})
notifyClient.on('end', () => {
  // A clean end we didn't initiate (we set shuttingDown before notifyClient.end() in the signal
  // handler) is still a dead LISTEN socket — exit so pm2 brings us back with a fresh subscription.
  if (shuttingDown) return
  console.error('[discord] NOTIFY connection ended unexpectedly — exiting for pm2 restart')
  process.exit(1)
})

// --- Notifications consumer (per-fire watcher posts, spec 2026-06-20) ---------------------------
//
// The bot is a SECOND consumer of the 'notifications' channel (the worker's Web Push dispatcher is
// the first; LISTEN/NOTIFY broadcasts to both independently). The NOTIFY payload is a bare doorbell
// (run.ts: pgNotify('notifications', '')), so on each ping we re-read recent rows and act on the ones
// we haven't yet. A watcher run no longer streams into Discord — instead, on the FIRST notification
// for a watcher conversation (a mid-run approval/question OR the final result/error) we create a NEW
// post in the `watchers` forum (a real Discord ping), repoint the conversation to it, and render the
// content read FROM THE DB. A reply in that post is then an ordinary onMessageCreate turn.
//
// Status-column ownership: this consumer NEVER touches notifications.status — the Web Push dispatcher
// owns the outbox lifecycle (sent/failed). The two don't clash because we dedupe locally (seenNotifs)
// instead of by status, and we read rows regardless of status. The price: on a bot restart we'd
// re-see every still-pending row, so a boot catch-up could post a flood of historical fires; the spec
// says a fire while the bot is down notifies via Web Push ONLY (no catch-up post), so boot SEEDS
// seenNotifs with every existing notification id — only rows that appear AFTER boot get a post.

const notifClient = new pg.Client({ connectionString: POSTGRES_URL })

// Notification ids already handled this process (dedupe; seeded at boot with the existing backlog so
// historical fires never get a catch-up post — spec "Re-pointing when the bot is down").
const seenNotifs = new Set<string>()

// Watcher conversation id -> the Discord post (thread) channel id we created for it this process, so
// the SECOND notification for the same fire (e.g. result after an approval) renders into the existing
// post instead of creating a duplicate. Persisted only in-process; a restart rebuilds it lazily from
// conversations.ingress='discord' (a repointed conversation needs no new post — its channelKey IS the
// post). Mirrors the old reconciledTriggers de-dup intent.
const watcherPosts = new Map<string, string>()

// Serializes notification drains (a burst of NOTIFYs + the per-channel async post-create/render)
// so two pings don't race into creating two posts for the same fire.
let notifDrainChain: Promise<void> = Promise.resolve()

function scheduleNotifDrain(): void {
  notifDrainChain = notifDrainChain
    .then(() => drainNotifications())
    .catch((err) => console.error('[discord] notifications drain failed:', err))
}

// Read recent notification rows and handle any unseen ones whose conversation is a WATCHER
// conversation (conversations.automation_id set). Bounded (most-recent 50 by uuidv7 id) — a fire
// generates at most a few rows (result, or approval(s)+result), and seenNotifs caps re-work; the
// window only needs to comfortably exceed the rows produced between two drains.
async function drainNotifications(): Promise<void> {
  let rows
  try {
    rows = await db
      .select({
        id: notificationsTable.id,
        conversationId: notificationsTable.conversationId,
        interactionId: notificationsTable.interactionId,
        kind: notificationsTable.kind,
        title: notificationsTable.title,
        body: notificationsTable.body,
        automationId: conversationsTable.automationId,
        channelKey: conversationsTable.channelKey,
        ingress: conversationsTable.ingress,
        convTitle: conversationsTable.title,
      })
      .from(notificationsTable)
      .innerJoin(conversationsTable, eq(notificationsTable.conversationId, conversationsTable.id))
      .orderBy(desc(notificationsTable.id))
      .limit(50)
  } catch (err) {
    console.error('[discord] notifications read failed:', err)
    return
  }

  // Process oldest-first (rows came newest-first) so a fire's approval renders before its result, and
  // a missing post is created by the FIRST notification rather than the last.
  for (const row of rows.reverse()) {
    if (seenNotifs.has(row.id)) continue
    seenNotifs.add(row.id)
    // Only watcher conversations: automation_id must be set (a normal web/discord/voice conversation
    // has none, and its run already streamed/answered live — nothing to post).
    if (!row.automationId || !row.conversationId) continue
    try {
      await handleWatcherNotification(row)
    } catch (err) {
      console.error(`[discord] watcher notification ${row.id} handling failed:`, err)
    }
  }
}

// Handle one watcher notification: ensure the conversation has a Discord post (create + repoint on the
// first notification), then render the notification's content into the post by reading the DB.
async function handleWatcherNotification(row: {
  id: string
  conversationId: string | null
  interactionId: string | null
  kind: string
  title: string
  body: string
  channelKey: string
  ingress: string
  convTitle: string | null
}): Promise<void> {
  const conversationId = row.conversationId!
  const post = await ensureWatcherPost(conversationId, row.ingress, row.channelKey, row.convTitle, row.title)
  if (!post) return // forums unavailable / not in our guild — Web Push still delivered it

  // Register (or reuse) a lightweight render state for this post so the approval/question renderers
  // (which post into state.emitted[0]'s channel) and the component-resolve tracking work. Watcher
  // runs don't stream, so we never LISTEN this conversation channel — the state only carries the post
  // message + the pendingComponents map.
  const channel = `conversation:${conversationId}`
  let state = renderByChannel.get(channel)
  if (!state) {
    state = {
      conversationId,
      emitted: [post],
      buffer: '',
      sealedLen: 0,
      editTimer: undefined,
      editing: false,
      pendingFlush: false,
      flushPromise: undefined,
      sinceMessageId: null,
      pendingComponents: new Map(),
      eventChain: Promise.resolve(),
    }
    renderByChannel.set(channel, state)
  }

  switch (row.kind) {
    case 'approval':
      if (row.interactionId) await renderApproval(state, row.interactionId)
      break
    case 'question':
      if (row.interactionId) await renderQuestion(state, row.interactionId)
      break
    case 'error': {
      const note = row.body?.trim() || 'A background task failed.'
      await postWatcherText(post, `_Error: ${note}_`)
      // A terminal notification means the run ended. Any approval/question this fire posted that the
      // bot never saw resolved (timed out, or answered on web — the watcher post isn't LISTENed) must
      // be disabled now so its buttons can't be clicked against a terminal interaction (S2).
      await disablePendingComponents(state)
      break
    }
    case 'result':
    default: {
      // Render the run's final report: the conversation's newest assistant text (read from the DB,
      // post-final — no streaming) plus any images the run produced into the workspace.
      const text = await readLastAssistantText(db, conversationId).catch(() => null)
      if (text) await postWatcherText(post, text)
      else if (row.body?.trim()) await postWatcherText(post, row.body.trim())
      await uploadRunImages(state)
      // Disable any leftover approval/question components for this terminal run (see the error case).
      await disablePendingComponents(state)
      break
    }
  }
}

// Ensure the watcher conversation has a Discord post, creating one on the first notification and
// repointing the conversation to it. Returns the post's starter message (the surface the renderers
// post into) or null if the forum is unavailable / not in our guild.
//
// Three cases:
//   1. We already created a post this process (watcherPosts) — fetch + reuse it.
//   2. The conversation is already ingress='discord' (a prior fire repointed it, surviving in the DB
//      across a bot restart) — its channelKey IS the post; fetch + reuse, no new post.
//   3. Still ingress='trigger' (worker just created it) — create a NEW post in the watchers forum and
//      repoint the conversation to (ingress='discord', channel_key=<post id>).
async function ensureWatcherPost(
  conversationId: string,
  ingress: string,
  channelKey: string,
  convTitle: string | null,
  notificationTitle: string,
): Promise<DiscordMessage | null> {
  // Case 1/2: a post channel id is known (in-process map, or the conversation is already on Discord).
  const knownPostId = watcherPosts.get(conversationId) ?? (ingress === 'discord' ? channelKey : undefined)
  if (knownPostId) {
    const msg = await fetchPostTarget(knownPostId)
    if (msg) {
      watcherPosts.set(conversationId, knownPostId)
      // We created the post but a prior repoint failed (conversation still ingress='trigger') — retry
      // so a reply in the post resolves. A no-op once it's already ingress='discord'.
      if (ingress !== 'discord') {
        await repointConversationChannel(db, { id: conversationId, ingress: 'discord', channelKey: knownPostId }).catch(
          (err) => console.error(`[discord ${conversationId}] repoint retry failed:`, err instanceof Error ? err.message : err),
        )
      }
      return msg
    }
    // The known post vanished (deleted) — fall through to create a fresh one.
  }

  // Case 3: create a new post in the watchers forum.
  if (!watchersForum) {
    console.error(`[discord ${conversationId}] watcher notification but no watchers forum — Web Push only`)
    return null
  }
  const name = convTitle?.trim() || notificationTitle?.trim() || 'Watcher'
  let post
  try {
    // Max auto-archive (1 week) so a low-frequency fire's post doesn't archive before the owner reads
    // it. Seed the starter with the notification title (not a bare '…') so an approval/question-first
    // fire reads as a sensible header rather than a dangling ellipsis; the result path edits it.
    post = await createForumPost(watchersForum, name, notificationTitle?.trim() || name, 10080)
  } catch (err) {
    console.error(`[discord ${conversationId}] watcher post creation failed:`, err instanceof Error ? err.message : err)
    return null
  }
  try {
    await repointConversationChannel(db, { id: conversationId, ingress: 'discord', channelKey: post.id })
  } catch (err) {
    // The repoint failed — the conversation stays ingress='trigger', so a reply in the post won't
    // resolve (onMessageCreate keys on channelId). Still post the report (better than silence), but
    // log loudly. Best-effort; a next notification re-attempts the repoint via case 3 again.
    console.error(`[discord ${conversationId}] repoint to post ${post.id} failed:`, err instanceof Error ? err.message : err)
  }
  watcherPosts.set(conversationId, post.id)
  // The starter message of the post is its first renderable target (createForumPost seeds it with '…').
  const starter = await post.fetchStarterMessage().catch(() => null)
  return starter ?? (await fetchPostTarget(post.id))
}

// Fetch a fresh sendable message inside a post thread to render into. We post a new '…' message
// rather than editing the starter, so each notification (approval card, then result) is its own
// message in the thread. Returns null (logged) if the thread is gone / not in our guild / not sendable.
async function fetchPostTarget(postChannelId: string): Promise<DiscordMessage | null> {
  try {
    const channel = await client.channels.fetch(postChannelId).catch(() => null)
    if (!channel || !channel.isSendable()) return null
    if (!('guildId' in channel) || channel.guildId !== DISCORD_GUILD_ID) {
      console.error(`[discord] watcher post ${postChannelId} not in the Alfred guild; skipping`)
      return null
    }
    // Un-archive a thread Discord auto-archived between fires, else the send fails.
    if (channel.isThread() && channel.archived) {
      await channel.setArchived(false).catch(() => {})
    }
    return await channel.send({ content: '…' })
  } catch (err) {
    console.error(`[discord] failed to open watcher post ${postChannelId}:`, err)
    return null
  }
}

// Post the watcher's report text into the post, editing the placeholder target and continuing past
// Discord's 2000-char limit (reuse chunkMessage). Best-effort.
async function postWatcherText(target: DiscordMessage, text: string): Promise<void> {
  const chunks = chunkMessage(text, DISCORD_MESSAGE_LIMIT)
  if (chunks.length === 0) return
  await target.edit(chunks[0]!).catch((err) =>
    console.error(`[discord] watcher report edit failed:`, err),
  )
  const channel = target.channel
  if (!channel.isSendable()) return
  for (const chunk of chunks.slice(1)) {
    await channel.send({ content: chunk }).catch((err) =>
      console.error(`[discord] watcher report continuation failed:`, err),
    )
  }
}

// --- Inbound message flow -----------------------------------------------------------------------

client.on(Events.MessageCreate, (message) => {
  void onMessageCreate(message).catch((err) =>
    console.error('[discord] messageCreate handler failed:', err),
  )
})

async function onMessageCreate(message: DiscordMessage): Promise<void> {
  // Owner-only (§12), not the bot's own message.
  if (message.author.bot) return
  if (!isOwner(message.author.id, ownerId)) return
  const isDM = !message.guildId
  const mentionsBot = client.user ? message.mentions.has(client.user.id) : false

  // Filter + conversation keying depend on whether the Alfred guild is configured. The result is a
  // resolved `channelKey` (the natural key getOrCreateConversationByChannel maps) or a bail-out.
  let channelKey: string
  if (DISCORD_GUILD_ID && message.guildId === DISCORD_GUILD_ID) {
    // The Alfred guild is home: answer EVERY owner message with no @-mention. Inside a forum post
    // (channel.isThread()) the post's channel id IS the conversation key (unchanged keying). A stray
    // message outside any post routes to a stable per-guild catch-all so it isn't dropped.
    channelKey = message.channel.isThread() ? message.channelId : catchAllChannelKey(message.guildId)
  } else if (DISCORD_GUILD_ID && isDM) {
    // The DM is retired as a conversation surface — point the owner at the guild and create NO run.
    // (Only when a home guild is configured; an unconfigured bot keeps answering DMs below.)
    await message
      .reply({
        content:
          "Let's talk in your Alfred server — start a post in **#conversations** (or use `/new`). DMs aren't used anymore.",
        allowedMentions: { repliedUser: false },
      })
      .catch((err) => console.error('[discord] DM redirect reply failed:', err))
    return
  } else {
    // Unconfigured bot (DISCORD_GUILD_ID unset) OR any other guild the bot is in: today's behavior —
    // a DM, or a guild message that @-mentions us; everything else is ignored.
    if (!isDM && !mentionsBot) return
    channelKey = message.channelId
  }

  // Strip our leading mention so the model sees the bare prompt (a no-op in the Alfred guild, where
  // no mention is required, and in a DM).
  const rawText = client.user ? stripLeadingMention(message.content, client.user.id) : message.content.trim()
  const text = rawText.trim()

  // Use the forum post's own title as the conversation title (set once, on creation) so it matches
  // what the owner named the post and the worker's auto-title is skipped. Only for an actual post (a
  // thread) — a catch-all/DM channel has no meaningful title, so it falls back to auto-title.
  const postTitle = message.channel.isThread() ? message.channel.name?.trim() || undefined : undefined
  const conversationId = await getOrCreateConversationByChannel(db, {
    ingress: 'discord',
    channelKey,
    title: postTitle,
  })

  // Ingest image attachments into the conversation workspace as reference-form parts.
  const imageParts = await ingestImages(message, conversationId)

  // Require text OR at least one image — otherwise ignore (e.g. a bare non-image attachment).
  if (!text && imageParts.length === 0) return

  const channel = `conversation:${conversationId}`

  // Send the placeholder as a PLAIN message (channel.send), NOT message.reply: a reply renders a
  // "replying to…" reference on every turn — pure noise in a 1:1 post where the bot only ever has one
  // active run per channel. isSendable() narrows the channel union (it excludes the .send-less
  // PartialGroupDMChannel, the reason we previously used reply), so this typechecks; a non-sendable
  // channel just bails. This is also the run-agnostic point where the outbound-image watermark is captured.
  const target = message.channel
  if (!target.isSendable()) return
  const placeholder = await target.send('…').catch((err) => {
    console.error(`[discord ${conversationId}] failed to send placeholder:`, err)
    return null
  })
  if (!placeholder) return

  const sinceMessageId = await latestMessageId(conversationId)

  // Create the user message + pending run FIRST, so the one-active-run unique-violation (23505)
  // short-circuits BEFORE we touch renderByChannel/LISTEN. If we registered the render state before
  // this throw, a second message in a channel that already has an active run would (a) clobber the
  // live run's render state in the map and (b) make the catch's teardownRender UNLISTEN the shared
  // channel — freezing the very run we're deferring to. Creating the run first keeps the busy path
  // a pure "edit the placeholder and return" with no shared-state side effects.
  //
  // Subscribe-before-enqueue (spec) is preserved: the worker emits tokens only after enqueueAgentRun
  // (boss.send), never on the pending-row INSERT, so registering the render state + LISTEN between
  // run creation and enqueue still beats the first `token`.
  let runId: string
  try {
    runId = await db.transaction((tx) =>
      createUserMessageRun(tx, conversationId, [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...imageParts,
      ]),
    )
  } catch (err) {
    if (isUniqueViolation(err)) {
      await placeholder.edit("I'm still working on your last message.").catch(() => {})
      return
    }
    await placeholder.edit('_Error: could not start a run._').catch(() => {})
    throw err
  }

  const state: RenderState = {
    conversationId,
    emitted: [placeholder],
    buffer: '',
    sealedLen: 0,
    editTimer: undefined,
    editing: false,
    pendingFlush: false,
    flushPromise: undefined,
    sinceMessageId,
    pendingComponents: new Map(),
    eventChain: Promise.resolve(),
  }
  renderByChannel.set(channel, state)
  await notifyClient.query(`LISTEN "${channel}"`)

  await enqueueAgentRun(runId)
}

// The conversation's latest messages.id (uuidv7 — time-ordered), captured before enqueue so the
// done path can select only THIS run's newer assistant/tool messages for outbound images. Null
// when the conversation has no messages yet (a brand-new thread).
async function latestMessageId(conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.id))
    .limit(1)
  return row?.id ?? null
}

// Download each supported image attachment (<=10 MB) into the conversation workspace and return its
// reference-form part. The extension is derived from the VALIDATED mime, never the client filename,
// so the on-disk type is always known. Non-image / oversized attachments are skipped with a log
// note (v1 ingests images only — spec Non-goals).
async function ingestImages(
  message: DiscordMessage,
  conversationId: string,
): Promise<{ type: 'image'; path: string; mimeType: string }[]> {
  const parts: { type: 'image'; path: string; mimeType: string }[] = []
  for (const attachment of message.attachments.values()) {
    const mimeType = attachment.contentType?.split(';')[0]?.trim() ?? ''
    const ext = extForImageMime(mimeType)
    if (!ext) {
      console.log(`[discord ${conversationId}] skipping non-image attachment: ${attachment.name}`)
      continue
    }
    if (attachment.size > MAX_IMAGE_BYTES) {
      console.log(`[discord ${conversationId}] skipping oversized image: ${attachment.name}`)
      continue
    }
    try {
      const res = await fetch(attachment.url)
      if (!res.ok) {
        console.error(`[discord ${conversationId}] image fetch ${res.status} for ${attachment.name}`)
        continue
      }
      const bytes = Buffer.from(await res.arrayBuffer())
      const rawStem = (attachment.name || 'image').replace(/\.[^.]+$/, '')
      const safeStem =
        rawStem
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .replace(/^_+/, '')
          .slice(0, 64) || 'image'
      const relPath = `discord-${Date.now()}-${safeStem}.${ext}`
      const abs = resolveInWorkspace(conversationId, relPath)
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, bytes)
      // Re-derive the canonical mime from the validated ext so the stored part's mimeType matches
      // the on-disk extension exactly (jpg -> image/jpeg, not whatever Discord reported).
      parts.push({ type: 'image', path: relPath, mimeType: imageMimeForExt(ext) ?? mimeType })
    } catch (err) {
      console.error(`[discord ${conversationId}] image ingest failed for ${attachment.name}:`, err)
    }
  }
  return parts
}

// --- interactionCreate dispatcher (buttons, selects, modals, slash commands) --------------------

client.on(Events.InteractionCreate, (interaction) => {
  void onInteractionCreate(interaction).catch((err) =>
    console.error('[discord] interactionCreate handler failed:', err),
  )
})

async function onInteractionCreate(interaction: Interaction): Promise<void> {
  // Owner-only (§12): re-check on every interaction, like every gateway event.
  if (!isOwner(interaction.user.id, ownerId)) {
    if (interaction.isRepliable()) {
      await interaction
        .reply({ content: 'This is not for you.', flags: MessageFlags.Ephemeral })
        .catch(() => {})
    }
    return
  }

  // Slash command — resolve to the conversation, assemble raw args, run the shared registry.
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction)
    return
  }

  // Component / modal — route by the interactionId embedded in the customId.
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    await handleComponent(interaction)
    return
  }
}

async function handleSlashCommand(
  interaction: import('discord.js').ChatInputCommandInteraction,
): Promise<void> {
  // ACK FIRST: a slash command must be acknowledged within Discord's hard 3s window. The DB lookup
  // + executeCommand below can outrun that (a cold conversation create, a slow query), after which
  // any reply is rejected ("Unknown interaction"). deferReply consumes the window immediately;
  // editReply delivers the real note/error whenever the work finishes. Ephemeral so the reply is
  // visible only to the owner.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {})

  // /new is a bot-LOCAL command (not in the shared @alfred/commands registry — it creates a Discord
  // forum post, a surface-specific act). Create a post in the conversations forum + a greeting so it
  // isn't empty; the post's channel id becomes a fresh conversation on the owner's first message
  // there (unchanged keying). Only meaningful in the configured Alfred guild.
  if (interaction.commandName === 'new') {
    if (!conversationsForum) {
      await interaction
        .editReply({ content: 'The Alfred server isn’t set up for posts yet (no conversations forum).' })
        .catch(() => {})
      return
    }
    const title = interaction.options.getString('title')?.trim() || 'New conversation'
    const post = await createForumPost(conversationsForum, title, 'New conversation started. What can I do?').catch(
      (err) => {
        console.error('[discord] /new post creation failed:', err)
        return null
      },
    )
    const content = post
      ? `Started a new conversation: <#${post.id}>`
      : 'Could not create the post (check my Manage Channels permission).'
    await interaction.editReply({ content }).catch(() => {})
    return
  }

  const conversationId = await getOrCreateConversationByChannel(db, {
    ingress: 'discord',
    channelKey: interaction.channelId,
  })
  // Assemble every declared string option into the registry's raw args string. We register only
  // string options (one per command whose usage shows <...>), so reading them as strings is safe.
  const optionValues = interaction.options.data.map((o) =>
    o.value === undefined || o.value === null ? undefined : String(o.value),
  )
  const args = assembleCommandArgs(optionValues)
  const result = await executeCommand(`/${interaction.commandName} ${args}`, { conversationId, db })
  // The conversation.title echo is web-only (updates the web header) — ignored here. Edit the
  // deferred (ephemeral) reply with the note/error.
  const content = result.error ?? result.note ?? 'Done.'
  await interaction.editReply({ content: content.slice(0, DISCORD_MESSAGE_LIMIT) }).catch(() => {})
}

async function handleComponent(
  interaction:
    | import('discord.js').ButtonInteraction
    | import('discord.js').StringSelectMenuInteraction
    | import('discord.js').ModalSubmitInteraction,
): Promise<void> {
  // CONFINEMENT — there is no explicit channel-ownership check here, and three load-bearing
  // invariants are what make that safe (single-user, §12): (1) onInteractionCreate already dropped
  // every non-owner click before we get here; (2) the customId carries the interactionId verbatim
  // (parseCustomId below), and a customId is bot-emitted + integrity-checked by Discord, so a click
  // can't forge an id for another conversation's interaction; (3) interaction_required NOTIFYs are
  // per-conversation, so an interaction the bot rendered is one it owns. Removing any of these (e.g.
  // multi-user, or sourcing the interactionId from user input) would break confinement — add a real
  // conversation-ownership assertion before doing so.
  const parsed = parseCustomId(interaction.customId)
  if (!parsed) return
  const { action, interactionId } = parsed

  // A freeform button opens the modal — it doesn't resolve yet. The modal submit (also a 'freeform'
  // action) carries the typed answer. showModal is itself the interaction ACK (within the 3s
  // window), so this branch must NOT deferUpdate first.
  if (action === 'freeform' && interaction.isButton()) {
    const modal = new ModalBuilder()
      .setCustomId(buildCustomId('freeform', interactionId))
      .setTitle('Your answer')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('text')
            .setLabel('Answer')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true),
        ),
      )
    await interaction.showModal(modal).catch((err) =>
      console.error('[discord] showModal failed:', err),
    )
    return
  }

  // Build the response payload by action. The select's values are option INDEXES (String(i)) so a
  // >100-char label survives Discord's 100-char option-value cap — map them back to the full prompt
  // labels here (see #10). A bad/missing component pairing returns before any ACK.
  let response: unknown
  if (action === 'approve' || action === 'reject') {
    response = { approved: action === 'approve' }
  } else if (action === 'answer' && interaction.isStringSelectMenu()) {
    // A question's select: each value is the chosen option's index; resolve it to the untruncated
    // label off the interaction's prompt so selected_labels carries the exact label the agent set.
    const labels = await selectedLabels(interactionId, interaction.values)
    response = { selected_labels: labels, freeform_text: undefined }
  } else if (action === 'freeform' && interaction.isModalSubmit()) {
    const textValue = interaction.fields.getTextInputValue('text')
    response = { selected_labels: [], freeform_text: textValue }
  } else {
    return // an unexpected component/action pairing
  }

  // ACK FIRST: deferUpdate consumes Discord's 3s window before the DB resolve below (the conditional
  // UPDATE + NOTIFY), after which interaction.update is no longer valid — so we disable the
  // components via the originating message.edit and surface notes via followUp. Valid for both a
  // message component and a modal submit (the modal button already showed the modal in-window above).
  await interaction.deferUpdate().catch(() => {})

  const won = await resolveInteraction(db, interactionId, { response, resolvedVia: 'discord' })

  // We own this click's disable below, so drop the tracking entry first — that keeps the
  // interaction_resolved NOTIFY (which resolveInteraction emits) from racing in to re-edit the
  // same message with a "Resolved elsewhere." note. Done on win OR loss (a lost race means
  // someone else resolved it; their interaction_resolved already passed, so the entry is stale).
  forgetPendingComponent(interactionId)

  if (!won) {
    // Lost the race (already resolved on web, timed out, or the run was cancelled).
    await interaction.followUp({ content: 'Already resolved.', flags: MessageFlags.Ephemeral }).catch(() => {})
    return
  }

  // Disable the components on the originating message so the buttons/select can't be clicked again,
  // appending the verdict. A message component carries its `message` (edit it directly — after a
  // deferUpdate, interaction.update is no longer valid); a modal submit has no `message`, so fall
  // back to an ephemeral followUp note.
  const verb =
    action === 'approve' ? 'Approved.' : action === 'reject' ? 'Rejected.' : 'Answer recorded.'
  if (interaction.isMessageComponent() && interaction.message) {
    await interaction.message
      .edit({ content: `${interaction.message.content}\n\n_${verb}_`, components: [] })
      .catch(() => {})
  } else {
    await interaction.followUp({ content: verb, flags: MessageFlags.Ephemeral }).catch(() => {})
  }
}

// Map a question select's chosen option INDEXES (the values we render, String(i)) back to the full
// untruncated prompt labels — the select option's `value` is the index, not the (100-char-capped)
// label, so a >100-char label resolves correctly. Reads the interaction's prompt; a value that
// isn't a valid index is dropped (a stray / out-of-range selection).
async function selectedLabels(interactionId: string, values: string[]): Promise<string[]> {
  const [row] = await db
    .select({ prompt: userInteractions.prompt })
    .from(userInteractions)
    .where(eq(userInteractions.id, interactionId))
  const prompt = row?.prompt as { options?: { label: string }[] } | undefined
  const options = Array.isArray(prompt?.options) ? prompt.options : []
  const labels: string[] = []
  for (const v of values) {
    const idx = Number(v)
    const opt = Number.isInteger(idx) ? options[idx] : undefined
    if (opt) labels.push(opt.label)
  }
  return labels
}

// Drop an interaction from whatever render state is tracking its component message (so a later
// interaction_resolved NOTIFY for the same id is a no-op). At most one active run per conversation,
// and few conversations, so a scan is cheap.
function forgetPendingComponent(interactionId: string): void {
  for (const state of renderByChannel.values()) {
    if (state.pendingComponents.delete(interactionId)) return
  }
}

// --- Slash command registration -----------------------------------------------------------------

// Derive Discord application (slash) command definitions from the shared command registry. Each
// command whose usage shows a <placeholder> gets one required string option; the rest are bare.
// Registered GLOBALLY so they work in DMs (accepting the up-to-an-hour first-registration delay).
function buildSlashCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  const registry = listCommands().map((cmd) => {
    const builder = new SlashCommandBuilder()
      .setName(cmd.name)
      .setDescription(cmd.description.slice(0, 100))
    // A usage like "/rename <new title>" implies a free-text argument; expose it as one string
    // option the dispatcher concatenates back into the registry's raw args string.
    const placeholder = cmd.usage.match(/<([^>]+)>/)
    if (placeholder) {
      const optionName = placeholder[1]!.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 32) || 'value'
      builder.addStringOption((opt) =>
        opt.setName(optionName).setDescription(placeholder[1]!.slice(0, 100)).setRequired(true),
      )
    }
    return builder.toJSON()
  })

  // The bot-local /new (handled in handleSlashCommand, not the registry) — start a new conversation
  // post in the conversations forum. Registered ALONGSIDE the registry commands; harmless when no
  // guild is configured (its handler reports the forum is unavailable). Optional title argument.
  const newCmd = new SlashCommandBuilder()
    .setName('new')
    .setDescription('Start a new Alfred conversation (a post in the conversations forum)')
    .addStringOption((opt) => opt.setName('title').setDescription('Optional title for the conversation').setRequired(false))
    .toJSON()

  return [...registry, newCmd]
}

async function registerSlashCommands(applicationId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(botToken)
  const body = buildSlashCommands()
  await rest.put(Routes.applicationCommands(applicationId), { body })
  console.log(`alfred-discord: registered ${body.length} global slash command(s)`)
}

// --- Guild home: forums (gated on DISCORD_GUILD_ID) ---------------------------------------------

// Find (or create) the two forum channels the guild home needs: `conversations` and `watchers`.
// Best-effort by design — a forum channel requires a COMMUNITY-enabled guild and Manage Channels,
// neither of which we can guarantee. On any failure we log a clear, actionable error and leave the
// forum refs null so every dependent feature degrades (no crash): the DM-redirect/mention filter
// still works, /new reports the forum is unavailable, and the notifications consumer can't create a
// watcher post (Web Push still delivers). Sets the module-level conversationsForum/watchersForum refs.
async function setupForums(guild: Guild): Promise<void> {
  // Need the bot's own Manage Channels to create a missing forum; without it we can still USE forums
  // that already exist. Check up front so the error message is precise.
  const me = guild.members.me
  const canManage = me?.permissions.has(PermissionFlagsBits.ManageChannels) ?? false

  conversationsForum = await findOrCreateForum(guild, 'conversations', canManage)
  watchersForum = await findOrCreateForum(guild, 'watchers', canManage)
}

// Resolve one forum channel by (case-insensitive) name from the guild's channel cache, creating it
// when missing if we hold Manage Channels. Returns the ForumChannel or null (logged) on any miss.
async function findOrCreateForum(
  guild: Guild,
  name: string,
  canManage: boolean,
): Promise<ForumChannel | null> {
  try {
    // Fetch fresh so a forum created out-of-band (the owner made it by hand) is seen without a
    // restart; fall back to the cache if the fetch fails. Iterate explicitly (the fetch-vs-cache
    // collections have different value types, so a single typed .find() predicate won't unify).
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache)
    for (const channel of channels.values()) {
      if (
        channel?.type === ChannelType.GuildForum &&
        channel.name.toLowerCase() === name.toLowerCase()
      ) {
        return channel
      }
    }
    if (!canManage) {
      console.error(
        `[discord] no '${name}' forum and I lack Manage Channels — create it by hand (the guild must be Community-enabled for forum channels).`,
      )
      return null
    }
    return await guild.channels.create({ name, type: ChannelType.GuildForum })
  } catch (err) {
    // The most common cause is the guild not being Community-enabled (forum channels require it).
    console.error(
      `[discord] could not find/create the '${name}' forum (the guild must be Community-enabled, and I need Manage Channels):`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

// Create a forum POST (a thread with a starter message, so it isn't empty). Discord requires the
// starter `message` on a forum thread. `autoArchiveDuration` (minutes) overrides the forum default —
// watcher posts pass the max (10080 = 1 week) so a low-frequency watcher's post doesn't auto-archive
// before the owner reads it (see fetchPostTarget's un-archive fallback for when it does anyway).
// Returns the created thread (its id is the conversation's channel_key). Throws on failure (callers
// catch + degrade): a Community forum with "require tags when posting" rejects a tag-less create —
// the most likely cause if a watcher post never gets created.
async function createForumPost(
  forum: ForumChannel,
  name: string,
  greeting: string,
  autoArchiveDuration?: number,
): Promise<import('discord.js').ThreadChannel> {
  const thread = await forum.threads.create({
    // Discord caps a thread name at 100 chars.
    name: name.slice(0, 100) || 'Conversation',
    message: { content: greeting.slice(0, DISCORD_MESSAGE_LIMIT) },
    ...(autoArchiveDuration ? { autoArchiveDuration } : {}),
  })
  return thread
}

// Resolve the Alfred guild (cache → fetch) and set up its forums. Gated on DISCORD_GUILD_ID by the
// caller. Best-effort: a missing/unreachable guild logs + leaves the home features inert (the bot
// still answers DMs/mentions as the unconfigured bot would). Watcher posts are no longer created here
// (no proactive reconcile) — they're created on demand from the notifications consumer, the first time
// a watcher conversation produces a notification.
async function setupGuildHome(): Promise<void> {
  if (!DISCORD_GUILD_ID) return
  let guild: Guild | null
  try {
    guild = client.guilds.cache.get(DISCORD_GUILD_ID) ?? (await client.guilds.fetch(DISCORD_GUILD_ID))
  } catch (err) {
    console.error(
      `[discord] DISCORD_GUILD_ID=${DISCORD_GUILD_ID} not reachable (is the bot a member?):`,
      err instanceof Error ? err.message : err,
    )
    return
  }
  await setupForums(guild)
  console.log(
    `alfred-discord: guild home ready — conversations forum ${conversationsForum ? 'ok' : 'MISSING'}, watchers forum ${watchersForum ? 'ok' : 'MISSING'}`,
  )
}

// --- Boot ---------------------------------------------------------------------------------------

// Re-resolve the forums on a timer (guild home only) so the home self-heals if boot setup failed
// (e.g. Manage Channels granted after boot, or the guild not yet Community-enabled). No watcher
// reconcile anymore — posts are created on demand by the notifications consumer.
const FORUM_RESETUP_INTERVAL_MS = 30_000
let forumResetupTimer: NodeJS.Timeout | undefined

client.once(Events.ClientReady, (ready) => {
  console.log(`alfred-discord: logged in as ${ready.user.tag}`)
  void registerSlashCommands(ready.user.id).catch((err) =>
    console.error('[discord] slash-command registration failed:', err),
  )
  // Guild home (gated): set up forums at boot, then re-resolve them on a timer until both are present
  // so the home self-heals once the prerequisite (Community + Manage Channels) is fixed.
  if (DISCORD_GUILD_ID) {
    void setupGuildHome().catch((err) => console.error('[discord] guild-home setup failed:', err))
    forumResetupTimer = setInterval(() => {
      if (conversationsForum && watchersForum) return
      void setupGuildHome().catch((err) => console.error('[discord] guild-home re-setup failed:', err))
    }, FORUM_RESETUP_INTERVAL_MS)
  }
})

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

// Connect the shared NOTIFY client first (a missing/unreachable Postgres fails fast here).
await notifyClient.connect()

// Start the notifications consumer (per-fire watcher posts) — only in the guild model, where watcher
// output lands in a forum post. Without DISCORD_GUILD_ID there's no watchers forum to post into, so
// the worker's Web Push dispatcher is the only consumer (unchanged). A dropped socket exits for a pm2
// restart, like notifyClient — the seed-then-live-only contract means a restart simply re-seeds (no
// catch-up flood).
if (DISCORD_GUILD_ID) {
  await notifClient.connect()
  notifClient.on('error', (err) => {
    console.error('[discord] notifications LISTEN connection error — exiting for pm2 restart:', err)
    process.exit(1)
  })
  notifClient.on('end', () => {
    if (shuttingDown) return
    console.error('[discord] notifications LISTEN connection ended unexpectedly — exiting for pm2 restart')
    process.exit(1)
  })
  notifClient.on('notification', () => scheduleNotifDrain())
  // Seed the dedupe set with the EXISTING backlog so a fire that happened while the bot was down is
  // NOT given a catch-up post (spec "Re-pointing when the bot is down → Web Push only"). Only rows
  // inserted after this point get a post. Bounded to the most-recent rows (uuidv7 id desc) — well
  // above drainNotifications' 50-row read window, so nothing the drain could surface escapes the seed.
  try {
    const existing = await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .orderBy(desc(notificationsTable.id))
      .limit(200)
    for (const n of existing) seenNotifs.add(n.id)
  } catch (err) {
    console.error('[discord] notifications boot-seed failed (a stale fire may get a catch-up post):', err)
  }
  await notifClient.query('LISTEN "notifications"')
  console.log('[discord] notifications consumer listening (per-fire watcher posts)')
}

// Log in to the Discord gateway.
try {
  await client.login(botToken)
} catch (err) {
  // A bad/expired token or a disallowed (privileged) intent makes login throw. Don't exit: a bad
  // token won't fix itself by retrying, so exiting would crash-loop us under pm2 — and in the
  // `pnpm dev` concurrently -k set it would take worker/server/web down with us. Log loudly and
  // idle until the token/intent is fixed + the process restarted (mirrors the unconfigured-idle
  // path above). The most common cause here is the privileged Message Content Intent not being
  // enabled in the Discord developer portal.
  console.error(
    '[discord] gateway login failed; idling until restarted:',
    err instanceof Error ? err.message : err,
  )
  await new Promise<void>(() => {})
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      shuttingDown = true
      if (forumResetupTimer) clearInterval(forumResetupTimer)
      await client.destroy().catch(() => {})
      await notifyClient.end().catch(() => {})
      await notifClient.end().catch(() => {})
      process.exit(0)
    })()
  })
}
