# ask_user — the question pause path

Wire up `ask_user`: a built-in tool the agent calls to ask the owner a structured question
mid-run. Calling it creates a `user_interactions` row of `kind='question'`, pauses the run
(exactly as an approval does), surfaces a question card in the web chat, and resumes with the
owner's answer fed back as the tool result. This is the agent-initiated sibling of the
runtime-injected approval flow (§7.3, §10.2, §6.2) — the same `user_interactions` machinery,
a different trigger. The pause is harness-side plumbing, not a model feature: like Claude's
`AskUserQuestion`, the model only emits a function call; the worker owns the wait.

## Key decisions

- **`ask_user` is a worker-built, context-bound tool** (extends). Built in
  `services/worker/src/tools.ts` and wired into `buildRunTools`, exactly like
  `makeSetTitleTool` / the file / python tools — it touches the DB, so it belongs in the
  worker where the DB connection lives, not in DB-free `agent-core`. The agent loop never
  learns about questions; it already blocks on any tool's `invoke()`.
- **Extract a shared `awaitInteraction` helper** (extends). The body of `requestApproval`
  in `run.ts` — set `tool_calls.status='awaiting_user'`, insert the pending
  `user_interactions` row, set `agent_runs.status='awaiting_approval'`, NOTIFY
  `interaction_required`, block on a dedicated LISTEN (+ timeout), read the response, set the
  run back to `running` — becomes `awaitInteraction({ kind, prompt, toolCallId })`.
  `requestApproval` becomes a thin caller (`kind='approval'`, maps the verdict);
  `ask_user`'s invoke is the other caller (`kind='question'`).
- **`ToolContext` gains `callId`** (extends). The only `agent-core` change. The loop already
  has `tc.id`; it passes `{ callId: tc.id, recordLlmCall }` into `invoke`. `ask_user` needs
  it to find its own `tool_calls` row (to flip it to `awaiting_user`, honoring invariant 2).
- **`ask_user` is `read`-tier** (new). Asking a question is not a side-effecting action, so
  it must not itself trigger an approval card before the question. `read`-tier tools run
  without approval, which is what we want.
- **The resolve route branches on the interaction's kind** (extends).
  `POST /api/interactions/:id` currently requires `{ approved }`. It now reads the row's
  `kind` first and validates/shapes the response accordingly: approvals keep
  `{ approved, note }`; questions take `{ selected_labels, freeform_text }`. First-writer-wins
  is unchanged (the conditional `UPDATE … WHERE status='pending'`).
- **NOTIFY `kind` widens to `'approval' | 'question'`** (extends). `events.ts`,
  `Chat.tsx`'s `RunEvent`, and the SSE handler all already carry a `kind` field that today is
  only `'approval'`.
- **`ask_user`'s `tool_calls` row follows `pending → awaiting_user → done`** (reuses). It is
  recorded `pending` in `onToolStart` (diverging from the read-tier "starts running"
  shortcut) so it walks the §10.9-sanctioned path for `ask_user` and keeps invariant 2 true
  during the pause.
- **Timeout reuses `APPROVAL_TIMEOUT_MS`** (reuses). One constant for now (§10.4 already says
  a distinct question timeout is intended-not-built). On timeout the tool returns a synthetic
  "no answer" result so the agent can adapt rather than hang.

## Goals

- The agent can ask the owner a structured question mid-run and get a clean, typed answer
  back as the tool result — single-select, multi-select, or free-form.
- Reuse the approval pipeline end to end: one `user_interactions` table, one pause/resume
  mechanism, one resolve route, one crash-sweep behavior (§10.5).
- The web chat renders the question inline (sibling to the approval card) and posts the
  answer; resolution clears it the same way `interaction_resolved` already does.

## Non-goals

- **Discord / voice surfacing.** The same NOTIFY reaches every ingress (§10.3), but only the
  web card is built here — Discord/voice are post-MVP ingresses.
- **A distinct question timeout** or per-question configurability (§10.4) — one constant.
- **Autonomous (`human_in_loop=false`) deferral** of questions (§7.7). Triggers aren't built;
  for MVP a human is always present, and the 1h timeout is the only fallback.
- **Provider-side constrained decoding** to force the model's option pick. Orthogonal nicety;
  the model picks via normal function-call args.
- **Multi-step / wizard interactions.** One question, one answer, one resume.

## Design

### The tool

`makeAskUserTool` in `worker/src/tools.ts`, built per run because it closes over a
run-bound pause function. Input schema (surfaced to the model), mirroring the
`AskUserQuestion` convention:

```ts
{
  question: string,                                   // required
  options?: { label: string, description?: string }[], // omitted ⇒ free-form question
  multi_select?: boolean,                             // default false
  allow_freeform?: boolean,                           // default true; model passes false to constrain to options
}
```

`invoke(args, ctx)`:

1. Validate `args` (non-empty `question`; if `options` present, non-empty `label`s).
2. Build the `prompt` jsonb in the `DATABASE.md` question shape
   (`{ question, options, multi_select, allow_freeform }`).
3. `const response = await pause(ctx.callId, prompt)` — the run-bound function from `run.ts`
   that calls `awaitInteraction`.
4. Return the structured answer as the tool result: `{ selected_labels, freeform_text }` on a
   real answer, or `{ error: 'no_answer', note: 'question timed out' }` on timeout/cancel.

The tool is registered in `buildRunTools` so it's published to the `tools` catalog (Tools
page). `toolCatalog()` builds it with a stub `pause` (metadata only; never invoked there).

### Wiring the pause into the run

`runJob` already owns `db`, `runId`, `conversationId`, and the `toolCallRowIds` map. It builds
the run-bound pause and threads it into `buildRunTools`:

```ts
const askUserPause = (callId: string, prompt: QuestionPrompt) =>
  awaitInteraction(db, {
    conversationId: run.conversationId,
    runId,
    toolCallId: toolCallRowIds.get(callId) ?? null,
    kind: 'question',
    prompt,
  }).then(toQuestionResponse)   // maps the resolved user_interactions.response row

const tools = buildRunTools(run.conversationId, askUserPause)
```

`buildRunTools(conversationId, askUserPause?)` gains the optional second arg.

`awaitInteraction` is the generalized `requestApproval` body: it returns the resolved
`user_interactions.response` (or a marker on timeout). `requestApproval` keeps mapping that to
`ApprovalVerdict`; `askUserPause` maps it to the question response shape.

### `onToolStart` and the `pending` status

`onToolStart` (run.ts:130) records the `tool_calls` row. Today it sets `running` for
no-approval tools. `ask_user` must start `pending` so it can legally transition to
`awaiting_user` inside `invoke`. The predicate becomes: `pending` if it requires approval
**or** it is `ask_user`; else `running`. (Cleanest: a small `startsPending(call)` check.)

### Resolve route

`POST /api/interactions/:id` (app.ts:256):

1. `SELECT kind` for the row (non-authoritative; the conditional UPDATE still guards the race).
2. `kind === 'approval'` → existing path (`{ approved, note }`, the `remember` side effect).
3. `kind === 'question'` → validate `{ selected_labels?: string[], freeform_text?: string }`,
   require at least one of them (or allow empty if the prompt allowed it), write
   `response = { selected_labels: [...], freeform_text }`, then the same conditional UPDATE +
   `interaction_resolved` NOTIFY. No `remember` for questions.

`GET /api/interactions/:id` is unchanged (already returns the whole row incl. `kind` + `prompt`).

### Web question card (`Chat.tsx`)

- `interaction_required` handler already fetches the interaction on receipt. Branch on
  `kind`: `'approval'` → existing approval card state; `'question'` → new question card state
  holding `{ interactionId, prompt }`.
- Render a card (sibling to the approval card, same espresso/brass styling): the question
  text, then options as radios (`multi_select=false`) or checkboxes (`true`), plus a text
  input when `allow_freeform`. A submit button posts
  `{ selected_labels, freeform_text }` to `/api/interactions/:id`.
- `interaction_resolved` clears the question card exactly as it clears the approval card.

### State machine (§10.9)

Unchanged transitions, now exercised by the question trigger:
`agent_runs`: `running → awaiting_approval → running` (the name covers questions per the §6.1
note). `user_interactions`: `pending → resolved | timed_out | cancelled`. `tool_calls` (for
`ask_user`): `pending → awaiting_user → done`. The crash sweep (§10.5) already cascades all
three, so a worker death during a question pause is handled with no new code.

## Resolved choices

- **`allow_freeform` defaults to `true`**, even when the model supplies `options` — the
  question card always offers a free-form box unless the model passes `allow_freeform: false`
  to constrain the answer to the listed options.
- **`ask_user` is published to the `tools` catalog** like every other tool, so it appears on
  the web Tools page; an owner forcing `require_approval=true` on it is a harmless accepted
  edge.
- **Timeout/cancel returns an error-shaped result** (`{ error: 'no_answer', note }`) so the
  model clearly sees the question went unanswered rather than mistaking it for an empty
  selection.

## Alternatives considered

- **Approach B — `ask_user` as a first-class `agent-core` built-in** calling a new
  `ctx.askUser(prompt)`, with an `onAskUser` loop hook the worker implements. More symmetric
  with `requestApproval`, but adds loop + `ToolContext` plumbing through `agent-core` for one
  tool and breaks the established precedent that DB-touching context-bound tools
  (`set_conversation_title`) live in the worker. Rejected for that asymmetry.
- **Loosen the tool_call coupling** — create the `user_interactions` row with
  `toolCallId=null` and skip the `awaiting_user` flip, avoiding the `ToolContext.callId`
  addition. Rejected: it violates invariant 2 (pause coupling) and loses the
  `tool_calls ← user_interactions` link that explains *why* a run is paused.
