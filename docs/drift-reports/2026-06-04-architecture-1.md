# Drift report — ARCHITECTURE.md — 2026-06-04

Reconciliation scope: **ARCHITECTURE only**. Most of the doc matched the code; the
edits made are summarized in CHANGELOG entry 36. This report records the findings
worth keeping after the conversation — specifically the **gaps where the doc promised
runtime behavior the code does not implement.**

None of these are "code drifted from a once-correct design" (the classic possible-bug);
in every case the feature was *never built* and the doc described it in present tense.
They are listed here because they're documented safety/robustness features the owner may
want to actually implement — the doc now marks them "planned," so a fresh agent won't be
misled, but the underlying capability is still owed.

## Documented-but-unbuilt runtime features

1. **No cost-cap enforcement (§10.7).**
   - *Doc said:* "Per-run cap (default $1, configurable). Checked after each LLM call.
     Exceeded: fail with `error='cost_exceeded'`."
   - *Reality:* per-call and per-run cost is computed and persisted
     (`llm_calls.cost_usd` → `agent_runs.cost_usd`, see `services/worker/src/run.ts`),
     but nothing checks it — no run is ever aborted for exceeding a budget. No
     `cost_exceeded` code path exists anywhere.
   - *Why it matters:* this is the safety valve for an always-on agent. A looping
     trigger or a prompt-injected instruction can run up unbounded cost. The layered
     run/objective/daily budgets in §7.7 build on this same missing cap.
   - *Where it'd go:* after each LLM call in the loop / worker, compare the run's
     accumulated `cost_usd` against a configured cap and fail the run.

2. **No LLM transient-error retry/backoff (§10.7).**
   - *Doc said:* "Provider abstraction retries with backoff: 1s, 2s, 4s, 8s. After 4
     attempts: fail run with `error='llm_unavailable'`."
   - *Reality:* `GeminiProvider` has no retry/backoff. A transient 5xx/429 propagates
     and fails the run immediately (captured raw in `agent_runs.error`).
   - *Why it matters:* a single transient provider hiccup kills a run that would
     have succeeded on retry — more painful once autonomous triggers run unattended.
   - *Where it'd go:* in the provider abstraction (wrap `stream`), or a retry decorator
     analogous to the existing `TracingProvider`.

## Lower-priority observations (handled in the doc, noted for completeness)

- **`context_overflow` detection not built (§7.5).** No pre-flight token/headroom check;
  an oversized history just fails as whatever the provider returns. Marked "not yet built."
  Low urgency — modern context windows rarely hit it, per the doc's own reasoning.
- **Persona is a hardcoded constant, not the documented file (§7.5).** `SYSTEM_PROMPT`
  in `services/worker/src/run.ts`, not `packages/agent-core/personas/alfred.md`. Marked
  as a deferred refactor (target = the file). Not a bug; just a relocation owed.
- **DATABASE.md `memory_facts` table is documented but not migrated.** Consistent with its
  "post-MVP placeholder" status; flagged only so it's not mistaken for an existing table.
  (DATABASE.md was out of scope this run — ARCHITECTURE only.)
- **`clients/web/CLAUDE.md` propagates the old §11 stack drift** (claims `@ai-sdk/react`
  `useChat` + TanStack Query). ARCHITECTURE §11 is now corrected; the per-subtree CLAUDE.md
  still needs the same fix (out of scope for a docs reconciliation, noted for follow-up).

## Not drift (verified correct)

- "22 built-in browser tools" (§8) is **accurate** — both reconciliation subagents
  miscounted (19/20) because the multi-line tool specs split their `name:` field across
  lines; a direct count of the `SPECS` array confirms 22.
- Browser bridge containment, trust tiers, tools-table override, pg-boss config
  (`retryLimit:0`, `expireInSeconds:4500`), the full table/column schema, and the
  agent-core loop/provider/tool interface all match the doc.
