# Long-term memory (cross-conversation)

Give Alfred one memory that spans conversations: durable facts about the owner
saved in one conversation and recalled in every later one — the "one Alfred, one
memory" pillar (CONCEPT). The smallest interesting version is two halves on a new
`memory_facts` table: a **write** path that is an agent-called built-in tool
family (`remember` / `forget` / `list_memories`), and a **read** path that is an
automatic plain-rows `SELECT` injected into the system context of every run. No
embeddings, no semantic retrieval — those are a clean phase-2 migration on the
same table (ARCHITECTURE §6.4). This is build-order step 10 (§15), done as the
plain-rows foundation before pgvector.

## Key decisions

- **`memory_facts` created now; `embedding` column deferred** (diverges).
  `DATABASE.md` specs the table with a `vector(1536)` column "from day one" —
  but a real `vector` column can't exist without the pgvector extension, and v1
  uses no embeddings. So v1 creates the table *without* `embedding`; phase 2 adds
  the extension + column in one migration. The DATABASE.md design note is updated
  to match (the "exists from day one" intent was never executed anyway).
- **Write = an agent-called built-in tool family** (reuses). `remember` /
  `forget` / `list_memories` built and wired exactly like the file / python /
  email families (`makeMemoryTools()` → `buildRunTools` in `catalog.ts`,
  auto-published to the `tools` table at boot). The agent decides to call
  `remember` the way it decides to call any tool; "remember that I…" from the
  owner is just the agent obeying.
- **The table is the contract; the tool is one writer** (new). Recall reads the
  table, never the tool. A later background auto-extraction pass (the rejected
  Approach B) becomes a *second* writer into the same table with the read path
  untouched — so the write strategy is swappable/augmentable later without
  rework. This is the property that makes shipping the tool-only write safe now.
- **Read = automatic injection at context assembly, not a tool** (extends). A new
  `readMemoryFacts(db, userId, scope)` query helper in `packages/db/queries.ts`
  (sibling to `ensureConversation`) does a plain `SELECT`; `run.ts` folds the
  facts into the `[system]` block before the loop runs (`run.ts:114`). The model
  starts every run already knowing the facts — no "recall" tool, no round-trip.
  This is the `memory.read(scope)` of the TODO.
- **Recall-all, `scope='global'` only in v1** (new). Inject *all* global facts;
  no top-K, no relevance filter. The `scope` column is kept (default `'global'`)
  for future project / objective-scratchpad scopes (§7.7), but v1 reads only
  `'global'`. pgvector top-K retrieval is the one swap point in phase 2 — it
  replaces the body of `readMemoryFacts`, nothing else.
- **Memory write tools are `write`-tier, group `memory`** (reuses). `remember` /
  `forget` mutate durable state, so `write` is honest and auditable (every save
  is a `tool_calls` row); group-scoping means at most one approval prompt per run
  (first write prompts, rest auto-approve), and the owner can silence them
  entirely from the Tools page. `list_memories` is `read`-tier.
- **Provenance via `source_run_id`** (reuses). `buildRunTools` gains an optional
  `runId` so a saved fact records the run that created it (audit + the future
  objective-scratchpad seam). Nullable — `toolCatalog()`'s metadata build passes
  none.

## Goals

- Durable owner facts (preferences, names, recurring details) saved in one
  conversation are present in Alfred's context in every later conversation,
  across ingresses (the morning voice note is known in the evening web chat).
- The agent saves facts on its own judgment, and the owner can drive it
  ("remember that…", "forget that").
- Memory is inspectable and correctable: every save is in the `tool_calls` audit
  trail; `list_memories` + `forget` let the owner (via Alfred) review and prune.

## Non-goals

- **Embeddings / pgvector / semantic retrieval.** Phase 2 on the same table; the
  schema and the single `readMemoryFacts` seam are shaped for it (see below).
- **Background auto-extraction / summarization.** A possible later second writer
  into the same table — not v1 (per-turn cost, noise, dedup burden).
- **Similarity dedup.** v1 relies on recall-into-context plus a prompt nudge
  ("don't re-save what you already know"); real dedup is a phase-2 concern.
- **Scopes beyond `global`.** Project / objective scopes are reserved (the column
  exists) but unused in v1.
- **A memory management UI.** Managed through chat (`list_memories`/`forget`) and
  the existing Tools page (approval toggle); no new screen.
- **Multi-user.** Single owner (`OWNER_USER_ID`), like the rest of the system.

## Design

### Schema

A new `memoryFacts` table in `packages/db/src/schema.ts`, matching `DATABASE.md`
minus the deferred `embedding` column:

```
memory_facts
  id               uuid pk            (uuidv7, app-generated)
  user_id          uuid fk → users.id
  scope            text not null default 'global'
  text             text not null
  source_run_id    uuid fk → agent_runs.id   (nullable)
  created_at       timestamptz default now()
  updated_at       timestamptz default now()
  index (user_id, scope)
```

Migration `0009` creates it — no extension, no vector column. `DATABASE.md` is
updated: drop "PLANNED, NOT YET CREATED", note `embedding` lands with pgvector.

### Write — the `memory` tool family

A flat family from `makeMemoryTools(runId?: string): Tool[]`, built per run (it
closes over `runId`) and spread into `buildRunTools` alongside the others. Uses
`OWNER_USER_ID` and `scope='global'` internally (single-user).

| Tool | Tier | Args | Effect |
|------|------|------|--------|
| `remember` | write | `text` | INSERT a global fact (`source_run_id`, `user_id`) |
| `forget` | write | `id` | DELETE the fact by id |
| `list_memories` | read | — | `{ facts: [{ id, text }] }` — the id source for `forget` |

Results are objects with named arrays (never a bare array — the Gemini
function-response Struct, CHANGELOG 34). All three carry `group: 'memory'`. The
DB writes go through new `@alfred/db` helpers (`insertMemoryFact`,
`deleteMemoryFact`, `listMemoryFacts`) next to the existing query helpers.
`remember` caps `text` at ~500 chars so one runaway save can't bloat every
prompt; there is no count cap (recall-all is the point — revisit at phase 2).

`update_memory` is intentionally omitted in v1 — `forget` + `remember` covers
editing. No dedup on save: the recalled facts are already in the agent's context
and the system-prompt nudge tells it not to re-save what it knows; similarity
dedup waits for phase-2 embeddings.

### Read — automatic recall injection

`run.ts` context assembly changes from:

```ts
const history = [{ role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] }, ...rows]
```

to fold the facts into the system block:

```ts
const facts = await readMemoryFacts(db, OWNER_USER_ID, 'global')   // plain SELECT
const systemText = facts.length
  ? `${SYSTEM_PROMPT}\n\nWhat you remember about the owner:\n${facts.map((f) => `- ${f.text}`).join('\n')}`
  : SYSTEM_PROMPT
const history = [{ role: 'system', content: [{ type: 'text', text: systemText }] }, ...rows]
```

`readMemoryFacts` is the single seam phase-2 pgvector swaps: from "all global
facts" to "embed the latest user turn, return top-K by `embedding <=> $query`".

### Wiring

- `catalog.ts`: `makeMemoryTools(runId)` spread into `buildRunTools`;
  `toolCatalog()` (metadata only) builds with no `runId`. They publish to the
  `tools` table at boot automatically, appearing on the Tools page with the
  `memory` group.
- `buildRunTools(conversationId, askUserPause?, runId?)` — the new optional
  `runId` threads `run.id` through for `source_run_id`.
- `SYSTEM_PROMPT` gains one line: *"You have a long-term memory across
  conversations. Save durable facts about the owner with `remember`; recall is
  automatic, so don't re-save what you already know. Use `forget` to remove a
  fact."* (Full persona assembly, §7.5, stays a separate deferred refactor.)

### Phase 2 (pgvector) — out of scope, shape only

When the fact set outgrows the prompt: add `CREATE EXTENSION vector` + an
`embedding` column (migration), an `EmbeddingProvider` sibling in agent-core
(mirroring `ImageProvider`), embed on `remember` with cost via
`recordOutOfLoopLlmCall`, and swap `readMemoryFacts` to top-K vector search. None
of it touches the tool family or the injection site. The embedding dimension is
chosen with the model then, not fixed at 1536 now.

### Cost / growth note

v1 adds **no** new AI cost — recall is a `SELECT`, writes are `INSERT`/`DELETE`.
The only consequence is that every run's system prompt grows by the fact set
(cheap, and implicit context caching makes the repeated block cheaper still).
That growth is exactly the signal for phase 2: when injecting all facts stops
being negligible, switch the read path to top-K.

## Alternatives considered

- **Approach B — background LLM extraction.** A post-run pass (like
  `maybeAutoTitle`) extracts facts automatically with no agent tool. Rejected for
  v1: a per-turn cost on *every* run, prone to noise/duplicates needing dedup,
  and less controllable. Cleanly addable later as a second writer into the same
  table (the "table is the contract" decision), so nothing here forecloses it.
- **Approach C — full pgvector now.** Embedding provider + extension + vector
  index + top-K retrieval up front. Rejected as premature: embedding infra and
  retrieval tuning for a fact set that fits in the prompt anyway. It's the
  deliberate phase-2 upgrade, gated on real volume.
