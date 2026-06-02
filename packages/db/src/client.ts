import { loadConfig } from '@alfred/shared'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

export type Db = NodePgDatabase<typeof schema>

// Build a client against an explicit connection string (used by tests and migrations).
export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString })
  return drizzle(pool, { schema })
}

let cached: Db | null = null

// Lazy singleton for application processes. Fails fast if POSTGRES_URL is unset —
// the URL is optional in the shared config so non-DB processes (e.g. the webserver)
// still boot, but anything that actually opens a client requires it.
export function getDb(): Db {
  if (cached) return cached
  const { POSTGRES_URL } = loadConfig()
  if (!POSTGRES_URL) {
    throw new Error('POSTGRES_URL is not set — required to create the database client')
  }
  cached = createDb(POSTGRES_URL)
  return cached
}
