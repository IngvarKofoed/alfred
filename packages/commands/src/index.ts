import { ensureConversation, type Db } from '@alfred/db'

// A backend-owned slash-command registry + executor (spec 2026-06-09-chat-commands). The web
// client only detects a leading '/' and forwards the raw line here; parsing, the command
// definitions, and execution all live in one place — reusable by future clients/ingresses.

export type CommandContext = { conversationId: string; db: Db }

// Effects the client should apply (a `conversation` echo updates the header) plus the inline
// note/error it renders as an ephemeral system line. `action` is an ingress-interpreted directive
// (e.g. 'speak' ⇒ open the read-out stream); the package stays a pure @alfred/db-only registry —
// it decides WHETHER to act, the ingress decides HOW (spec 2026-06-18-read-out-command).
export type CommandResult = {
  note?: string
  error?: string
  conversation?: { title: string }
  action?: 'speak'
}

export type Command = {
  name: string
  aliases?: string[]
  description: string
  usage?: string
  run: (args: string, ctx: CommandContext) => Promise<CommandResult>
}

const rename: Command = {
  name: 'rename',
  aliases: ['name'],
  description: 'Rename the current conversation.',
  usage: '/rename <new title>',
  async run(args, ctx) {
    const title = args.trim()
    if (!title) return { error: 'Usage: /rename <new title>' }
    if (title.length > 200) return { error: 'Title is too long (max 200).' }

    // One atomic upsert — seeds the owner + conversation if absent (so a never-messaged chat
    // can still be named) and sets the title either way. The title lands on the same column the
    // agent's set_conversation_title tool writes, via the shared seeding helper.
    await ensureConversation(ctx.db, ctx.conversationId, { title })

    return { note: `Renamed conversation to "${title}".`, conversation: { title } }
  },
}

const help: Command = {
  name: 'help',
  description: 'List the available commands.',
  async run() {
    const lines = COMMANDS.map((cmd) => `${cmd.usage ?? `/${cmd.name}`} — ${cmd.description}`)
    return { note: ['Available commands:', ...lines].join('\n') }
  },
}

const speak: Command = {
  name: 'speak',
  aliases: ['read'],
  description: 'Read out the last reply aloud.',
  usage: '/speak',
  async run() {
    // No synthesis or DB read here — hand the ingress a 'speak' directive and let the read-out
    // route be the single authority on whether there's anything to read (its 422 surfaces
    // "Nothing to read out yet."), so the message isn't loaded twice per /speak.
    return { action: 'speak' }
  },
}

// The single source of truth: the registry /help derives from and executeCommand dispatches on.
export const COMMANDS: Command[] = [rename, help, speak]

// Public metadata for the command catalog (served at GET /api/commands so the web client can
// render autocomplete suggestions). Derived from the same registry, so the suggestions can
// never drift from what executeCommand actually dispatches. The `run` fn is intentionally
// dropped — clients only need to display and complete commands, not execute them locally.
export type CommandInfo = { name: string; aliases: string[]; description: string; usage: string }

export function listCommands(): CommandInfo[] {
  return COMMANDS.map((c) => ({
    name: c.name,
    aliases: c.aliases ?? [],
    description: c.description,
    usage: c.usage ?? `/${c.name}`,
  }))
}

export async function executeCommand(input: string, ctx: CommandContext): Promise<CommandResult> {
  // Strip the leading '/', take the first whitespace-delimited token as the (lowercased)
  // command name, and treat the remainder (with its leading separator trimmed) as the args.
  const stripped = input.replace(/^\//, '')
  const match = stripped.match(/^(\S+)(\s+([\s\S]*))?$/)
  const name = (match?.[1] ?? '').toLowerCase()
  const args = match?.[3] ?? ''

  const cmd = COMMANDS.find((c) => c.name === name || c.aliases?.includes(name))
  if (!cmd) return { error: `Unknown command "/${name}". Try /help.` }
  return cmd.run(args, ctx)
}
