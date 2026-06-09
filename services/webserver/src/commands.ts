import { ensureConversation, type Db } from '@alfred/db'

// A backend-owned slash-command registry + executor (spec 2026-06-09-chat-commands). The web
// client only detects a leading '/' and forwards the raw line here; parsing, the command
// definitions, and execution all live in one place — reusable by future clients/ingresses.

export type CommandContext = { conversationId: string; db: Db }

// Effects the client should apply (a `conversation` echo updates the header) plus the inline
// note/error it renders as an ephemeral system line.
export type CommandResult = { note?: string; error?: string; conversation?: { title: string } }

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

// The single source of truth: the registry /help derives from and executeCommand dispatches on.
export const COMMANDS: Command[] = [rename, help]

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
