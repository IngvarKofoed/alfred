import {
  type ApprovalRequest,
  type ApprovalVerdict,
  computeCostUsd,
  type ContentPart,
  GeminiProvider,
  isImageResult,
  type LlmProvider,
  type LlmTrace,
  makeTtsProvider,
  type Message,
  RetryProvider,
  runAgent,
  speechLlmCallFields,
  TracingProvider,
  type TtsProvider,
} from '@alfred/agent-core'
import { agentRuns, conversations, getDb, getTrigger, insertNotification, llmCalls, messages, OWNER_USER_ID, pgNotify, readMemoryFacts, recordOutOfLoopLlmCall, toolCalls, tools as toolsTable, userInteractions } from '@alfred/db'
import { loadConfig } from '@alfred/shared'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import pg from 'pg'
import { writeAudioToWorkspace } from './audio.js'
import { buildRunTools } from './catalog.js'
import { notifyRun } from './events.js'
import { type ImageRef, writeImageToWorkspace } from './images.js'
import { rowsToMessages, textOf } from './messages.js'

// MVP approval window (§10.4): a deliberate shortening of the 24h default. The pg-boss
// lease sits just above it so a job blocked on approval outlives the timeout.
const APPROVAL_TIMEOUT_MS = 60 * 60 * 1000

// Voice TTS (run.speak, spec 2026-06-14): flush a sentence to synthesis once it ends on a
// .!?/newline boundary AND is at least this long, so a tiny fragment ("Hi.") still speaks but
// an abbreviation mid-sentence doesn't trigger a premature, choppy clip.
const TTS_MIN_SENTENCE_CHARS = 12

// Strip light markdown so the spoken text reads as plain prose, not symbols ("star star bold").
// Best-effort and conservative — emphasis/heading/code markers, link/image syntax (keep the
// visible label, drop the URL). Not a full markdown parser; the model's prose is mostly plain.
function stripMarkdownForSpeech(text: string): string {
  return (
    text
      // images then links: ![alt](url) / [label](url) -> alt / label
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // fenced/inline code fences -> drop the backticks, keep the content
      .replace(/`+/g, '')
      // emphasis/bold markers and leading heading hashes/blockquote markers
      .replace(/[*_~]+/g, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

// Minimal system prompt for now; full persona assembly (§7.5) is deferred.
const SYSTEM_PROMPT =
  'You are Alfred, a helpful personal assistant. Be concise and direct. ' +
  'Images you create with generate_image are shown to the user automatically; ' +
  "don't thank the user for them or describe them back unless asked. " +
  "You can run Python in this conversation's working directory with run_python (the same directory " +
  'the file tools use) and install packages with pip_install. ' +
  'You can list/search/read the owner’s inbox (list_emails, search_emails, read_email), save drafts, ' +
  'and send mail — sending asks the owner first. ' +
  'You have a long-term memory across conversations: save durable facts about the owner with remember; ' +
  "recall is automatic, so don't re-save what you already know. Use forget to remove a fact."

// Render the run's [system] text: the static persona prompt plus, when present, a global-recall
// block (long-term memory spec) and — for a recurring watcher run — the watcher scratchpad block
// (the objective scratchpad, §7.7). Kept a named seam rather than inlined so the deferred §7.5 work
// (identity block + persona file) has one place to compose the system message instead of having
// to untangle a concatenation. `scratchpad` is empty for an interactive (and 'self' one-shot) run.
//
// `isTrigger` frames any unattended run (no human live); `watcherId` is set ONLY for a recurring
// watcher (which owns a `trigger:<id>` scratchpad scope) — its remember/forget already write that
// scope (the tools are scope-bound), so we tell the model to record progress with remember WITHOUT
// naming the scope (a one-shot 'self' run has no scratchpad, so it never gets that instruction).
function systemTextWithMemory(
  facts: { text: string }[],
  scratchpad: { text: string }[] = [],
  opts: { isTrigger?: boolean; watcherId?: string } = {},
): string {
  let text = SYSTEM_PROMPT
  if (opts.isTrigger) {
    // Frame the autonomous run: no human is watching live, be decisive, actions still gate.
    text +=
      '\n\nThis is an autonomous background run with no human watching live. Be decisive; ' +
      "any action that sends, deletes, or changes things still pauses for the owner's approval."
    if (opts.watcherId) {
      // A recurring watcher: the scratchpad is the continuity mechanism, and remember/forget on
      // this run carry progress forward (no full-history replay). The tools are already scoped to
      // this watcher, so don't name a scope the model would otherwise mis-type.
      text +=
        ' Record progress and next steps with remember so future runs of this watcher continue ' +
        'where you left off.'
    }
  }
  if (facts.length > 0) {
    text += `\n\nWhat you remember about the owner:\n${facts.map((f) => `- ${f.text}`).join('\n')}`
  }
  if (scratchpad.length > 0) {
    text += `\n\nYour notes on this watcher so far:\n${scratchpad.map((f) => `- ${f.text}`).join('\n')}`
  }
  return text
}

export interface RunDeps {
  provider?: LlmProvider
}

// Sentinel thrown by awaitInteraction when an approval pause times out (vs. resolves to a
// rejection). An interactive run never sees this — its caller maps a timeout to the same
// not-approved verdict as today. An UNATTENDED (trigger) run lets it propagate so the run takes
// the failed path and emits an 'error' notification (spec line 153 / §7.7 "fail loudly"), rather
// than silently feeding { approved:false } to a model with no human behind it.
class ApprovalTimeoutError extends Error {
  constructor() {
    super('approval timed out')
    this.name = 'ApprovalTimeoutError'
  }
}

// One place the notifications-outbox write + its NOTIFY 'notifications' doorbell live, so the
// write+notify coupling can't drift across the ~4 call sites (pause / result / error). The
// dispatcher LISTENs 'notifications', loads the pending row, and pushes it (spec "Notifications").
async function notifyOutbox(
  db: ReturnType<typeof getDb>,
  params: Parameters<typeof insertNotification>[1],
): Promise<void> {
  await insertNotification(db, params)
  await pgNotify('notifications', '')
}

// Advance one run to completion: load history, run the loop streaming tokens over NOTIFY,
// persist the assistant turn, and move the run to done/failed. Idempotent on status. A
// route-cancelled run (§10.6) is left exactly as the cancel route wrote it — the worker
// only aborts promptly and tops up tokens/cost.
export async function runJob(runId: string, deps: RunDeps = {}): Promise<void> {
  const db = getDb()

  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId))
  if (!run || run.status !== 'pending') return // already handled / cancelled

  // The conversation backs the autonomous-watcher decisions (spec): its `ingress` distinguishes a
  // trigger run (alongside run.humanInLoop, set false only by createTriggerRun), and — for a
  // RECURRING watcher only — its `channelKey` is the trigger id (so we can look the trigger up for
  // the scratchpad scope + notify policy).
  const [conv] = await db
    .select({ ingress: conversations.ingress, channelKey: conversations.channelKey })
    .from(conversations)
    .where(eq(conversations.id, run.conversationId))
  // Trigger run: no human is watching (run.humanInLoop=false, or a 'trigger'-ingress conversation).
  // Selects bounded context, a longer approval timeout, deferred ask_user, and out-of-band push (§7.7).
  const isTrigger = !run.humanInLoop || conv?.ingress === 'trigger'

  // Robustly derive watcher-ness for the scratchpad (spec §7.7). A RECURRING watcher's conversation
  // IS the watcher: getTrigger(conv.channelKey) resolves a 'schedule'|'inbox'|'webhook' row, so it
  // owns a scratchpad scope `trigger:<id>` and uses the trigger's notify policy. A one-shot 'self'
  // run is unattended too, but runs on the ORIGINATING (web) conversation — channelKey is not a
  // trigger id, getTrigger returns undefined — so it gets NO scratchpad scope (the agent must not be
  // told to remember to a `trigger:<uuid>` scope nothing can resolve) and notifies on result with
  // an implicit 'always' policy. Resolved up front so the scratchpad recall + the memory tools'
  // scope + the result-notify policy all key off the same, correct fact.
  const watcher =
    isTrigger && conv?.channelKey ? await getTrigger(db, conv.channelKey).catch(() => undefined) : undefined
  // Only a recurring watcher (not a 'self' one-shot) keeps a durable scratchpad.
  const watcherId = watcher && watcher.kind !== 'self' ? watcher.id : undefined
  // The memory scope the run's remember/list_memories operate on: the watcher's scratchpad for a
  // recurring watcher, the owner's global memory otherwise (interactive AND 'self' runs).
  const memoryScope = watcherId ? `trigger:${watcherId}` : 'global'

  // Autonomous runs pause for approval far longer than the 1h interactive window — the owner may
  // be asleep when a watcher fires (§7.7 / spec "Approval & questions while unattended").
  const { AUTONOMOUS_APPROVAL_TIMEOUT_MS } = loadConfig()
  const approvalTimeoutMs = isTrigger ? AUTONOMOUS_APPROVAL_TIMEOUT_MS : APPROVAL_TIMEOUT_MS

  // One AbortController per run (§10.6). The cancel ROUTE owns the terminal write + cascade
  // and NOTIFYs {type:'cancelled'}; the worker's only cancellation job is to abort the
  // in-flight work and finalize without touching what the route wrote.
  const controller = new AbortController()
  let unwatch: (() => Promise<void>) | undefined
  // Serialize NOTIFYs so tokens reach the client in order (onText is synchronous). Declared
  // BEFORE the try so the catch can drain it before the `error` NOTIFY — the success path drains
  // it before `done` (below) and the cancel path is client-guarded, so `error` is otherwise the
  // one terminal event that could let a queued `usage` snapshot land after it (stranding the
  // client: composer stuck busy / footer double-counting).
  let notifyChain: Promise<void> = Promise.resolve()

  try {
    // Start the watcher BEFORE the pending->running flip so there is no notify gap: a cancel
    // landing before the LISTEN already made the run terminal (so the guarded flip below
    // loses and we bail), and a cancel landing after it fires the watcher. A watcher that
    // fails to start lands in the catch below as an honest run failure.
    unwatch = await watchForCancel(run.conversationId, () => controller.abort())

    // Guarded flip (§10.9, terminal states are absorbing): a pre-pickup cancel already wrote
    // 'cancelled' — losing here means never resurrect a terminal run.
    const flipped = await db
      .update(agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'pending')))
      .returning({ id: agentRuns.id })
    if (flipped.length === 0) return // a cancel won the pre-pickup race

    // Memory recall (spec docs/specs/2026-06-15-long-term-memory.md): the memory.read(scope)
    // seam — fold the owner's durable facts into the system block so the model starts every run
    // already knowing them (no recall tool, no round-trip). readMemoryFacts is the SINGLE point
    // phase-2 pgvector swaps (all facts -> top-K by embedding distance); nothing else here moves.
    // Run CONCURRENTLY with the history load — independent queries, both on the pre-loop critical
    // path — and BEST-EFFORT: a recall failure degrades to no-recall rather than failing the run
    // (history is essential, memory an enhancement). Injecting into the system message is safe for
    // maybeAutoTitle, which builds its own titleMessages and only reads history via find(role==='user').
    //
    // For a TRIGGER run (autonomous-watchers spec §7.7 "Continuity via an objective scratchpad,
    // not history replay") we ALSO read the watcher's scratchpad scope (`trigger:<id>`, recurring
    // watchers only) — folded into the system block — and deliberately do NOT replay the full
    // conversation history: a year of daily fires must not replay a year of messages, and the DB
    // read must not grow with the watcher's lifetime. The history query is BOUNDED to the latest
    // user message (the objective for this fire); an interactive run still selects the full
    // history. Global recall applies to both.
    const historyQuery = isTrigger
      ? db
          .select({ role: messages.role, content: messages.content })
          .from(messages)
          .where(and(eq(messages.conversationId, run.conversationId), eq(messages.role, 'user')))
          .orderBy(desc(messages.createdAt))
          .limit(1)
      : db
          .select({ role: messages.role, content: messages.content })
          .from(messages)
          .where(eq(messages.conversationId, run.conversationId))
          .orderBy(asc(messages.createdAt))
    const [rows, facts, scratchpad] = await Promise.all([
      historyQuery,
      readMemoryFacts(db, OWNER_USER_ID, 'global').catch((err) => {
        console.error(`[run ${runId}] memory recall failed; proceeding without it:`, err)
        return [] as { id: string; text: string }[]
      }),
      watcherId
        ? readMemoryFacts(db, OWNER_USER_ID, memoryScope).catch((err) => {
            console.error(`[run ${runId}] scratchpad recall failed; proceeding without it:`, err)
            return [] as { id: string; text: string }[]
          })
        : Promise.resolve([] as { id: string; text: string }[]),
    ])

    const conversationMessages = await rowsToMessages(run.conversationId, rows)

    const history: Message[] = [
      {
        role: 'system',
        content: [{ type: 'text', text: systemTextWithMemory(facts, scratchpad, { isTrigger, watcherId }) }],
      },
      ...conversationMessages,
    ]

    // Live "along the way" usage (spec 2026-06-15): accumulate the run's IN-LOOP token/cost as
    // each llm_calls row is written and push a CUMULATIVE snapshot over NOTIFY. Capture the
    // snapshot into a const synchronously so a later increment can't mutate an already-queued
    // event; chaining on notifyChain in the same synchronous tick as the increment guarantees
    // every usage event lands before the `await notifyChain` that precedes the `done` NOTIFY.
    // Only loop calls + onToolLlmCall feed this; maybeAutoTitle / TTS are intentionally left to
    // the client's terminal meta re-fetch (they run at/after the done boundary).
    const runUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0 }
    const emitUsage = () => {
      const snapshot = { type: 'usage' as const, ...runUsage }
      notifyChain = notifyChain.then(() => notifyRun(run.conversationId, snapshot))
    }

    // Server-pushed TTS (spec 2026-06-14), gated entirely on run.speak — for a typed /messages
    // run (speak=false) this whole block is inert and the path is byte-for-byte today's. The
    // provider is constructed lazily + best-effort: a construction throw (provider not
    // configured) logs once and disables TTS for this run; the run then proceeds completely
    // normally. Synthesis is serialized through ttsChain (exactly like notifyChain) so clips
    // emit in seq order and one synthesis runs at a time; a per-clip synth/write failure logs
    // and DROPS that clip — it never throws into the run. Audio bytes go to the workspace; only
    // a path + seq ride NOTIFY.
    let tts: TtsProvider | undefined
    if (run.speak) {
      try {
        tts = makeTtsProvider()
      } catch (err) {
        console.error(`[run ${runId}] TTS unavailable; speaking disabled for this run:`, err)
      }
    }
    let ttsBuffer = ''
    let ttsSeq = 0
    let ttsChain: Promise<void> = Promise.resolve()
    // TTS cost accounting (spec 2026-06-14): accumulate per-clip usage across the run and record
    // ONE aggregated 'tts' synthetic tool_call + llm_calls row before the done rollup, exactly like
    // generate_image / auto_title (out-of-loop attribution). Stays 0/unset when speak=false.
    const ttsUsage = {
      model: undefined as string | undefined,
      promptTokens: 0,
      completionTokens: 0,
      clips: 0,
    }

    // Synthesize one sentence and push it as a tts_audio clip in seq order. Best-effort: any
    // failure (synthesis or workspace write) logs and drops the clip, never throwing into the
    // run. The cancel signal threads into synthesize so a cancel kills in-flight TTS.
    const speakSentence = (sentence: string): void => {
      if (!tts) return
      const text = stripMarkdownForSpeech(sentence)
      if (!text) return
      const provider = tts
      const seq = ttsSeq++
      ttsChain = ttsChain.then(async () => {
        try {
          const { audio, mimeType, usage } = await provider.synthesize(text, {
            signal: controller.signal,
          })
          // Accumulate this clip's usage for the aggregated 'tts' cost row (recorded after the
          // ttsChain drains). Missing token counts contribute 0 ("unknown -> 0, never a guess").
          if (usage) {
            ttsUsage.model = usage.model
            ttsUsage.promptTokens += usage.promptTokens ?? 0
            ttsUsage.completionTokens += usage.completionTokens ?? 0
            ttsUsage.clips++
          }
          const ref = writeAudioToWorkspace(run.conversationId, audio, mimeType)
          await notifyRun(run.conversationId, {
            type: 'tts_audio',
            seq,
            path: ref.path,
            mimeType: ref.mimeType,
          })
        } catch (err) {
          // Log only the message (not the full error object) — a provider error can embed the
          // upstream response body, which shouldn't land verbatim in the worker log.
          console.error(
            `[run ${runId}] TTS clip ${seq} failed; dropped:`,
            err instanceof Error ? err.message : String(err),
          )
        }
      })
    }

    const base = deps.provider ?? new GeminiProvider()
    // Decorate with tracing: each provider call persists an llm_calls row (observability).
    // toolCallId stays null ⇒ rollupUsage counts these toward the run's model (loop calls).
    // Retry wraps OUTSIDE tracing so each failed attempt is its own traced row (§10.7) —
    // up to 4 retries at 1/2/4/8s on transient errors; exhausted retries fail the run
    // through the existing failed path with an llm_unavailable:-prefixed error.
    const provider = new RetryProvider(
      new TracingProvider(base, (trace) => {
        // Accumulate + chain the cumulative-usage NOTIFY SYNCHRONOUSLY (before awaiting the
        // insert), so the usage event is always queued ahead of the `await notifyChain` that
        // gates the `done` NOTIFY — no usage event can land after `done`.
        runUsage.promptTokens += trace.promptTokens ?? 0
        runUsage.completionTokens += trace.completionTokens ?? 0
        runUsage.costUsd += computeCostUsd(
          trace.model,
          trace.promptTokens ?? 0,
          trace.completionTokens ?? 0,
          trace.cachedTokens ?? 0,
        )
        emitUsage()
        return insertLlmCall(db, runId, trace)
      }),
    )

    // Maps an agent-core call id to the tool_calls row id, so onToolEnd / requestApproval /
    // ask_user can update the row the loop is talking about. Built before the toolset so
    // ask_user's pause can resolve its own row from the call id (invariant 2, §10.9).
    const toolCallRowIds = new Map<string, string>()

    // Out-of-band push when an unattended (trigger) run pauses (§7.7 / spec "Approval & questions
    // while unattended"). For an interactive run this is undefined (no push — the owner is on SSE).
    // For a trigger run it writes a notifications row (kind 'approval'|'question') deep-linking the
    // conversation + NOTIFYs the SEPARATE 'notifications' channel so the dispatcher pushes it.
    const pauseNotifier = isTrigger
      ? (interactionId: string, kind: 'approval' | 'question'): Promise<void> =>
          notifyOutbox(db, {
            userId: OWNER_USER_ID,
            conversationId: run.conversationId,
            agentRunId: runId,
            interactionId,
            kind,
            title: kind === 'approval' ? 'Alfred needs your approval' : 'Alfred has a question',
            body: 'A background task is waiting for your input.',
            deepLink: `/conversation/${run.conversationId}`,
          })
      : undefined

    // ask_user's run-bound pause (§7.3, §10.2): the agent calls ask_user, which calls this to
    // raise a question interaction and block until the owner answers (or it times out). Maps
    // the resolved user_interactions.response to the tool result the model sees.
    //
    // UNATTENDED runs (§7.7 / spec line 153): an open-ended ask_user has no synchronous human, so
    // it must DEFER the objective — not block for the full autonomous timeout window holding the
    // one-active-run slot. Skip the interaction entirely and hand back a structured "no human"
    // result so the model records what it needs (remember) and ends the run promptly. Only ask_user
    // defers; write/destructive APPROVAL pauses still block (they're the owner's safety gate).
    const askUserPause = async (callId: string, prompt: unknown): Promise<unknown> => {
      if (isTrigger) {
        return {
          error: 'no_synchronous_user',
          note: 'No human is available; record what you need with remember and end the run.',
        }
      }
      const response = (await awaitInteraction(db, {
        conversationId: run.conversationId,
        runId,
        toolCallId: toolCallRowIds.get(callId) ?? null,
        kind: 'question',
        prompt,
        signal: controller.signal,
        timeoutMs: approvalTimeoutMs,
        onPause: pauseNotifier,
      })) as { selected_labels?: string[]; freeform_text?: string } | null
      // null/timeout ⇒ an error-shaped result so the model sees the question went unanswered
      // rather than mistaking it for an empty selection.
      if (!response) return { error: 'no_answer', note: 'question timed out' }
      return { selected_labels: response.selected_labels ?? [], freeform_text: response.freeform_text }
    }

    // The full toolset for this run (echo + the context-bound title tool + the browser
    // tools), assembled in one place so the boot catalog publish can't drift from it. run.id
    // threads through so a remember'd fact records its source_run_id (memory spec); memoryScope
    // binds remember/list_memories to the watcher's scratchpad scope for a recurring watcher
    // (else 'global', so an interactive run is unchanged).
    const tools = buildRunTools(run.conversationId, askUserPause, run.id, memoryScope)

    // The owner's per-tool approval overrides (the tools page, §16), loaded once per run.
    // require_approval is a tri-state: null/absent ⇒ fall back to the trust-tier default.
    const overrideRows = await db
      .select({ name: toolsTable.name, requireApproval: toolsTable.requireApproval })
      .from(toolsTable)
    const approvalOverrides = new Map(overrideRows.map((r) => [r.name, r.requireApproval]))
    const requiresApproval = (call: ApprovalRequest): boolean =>
      approvalOverrides.get(call.name) ?? call.trustTier !== 'read'

    // When a tool returns an image, the loop puts the inline base64 on an `image` part of the
    // tool turn (so the model sees it this turn) but Postgres must stay blob-free. onToolEnd
    // writes the bytes to the workspace and records base64 -> reference here; the message
    // persistence below swaps each inline `image` part for its on-disk reference.
    const imageRefByData = new Map<string, ImageRef>()

    // Group-scoped approval (§16): once the owner approves a tool group (e.g. 'browser'),
    // further calls in that group skip the prompt for the rest of THIS run. Per-run and
    // in-memory — a crash drops the grant with the run (fail-and-restart, §7.6). Only
    // successful approvals are remembered; a rejection rejects just that call.
    const approvedGroups = new Set<string>()

    const finalMessages = await runAgent({
      provider,
      tools,
      messages: history,
      model: run.model ?? undefined,
      // The cancel signal (§10.6): the loop checks it at its turn/tool checkpoints and
      // forwards it to the provider SDK, so a cancel kills the in-flight LLM stream too.
      signal: controller.signal,
      onText: (delta) => {
        notifyChain = notifyChain.then(() =>
          notifyRun(run.conversationId, { type: 'token', text: delta }),
        )
        // Voice (run.speak): accumulate the streamed text and flush each COMPLETE sentence to
        // TTS as it lands, so reply audio starts at the first sentence rather than the whole
        // turn. Inert when tts is unset (speak=false or provider unavailable).
        if (!tts) return
        ttsBuffer += delta
        // Flush up to the first sentence boundary whose chunk is at least the min length; keep
        // the trailing partial for the next delta / the final flush. A short leading fragment
        // ("Hi.", "Sure.") must NOT stop the scan — it merges into the next clip. Breaking on it
        // (the earlier bug) re-matched that same boundary on every delta, so a reply opening with
        // a short sentence never streamed any audio until the whole-turn final flush.
        for (;;) {
          const re = /[.!?\n]/g
          let end = -1
          for (let m = re.exec(ttsBuffer); m; m = re.exec(ttsBuffer)) {
            if (ttsBuffer.slice(0, m.index + 1).trim().length >= TTS_MIN_SENTENCE_CHARS) {
              end = m.index + 1
              break
            }
          }
          if (end === -1) break
          speakSentence(ttsBuffer.slice(0, end))
          ttsBuffer = ttsBuffer.slice(end)
        }
      },
      onToolStart: async (call) => {
        const [row] = await db
          .insert(toolCalls)
          .values({
            agentRunId: runId,
            toolName: call.name,
            args: call.args,
            trustTier: call.trustTier,
            // 'pending' if it will pause for approval, else 'running' (it runs immediately).
            // Mirrors the same predicate the loop gates on, so an owner-disabled gate (the
            // tools page) isn't recorded as a misleading 'pending'. A pausesForInput tool
            // (e.g. ask_user) also starts 'pending': it pauses on its own (question, §10.2),
            // so it walks the §10.9-sanctioned pending -> awaiting_user -> done path even
            // though it's read-tier.
            status: requiresApproval(call) || call.pausesForInput ? 'pending' : 'running',
            startedAt: new Date(),
          })
          .returning({ id: toolCalls.id })
        toolCallRowIds.set(call.id, row!.id)
        // Subtle live signal to the chat (chained after this turn's tokens for ordering).
        // Carry the args for the chip's summary, but only when small — large args (e.g. an
        // evaluate_javascript script) could exceed the 8000-byte NOTIFY cap and fail the run;
        // omit them and the live chip shows just the name (history still summarizes from the
        // persisted tool_use part).
        const argsForChip =
          call.args != null && JSON.stringify(call.args).length <= 1024 ? call.args : undefined
        notifyChain = notifyChain.then(() =>
          notifyRun(run.conversationId, {
            type: 'tool_call_start',
            id: call.id,
            toolName: call.name,
            args: argsForChip,
          }),
        )
      },
      onToolEnd: async (call, outcome) => {
        const rowId = toolCallRowIds.get(call.id)
        if (!rowId) return
        // Image results: write the bytes to the workspace and store only the REFERENCE in
        // tool_calls.result — base64 never lands in Postgres (spec's two-representation
        // design). The in-memory base64 already flowed to the model this turn via the loop.
        let persistedResult: unknown = outcome.result ?? null
        if (isImageResult(outcome.result)) {
          // The model already saw the image this turn; a workspace-write failure must not
          // crash an otherwise-healthy run, and base64 must never land in Postgres. On
          // failure, persist a reference-less marker and leave the map unset (toRef below
          // then drops the inline part rather than writing bytes to the DB).
          try {
            const ref = writeImageToWorkspace(run.conversationId, call.name, outcome.result.image)
            imageRefByData.set(outcome.result.image.data, ref)
            persistedResult = { ...ref, summary: outcome.result.summary }
          } catch (err) {
            console.error(`[run ${runId}] failed to persist image from ${call.name}:`, err)
            persistedResult = { error: 'image persistence failed', summary: outcome.result.summary }
          }
        }
        // Guarded (§10.9, terminal states are absorbing): only a still-active row takes the
        // outcome. A cancel's cascade may have already flipped this row to 'failed' while the
        // invoke was in flight — the settled result is dropped and the cascade's write stands.
        await db
          .update(toolCalls)
          .set({
            status: outcome.status,
            result: persistedResult,
            error: outcome.error ?? null,
            finishedAt: new Date(),
          })
          .where(
            and(
              eq(toolCalls.id, rowId),
              inArray(toolCalls.status, ['pending', 'awaiting_user', 'running']),
            ),
          )
        notifyChain = notifyChain.then(() =>
          notifyRun(run.conversationId, { type: 'tool_call_end', id: call.id }),
        )
      },
      // An AI call a tool made outside the loop (e.g. generate_image). Persist it as an
      // llm_calls row linked to the originating tool_call so its cost is attributed (§6.5);
      // the summaries never carry image base64.
      onToolLlmCall: async (callId, call) => {
        const promptTokens = call.promptTokens ?? 0
        const completionTokens = call.completionTokens ?? 0
        const costNum = computeCostUsd(
          call.model,
          promptTokens,
          completionTokens,
          call.cachedTokens ?? 0,
          call.images ?? 0,
        )
        // Live usage (spec 2026-06-15): accumulate + chain the cumulative snapshot SYNCHRONOUSLY
        // before the await, same ordering guarantee as the loop's TracingProvider callback.
        runUsage.promptTokens += promptTokens
        runUsage.completionTokens += completionTokens
        runUsage.costUsd += costNum
        emitUsage()
        await db.insert(llmCalls).values({
          agentRunId: runId,
          toolCallId: toolCallRowIds.get(callId) ?? null,
          model: call.model,
          // A small summary, never image base64.
          request: { tool: true, summary: call.requestSummary ?? null },
          tools: null,
          responseText: call.responseSummary ?? '',
          responseToolCalls: null,
          promptTokens,
          completionTokens,
          costUsd: costNum.toFixed(6),
          finishReason: call.finishReason ?? null,
          latencyMs: call.latencyMs ?? 0,
          error: null,
        })
      },
      requiresApproval,
      requestApproval: async (call) => {
        // Group already granted this run → auto-approve without prompting. The tool_calls
        // row is still written by onToolStart above, so the action stays in the audit log.
        // Destructive calls are exempt: §16 requires them to always prompt, regardless of
        // any group grant (a grant earned by a write call must never cover a destructive one).
        if (call.group && call.trustTier !== 'destructive' && approvedGroups.has(call.group)) {
          return { approved: true }
        }
        const verdict = await requestApproval(
          db,
          run.conversationId,
          runId,
          toolCallRowIds,
          call,
          controller.signal,
          // An unattended run fails loudly on approval timeout (§7.7) instead of continuing
          // as-if-rejected; an interactive run keeps today's rejection-on-timeout behaviour.
          { timeoutMs: approvalTimeoutMs, onPause: pauseNotifier, failOnTimeout: isTrigger },
        )
        if (verdict.approved && call.group) approvedGroups.add(call.group)
        return verdict
      },
    })
    await notifyChain

    // A cancel that raced the finish line (§10.6): the route already wrote the terminal
    // status; persisting the full assistant turn here would contradict the spec's "partial
    // output is discarded" choice — bail now, shrinking the accepted race back to a true ms
    // window (it previously spanned the NOTIFY flush + persist + the ~1s auto-title call).
    // Usage-only top-up; status / finished_at belong to the route.
    if (controller.signal.aborted) {
      await rollupUsageOnly(db, runId)
      return
    }

    // Voice (run.speak): flush the trailing buffer (the last sentence, which may not have ended
    // on a boundary) as a final clip. Only reached when NOT aborted (the abort path returned
    // above), so a cancelled run never synthesizes its tail. Inert when tts is unset.
    if (tts && ttsBuffer.trim().length > 0) {
      speakSentence(ttsBuffer)
      ttsBuffer = ''
    }

    // Persist everything the loop appended beyond the input (the assistant turn(s)). Inline
    // `image` parts (carrying base64) are swapped for their on-disk reference so Postgres
    // stays blob-free; the bytes were written to the workspace in onToolEnd. The persisted
    // shape (the reference) deliberately diverges from the in-memory ContentPart.
    const toRef = (part: ContentPart): ContentPart | ImageRef => {
      if (part.type !== 'image') return part
      const ref = imageRefByData.get(part.data)
      if (ref) return ref
      // No reference means the workspace write failed (logged in onToolEnd) — never persist
      // the raw base64 into Postgres. Drop it to a placeholder; the model saw it in-run.
      console.error(`[run ${runId}] image part has no workspace reference; storing placeholder`)
      return { type: 'text', text: '[image not persisted]' }
    }
    for (const m of finalMessages.slice(history.length)) {
      if (m.role === 'assistant' || m.role === 'tool') {
        await db.insert(messages).values({
          conversationId: run.conversationId,
          role: m.role,
          content: m.content.map(toRef),
        })
      }
    }

    // Best-effort auto-title (§7.5 auto-name): one cheap out-of-loop LLM call from the opening
    // exchange, gated on the title still being null. Runs BEFORE rollupUsage so the title
    // call's cost rolls into the run (its synthetic tool_call_id keeps it out of the model
    // pick), and never fails the already-successful run. Skipped when a cancel raced the
    // finish line — no point titling for a run the owner just killed.
    if (!controller.signal.aborted) {
      await maybeAutoTitle(db, base, run, history, finalMessages, controller.signal)
    }

    // Voice (run.speak): drain the TTS chain so every clip's tts_audio event is sent BEFORE the
    // terminal `done` event (the app uses `done` to stop expecting more audio). Reached only on
    // the success path — the aborted/cancel path returned above (a cancelled run must not wait
    // on TTS) and the catch path never awaits it. Inert when tts is unset (ttsChain stays a
    // resolved promise), so a typed run adds nothing.
    await ttsChain

    // TTS cost accounting (spec 2026-06-14): one aggregated out-of-loop 'tts' row for the run's
    // clips — a synthetic tool_call + linked llm_calls row (CHANGELOG 47 / auto_title pattern),
    // so the cost rolls into the run without leaking the speech model into agent_runs.model.
    // Placed BEFORE the final rollupUsage so its llm_calls row is summed into the done update,
    // and gated on NOT aborted (a cancelled run discarded its tail, §10.6) + a known model.
    // Best-effort — observability must never fail an otherwise-successful run.
    if (!controller.signal.aborted && ttsUsage.model) {
      try {
        await recordOutOfLoopLlmCall(db, {
          runId,
          ...speechLlmCallFields(
            {
              model: ttsUsage.model,
              promptTokens: ttsUsage.promptTokens,
              completionTokens: ttsUsage.completionTokens,
            },
            'tts',
            { detail: `${ttsUsage.clips} clip(s)` },
          ),
        })
      } catch (err) {
        console.error(
          `[run ${runId}] TTS cost record failed:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    // Guarded running -> done (§10.9, terminal states are absorbing): a cancel at the finish
    // line already wrote 'cancelled', so losing means skip the done NOTIFY (the route's
    // cancelled event was the user-facing signal). The messages persisted above stand — the
    // accepted ms-window race (spec). On losing, still top up tokens/cost: no exception is
    // thrown on this path, so the catch's rollup never runs for it.
    const doneRows = await db
      .update(agentRuns)
      .set({ status: 'done', finishedAt: new Date(), ...(await rollupUsage(db, runId)) })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')))
      .returning({ id: agentRuns.id })
    if (doneRows.length > 0) {
      await notifyRun(run.conversationId, { type: 'done' })
      // Out-of-band push for a finished UNATTENDED run (autonomous-watchers spec, "Notifications"):
      // write a notifications row + NOTIFY 'notifications', so the dispatcher pushes it. Only when
      // the done write actually won (a cancel at the finish line already told the client).
      // Best-effort — a notify failure must not fail the successful run. A recurring watcher uses
      // its notify_policy; a one-shot 'self' run (no resolvable watcher) notifies with an implicit
      // 'always' policy (its result is what the owner asked to be reminded of).
      if (isTrigger) {
        const finalText = lastAssistantText(finalMessages)
        await maybeNotifyResult(db, run, watcher, finalText).catch((notifyErr) =>
          console.error(`[run ${runId}] result notification failed:`, notifyErr),
        )
      }
    } else {
      await rollupUsageOnly(db, runId)
    }
  } catch (err) {
    if (controller.signal.aborted) {
      // Cancelled (§10.6): the route already wrote the terminal status + cascade and told
      // every client with its {type:'cancelled'} NOTIFY. The worker persists NO messages,
      // emits NOTHING, and only tops up tokens/cost (best-effort) so the cancelled run's
      // cost stays honest — status / finished_at / error are the route's, never touched here.
      await rollupUsageOnly(db, runId)
      return
    }
    // Drain any queued NOTIFYs (incl. a pending `usage` snapshot) before the error event so a
    // straggler can't land after {type:'error'} — symmetric with the success path's drain before
    // `done`. Best-effort: a notify failure must not mask the run's real error.
    await notifyChain.catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    // Roll up usage on failure too: llm_calls rows are written per call (even when the
    // run later throws), so a run that made paid calls before failing still reports its
    // true cost/tokens rather than the 0 default. Guarded (§10.9): only an ACTIVE run may
    // move to failed — if it's already terminal (route-cancelled without the signal having
    // aborted yet, or swept), the write loses, the error NOTIFY is skipped, and we fall back
    // to the same usage-only top-up.
    const failedRows = await db
      .update(agentRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        error: message,
        ...(await rollupUsage(db, runId)),
      })
      .where(
        and(
          eq(agentRuns.id, runId),
          inArray(agentRuns.status, ['pending', 'running', 'awaiting_approval']),
        ),
      )
      .returning({ id: agentRuns.id })
    if (failedRows.length > 0) {
      await notifyRun(run.conversationId, { type: 'error', message })
      // Fail loudly out-of-band for an unattended run (§7.7): the owner isn't on SSE, so a watcher
      // failure (incl. an approval timeout, ApprovalTimeoutError) would otherwise be silent. Write
      // an 'error' notification + NOTIFY 'notifications'. Best-effort — never let the notification
      // mask the run's real failure.
      if (isTrigger) {
        try {
          await notifyOutbox(db, {
            userId: OWNER_USER_ID,
            conversationId: run.conversationId,
            agentRunId: runId,
            kind: 'error',
            title: 'A background task failed',
            body: message.slice(0, 300),
            deepLink: `/conversation/${run.conversationId}`,
          })
        } catch (notifyErr) {
          console.error(`[run ${runId}] error notification failed:`, notifyErr)
        }
      }
    } else {
      await rollupUsageOnly(db, runId)
    }
  } finally {
    // Always tear the watcher down — its dedicated LISTEN client must never outlive the run.
    if (unwatch) await unwatch()
  }
}

// Open a dedicated LISTEN connection (the same per-pause pattern awaitInteraction uses) on
// the conversation channel and fire onCancel when the webserver's cancel route NOTIFYs
// {type:'cancelled'} (§10.6). One connection per active run — fine at single-user scale.
// Returns an async disposer; the caller runs it in a finally so the client never leaks.
async function watchForCancel(
  conversationId: string,
  onCancel: () => void,
): Promise<() => Promise<void>> {
  const { POSTGRES_URL } = loadConfig()
  if (!POSTGRES_URL) throw new Error('POSTGRES_URL is not set — required to watch for cancel')
  const client = new pg.Client({ connectionString: POSTGRES_URL })
  await client.connect()
  // A dropped LISTEN socket (Postgres restart mid-run) is otherwise an unhandled 'error'
  // EventEmitter event that crashes the whole worker; log and degrade — the run continues,
  // cancellation just won't be observed for this run.
  client.on('error', (err) => console.error(`[cancel-watch ${conversationId}] LISTEN connection error:`, err))
  client.on('notification', (msg) => {
    if (!msg.payload) return
    try {
      const event = JSON.parse(msg.payload)
      if (event.type === 'cancelled') onCancel()
    } catch {
      // ignore malformed payloads
    }
  })
  try {
    await client.query(`LISTEN "conversation:${conversationId}"`)
  } catch (err) {
    await client.end().catch(() => {}) // don't leak the client when LISTEN itself fails
    throw err
  }
  return async () => {
    await client.query(`UNLISTEN "conversation:${conversationId}"`).catch(() => {})
    await client.end().catch(() => {})
  }
}

// Best-effort usage-only top-up for a run something ELSE already finalized (route-cancelled,
// or swept while we raced): tokens/cost/model land on the row without touching status /
// finished_at / error — those belong to whoever wrote the terminal state (§10.6). Never
// throws: cost accounting must not mask the run's real outcome.
async function rollupUsageOnly(db: ReturnType<typeof getDb>, runId: string): Promise<void> {
  try {
    await db.update(agentRuns).set(await rollupUsage(db, runId)).where(eq(agentRuns.id, runId))
  } catch (err) {
    console.error(`[run ${runId}] best-effort usage rollup failed:`, err)
  }
}

// Persist one LlmTrace as an llm_calls row (the observability record, §6.5). Shared by the
// loop's TracingProvider (toolCallId null ⇒ a loop call that counts toward the run's model)
// and the out-of-loop auto-title call (toolCallId set ⇒ excluded from the model pick by
// rollupUsage's tool_call_id IS NULL filter, while its cost still rolls into the run).
async function insertLlmCall(
  db: ReturnType<typeof getDb>,
  runId: string,
  trace: LlmTrace,
  toolCallId?: string,
): Promise<void> {
  const promptTokens = trace.promptTokens ?? 0
  const completionTokens = trace.completionTokens ?? 0
  await db.insert(llmCalls).values({
    agentRunId: runId,
    toolCallId: toolCallId ?? null,
    model: trace.model,
    request: trace.request,
    tools: trace.tools,
    responseText: trace.responseText,
    responseToolCalls: trace.responseToolCalls,
    promptTokens,
    completionTokens,
    costUsd: computeCostUsd(
      trace.model,
      promptTokens,
      completionTokens,
      trace.cachedTokens ?? 0,
    ).toFixed(6),
    finishReason: trace.finishReason ?? null,
    latencyMs: trace.latencyMs,
    error: trace.error ?? null,
  })
}

// Cap on each side of the opening exchange fed to the title prompt — a huge message can't
// blow up the call (the model only needs the gist to title it).
const TITLE_INPUT_CAP = 2000
// Final sanitized title length cap (matches the sidebar's expectations).
const TITLE_MAX_CHARS = 60

// The message's prose for titling (reuses the canonical textOf — non-text parts contribute
// nothing), trimmed and length-capped so a huge message can't blow up the prompt.
function exchangeText(message: Message | undefined): string {
  return message ? textOf(message.content).trim().slice(0, TITLE_INPUT_CAP) : ''
}

// Trim, strip surrounding quotes, collapse internal whitespace/newlines, cap length.
// Returns '' when nothing usable remains (caller then leaves the title null to retry).
function sanitizeTitle(raw: string): string {
  let title = raw.trim().replace(/\s+/g, ' ')
  // Strip a single layer of surrounding quotes the model sometimes adds — straight or curly,
  // and curly pairs open/close with *different* chars (“…”), so match the pair, not a backref.
  const quoted = title.match(/^["'“”](.*)["'“”]$/)
  if (quoted) title = quoted[1]!.trim()
  return title.slice(0, TITLE_MAX_CHARS).trim()
}

// Best-effort auto-title (§7.5 auto-name): one cheap out-of-loop LLM call from the opening
// exchange, gated on the conversation's title still being null. Runs BEFORE the final
// rollupUsage (so the title call's cost rolls into the run while its synthetic tool_call_id
// keeps it out of the model derivation) and is wrapped entirely in try/catch — a titling
// failure logs and is swallowed, never failing the already-successful run (mirrors the
// best-effort "don't ask again" pattern). A failed attempt naturally retries on the next
// still-null run.
async function maybeAutoTitle(
  db: ReturnType<typeof getDb>,
  base: LlmProvider,
  run: typeof agentRuns.$inferSelect,
  history: Message[],
  finalMessages: Message[],
  signal?: AbortSignal,
): Promise<void> {
  let titleCallId: string | undefined
  try {
    // (a) Gate: only title while the conversation has no title — never overwrite an
    // agent-set or /rename'd one (idempotent, self-healing).
    const [conv] = await db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, run.conversationId))
    if (!conv || conv.title !== null) return

    // (b) Inputs: the opening exchange — the first user message and the first assistant reply.
    const firstUser = history.find((m) => m.role === 'user')
    const firstAssistant = finalMessages.slice(history.length).find((m) => m.role === 'assistant')
    const userText = exchangeText(firstUser)
    const assistantText = exchangeText(firstAssistant)
    if (!userText && !assistantText) return // nothing to title from

    // (c) Synthetic tool_calls row — the cost-attribution anchor (CHANGELOG 47): the title's
    // llm_calls row links to it, so rollupUsage's tool_call_id IS NULL filter excludes the
    // title model from the run's model pick while its cost still rolls in. Created 'running'
    // (in-flight, like any tool call) and finalized to 'done'/'failed' below, so it never
    // lingers as a result-less terminal row and respects §10.9 (running → done/failed).
    const [titleCall] = await db
      .insert(toolCalls)
      .values({
        agentRunId: run.id,
        toolName: 'auto_title',
        args: {},
        trustTier: 'read',
        status: 'running',
        startedAt: new Date(),
      })
      .returning({ id: toolCalls.id })
    titleCallId = titleCall!.id

    // (d) The title call: drive the provider directly (tools: []), traced so it lands on
    // /debug like any other call but linked to the synthetic tool_call. model undefined ⇒
    // GeminiProvider falls back to GEMINI_MODEL (reuse the chat model, no new config key).
    const titleMessages: Message[] = [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text:
              'Generate a concise 3–6 word title for this conversation. ' +
              'Reply with ONLY the title — no surrounding quotes, no trailing punctuation.',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Title this conversation based on its opening exchange:\n\n' +
              `User: ${userText}\n\n` +
              `Assistant: ${assistantText}`,
          },
        ],
      },
    ]
    // Deliberately NOT RetryProvider-wrapped (unlike the loop provider): titling is
    // best-effort and self-healing — retrying would hold the run's `done` up to ~15s
    // longer for a cosmetic feature (spec 2026-06-11-llm-retry-backoff, resolved choice).
    const titleProvider = new TracingProvider(base, (trace) =>
      insertLlmCall(db, run.id, trace, titleCallId),
    )
    let raw = ''
    // The cancel signal rides along so a mid-title cancel aborts the stream into the catch
    // below (the ~1s title call was otherwise the longest uncancellable stretch of the run).
    for await (const ev of titleProvider.stream(titleMessages, [], {
      model: run.model ?? undefined,
      signal,
    })) {
      if (ev.type === 'text') raw += ev.text
    }

    // (e) Sanitize; an empty result leaves the title null so the next run retries.
    const title = sanitizeTitle(raw)

    // (f) Write the title — the `title IS NULL` guard closes the race with a concurrent
    // /rename; `.returning()` tells us whether we actually won it (first writer wins), so we
    // don't push a title the owner's /rename already overwrote.
    const applied =
      title.length > 0 &&
      (
        await db
          .update(conversations)
          .set({ title })
          .where(and(eq(conversations.id, run.conversationId), isNull(conversations.title)))
          .returning({ id: conversations.id })
      ).length > 0

    // Finalize the synthetic row (terminal, with the outcome) — never a result-less 'done'.
    // Guarded running -> done (§10.9, terminal states are absorbing): a cancel cascade may
    // have already flipped the row to 'failed' while the title call was in flight.
    await db
      .update(toolCalls)
      .set({ status: 'done', finishedAt: new Date(), result: { title: title || null, applied } })
      .where(and(eq(toolCalls.id, titleCallId), eq(toolCalls.status, 'running')))

    // (g) Surface it live to the open chat + sidebar (§7.5) — only when we actually set it.
    if (applied) await notifyRun(run.conversationId, { type: 'title', title })
  } catch (err) {
    console.error(`[run ${run.id}] auto-title failed:`, err)
    // Mark the in-flight synthetic row failed (running → failed, §10.9) so it doesn't linger.
    // Same guard as the done path: the cancel cascade's terminal write is never overwritten.
    if (titleCallId) {
      await db
        .update(toolCalls)
        .set({ status: 'failed', finishedAt: new Date(), error: String(err) })
        .where(and(eq(toolCalls.id, titleCallId), eq(toolCalls.status, 'running')))
        .catch(() => {})
    }
  }
}

// The final assistant turn's prose (the result body for a trigger-result notification). Walks
// back over the run's appended messages to the last assistant message and returns its text.
function lastAssistantText(finalMessages: Message[]): string {
  for (let i = finalMessages.length - 1; i >= 0; i--) {
    const m = finalMessages[i]!
    if (m.role === 'assistant') {
      const t = textOf(m.content).trim()
      if (t) return t
    }
  }
  return ''
}

// Out-of-band push for a finished unattended run (autonomous-watchers spec, "Notifications" +
// "Noise control"). Takes the run's already-resolved watcher row (or undefined for a one-shot
// 'self' run, whose conversation is not a watcher) — no re-fetch — reads its notify_policy, and,
// when the policy says push, writes a notifications row + NOTIFY 'notifications' so the dispatcher
// delivers it. A recurring watcher: 'always'/'on_change' push every finished run (the gate already
// ensured "something changed" for on_change before this run was created); 'on_threshold' lacks a
// structured urgency signal in the MVP classifier, so it behaves like on_change for now; 'digest'
// emits no per-run push (the agent accrues to the scratchpad and a scheduled digest run
// summarizes). A 'self' one-shot run (no watcher) notifies with an implicit 'always' policy — its
// result is exactly what the owner asked to be reminded of.
async function maybeNotifyResult(
  db: ReturnType<typeof getDb>,
  run: typeof agentRuns.$inferSelect,
  watcher: Awaited<ReturnType<typeof getTrigger>>,
  resultText: string,
): Promise<void> {
  // A 'digest' watcher emits no per-run push; every other case (recurring non-digest watcher, or a
  // 'self' run with no watcher row) pushes.
  if (watcher?.notifyPolicy === 'digest') return

  await notifyOutbox(db, {
    userId: OWNER_USER_ID,
    conversationId: run.conversationId,
    agentRunId: run.id,
    kind: 'result',
    title: watcher?.name || 'Alfred finished a task',
    body: resultText.slice(0, 300),
    deepLink: `/conversation/${run.conversationId}`,
  })
}

// Sum token usage + cost (and pick the model) from a run's llm_calls, shaped for an
// agent_runs update. costUsd is numeric → string in JS; summed as floats and stored at
// 6-decimal scale. Used on both the done and failed paths so cost accounting is honest
// regardless of outcome.
async function rollupUsage(db: ReturnType<typeof getDb>, runId: string) {
  const calls = await db
    .select({
      promptTokens: llmCalls.promptTokens,
      completionTokens: llmCalls.completionTokens,
      costUsd: llmCalls.costUsd,
      model: llmCalls.model,
      toolCallId: llmCalls.toolCallId,
    })
    .from(llmCalls)
    .where(eq(llmCalls.agentRunId, runId))
  // The run's model reflects the AGENT LOOP only (tool_call_id IS NULL) — an image-tool call
  // has its own llm_calls row and must not mislabel the run as the image model. Fall back to
  // the last call of any kind only if there are no loop calls.
  const loopModel = calls.filter((row) => row.toolCallId === null).at(-1)?.model
  return {
    // SUMS span ALL calls (image cost still counts toward the run); only the model is filtered.
    promptTokens: calls.reduce((sum, row) => sum + row.promptTokens, 0),
    completionTokens: calls.reduce((sum, row) => sum + row.completionTokens, 0),
    costUsd: calls.reduce((sum, row) => sum + Number(row.costUsd), 0).toFixed(6),
    model: loopModel ?? calls.at(-1)?.model ?? null,
  }
}

// The generic pause-for-user mechanism (§10.2–§10.4): persist a user_interactions row of the
// given kind/prompt, surface it over NOTIFY, and BLOCK on a dedicated LISTEN until the owner
// resolves it (or a 1h timeout flips it to timed_out). Returns the resolved row's `response`
// (raw — null on timeout/cancel), UNLESS `failOnTimeout` is set and the timeout won the race, in
// which case it throws ApprovalTimeoutError so the caller can distinguish a timeout from a
// rejection (an unattended approval timeout must fail loudly, §7.7 / spec line 153 — never feed a
// silent { approved:false } to a model with no human behind it). No durable resume — a crash
// sweeps the run to failed on startup (§7.6). Both the approval gate and ask_user's question pause
// are thin callers of this.
async function awaitInteraction(
  db: ReturnType<typeof getDb>,
  args: {
    conversationId: string
    runId: string
    toolCallId: string | null
    kind: 'approval' | 'question'
    prompt: unknown
    signal?: AbortSignal
    // The approval/question pause window. Interactive runs use the 1h APPROVAL_TIMEOUT_MS; an
    // autonomous (trigger) run uses the much longer AUTONOMOUS_APPROVAL_TIMEOUT_MS (§7.7).
    timeoutMs?: number
    // Fired AFTER the pending interaction is recorded + the client NOTIFY, so a caller can push
    // it out-of-band (autonomous runs write a notifications row — the owner isn't watching SSE).
    // Best-effort: a throw here must not derail the pause.
    onPause?: (interactionId: string, kind: 'approval' | 'question') => Promise<void>
    // When set, a timeout (this call's timer flipped a still-pending row to timed_out) throws
    // ApprovalTimeoutError instead of returning the null response — so the unattended approval
    // gate fails the run loudly rather than continuing as-if-rejected (§7.7). A cancel/resolution
    // wake never throws. Off by default ⇒ today's return-null-on-timeout behaviour, unchanged.
    failOnTimeout?: boolean
  },
): Promise<unknown> {
  const { conversationId, runId, toolCallId, kind, prompt, signal, onPause } = args
  const timeoutMs = args.timeoutMs ?? APPROVAL_TIMEOUT_MS

  // An already-cancelled run never opens a pause: bail before any writes. The loop's next
  // checkpoint will throw, and the cancel route's cascade already handled the tool_call row —
  // creating an interaction here would only orphan a pending row no one can resolve.
  if (signal?.aborted) return null

  // (a) the tool_call is now waiting on the user. Guarded (§10.9, terminal states are
  // absorbing): a cancel cascade may already have flipped this row to 'failed'.
  if (toolCallId) {
    await db
      .update(toolCalls)
      .set({ status: 'awaiting_user' })
      .where(and(eq(toolCalls.id, toolCallId), eq(toolCalls.status, 'pending')))
  }

  // (b) record the pending interaction (the card the client renders).
  const [interaction] = await db
    .insert(userInteractions)
    .values({
      agentRunId: runId,
      toolCallId,
      kind,
      prompt,
      status: 'pending',
    })
    .returning({ id: userInteractions.id })
  const interactionId = interaction!.id

  // (c) the run is parked awaiting input. Guarded running -> awaiting_approval: this is the
  // §10.9 invariant-1 (terminal states are absorbing) guard for the pause-entry window —
  // without it a cancel racing the pause resurrects a terminal run into the
  // one-active-run index slot. Losing means the run was made terminal (cancelled/swept)
  // between the loop checkpoint and here: flip the just-inserted interaction to 'cancelled'
  // so no orphan pending row survives, skip the NOTIFY and the LISTEN, and bail.
  const parked = await db
    .update(agentRuns)
    .set({ status: 'awaiting_approval' })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')))
    .returning({ id: agentRuns.id })
  if (parked.length === 0) {
    await db
      .update(userInteractions)
      .set({ status: 'cancelled', resolvedAt: new Date() })
      .where(and(eq(userInteractions.id, interactionId), eq(userInteractions.status, 'pending')))
    return null
  }

  // (d) tell the client.
  await notifyRun(conversationId, { type: 'interaction_required', interactionId, kind })

  // (d′) out-of-band push for an unattended run (§7.7 / spec "Approval & questions while
  // unattended"): the owner isn't on SSE, so write a notifications row + push. Best-effort — a
  // failure here must not derail the pause (the interaction is already recorded + NOTIFY'd).
  if (onPause) {
    try {
      await onPause(interactionId, kind)
    } catch (err) {
      console.error(`[interaction ${interactionId}] pause notification failed:`, err)
    }
  }

  // (e) block until resolved on a dedicated LISTEN connection.
  const { POSTGRES_URL } = loadConfig()
  if (!POSTGRES_URL) throw new Error('POSTGRES_URL is not set — required to await interaction')
  const client = new pg.Client({ connectionString: POSTGRES_URL })
  await client.connect()
  // A dropped LISTEN socket (Postgres restart mid-pause) is otherwise an unhandled 'error'
  // EventEmitter event that crashes the whole worker; log and degrade (the timeout still
  // bounds the pause).
  client.on('error', (err) => console.error(`[interaction ${interactionId}] LISTEN connection error:`, err))

  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  // Set true only when THIS call's timer flipped a still-pending row to timed_out (won the race) —
  // distinguishes a timeout wake from a resolution/cancel wake for the failOnTimeout caller.
  let timedOut = false
  try {
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }

      client.on('notification', (msg) => {
        if (!msg.payload) return
        try {
          const event = JSON.parse(msg.payload)
          if (
            (event.type === 'interaction_resolved' && event.interactionId === interactionId) ||
            // Run cancel (§10.6): the route's cascade already flipped this pending
            // interaction to 'cancelled' — wake promptly. The post-wake read below returns a
            // null response (approval ⇒ not approved, question ⇒ no_answer) and the aborted
            // signal short-circuits the loop at its next checkpoint.
            event.type === 'cancelled'
          ) {
            finish()
          }
        } catch {
          // ignore malformed payloads
        }
      })

      // Timeout (1h interactive / longer for autonomous): conditionally flip a still-pending
      // interaction to timed_out, then wake. `.returning()` reports whether we actually won the
      // race (a response/cancel that landed first leaves no pending row) — only then is it a true
      // timeout for the failOnTimeout caller.
      timeout = setTimeout(() => {
        void db
          .update(userInteractions)
          .set({ status: 'timed_out', resolvedAt: new Date() })
          .where(and(eq(userInteractions.id, interactionId), eq(userInteractions.status, 'pending')))
          .returning({ id: userInteractions.id })
          .then((flipped) => {
            if (flipped.length > 0) timedOut = true
            finish()
          })
      }, timeoutMs)

      // Wake on abort too: this pause's own LISTEN can subscribe AFTER the cancel NOTIFY
      // fired, in which case it's never delivered on this connection. The run-level watcher
      // (watchForCancel) always sees it and aborts the controller, so the abort event covers
      // every NOTIFY this connection can miss.
      onAbort = finish
      signal?.addEventListener('abort', onAbort)
      // addEventListener on an already-aborted signal never fires — check once after registering.
      if (signal?.aborted) finish()

      // Subscribe, then check once for a resolution that raced the LISTEN.
      client
        .query(`LISTEN "conversation:${conversationId}"`)
        .then(() => db.select().from(userInteractions).where(eq(userInteractions.id, interactionId)))
        .then(([row]) => {
          if (row && row.status !== 'pending') finish()
        })
    })
  } finally {
    if (timeout) clearTimeout(timeout)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    await client.query(`UNLISTEN "conversation:${conversationId}"`).catch(() => {})
    await client.end().catch(() => {})
  }

  // Unattended approval timeout (§7.7 / spec line 153): fail the run loudly rather than continue
  // as-if-rejected. Throw BEFORE resuming to running, so the run stays 'awaiting_approval' and the
  // runJob catch path's guarded failed-write (which includes 'awaiting_approval') flips it to
  // 'failed' and emits the 'error' notification. An interactive run never sets failOnTimeout, so it
  // falls through to the unchanged return-null path below (mapped to a rejection verdict). A cancel
  // wake is not a timeout (timedOut stays false), so it never throws here.
  if (timedOut && args.failOnTimeout) throw new ApprovalTimeoutError()

  // (f) read the response, resume the run, return it (null on timeout).
  const [resolved] = await db
    .select({ response: userInteractions.response })
    .from(userInteractions)
    .where(eq(userInteractions.id, interactionId))

  // Guarded resume (§10.9, terminal states are absorbing): only a parked run goes back to
  // running. A cancel during the pause already wrote 'cancelled'; losing here needs no
  // handling — the aborted signal short-circuits the loop at its next checkpoint.
  await db
    .update(agentRuns)
    .set({ status: 'running' })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'awaiting_approval')))

  return resolved?.response ?? null
}

// The approval gate (§10.2–§10.4, §16). A thin caller of awaitInteraction: build the approval
// prompt (group vs call summary + scope), pause with kind='approval', map the resolved
// response to an ApprovalVerdict (null/absent ⇒ not approved).
async function requestApproval(
  db: ReturnType<typeof getDb>,
  conversationId: string,
  runId: string,
  toolCallRowIds: Map<string, string>,
  call: ApprovalRequest,
  signal?: AbortSignal,
  opts: {
    timeoutMs?: number
    onPause?: (interactionId: string, kind: 'approval' | 'question') => Promise<void>
    // Unattended run: a timeout fails the run loudly (ApprovalTimeoutError, surfaced as a failed
    // run + 'error' notification) instead of continuing as-if-rejected (§7.7 / spec line 153).
    failOnTimeout?: boolean
  } = {},
): Promise<ApprovalVerdict> {
  const prompt = {
    // Group calls render a task-scoped card: approving covers every action in the
    // group for the rest of the run, not just the one triggering call (§16).
    summary: call.group
      ? `Allow Alfred to use its ${call.group} tools for this task? Approving covers all ${call.group} actions until this run finishes.`
      : 'Run ' + call.name,
    tool: call.name,
    args: call.args,
    trust_tier: call.trustTier,
    scope: call.group ? 'group' : 'call',
  }
  const response = (await awaitInteraction(db, {
    conversationId,
    runId,
    toolCallId: toolCallRowIds.get(call.id) ?? null,
    kind: 'approval',
    prompt,
    signal,
    timeoutMs: opts.timeoutMs,
    onPause: opts.onPause,
    failOnTimeout: opts.failOnTimeout,
  })) as { approved?: boolean; note?: string } | null
  return response?.approved
    ? { approved: true, note: response.note }
    : { approved: false, note: response?.note }
}
