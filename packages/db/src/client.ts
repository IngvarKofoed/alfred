import { loadConfig } from '@alfred/shared'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

export type Db = NodePgDatabase<typeof schema>

// Build a client against an explicit connection string (used by tests).
export function createDb(connectionString: string): Db {
  return drizzle(new pg.Pool({ connectionString }), { schema })
}

let cachedPool: pg.Pool | null = null
let cachedDb: Db | null = null

function requireUrl(): string {
  const { POSTGRES_URL } = loadConfig()
  if (!POSTGRES_URL) {
    throw new Error('POSTGRES_URL is not set — required to use the database')
  }
  return POSTGRES_URL
}

// Shared connection pool for application processes (drizzle + raw queries like NOTIFY).
export function getPool(): pg.Pool {
  if (!cachedPool) cachedPool = new pg.Pool({ connectionString: requireUrl() })
  return cachedPool
}

export function getDb(): Db {
  if (!cachedDb) cachedDb = drizzle(getPool(), { schema })
  return cachedDb
}

// Fire a Postgres NOTIFY on `channel` with a string `payload` (≤ 8000 bytes, §6.2).
export async function pgNotify(channel: string, payload: string): Promise<void> {
  await getPool().query('SELECT pg_notify($1, $2)', [channel, payload])
}
