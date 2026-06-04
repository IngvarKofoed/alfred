# Tool groups + group-scoped approval

Add an optional `group` field to the `Tool` interface so related tools can be treated as one unit, and use it to fix the browser's per-click approval fatigue (§16): the **first** browser action in a run prompts the owner with task-scoped copy ("allow Alfred to control the browser for this task"), and the rest of that run's browser actions auto-approve. The group label is also the seam for future per-conversation tool scoping (`tools_allowed`, §7.5), but that filter is **not** built here. Approval scope is per-run and in-memory, matching the fail-and-restart model (§7.6).

## Key decisions

- **`group?: string` on the `Tool` interface** (extends). One optional field added to `Tool` (`packages/agent-core/src/tool.ts`). Ungrouped tools (`echo`, `set_conversation_title`) are unaffected — each is its own implicit group of one.
- **Policy lives in the worker, not the loop** (reuses). The loop stays mechanical (`packages/CLAUDE.md`): it copies `tool.group` onto `ApprovalRequest` and calls `requestApproval` per write/destructive call exactly as today. The worker's gate decides whether a call is already covered by a granted group. agent-core never knows a group was pre-approved.
- **Per-run, in-memory grant** (new). An `approvedGroups: Set<string>` lives inside `runJob` and resets each run. No DB, no schema change. A crash drops the grant with the run (§7.6) — the behavior we want.
- **Every browser action is still individually logged** (reuses). Auto-approved calls still flow through `onToolStart`/`onToolEnd`, so `tool_calls` keeps a full per-action audit trail (§16). Only the *prompt* is suppressed, not the record.
- **Approval-card scope rides in the existing `jsonb`** (reuses). The interaction prompt gains a `scope` field inside `user_interactions.prompt` (already `jsonb`, no migration). The web card reads it to render a task-scoped message instead of a single-call one.
- **`tools_allowed` exposure filter is reserved, not built** (new, deferred). The `group` field is what a future `scopeTools(tools, allowed)` would filter on. Documented as a seam (§7.5); building it before there's a second tool source would be speculative.

## Goals

- Make browser automation usable: one approval per objective instead of one per click.
- Preserve the full audit trail — every browser action logged in `tool_calls` regardless of whether it prompted.
- Keep the agent loop policy-free; all approval policy stays in the worker.
- Lay the `group` seam that future per-conversation tool scoping will reuse.

## Non-goals

- **Persistent / cross-run grants.** Approval is per-run only (Approach A). Per-conversation or time-boxed grants (Approaches B/C) are explicit follow-ups, not this change.
- **The `tools_allowed` exposure filter.** Reserved as a documented seam; no filtering logic, no schema, no `conversations.tools_allowed` column here.
- **The structural browser containment from §16** (profile isolation, sensitive-domain gating). Still deferred. This change does not pretend to solve in-page prompt-injection risk.
- **Demoting browser reads to `read` tier.** Out of scope; all 22 browser tools stay `write`. Group-scoped approval makes their uniform tier bearable, which removes the pressure to split tiers now.

## Design

### agent-core: one field, threaded through

`Tool` gains an optional label (`packages/agent-core/src/tool.ts`):

```ts
export interface Tool {
  name: string
  description: string
  inputSchema: object
  trustTier: 'read' | 'write' | 'destructive'
  group?: string   // provenance/grouping label; the loop ignores it, the worker acts on it
  invoke(args: unknown): Promise<unknown>
}
```

`ApprovalRequest` (`packages/agent-core/src/loop.ts`) carries it so the worker's gate and the lifecycle hooks see it:

```ts
export interface ApprovalRequest {
  id: string
  name: string
  args: unknown
  trustTier: 'read' | 'write' | 'destructive'
  group?: string
}
```

The loop populates it where it builds the call (currently `loop.ts:75`):

```ts
const call: ApprovalRequest = { id: tc.id, name: tc.name, args: tc.args, trustTier, group: tool?.group }
```

That is the entire agent-core change. The per-call `requestApproval` invocation at `loop.ts:81` is unchanged — the loop does not know some groups are pre-approved.

### Browser tools tagged

`makeBrowserTools` (`services/worker/src/browser/tools.ts:106`) adds one line to each adapted tool:

```ts
group: 'browser',
```

All 22 become one unit.

### Worker: the per-run grant

In `runJob` (`services/worker/src/run.ts`), before `runAgent`:

```ts
// Per-run scope: a fresh set each run, matching fail-and-restart (§7.6) and §16's
// "approve the objective, not the primitive". Browser grant dies with the run.
const approvedGroups = new Set<string>()
```

Wrap the existing gate where `requestApproval` is wired into `runAgent`:

```ts
requestApproval: async (call) => {
  if (call.group && approvedGroups.has(call.group)) {
    return { approved: true }   // already granted this group this run — don't prompt
  }
  const verdict = await requestApproval(db, run.conversationId, runId, toolCallRowIds, call)
  if (verdict.approved && call.group) approvedGroups.add(call.group)
  return verdict
},
```

Only *successful* approvals are remembered (the `verdict.approved &&` guard): a rejected browser call rejects just that call, and the next browser action prompts again — the model may legitimately retry with args the owner would approve. There is no negative-cache. `evaluate_javascript` stays inside the `browser` group like every other browser primitive; it's `write` tier today, and splitting it out is trivial once a `destructive` browser tier exists.

Note: this only short-circuits the *prompt*. `onToolStart` (which inserts the `tool_calls` row) runs before `requestApproval` in the loop (`loop.ts:77` then `:81`), so an auto-approved browser action is still recorded with args, result, and status. The audit trail is intact.

### Worker: task-scoped prompt copy

The `requestApproval` function builds the interaction prompt (`run.ts`, the `userInteractions` insert). Make the summary group-aware and add a `scope` discriminator:

```ts
prompt: {
  summary: call.group === 'browser'
    ? 'Allow Alfred to control the browser for this task (navigate, click, type, read pages) until this run finishes?'
    : 'Run ' + call.name,
  tool: call.name,
  args: call.args,
  trust_tier: call.trustTier,
  scope: call.group ? 'group' : 'call',
},
```

`user_interactions.prompt` is already `jsonb` (DATABASE.md), so `scope` needs no migration. The `DATABASE.md` "Approval prompt shape" note should be updated to mention the optional `scope` field.

### Web: the approval card

The approval card (`clients/web`) reads the new `scope`. When `scope === 'group'`, render the task-scoped summary and make clear the approval covers the whole task, not just the one shown call (e.g. a subtitle: "Covers all browser actions for this task"). The displayed `tool`/`args` still show the *triggering* call so the owner sees what's about to happen first. When `scope === 'call'` (or absent), the card renders exactly as today.

### What stays the same

- The approval state machine (§10.9) is untouched — auto-approval returns a verdict to the loop without creating a `user_interactions` row, so there's no new transition.
- The 1h timeout, the LISTEN/NOTIFY resolution, the first-writer-wins resolve — all unchanged. They only run for the *first* browser action (the one that actually prompts).
- Ungrouped write/destructive tools (a future Gmail `send`) prompt per call exactly as today, because their `group` is undefined.

## Alternatives considered

- **B — Per-conversation, DB-backed grant.** Approve browser control once, persists across runs. Fewest prompts, but widens blast radius to the whole conversation and needs a schema change, a revoke/expiry story, and an interaction with the startup sweep. Deferred; A doesn't block it.
- **C — Time- or count-boxed grant** ("browser for 10 min / 20 actions"). A tuning knob for a problem we have no evidence of yet. Deferred.
- **Group-approval logic in the loop.** Rejected — `packages/CLAUDE.md` requires agent-core stay mechanical and policy-free. The worker owns approval policy.
