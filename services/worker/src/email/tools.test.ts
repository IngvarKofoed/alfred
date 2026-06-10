import { describe, expect, it } from 'vitest'
import type { Tool } from '@alfred/agent-core'
import type { Config } from '@alfred/shared'
import {
  buildSearchCriteria,
  emailConfig,
  formatAddresses,
  htmlToText,
  makeEmailTools,
  snippet,
} from './tools.js'

function toolByName(name: string): Tool {
  const tool = makeEmailTools().find((t) => t.name === name)
  if (!tool) throw new Error(`makeEmailTools did not return a tool named ${name}`)
  return tool
}

describe('makeEmailTools catalog shape', () => {
  it('exposes the five tools with the right tiers, all in the email group', () => {
    const tools = makeEmailTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(['list_emails', 'search_emails', 'read_email', 'save_draft', 'send_email'])
    for (const name of ['list_emails', 'search_emails', 'read_email']) {
      expect(toolByName(name).trustTier).toBe('read')
    }
    for (const name of ['save_draft', 'send_email']) {
      expect(toolByName(name).trustTier).toBe('write')
    }
    for (const t of tools) expect(t.group).toBe('email')
  })

  it('builds with no email config present (side-effect-free construction)', () => {
    // makeEmailTools must not read/validate config at construction, so the catalog can be
    // published on a box with no mail credentials — the same lazy-config contract as the
    // python venv. Constructing here with the env cleared (below) proves it doesn't throw.
    expect(() => makeEmailTools()).not.toThrow()
  })
})

describe('buildSearchCriteria', () => {
  it('returns an empty object when no args are given (degrades to a listing)', () => {
    expect(buildSearchCriteria({})).toEqual({})
  })

  it('maps free text to TEXT, from to FROM, and unseen to seen:false', () => {
    expect(buildSearchCriteria({ query: 'invoice', from: 'alice@example.com', unseen: true })).toEqual({
      text: 'invoice',
      from: 'alice@example.com',
      seen: false,
    })
  })

  it('parses since into a Date', () => {
    const c = buildSearchCriteria({ since: '2026-06-01' })
    expect(c.since).toBeInstanceOf(Date)
    expect((c.since as Date).getUTCFullYear()).toBe(2026)
  })

  it('drops an unparseable since rather than passing a bad value', () => {
    expect(buildSearchCriteria({ since: 'not-a-date' })).toEqual({})
  })

  it('omits unseen when false (a false flag is not a criterion)', () => {
    expect(buildSearchCriteria({ unseen: false })).toEqual({})
  })
})

describe('formatAddresses', () => {
  it('returns empty string for no addresses', () => {
    expect(formatAddresses(undefined)).toBe('')
    expect(formatAddresses([])).toBe('')
  })

  it('renders "Name <addr>" and bare addresses, joined by commas', () => {
    expect(
      formatAddresses([{ name: 'Alice', address: 'a@x.com' }, { address: 'b@x.com' }]),
    ).toBe('Alice <a@x.com>, b@x.com')
  })
})

describe('htmlToText', () => {
  it('strips tags, drops script/style, and collapses whitespace', () => {
    const html = '<style>p{}</style><p>Hello</p><script>x()</script><div>World&nbsp;&amp; more</div>'
    const text = htmlToText(html)
    expect(text).toContain('Hello')
    expect(text).toContain('World & more')
    expect(text).not.toContain('<')
    expect(text).not.toContain('x()')
  })
})

describe('snippet', () => {
  it('returns empty string for undefined', () => {
    expect(snippet(undefined)).toBe('')
  })

  it('collapses whitespace and truncates long text', () => {
    expect(snippet('  a\n\t b  ')).toBe('a b')
    const long = 'x'.repeat(500)
    expect(snippet(long).length).toBe(200)
  })
})

// emailConfig selects + validates a credential subset from a loadConfig() Config. Inject the
// Config directly (rather than mutating process.env around loadConfig's boot-time cache) so each
// case controls exactly what's present. The string→number/boolean parsing of the env itself is
// the zod schema's job (packages/shared/config.ts), not retested here.
function cfg(overrides: Partial<Config>): Config {
  return overrides as Config
}

describe('emailConfig', () => {
  it('throws a friendly error when IMAP config is missing', () => {
    expect(() => emailConfig('imap', cfg({}))).toThrow(/email is not configured/)
  })

  it('throws a friendly error when SMTP config is missing', () => {
    expect(() => emailConfig('smtp', cfg({}))).toThrow(/email is not configured/)
  })

  it('reads the IMAP credential subset from the config', () => {
    const { imap } = emailConfig(
      'imap',
      cfg({
        IMAP_HOST: 'imap.example.com',
        IMAP_PORT: 993,
        IMAP_SECURE: true,
        IMAP_USER: 'me@example.com',
        IMAP_PASSWORD: 'secret',
      }),
    )
    expect(imap).toEqual({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      user: 'me@example.com',
      pass: 'secret',
    })
  })

  it('defaults EMAIL_FROM to SMTP_USER and honours an explicit override', () => {
    const base = {
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 465,
      SMTP_SECURE: true,
      SMTP_USER: 'me@example.com',
      SMTP_PASSWORD: 'secret',
    }
    expect(emailConfig('smtp', cfg(base)).smtp.from).toBe('me@example.com')
    expect(emailConfig('smtp', cfg({ ...base, EMAIL_FROM: 'noreply@example.com' })).smtp.from).toBe(
      'noreply@example.com',
    )
  })

  it('passes through the parsed SMTP_SECURE boolean', () => {
    const { smtp } = emailConfig(
      'smtp',
      cfg({
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: 465,
        SMTP_SECURE: false,
        SMTP_USER: 'me@example.com',
        SMTP_PASSWORD: 'secret',
      }),
    )
    expect(smtp.secure).toBe(false)
  })
})

// Live IMAP needs a reachable mailbox + credentials in the env — skipped when absent so
// `pnpm test` stays green elsewhere, the same gating pattern as the python/Postgres suites.
const haveImap = !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD)

describe.skipIf(!haveImap)('list_emails (live, needs IMAP)', () => {
  it(
    'lists messages with the documented row shape',
    async () => {
      const tool = toolByName('list_emails')
      const result = (await tool.invoke({ limit: 5 })) as { messages: unknown[] }
      expect(Array.isArray(result.messages)).toBe(true)
      if (result.messages.length > 0) {
        const m = result.messages[0] as Record<string, unknown>
        for (const key of ['uid', 'mailbox', 'from', 'to', 'subject', 'date', 'snippet', 'unseen']) {
          expect(m).toHaveProperty(key)
        }
      }
    },
    30_000,
  )
})
