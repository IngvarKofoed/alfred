# Alfred — Database Schema

Column-level data model for Alfred's Postgres database. This is the authoritative reference for table shapes; the surrounding data-layer rationale (why Postgres-only, pg-boss, LISTEN/NOTIFY, pgvector) lives in `ARCHITECTURE.md` §6, and the **state machines / invariants** that govern the `status` columns live in `ARCHITECTURE.md` §10.9.

Two logical schemas in the same Postgres database:

- `public` — application tables (owned by us, defined in Drizzle).
- `pgboss` — pg-boss's internal tables (auto-managed, we don't touch).

UUIDs everywhere (UUIDv7 for time-ordered IDs).

```
users
  id              uuid pk
  display_name    text
  created_at      timestamptz default now()
  -- A single row for now; schema is multi-user-ready so we don't have to
  -- refactor later.

conversations
  id              uuid pk
  user_id         uuid fk → users.id
  ingress         text       -- 'web' | 'discord' | 'voice' | 'trigger'
  channel_key     text       -- ingress-specific identifier
                             --   web:     <conversation uuid>
                             --   discord: <channel_id or DM channel>
                             --   voice:   <session uuid>
                             --   trigger: <trigger name>
  title           text       -- nullable, auto-generated from first message
  created_at      timestamptz default now()
  last_active_at  timestamptz default now()
  unique (ingress, channel_key)
  index (user_id, last_active_at desc)

messages
  id                uuid pk
  conversation_id   uuid fk → conversations.id
  role              text     -- 'user' | 'assistant' | 'tool' | 'system'
  content           jsonb    -- structured: text parts, attachments, tool_use, tool_result
  created_at        timestamptz default now()
  index (conversation_id, created_at)

agent_runs
  id                  uuid pk
  conversation_id     uuid fk → conversations.id
  trigger_message_id  uuid fk → messages.id, nullable
                              -- nullable because trigger ingresses have no user message
  status              text   -- 'pending' | 'running' | 'awaiting_approval'
                             -- | 'done' | 'failed' | 'cancelled'
  model               text   -- model id actually used
  prompt_tokens       int    default 0
  completion_tokens   int    default 0
  cost_usd            numeric(10, 6) default 0
  started_at          timestamptz
  finished_at         timestamptz
  error               text   -- nullable; set on failure
  index (conversation_id, started_at desc)
  index (status) where status in ('pending', 'running', 'awaiting_approval')
  -- one active run per conversation (the concurrency "actor", ARCHITECTURE §7.6):
  unique (conversation_id) where status in ('pending', 'running', 'awaiting_approval')

llm_calls                               -- one row per LLM provider call (observability)
  id                  uuid pk
  agent_run_id        uuid fk → agent_runs.id
  model               text
  request             jsonb         -- the Message[] sent to the provider (incl. the system message)
  tools               jsonb         -- nullable; function declarations offered this call (name/description/parameters)
  response_text       text
  response_tool_calls jsonb         -- nullable; tool_use calls the model returned this call (id/name/args)
  prompt_tokens       int default 0
  completion_tokens   int default 0
  cost_usd            numeric(10, 6) default 0   -- tokens × model price map (agent-core/pricing.ts)
  finish_reason       text          -- nullable
  latency_ms          int
  error               text          -- nullable
  created_at          timestamptz default now()
  index (agent_run_id, created_at)

tool_calls
  id                  uuid pk
  agent_run_id        uuid fk → agent_runs.id
  tool_name           text
  args                jsonb
  result              jsonb         -- nullable until completion
  trust_tier          text          -- 'read' | 'write' | 'destructive'
  status              text          -- 'pending' | 'awaiting_user' | 'running'
                                    -- | 'done' | 'rejected' | 'failed'
  started_at          timestamptz
  finished_at         timestamptz
  error               text
  index (agent_run_id, started_at)

user_interactions     -- any moment the run pauses for user input
  id                  uuid pk
  agent_run_id        uuid fk → agent_runs.id
  tool_call_id        uuid fk → tool_calls.id   -- the call that triggered this
  kind                text     -- 'approval' | 'question'
  prompt              jsonb    -- structured; shape depends on kind (see below)
  response            jsonb    -- structured; nullable until resolved
  status              text     -- 'pending' | 'resolved' | 'cancelled' | 'timed_out'
  resolved_via        text     -- nullable: 'web' | 'discord' | 'voice'
  created_at          timestamptz default now()
  resolved_at         timestamptz
  index (agent_run_id)
  index (status) where status = 'pending'
  -- partial index → fast "pending interactions" inbox lookup

tools                                 -- the worker-published tool catalog + owner approval setting
  name              text pk             -- tool name, e.g. 'navigate'
  tool_group        text                -- nullable; e.g. 'browser'
  trust_tier        text                -- 'read' | 'write' | 'destructive' (worker-published)
  description       text default ''
  require_approval  boolean             -- nullable tri-state: null = use trust_tier default,
                                        --   true = force approval, false = skip approval
  last_seen_at      timestamptz default now()  -- refreshed each boot publish
  updated_at        timestamptz         -- when the owner last changed require_approval
  created_at        timestamptz default now()
  index (tool_group)

memory_facts                          -- placeholder; expanded post-MVP
  id              uuid pk
  user_id         uuid fk → users.id
  scope           text                -- 'global' | 'project:<name>' | etc.
  text            text
  embedding       vector(1536)        -- nullable until pgvector is enabled
  source_run_id   uuid fk → agent_runs.id, nullable
  created_at      timestamptz default now()
  updated_at      timestamptz default now()
  -- Index on (user_id, scope) for retrieval. Vector index added when
  -- pgvector arrives.
```

## Design notes

- **`tools` is worker-published catalog + owner setting in one row.** The worker upserts the catalog columns (`tool_group`, `trust_tier`, `description`, `last_seen_at`) at boot from its live `Tool` instances — so the catalog can't drift from what actually runs, and runtime-discovered MCP tools (§7.3) publish the same way. `require_approval` is owner-owned (set from the web Tools page) and the boot upsert never touches it. It's a tri-state: `null` ⇒ use the trust-tier default (write/destructive ask, read runs free); `true`/`false` ⇒ explicit override. The worker reads these per run to build its approval predicate (§16). A tool removed from code leaves a stale row (its setting persists harmlessly); rows are not pruned.
- **`user_interactions` is a generic pause-for-user table** that handles two kinds today (`approval`, `question`) and can absorb new kinds later (clarification, multi-step wizard) without schema churn. Both kinds share the same machinery: create row, surface through ingresses, wait for resolution, resume the run.
- **Approvals and questions split because the trigger differs**:
  - *Approval* is **runtime-injected**: the worker, about to invoke a `write`/`destructive` tool, creates an approval interaction *before* the tool runs. If rejected, the tool never runs.
  - *Question* is **agent-initiated**: the agent calls a built-in `ask_user` tool whose `invoke()` creates a question interaction and waits for the response, then returns the structured answer as the tool result.
- **`tool_calls.status`** carries `awaiting_user` while an interaction is open. The `tool_calls ← user_interactions` link gives the full context of *why* the run is paused.
- **`messages.content` as JSONB**, not plain text. Lets a single message carry text, attachments, tool-use blocks, tool-result blocks — matches the structure the LLM API returns and avoids fan-out tables for every variant.
- **Token + cost accounting on `agent_runs`** (rolled up from `llm_calls`) so cost views don't have to walk per-call rows.
- **`llm_calls` is the observability trace** — one row per provider call capturing the full exchange: the request `Message[]`, the `tools` (function declarations) offered, the response text **and** any `response_tool_calls` the model returned, plus tokens, **cost**, latency, errors. Rolled up onto `agent_runs` and surfaced on the web `/debug` page (which also joins the run's `tool_calls` to show executed-tool results + approval outcomes). Per-call `cost_usd` is computed at insert from `tokens × model price` (the price map lives in `packages/agent-core/pricing.ts`, not the DB — see ARCHITECTURE §13); the run's `cost_usd` is the sum of its calls'. It's the in-Postgres alternative to Langfuse (ARCHITECTURE §17).
- **No `audit_log` table** — `agent_runs` + `tool_calls` + `user_interactions` form the audit log. Every action the agent took is a row with args, result, and (if applicable) the owner's response.
- **No `attachments` table yet** — file references go inline in `messages.content` as `{type: 'attachment', path: '...'}`. Promote to a real table the first time multiple messages need to share a file.
- **Status columns are governed by explicit state machines** — the legal transitions and cross-entity invariants for `agent_runs`, `tool_calls`, and `user_interactions` are specified in `ARCHITECTURE.md` §10.9, not left implicit in the runtime-flow prose of §10.

## Interaction prompt/response shapes

```ts
// Approval
prompt:   { summary: string; tool: string; args: object;
            trust_tier: 'read' | 'write' | 'destructive'; scope?: 'group' | 'call' }
            // trust_tier is usually write|destructive, but can be 'read' when the owner
            // forces approval on a read tool from the Tools page (the `tools` table, §16).
            // scope='group' ⇒ a task-scoped approval: granting it covers every call in the
            // tool's group (e.g. 'browser') for the rest of the run, not just this call
            // (ARCHITECTURE §16). Absent / 'call' ⇒ a single-call approval.
response: { approved: boolean; note?: string }

// Question (mirrors AskUserQuestion-style structured prompts)
prompt:   {
  question: string
  options: { label: string; description?: string }[]
  multi_select: boolean
  allow_freeform: boolean
}
response: {
  selected_labels: string[]     -- empty if freeform only
  freeform_text?: string
}
```
