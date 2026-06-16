import { type Tool } from '@alfred/agent-core'
import { deleteMemoryFact, getDb, insertMemoryFact, listMemoryFacts, OWNER_USER_ID } from '@alfred/db'
import { capResult } from '../cap.js'

// Cap on a single saved fact (spec docs/specs/2026-06-15-long-term-memory.md): recall injects
// EVERY fact into every run's system prompt, so one runaway save would bloat every prompt
// forever. There is deliberately no COUNT cap (recall-all is the point — revisit at phase-2
// pgvector); only the per-fact length is bounded.
const MAX_FACT_CHARS = 500

// The long-term-memory tool family (spec docs/specs/2026-06-15-long-term-memory.md). Modelled on
// the file/python/email families: built per run (closes over runId for source_run_id), group
// 'memory'. remember/forget mutate durable state so they're write-tier (auditable + at most one
// approval prompt per run via the group); list_memories is read-tier. These are Alfred's ONE
// memory across all conversations — the read side (automatic recall into the system prompt) is in
// run.ts, not a tool. `runId` is optional so toolCatalog()'s metadata build can pass none.
export function makeMemoryTools(runId?: string): Tool[] {
  return [
    {
      name: 'remember',
      description:
        'Save a durable fact about the owner to your long-term memory (preferences, names, ' +
        'recurring details). It is recalled automatically in every later conversation.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The fact to remember' } },
        required: ['text'],
      },
      trustTier: 'write',
      group: 'memory',
      async invoke(args: unknown): Promise<unknown> {
        const raw = String((args as { text?: unknown } | null)?.text ?? '').trim()
        if (!raw) throw new Error('remember requires a non-empty text')
        // Cap so one runaway save can't bloat every future prompt (recall injects all facts).
        // Slice by code point (Array.from), not UTF-16 code unit, so the boundary never splits a
        // surrogate pair into a lone half that would render as U+FFFD in every future prompt.
        const text = Array.from(raw).slice(0, MAX_FACT_CHARS).join('')
        const { id } = await insertMemoryFact(getDb(), {
          userId: OWNER_USER_ID,
          text,
          sourceRunId: runId ?? null,
        })
        return { ok: true, id }
      },
    },
    {
      name: 'forget',
      description:
        'Remove a fact from your long-term memory by id (get ids from list_memories). Use when ' +
        'a remembered fact is wrong or no longer true.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The id of the fact to forget' } },
        required: ['id'],
      },
      trustTier: 'write',
      group: 'memory',
      async invoke(args: unknown): Promise<unknown> {
        const id = String((args as { id?: unknown } | null)?.id ?? '')
        if (!id) throw new Error('forget requires a fact id')
        const { deleted } = await deleteMemoryFact(getDb(), { userId: OWNER_USER_ID, id })
        return { ok: true, deleted }
      },
    },
    {
      name: 'list_memories',
      description:
        'List the durable facts in your long-term memory, each with its id (the id source for ' +
        'forget). Recall already injects these automatically — use this to review or prune.',
      inputSchema: { type: 'object', properties: {} },
      trustTier: 'read',
      group: 'memory',
      async invoke(): Promise<unknown> {
        const facts = await listMemoryFacts(getDb(), OWNER_USER_ID)
        // Named array (never a bare array — the Gemini function-response Struct, CHANGELOG 34);
        // capped like every other tool result in case the fact set has grown large.
        return capResult({ facts })
      },
    },
  ]
}
