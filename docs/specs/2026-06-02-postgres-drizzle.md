# Postgres + Drizzle (build-order step 2)

Stand up the data layer: a new `packages/db` workspace member exposing a typed Drizzle client over `POSTGRES_URL`, with the first slice of the schema (`users` → `conversations` → `messages`) managed by committed drizzle-kit migrations. Connectivity is proven by an integration test that inserts a conversation + message and reads it back against a local Postgres. The webserver is untouched — nothing consumes the DB yet; this step just makes the layer exist and proves it works.

Grounded in `docs/ARCHITECTURE.md` §6 (data layer), `docs/DATABASE.md` (authoritative column model), §13 (config), §5 (process topology), §15 (build order), and the step-1 code in `packages/shared` and `services/webserver`.

## Key decisions

- **New `packages/db` workspace member** (new). Owns the Drizzle schema, migrations, and the typed client — the home `DATABASE.md` already points to (`packages/db`). It's a library (built with `tsc`, like `packages/shared`), consumed by services later.
- **Driver: `pg` (node-postgres) via `drizzle-orm/node-postgres`** (new). Mature, runs natively on any OS, and is the same driver pg-boss uses at step 3 — one driver for the whole data layer.
- **IDs: UUIDv7 generated in app** (new). `DATABASE.md` wants time-ordered IDs; a tiny `uuidv7` dep set as the Drizzle column default (`$defaultFn`) gives that portably, independent of Postgres version (no reliance on PG 18's built-in `uuidv7()`).
- **Schema scope: `users` + `conversations` + `messages` only** (extends). `DATABASE.md` is the full authoritative model; this step implements just the FK chain those two tables need (`conversations.user_id → users.id` forces `users` in too). The rest (`agent_runs`, `tool_calls`, `user_interactions`, `memory_facts`) lands with the worker at step 3.
- **Migrations: drizzle-kit `generate` + `migrate`** (new). `generate` emits versioned SQL committed to `packages/db/migrations/`; `migrate` applies it. `push` is for throwaway dev only. This is the workflow every later schema change reuses.
- **`POSTGRES_URL` is optional in the shared config** (extends). Added to `packages/shared`'s zod schema as optional so the webserver still boots without a DB; `packages/db` reads it via `loadConfig()` and fails fast *at client creation* if it's missing. (Per-process config subsets, §13.2, are a later refactor — see Open questions.)
- **Webserver and existing tests stay green without a DB** (reuses). The integration test skips when `POSTGRES_URL` is unset, so `pnpm test` stays green in environments with no Postgres; it runs (and is the real proof) when the URL is set and migrations are applied.

## Goals

- A typed Drizzle client and the `users`/`conversations`/`messages` tables, created and versioned by migrations.
- Connectivity proven end to end against a real local Postgres (insert → read-back).
- The migration workflow established once, for every later step to reuse.
- `POSTGRES_URL` wired through the existing typed-config loader, fail-fast when the DB is actually used.

## Non-goals

- The rest of the schema (`agent_runs`, `tool_calls`, `user_interactions`, `memory_facts`) — step 3+.
- pg-boss / the job queue — step 3 (it manages its own `pgboss` schema).
- pgvector / embeddings — post-MVP.
- Wiring the DB into the webserver or any ingress feature — nothing needs it yet.
- Seed data, connection-pool tuning, read replicas. Defaults only.

## Design

### Layout (`packages/db`)

```
packages/db/
├─ package.json            @alfred/db; deps: drizzle-orm, pg, uuidv7, @alfred/shared
├─ tsconfig.json           extends ../../tsconfig.base.json (like packages/shared)
├─ drizzle.config.ts       dialect: postgresql; schema: src/schema.ts; out: migrations
├─ migrations/             generated SQL (committed)
└─ src/
   ├─ schema.ts            users, conversations, messages (per DATABASE.md)
   ├─ client.ts            createDb(url) + lazy singleton from loadConfig()
   ├─ index.ts             re-exports client + schema
   └─ db.test.ts           integration test (skipped without POSTGRES_URL)
```

### Schema (`src/schema.ts`)

The three tables exactly as `DATABASE.md` specifies them, e.g.:

```ts
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  userId: uuid('user_id').notNull().references(() => users.id),
  ingress: text('ingress').notNull(),         // 'web' | 'discord' | 'voice' | 'trigger'
  channelKey: text('channel_key').notNull(),
  title: text('title'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique().on(t.ingress, t.channelKey),
  index().on(t.userId, t.lastActiveAt.desc()),
])
```

`messages.content` is `jsonb`. Status enums and the rest of the model are out of scope (step 3). `ingress` stays plain `text` for now to match `DATABASE.md` as written.

### Client (`src/client.ts`)

`createDb(url)` builds a `pg` `Pool` and returns `drizzle(pool, { schema })`. A lazy singleton `getDb()` calls `loadConfig()`, throws a clear error if `POSTGRES_URL` is unset, and memoizes the client. Consumers import `getDb` and the schema from `@alfred/db`.

### Config

Extend `packages/shared`'s zod schema with `POSTGRES_URL: z.string().url().optional()`. The webserver is unaffected (it never reads it); `packages/db` enforces presence when a client is actually created.

### Migrations & dev Postgres

- `pnpm --filter @alfred/db db:generate` → SQL into `migrations/`; `db:migrate` applies it.
- Dev (macOS): `brew install postgresql@17`, `createdb alfred`, set `POSTGRES_URL=postgres://localhost:5432/alfred` in `.env`. No Docker (§5). Prod is the native Postgres install on the box.

### Proof (definition of done)

With a local Postgres and migrations applied: the integration test opens a transaction, inserts a `user` → `conversation` → `message`, reads the message back joined to its conversation, asserts the round-trip, and **rolls the transaction back** (no cleanup, DB stays pristine). With `POSTGRES_URL` unset the test is skipped, so `pnpm test` stays green everywhere else.

## Open questions

None — resolved during review: `POSTGRES_URL` stays optional in the single shared config schema (per-process subsets, §13.2, deferred); owner-row seeding deferred (the integration test creates its own user in a rolled-back transaction).

## Alternatives considered

- **Wire a DB ping into the webserver** for an end-to-end-through-the-server proof. Rejected for this step — it couples the webserver to the DB before any feature needs it and would make `/api/health` fail whenever Postgres is down.
- **`postgres` (postgres.js) driver.** Lighter/faster, but diverges from the `pg` driver pg-boss brings at step 3; one driver is simpler.
- **`gen_random_uuid()` (UUIDv4) defaults in Postgres.** Simpler, but loses the time-ordering `DATABASE.md` calls for.
