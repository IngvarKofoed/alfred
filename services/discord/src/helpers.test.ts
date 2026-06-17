import { describe, expect, it } from 'vitest'
import {
  assembleCommandArgs,
  buildCustomId,
  chunkMessage,
  DISCORD_MESSAGE_LIMIT,
  isOwner,
  parseCustomId,
  stripLeadingMention,
} from './helpers.js'

// Offline unit tests for the Discord ingress's pure helpers — no live gateway, no Postgres. The
// gateway/DB plumbing in index.ts isn't unit-testable here; these cover the logic that is.

describe('chunkMessage', () => {
  it('returns a single chunk when under the limit', () => {
    expect(chunkMessage('hello')).toEqual(['hello'])
  })

  it('returns no chunks for an empty string', () => {
    expect(chunkMessage('')).toEqual([])
  })

  it('every chunk is within the limit', () => {
    const text = 'x'.repeat(5000)
    const chunks = chunkMessage(text)
    expect(chunks.length).toBe(3) // 2000 + 2000 + 1000
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)
    expect(chunks.join('')).toBe(text)
  })

  it('prefers to break on a newline boundary near the limit', () => {
    // A short line, then a long run that crosses the limit. The first cut should land at the
    // newline (not mid-line), so the first chunk ends with the boundary line.
    const head = 'short line\n'
    const tail = 'y'.repeat(DISCORD_MESSAGE_LIMIT) // forces a split after `head`
    const chunks = chunkMessage(head + tail, 50)
    expect(chunks[0]).toBe(head) // broke exactly on the newline
    expect(chunks.join('')).toBe(head + tail)
  })

  it('hard-cuts a single over-long line with no newline', () => {
    const text = 'z'.repeat(120)
    const chunks = chunkMessage(text, 50)
    expect(chunks).toEqual(['z'.repeat(50), 'z'.repeat(50), 'z'.repeat(20)])
  })
})

describe('stripLeadingMention', () => {
  it('strips a leading <@id> mention and trims', () => {
    expect(stripLeadingMention('<@123> hello there', '123')).toBe('hello there')
  })

  it('strips the nickname form <@!id>', () => {
    expect(stripLeadingMention('<@!123>   what time is it', '123')).toBe('what time is it')
  })

  it('leaves a mid-sentence mention intact', () => {
    expect(stripLeadingMention('tell <@123> hi', '123')).toBe('tell <@123> hi')
  })

  it('does not strip a different bot/user mention', () => {
    expect(stripLeadingMention('<@999> hi', '123')).toBe('<@999> hi')
  })

  it('returns the trimmed text when there is no mention', () => {
    expect(stripLeadingMention('  plain text  ', '123')).toBe('plain text')
  })
})

describe('isOwner', () => {
  it('is true only for the allowed id', () => {
    expect(isOwner('123', '123')).toBe(true)
    expect(isOwner('456', '123')).toBe(false)
  })
})

describe('assembleCommandArgs', () => {
  it('joins present option values with spaces', () => {
    expect(assembleCommandArgs(['My', 'New Title'])).toBe('My New Title')
  })

  it('drops undefined and empty options', () => {
    expect(assembleCommandArgs(['title', undefined, ''])).toBe('title')
  })

  it('is empty for no options', () => {
    expect(assembleCommandArgs([])).toBe('')
  })
})

describe('buildCustomId / parseCustomId', () => {
  it('round-trips an action + interactionId', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    const customId = buildCustomId('approve', id)
    expect(customId).toBe(`approve:${id}`)
    expect(parseCustomId(customId)).toEqual({ action: 'approve', interactionId: id })
    expect(customId.length).toBeLessThanOrEqual(100) // Discord's customId cap
  })

  it('parses each known action', () => {
    expect(parseCustomId('reject:abc')?.action).toBe('reject')
    expect(parseCustomId('answer:abc')?.action).toBe('answer')
    expect(parseCustomId('freeform:abc')?.action).toBe('freeform')
  })

  it('returns undefined for an unknown action or a malformed id', () => {
    expect(parseCustomId('bogus:abc')).toBeUndefined()
    expect(parseCustomId('nocolon')).toBeUndefined()
    expect(parseCustomId('approve:')).toBeUndefined()
  })

  it('preserves a uuid interactionId containing no extra colons', () => {
    // The uuid itself has no ':' so indexOf(':') splits cleanly at the action separator.
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(parseCustomId(`answer:${id}`)).toEqual({ action: 'answer', interactionId: id })
  })
})
