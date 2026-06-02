import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

// The typed-config pattern (ARCHITECTURE §13): every process imports loadConfig(),
// validates the subset it needs with zod, and fails fast at boot. This slice needs
// only the webserver port; later steps extend the schema.
const schema = z.object({
  WEBSERVER_PORT: z.coerce.number().int().positive().default(3000),
  // Optional so non-DB processes (e.g. the webserver) still boot without a database.
  // packages/db enforces presence when a client is actually created.
  POSTGRES_URL: z.string().url().optional(),
  // Optional like POSTGRES_URL: agent-core's GeminiProvider fails fast if it's missing
  // when constructed, but non-LLM processes still boot without it.
  GEMINI_API_KEY: z.string().optional(),
  DEFAULT_MODEL: z.string().default('gemini-2.5-flash'),
})

export type Config = z.infer<typeof schema>

let cached: Config | null = null

export function loadConfig(): Config {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    console.error('Invalid configuration:\n' + parsed.error.toString())
    process.exit(1)
  }
  cached = parsed.data
  return cached
}
