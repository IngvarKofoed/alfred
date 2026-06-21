import { beforeEach, describe, expect, it, vi } from 'vitest'

// Capture the db helper calls so we can assert makeMemoryTools threads the right `scope` to
// insertMemoryFact / listMemoryFacts (autonomous-watchers review fix #1: a watcher run's
// remember/list_memories must operate on its `automation:<id>` scratchpad scope, not the owner's
// global memory). Offline — the helpers are mocked, no Postgres.
const insertMemoryFact = vi.fn(async () => ({ id: 'new-id' }))
const deleteMemoryFact = vi.fn(async () => ({ deleted: true }))
const listMemoryFacts = vi.fn(async () => [{ id: 'a', text: 'fact a' }])

vi.mock('@alfred/db', () => ({
  OWNER_USER_ID: 'owner',
  getDb: () => ({}) as never,
  insertMemoryFact: (...args: unknown[]) => insertMemoryFact(...(args as [])),
  deleteMemoryFact: (...args: unknown[]) => deleteMemoryFact(...(args as [])),
  listMemoryFacts: (...args: unknown[]) => listMemoryFacts(...(args as [])),
}))

const { makeMemoryTools } = await import('./tools.js')

function toolByName(scope?: string) {
  const tools = makeMemoryTools('run-1', scope)
  return (name: string) => {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error(`no tool ${name}`)
    return t
  }
}

beforeEach(() => {
  insertMemoryFact.mockClear()
  deleteMemoryFact.mockClear()
  listMemoryFacts.mockClear()
})

describe('makeMemoryTools catalog shape', () => {
  it('exposes remember/forget (write) + list_memories (read), all group memory', () => {
    const tools = makeMemoryTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['forget', 'list_memories', 'remember'])
    expect(tools.every((t) => t.group === 'memory')).toBe(true)
    expect(tools.find((t) => t.name === 'remember')!.trustTier).toBe('write')
    expect(tools.find((t) => t.name === 'forget')!.trustTier).toBe('write')
    expect(tools.find((t) => t.name === 'list_memories')!.trustTier).toBe('read')
  })
})

describe('default (interactive) scope is global — unchanged', () => {
  it('remember saves to scope global', async () => {
    await toolByName()('remember').invoke({ text: 'likes tea' })
    expect(insertMemoryFact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'global', text: 'likes tea', sourceRunId: 'run-1' }),
    )
  })

  it('list_memories reads scope global', async () => {
    await toolByName()('list_memories').invoke({})
    expect(listMemoryFacts).toHaveBeenCalledWith(expect.anything(), 'owner', 'global')
  })
})

describe('watcher scope is threaded through remember + list_memories', () => {
  const scope = 'automation:abc-123'

  it('remember saves to the watcher scratchpad scope', async () => {
    await toolByName(scope)('remember').invoke({ text: 'last uid 42' })
    expect(insertMemoryFact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope, text: 'last uid 42' }),
    )
  })

  it('list_memories reads the watcher scratchpad scope', async () => {
    await toolByName(scope)('list_memories').invoke({})
    expect(listMemoryFacts).toHaveBeenCalledWith(expect.anything(), 'owner', scope)
  })

  it('forget is by-id+owner and scope-independent (ids come from the scoped list)', async () => {
    await toolByName(scope)('forget').invoke({ id: 'a' })
    // deleteMemoryFact is by userId + id only — never a scope arg.
    expect(deleteMemoryFact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'owner', id: 'a' }),
    )
  })
})

describe('list_memories returns a NAMED array, never bare (CHANGELOG 34)', () => {
  it('wraps the facts under a `facts` key', async () => {
    const result = (await toolByName()('list_memories').invoke({})) as { facts: unknown[] }
    expect(Array.isArray(result)).toBe(false)
    expect(result.facts).toEqual([{ id: 'a', text: 'fact a' }])
  })
})
