# Tools page + persisted per-tool approval settings

A Tools page in the web client that lists every tool the agent can run, grouped by its `group`, and lets the owner control whether each tool requires approval — per-tool and "toggle all in a group". The setting is persisted in Postgres and survives restarts. The worker is the single source of truth for the catalog: it **publishes** its live toolset to a `tools` table at boot (Approach B), the webserver reads that table, and the worker consults the owner's per-tool setting when deciding whether to gate a call for approval.

## Key decisions

- **Worker publishes the catalog at boot** (new). On startup the worker upserts one row per live tool (name, group, trust tier, description, `last_seen_at`) into a new `tools` table, derived from the actual `Tool` instances it would run — so there is no second metadata source to drift, and runtime-discovered MCP tools (§7.3) publish the same way built-ins do. The upsert preserves the owner's `require_approval` column.
- **`tools` table holds catalog + setting in one row** (new). `require_approval` is a nullable tri-state: `null` = use the trust-tier default, `true` = force approval, `false` = skip approval. Catalog columns are worker-owned; `require_approval` is owner-owned. A single table avoids a join on a single-user box; the boot upsert touches only catalog columns (`onConflictDoUpdate`), never `require_approval`.
- **Effective-approval rule lives in the worker** (extends). `loop.ts` stops hardcoding `trustTier !== 'read'`; `RunOptions` gains an optional `requiresApproval(call): boolean` predicate (default = current behavior). The worker supplies a settings-aware predicate, keeping approval *policy* in the worker per `packages/CLAUDE.md`.
- **Destructive tools default to approval but are overridable** (diverges). The owner may disable approval even for a `destructive` tool. This **diverges from §16** ("destructive actions always require approval, regardless"), a deliberate owner choice: it's the owner's box and the owner's risk. The predicate has no destructive special-case — destructive simply defaults to approval-on (like `write`) and the stored setting can flip it off. Implementing this **requires updating ARCHITECTURE §16** to record that destructive approval is now an owner-overridable default, not an invariant. The UI adds a confirm step before disabling approval on a destructive tool (see Design).
- **Group toggle = bulk per-tool write** (new). "Toggle all in group" writes `require_approval` for every tool in the group. No group-level row, so no tool-vs-group precedence puzzle. One endpoint handles single and bulk uniformly.
- **Composes with per-run group-scoped approval** (reuses). The persisted setting decides *whether a call enters the approval gate at all*. If it does, the existing per-run group grant (spec 2026-06-04-tool-groups-scoped-approval) still applies — first prompt, rest of the run auto-approved. Setting the whole `browser` group to "don't require approval" is the persistent form of that grant.
- **Setting is global, not per-conversation** (reuses). One Alfred identity (§7.5). Per-conversation *exposure* (`tools_allowed`) remains a separate reserved concern; this is approval, and it's global.

## Goals

- Let the owner see every tool the agent can run, grouped, and flip approval on/off per tool and per group.
- Persist that choice across worker/webserver restarts.
- Keep the webserver a pure Postgres reader (§9) and the gating policy in the worker.
- Stay correct as the toolset changes — including future MCP tools the worker discovers at runtime.

## Non-goals

- **Per-conversation tool scoping / exposure** (`conversations.tools_allowed`, §7.5). This page governs approval, not which tools a conversation can see.
- **Removing the per-run group-scoped approval.** It still runs underneath; this layers persistence on top.
- **Editing trust tiers from the UI.** Tiers are owner-assigned in code (§16); the page reads them, it doesn't rewrite them.
- **Cost caps / persona overrides / other runtime config.** §13.3 reserves those; out of scope here.

## Design

### Data model — `tools` table

Added to `packages/db` (DATABASE.md updated; Drizzle migration):

```
tools
  name              text pk        -- tool name, e.g. 'navigate'
  tool_group        text           -- nullable; e.g. 'browser' ('group' is awkward in SQL)
  trust_tier        text           -- 'read' | 'write' | 'destructive' (worker-published)
  description       text
  require_approval  boolean        -- nullable tri-state: null=default, true=force, false=skip
  last_seen_at      timestamptz    -- set on every boot publish; stale-row detection
  updated_at        timestamptz    -- when the owner last changed require_approval
  created_at        timestamptz default now()
```

### Worker — publish at boot

A `getToolCatalog()` helper returns metadata descriptors `{ name, group, trustTier, description }` for every tool the worker can run, derived from the real instances (`echoTool`, `BROWSER_TOOLS`, and `makeSetTitleTool(<placeholder id>)` — the title tool's metadata is independent of the conversation id it closes over). `index.ts`, right after starting the bridge, calls `publishToolCatalog(db, catalog)`:

```ts
for (const t of catalog) {
  await db.insert(tools)
    .values({ name: t.name, toolGroup: t.group ?? null, trustTier: t.trustTier,
              description: t.description, lastSeenAt: now })
    .onConflictDoUpdate({
      target: tools.name,
      set: { toolGroup: t.group ?? null, trustTier: t.trustTier,
             description: t.description, lastSeenAt: now },  // NOT require_approval
    })
}
```

Deriving the catalog from the live instances (not a hand-maintained list) is what kills drift.

### Worker — consult the setting per run

In `runJob`, before `runAgent`, load the settings into a map once:

```ts
const settings = new Map(
  (await db.select({ name: tools.name, requireApproval: tools.requireApproval }).from(tools))
    .map((r) => [r.name, r.requireApproval]),
)
const requiresApproval = (call: ApprovalRequest) =>
  settings.get(call.name) ?? call.trustTier !== 'read' // explicit override, else tier default
```

No destructive special-case: `destructive` defaults to approval-on (it isn't `read`), and an explicit `false` setting overrides it — the deliberate §16 divergence above.

`requiresApproval` is passed into `runAgent`. In `loop.ts`, the gate at line ~80 changes from `if (trustTier !== 'read')` to `if (opts.requiresApproval?.(call) ?? trustTier !== 'read')`. When the predicate returns `false`, the tool runs with no approval interaction (and no per-run group grant needed). When it returns `true`, control flows into the existing worker gate, which still applies the per-run group grant.

### Webserver — read + write (pure DB)

- `GET /api/tools` → all `tools` rows (the client groups by `tool_group`; ungrouped rows render individually). Returns `name, toolGroup, trustTier, description, requireApproval`.
- `PATCH /api/tools` → body `{ names: string[]; requireApproval: boolean | null }`. One endpoint serves both a single toggle (`names: ['navigate']`) and a group toggle-all (every name in the group). No tier restriction — destructive is overridable (above). Sets `updated_at`.

### Web — the Tools page

New `/tools` route + a "Tools" nav link in `App.tsx`'s header (alongside Chat / Debug). The page fetches `GET /api/tools`, groups rows by `tool_group`, and renders each group as a section with:

- A group header carrying a **toggle-all** control (reflects all-on / all-off / mixed; clicking sets every tool in the group via one `PATCH`).
- One row per tool: name, description, trust-tier chip, and an approval toggle.

The toggle is binary — "Require approval" on/off — showing the *effective* state (computed from `requireApproval ?? tier !== 'read'`). Flipping it persists explicit `true`/`false`. Destructive tools default to on but are toggleable; disabling approval on a `destructive` tool pops a confirm ("This tool can take irreversible actions without asking — are you sure?") before the `PATCH`, the one guard rail left after the §16 divergence. Styled on the existing espresso/brass theme tokens, consistent with the Debug page restyle.

## Alternatives considered

- **Approach A — static shared catalog in `packages/shared`.** Code-only, simplest mental model, but drifts when a tool is added without updating the catalog and structurally *cannot* represent MCP tools discovered at runtime (§7.3). Rejected — the architecture's "tools are interchangeable, built-in or MCP" premise makes the worker the only honest catalog source.
- **Approach C — webserver RPCs the worker live.** No webserver↔worker channel exists today (Postgres-only, §9); adding one is new infra for no gain. Rejected.
- **Separate `tool_settings` table keyed by name.** Cleaner owner/worker column ownership, but a needless join on a single-user box; one table with a preserved `require_approval` column is simpler.
