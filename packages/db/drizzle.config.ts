import { defineConfig } from 'drizzle-kit'
// Side-effect: walks up to the repo root and loads `.env`, so `process.env.POSTGRES_URL`
// is populated when drizzle-kit runs `migrate`/`push` from packages/db (cwd-independent).
import '@alfred/shared'

// `generate` diffs the schema into SQL and needs no DB connection. `migrate`/`push`
// connect using POSTGRES_URL (the localhost fallback is the dev default, ARCHITECTURE §13).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.POSTGRES_URL ?? 'postgres://localhost:5432/alfred',
  },
})
