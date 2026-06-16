# Autonomous Watchers

The fourth ingress category (ARCHITECTURE §9.4 / RUNTIME §7.7): jobs with **no human at the other end** that turn Alfred from a reactive chat agent into a quiet background operator — "watch this inbox," "check this page daily," "remind me Tuesday." A thin `alfred-triggers` scheduler fires jobs on time/events; the existing worker runs them through a **tiered detection ladder** (free deterministic gate → cheap-model triage → full action run) so cost concentrates only where there's real signal; and a new **durable notifications outbox + Web-Push `Notifier`** reaches the owner when nobody's watching a screen. This generalizes the TODO "Autonomous Watchers" + "Morning-briefing trigger" items into one framework.

## Key decisions

- **`alfred-triggers` is a pure scheduler, not a tool host** (extends — reserved process in DEPLOYMENT §5/§14, now built). It owns *timing only*: computes due triggers and enqueues jobs on the existing pg-boss queue. It does **not** import the tool layer — all tool execution stays in the worker, where the `Tool` instances + provider already live. This is what avoids double-wiring tools across two processes.
- **A fired trigger uses the same enqueue path as every ingress** (reuses §9). It creates an `agent_runs` row + `boss.send('agent-run')` with `ingress='trigger'`; the worker is otherwise unchanged — it doesn't know the job came from a trigger.
- **`triggers` table** (new) — the watcher definitions: kind, schedule, declarative gate, objective, notify policy, `last_seen_signal`, provenance. One row per watcher.
- **One persistent conversation per recurring watcher** (reuses `unique(ingress, channel_key)`, DATABASE.md). `channel_key = trigger id`, so every fire resolves to the *same* conversation; each fire is a new run appended. One-shot `schedule_self` instead appends to the **originating** conversation (reuses `createUserMessageRun`), never an orphan thread.
- **Continuity via an objective scratchpad, not history replay** (extends §6.4 / reuses `memory_facts.scope`). A watcher's progress lives in a dedicated memory scope (`scope='trigger:<id>'`), so a year of daily fires never replays a year of messages — the run loads a bounded scratchpad (§7.7).
- **Tiered detection ladder** (new) — Tier 0 free deterministic gate, Tier 1 cheap-model triage, Tier 2 full action run. All three consume the **same `Tool` instances**; the only difference is the driver (Tier 0 = deterministic code, Tier 1/2 = a model).
- **Tier 0 gate calls `tool.invoke()` directly, read-tier only** (reuses the `Tool` interface; new invariant). No LLM. Calling `invoke()` directly bypasses the loop's approval gate — *safe only because the gate is restricted to `read`-tier tools* (detection is read-only by construction).
- **`DETECTION_MODEL` config knob** (new — the §7.4 cost/latency-routing seam). The cheap triage model (e.g. `gemini-2.5-flash-lite`), set per-run via the existing provider abstraction.
- **`escalate` / `dismiss` decision tools** (new) — Tier 1's only two outcomes; `escalate`'s args seed the Tier-2 objective. The MVP triage is a no-tool **classifier** call (attributed out-of-loop like `auto_title`, so `agent_runs.model` stays the action model); the tool-using **mini-agent** flavor is a documented extension.
- **`agent_runs.human_in_loop`** (new column, extends §7.7) — derived from `ingress` (`trigger` ⇒ false). Selects overflow + approval behaviour at the edges.
- **Notifications are a durable outbox + pluggable `Notifier`, not SSE** (new). `LISTEN/NOTIFY`+SSE is fire-and-forget live streaming — dropped when no client is connected, which is exactly when a watcher fires. The outbox is the push transport for events the system already emits (`interaction_required`/`done`); the push is a thin doorbell that **deep-links into the existing `/conversation/:id`** (reuses the whole chat/approval UI).
- **Web Push impl** (new deps: `web-push` + `vite-plugin-pwa` + VAPID keys). Covers the web PWA (incl. installed PWA on iOS 16.4+). Native iOS APNs is a deferred follow-on (Non-goals).

## Goals

- A watcher can fire on a schedule or a polled event, run autonomously, and reach the owner out-of-band.
- Cost is proportional to *signal*, not to *poll frequency* — idle watchers cost ~nothing.
- Autonomous runs reuse the existing worker, run model, approval flow, and chat UI unchanged wherever possible.
- A write/destructive action in an unattended run still pauses for approval, surfaced as a push (§7.7).
- Everything a watcher does is auditable (`agent_runs`/`tool_calls`/`notifications` rows) and the owner can disable any watcher.

## Non-goals

- **Native iOS APNs push.** Web Push covers the web PWA only; the native app keeps its best-effort local notifications until a dedicated APNs spec.
- **Other transports** (ntfy, Discord DM, email-as-push). The `Notifier` interface leaves room for them; only Web Push is built here. (Email *summaries* via the agent's existing `send_email` tool are always available as run output regardless.)
- **The full §7.7 layered budget** (objective/daily caps). The ladder is the per-run cost control; the standing caps are the separate "Cost & Risk Governor" TODO.
- **A watcher-management *UI*.** The agent manages triggers via the `triggers` tool family — `schedule_self` (create), `list_triggers` (read-tier), `disable_trigger`/`delete_trigger` (write-tier, approval-gated) — and direct rows; a web Watchers *page* is the follow-on.
- **Pushing for interactive runs when no client is connected.** Only `human_in_loop=false` (trigger) runs push; surfacing a backgrounded approval/result from a normal web/iOS run needs client-presence detection, deferred.
- **Mid-run durable resume.** Trigger runs are fail-and-restart like every other run (§7.6).

## Design

### The trigger process & table

`alfred-triggers` (new pm2 process, `services/triggers/`) loads enabled `triggers` rows at boot and schedules them:

- **`kind='schedule'`** — a cron expression via pg-boss `boss.schedule()` (available, not yet used; §6.3). The simplest watcher: fires at a fixed time, no gate (e.g. an 8am briefing — `gate=null` ⇒ always escalate).
- **`kind='inbox'`** — a poll cadence (also a cron/interval); each tick enqueues a `trigger-detect` job.
- **`kind='webhook'`** — fired by `POST /api/triggers/:id/webhook` on the existing webserver (no new listener process); the route enqueues a `trigger-detect` job.
- **`kind='self'`** — a one-shot future run created by the `schedule_self` tool; fires once at `next_fire_at`.

```
triggers
  id              uuid pk
  user_id         uuid fk → users
  name            text                  -- human label
  kind            text                  -- 'schedule' | 'inbox' | 'webhook' | 'self'
  enabled         boolean not null default true
  conversation_id uuid fk → conversations  -- persistent watcher conversation (recurring);
                                        --   null for 'self' (carries originating conv instead)
  schedule        text                  -- cron expr / poll cadence; null for webhook/self
  gate            jsonb                 -- Tier-0: { tool, args, signal } ; null ⇒ always-fire
  triage          jsonb                 -- Tier-1: { enabled, model?, prompt? } ; null ⇒ skip to action
  objective       text                  -- Tier-2 seed prompt
  notify_policy   text                  -- 'always' | 'on_change' | 'on_threshold' | 'digest'
  last_seen_signal jsonb                -- gate diff state
  next_fire_at    timestamptz
  last_fired_at   timestamptz
  detection_cost_usd numeric(10,6) default 0  -- cumulative dismissed-detection cost
  source_run_id   uuid fk → agent_runs  -- nullable; provenance for agent-scheduled triggers
  created_at / updated_at
```

The scheduler is thin enough to be fail-and-restart: on boot it re-reads enabled rows and re-registers schedules; a missed tick during downtime just fires late.

### Firing → the run (conversation model + scratchpad)

Each due trigger enqueues a **`trigger-detect`** job (a second job type alongside `agent-run`). The worker's `trigger-detect` handler runs Tier 0 → Tier 1 and, only on escalation, creates the Tier-2 `agent_runs` row and `boss.send('agent-run')` — the unchanged run path. So **detection never creates an `agent_runs` row** (no row-litter from idle polls); only an *action* does.

The Tier-2 run resolves its conversation via `ensureConversation('trigger', '<trigger id>')` for recurring watchers (one persistent thread, `last_active_at` bumped) or the carried `conversation_id` for `schedule_self`. It is created with `human_in_loop=false`. Context assembly (§7.5) folds the trigger's scratchpad scope (`readMemoryFacts(db, userId, 'trigger:<id>')`) into the `[system]` block instead of replaying the full conversation history, keeping the prompt bounded no matter how long the watcher has run. The run uses the existing `remember`/`forget` tools (scoped to `trigger:<id>`) to update its own scratchpad.

**Serialization:** the one-active-run-per-conversation index (§7.6) means a recurring watcher's fires are naturally serial. If a fire is due while the previous run is still active (e.g. parked on an approval), the detect handler **skips/coalesces** — it does not queue a second run (which the index would reject anyway). A skipped fire is logged, not lost: the next tick re-evaluates the gate.

### The tiered detection ladder

```
trigger-detect job  (worker; NO agent_runs row)
  │
  ├─ Tier 0  DETERMINISTIC GATE  ── free, no LLM
  │     pick the read-tier Tool by name → tool.invoke(gate.args)
  │     reduce result to a comparable signal (gate.signal: e.g. max IMAP UID / unread count / text hash)
  │     diff vs triggers.last_seen_signal
  │        unchanged → ack job, done.  (the silent free path)
  │        changed   → persist new signal, continue
  │     (gate.tool MUST be read-tier — enforced; invoke() here bypasses the loop's approval gate)
  │
  ├─ Tier 1  CHEAP-MODEL TRIAGE  ── DETECTION_MODEL, strict prompt
  │     classifier (MVP): one call over the changed item → escalate | dismiss
  │        dismiss  → bump triggers.detection_cost_usd, done. (no notification, unless digest)
  │        escalate → continue; escalate.hint seeds the objective
  │     mini-agent (extension): same but with a read-only toolset to pull more context first
  │
  └─ Tier 2  ACTION RUN  ── create agent_runs row + boss.send('agent-run')
        strong model + full tools + normal approval gates + the real objective
        on done → write result message; if notify-worthy → outbox row (§notifications)
```

**Tool reuse (the load-bearing point).** Tier 0 calls the *same* `Tool` instance the agent uses — e.g. for an inbox watcher, the `list_emails` tool's `invoke()` — and reduces its structured result to a signal. Tier 1/2 give the *same* tools to a model. There is no separate IMAP-core path; the `Tool` is the reusable unit. The gate config is declarative:

```jsonc
// inbox watcher gate
{ "tool": "list_emails", "args": { "unread": true, "limit": 10 }, "signal": "maxUid" }
```

`signal` names a small built-in reducer (`maxUid` | `count` | `hash`) applied to the tool result — extensible, but a closed set keeps untrusted config from running arbitrary code. Choose by intent: **`maxUid`** is a monotonic high-water mark — it fires only on *new arrivals* and never re-fires when items are read/removed (the right signal for a new-mail/new-item watcher); **`count`** diffs in *both* directions, so it also fires when the quantity drops (e.g. you read a mail) — only use it when a decrease is itself worth firing on; **`hash`** fires on any content change (a watched page).

**First poll establishes the baseline silently.** A fresh watcher has `last_seen_signal = NULL`; the first observation persists the signal and returns *no change* rather than escalating, so the watcher fires on what's *new after it's set up*, not on the pre-existing backlog you already had. (A degenerate reduction — `maxUid → null` / `count → 0`, i.e. "saw nothing", e.g. a transient empty/error tool result — never persists, so it can't clobber a good high-water mark or be mistaken for a baseline.) If you instead want to act on the current state once, use a one-shot (no-gate) trigger now plus the gated watcher for the future.

**Cost.** A detection call is ~1.5k in / ~100 out — sub-$0.001 even at flash rates, less on `flash-lite`. With Tier 0 in front, the cheap model only runs when the signal actually changed, so an idle inbox watcher costs nothing and a busy one costs pennies/month. The ladder *is* §7.7's escalation-rules idea in miniature.

### Notifications (outbox + `Notifier` + Web Push)

A new durable outbox + a pluggable sender, because SSE can't reach a disconnected owner.

```
notifications
  id              uuid pk
  user_id         uuid fk → users
  conversation_id uuid fk → conversations   -- deep-link target (nullable)
  agent_run_id    uuid fk → agent_runs       -- nullable
  interaction_id  uuid fk → user_interactions -- nullable (approval/question notifications)
  kind            text     -- 'result' | 'approval' | 'question' | 'error'
  title           text
  body            text     -- thin; the full content lives in the conversation
  deep_link       text     -- e.g. '/conversation/<id>'
  status          text     -- 'pending' | 'sent' | 'failed' | 'read'
  created_at / sent_at
  index (status) where status = 'pending'

push_subscriptions             -- Web Push registrations (one per device/browser)
  id, user_id fk, endpoint text, keys jsonb (p256dh, auth), user_agent text, created_at
```

`Notifier` is a sibling of `LlmProvider`/`SttProvider`/`TtsProvider` in `packages/agent-core`:

```ts
interface Notifier { send(n: NotificationPayload): Promise<void> }
// impl: WebPushNotifier (web-push lib + VAPID); future: NtfyNotifier, DiscordNotifier, ...
```

**Flow.** When a worker run (a) finishes with a notify-worthy result per the trigger's `notify_policy`, or (b) raises an interaction while `human_in_loop=false`, it writes a `notifications` row and `NOTIFY notifications`. A dispatcher (in the worker — it has db + can POST to the push service) LISTENs, loads the row, and sends to every `push_subscriptions` row for the user via the `WebPushNotifier`; on success marks `sent`, on a `410 Gone` prunes the dead subscription. The payload is thin — title + `deep_link` — because tapping opens `/conversation/:id` where the full result and the existing approval card already render over normal SSE/REST.

**Web PWA pieces** (`vite-plugin-pwa`, finally installed): a service worker handling `push` → `showNotification`, and `notificationclick` → focus/open the `deep_link`. The webserver exposes the VAPID public key, serves the SW, and adds `POST /api/push/subscribe` (the PWA registers after the owner enables notifications in Settings — the one permission prompt).

**Noise control.** `notify_policy` decides whether a finished detection writes an outbox row at all: `always` (briefings), `on_change` (any escalation), `on_threshold` (Tier-1 urgency ≥ N), `digest` (accrue to the scratchpad, emit one summary on a schedule). Only `notify=true` results push.

### Approval & questions while unattended

§7.7 already specifies the behaviour; this wires it. A `write`/`destructive` tool in a `human_in_loop=false` run pauses exactly as today (creates the `user_interactions` row, NOTIFYs `interaction_required`) **and** writes a `notifications` row of `kind='approval'`. The owner taps → the existing approval card resolves it via `POST /api/interactions/:id`, first-writer-wins (§10.3) across any device. The timeout uses a longer `AUTONOMOUS_APPROVAL_TIMEOUT_MS` (vs the 1h interactive `APPROVAL_TIMEOUT_MS`, §10.4); on timeout the run fails loudly and emits an `error` notification. Open-ended `ask_user` questions have no synchronous human, so per §7.7 they defer the objective (record to the scratchpad, end the run) rather than block.

### Config & schema changes

- **Migration 0010** — `triggers`, `notifications`, `push_subscriptions` tables; `agent_runs.human_in_loop boolean not null default true`.
- **Config keys** (`packages/shared/config.ts`): `DETECTION_MODEL` (optional; default = `GEMINI_MODEL`), `AUTONOMOUS_APPROVAL_TIMEOUT_MS` (default e.g. 24h), `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (optional; Web Push inert if unset, like the email keys).
- **`ecosystem.config.cjs`** — add `alfred-triggers`.
- **New built-in tool** `schedule_self(when, objective, gate?, notify_policy?)` (group `triggers`) in `buildRunTools` — inserts a `triggers` row with `source_run_id` = current run and `conversation_id` = the originating conversation. **Not approval-gated** (owner's decision): scheduling a future run is low-risk because that run gates every *action* itself, so the tool is published `read`-tier to run free by default. The `read` tier is a deliberate "no approval" choice, not a literal no-side-effects claim (it does write one `triggers` row); the owner can still flip it to ask via the Tools page.
- **Management tools round out the `triggers` family** — `list_triggers` (read-tier; the owner's watchers + ids), `disable_trigger` and `delete_trigger` (write-tier ⇒ approval-gated, owner-overridable, so a prompt-injected agent can't silently kill the owner's watchers). Disable is reversible (keeps the row + scratchpad + history, frees the `schedule_self` cap); delete is permanent. Helpers are owner-scoped + UUID-guarded (`setTriggerEnabled`/`deleteTrigger`, mirroring `deleteMemoryFact`). Both cost paths are visible: `list_triggers` returns each watcher's `detection_cost_usd`, and `/debug` has a **Watchers panel** (`GET /api/debug/triggers`) showing per-watcher detection spend + the escalated action-run aggregate (count/tokens/cost) + a total. A `run_trigger(id, mode?)` tool (read-tier) fires a watcher on demand for testing — `mode:'now'` (a `force` flag on the `trigger-detect` job) skips the gate/triage and runs the objective immediately, `mode:'detect'` runs the ladder now — so a fresh watcher needn't wait on its schedule.

### Safety / blast radius (§16)

The cheap detector reads untrusted content (email bodies, pages) — the prompt-injection surface — but is **read-only and powerless**: its only outputs are `escalate`/`dismiss`. Worst case is a spurious escalate (wasted cost) or a malicious `dismiss` (a *missed* detection — silent, denting "fail loudly"; mitigated by Tier 0 in front, so "something arrived" is still recorded even if the model is talked out of escalating). The detector **cannot** send/move/delete — any such action belongs to Tier 2 and still hits the approval gate. The strict triage prompt frames read content as data, never instructions. The Tier-0 read-tier-only invariant is enforced at gate-execution (a non-read `gate.tool` is a config error, refused).

## Alternatives considered

- **Tier 0 in `alfred-triggers` (calling tools directly there).** Avoids the per-poll `trigger-detect` job, but forces the tool layer to be importable by a second process — and bridge-dependent tools (browser) can't run outside the worker (the WS bridge is worker-embedded, §8). Rejected: keeping all tool execution in the worker is the real "no double implementation" win; the extra job is cheap (no row, no LLM on no-change).
- **One run that swaps models mid-flight (detection → action in a single `agent_runs`).** Tidy as one audit row, but muddies `agent_runs.model` (loop calls on two models) and couples detection serialization to the action slot. Rejected for the cleaner detect-then-spawn split; Tier-1 cost still rolls into the spawned run via the out-of-loop attribution path (`recordOutOfLoopLlmCall`).
- **Skip the ladder; every fire is a full run.** Simpler, but a 5-minute inbox watcher then burns a strong-model run every poll — the cost problem the ladder exists to solve.
- **Notifications over SSE/NOTIFY only.** Already how live streaming works; useless for the disconnected case that defines a watcher. The durable outbox is the whole point.
