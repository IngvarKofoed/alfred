// Pure, gateway-free helpers for the Discord ingress — message chunking, mention-stripping,
// slash-command arg assembly, and the owner-filter predicate. Kept separate from index.ts (which
// holds the live discord.js Client + the DB plumbing) so these can be unit-tested offline with no
// gateway, no Postgres (helpers.test.ts).

// Discord's hard per-message limit. We never emit a message over this; the streaming render seals
// a message and continues into a new one as the buffer grows (see index.ts), and the final flush
// splits the whole buffer into <=LIMIT chunks here.
export const DISCORD_MESSAGE_LIMIT = 2000

// While streaming, we seal the current message well before the hard limit so an in-flight delta
// can be appended without overshooting (a single token append should never need to split). Once a
// further append would exceed this soft cap, the streamer starts a fresh continuation message.
export const DISCORD_STREAM_SOFT_LIMIT = 1900

// Split arbitrary text into Discord-sendable chunks of at most `limit` chars. Prefers to break on
// a newline boundary near the limit (so a sealed message doesn't slice a line mid-word), falling
// back to a hard character cut when a single line is itself longer than the limit. An empty / all-
// whitespace input yields no chunks — the caller decides what to render for an empty turn.
export function chunkMessage(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  if (text.length === 0) return []
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    // Break at the last newline within the window if there is one (and it isn't the very start),
    // so we cut on a line boundary; otherwise hard-cut at the limit (an over-long single line).
    const window = rest.slice(0, limit)
    const nl = window.lastIndexOf('\n')
    const cut = nl > 0 ? nl + 1 : limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

// Strip the bot's leading @-mention from a message's content so the model sees the bare prompt,
// not "<@123> hello". Discord renders a mention as `<@id>` or `<@!id>` (the `!` nickname form);
// both are handled, and only a LEADING mention is stripped (a mid-sentence "tell <@123> hi" stays
// intact). The result is trimmed.
export function stripLeadingMention(content: string, botId: string): string {
  const re = new RegExp(`^\\s*<@!?${botId}>\\s*`)
  return content.replace(re, '').trim()
}

// Whether an event came from the owner. Single-user (§12): being the owner *is* the auth, so every
// gateway event is dropped unless the author/clicker id matches ALLOWED_DISCORD_USER_ID.
export function isOwner(userId: string, allowedUserId: string): boolean {
  return userId === allowedUserId
}

// Assemble a slash command's options into the raw `args` string the backend command registry
// (@alfred/commands) parses. The registry treats everything after the command name as a single
// args string (e.g. `/rename <new title>`), so we join the provided option values with spaces in
// the order the command declared them. Undefined / empty options are dropped. This keeps the
// Discord slash-command surface a thin adapter over the one shared registry — no per-command
// parsing duplicated here.
export function assembleCommandArgs(optionValues: (string | undefined)[]): string {
  return optionValues
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ')
    .trim()
}

// A component customId carries the interactionId so the single interactionCreate dispatcher can
// route a click back to the right user_interactions row. Discord caps customId at 100 chars; an
// `<action>:<uuid>` (uuid is 36) stays well under that. These two helpers are the one place the
// encoding lives, so the build site and the parse site can't drift.
export type ComponentAction = 'approve' | 'reject' | 'answer' | 'freeform'

export function buildCustomId(action: ComponentAction, interactionId: string): string {
  return `${action}:${interactionId}`
}

// Parse a component customId back into its action + interactionId. Returns undefined for anything
// that isn't one of ours (a stray component, or a future encoding), so the dispatcher can ignore it.
export function parseCustomId(
  customId: string,
): { action: ComponentAction; interactionId: string } | undefined {
  const idx = customId.indexOf(':')
  if (idx === -1) return undefined
  const action = customId.slice(0, idx)
  const interactionId = customId.slice(idx + 1)
  if (action !== 'approve' && action !== 'reject' && action !== 'answer' && action !== 'freeform') {
    return undefined
  }
  if (!interactionId) return undefined
  return { action, interactionId }
}
