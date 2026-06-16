import fs from 'node:fs'
import path from 'node:path'
import { type ImageToolResult, type Tool, type ToolContext } from '@alfred/agent-core'
import {
  conversations,
  deleteTrigger,
  enqueueTriggerDetect,
  getDb,
  getTrigger,
  insertTrigger,
  listEnabledTriggers,
  listTriggers,
  OWNER_USER_ID,
  setTriggerEnabled,
} from '@alfred/db'
import { imageMimeForExt, resolveInWorkspace } from '@alfred/shared'
import { eq } from 'drizzle-orm'
import { capResult } from './cap.js'
import { DEFAULT_IMAGE_MODEL, imageModelChoices, resolveImageProvider } from './images-registry.js'

// A context-bound built-in tool (ARCHITECTURE §7.3): it acts on a specific
// conversation, captured in a closure so Tool.invoke(args) stays context-free.
// trustTier 'write' ⇒ the loop pauses for owner approval before it runs.
export function makeSetTitleTool(conversationId: string): Tool {
  return {
    name: 'set_conversation_title',
    description: 'Set the title of the current conversation.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'New conversation title' } },
      required: ['title'],
    },
    trustTier: 'write',
    async invoke(args: unknown): Promise<unknown> {
      const title = String((args as { title?: unknown } | null)?.title)
      await getDb()
        .update(conversations)
        .set({ title })
        .where(eq(conversations.id, conversationId))
      return { ok: true, title }
    },
  }
}

// ask_user: the agent asks the owner a structured question mid-run and blocks on the answer
// (§7.3, §10.2). `pause` is the run-bound function from run.ts that raises a question
// interaction and waits for the resolution; this tool just validates + shapes the prompt and
// returns whatever pause gives back. read-tier — asking is not side-effecting, so it must not
// itself trigger an approval card before the question.
export function makeAskUserTool(pause: (callId: string, prompt: unknown) => Promise<unknown>): Tool {
  return {
    name: 'ask_user',
    description:
      'Ask the user a structured question and wait for their answer. Use when you need a ' +
      'decision or missing information to proceed.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user.' },
        options: {
          type: 'array',
          description: 'Optional answer choices for the user to pick from.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'The choice text.' },
              description: { type: 'string', description: 'Optional clarifying detail.' },
            },
            required: ['label'],
          },
        },
        multi_select: { type: 'boolean', description: 'Allow selecting more than one option (default false).' },
        allow_freeform: {
          type: 'boolean',
          description: 'Allow a free-text answer (default true); pass false to constrain to options.',
        },
      },
      required: ['question'],
    },
    trustTier: 'read',
    // Pauses mid-invoke to wait for the owner's answer, so the worker records its tool_calls
    // row as 'pending' (pending → awaiting_user → done, §10.9), not the read-tier shortcut.
    pausesForInput: true,
    async invoke(args: unknown, ctx?: ToolContext): Promise<unknown> {
      const {
        question: rawQuestion,
        options: rawOptions,
        multi_select,
        allow_freeform,
      } = (args ?? {}) as {
        question?: unknown
        options?: unknown
        multi_select?: unknown
        allow_freeform?: unknown
      }
      const question = String(rawQuestion ?? '')
      if (!question) throw new Error('ask_user requires a non-empty question')

      let options: { label: string; description?: string }[] | undefined
      if (rawOptions != null) {
        if (!Array.isArray(rawOptions)) throw new Error('ask_user options must be an array')
        options = rawOptions.map((o) => {
          const { label, description } = (o ?? {}) as { label?: unknown; description?: unknown }
          const labelStr = String(label ?? '')
          if (!labelStr) throw new Error('ask_user options each require a non-empty label')
          return description != null ? { label: labelStr, description: String(description) } : { label: labelStr }
        })
      }

      // The DATABASE.md question prompt shape.
      const prompt = {
        question,
        options,
        multi_select: multi_select === true,
        allow_freeform: allow_freeform !== false,
      }
      // callId is always supplied by the loop (ToolContext.callId = the call id); assert it
      // rather than defaulting, so the tool_calls row is reliably linked for the awaiting_user
      // flip (invariant 2, §10.9) instead of silently passing an unmatchable empty id.
      if (!ctx?.callId) throw new Error('ask_user requires ctx.callId from the agent loop')
      return await pause(ctx.callId, prompt)
    },
  }
}

// The image-model choices, read once from the registry (so they can't drift from what's
// wired). Both the `model` enum (ids) and its description — one line per id, since JSON-schema
// enum has no per-value docs — derive from this single list.
const IMAGE_MODEL_CHOICES = imageModelChoices()
const IMAGE_MODEL_IDS = IMAGE_MODEL_CHOICES.map((m) => m.id)
const MODEL_ENUM_DESCRIPTION =
  `Image model to use (default ${DEFAULT_IMAGE_MODEL}). ` +
  IMAGE_MODEL_CHOICES.map((m) => `${m.id}: ${m.description}`).join('; ')

// generate_image: produce an image from a text prompt, returning an ImageToolResult the worker
// persists (bytes -> workspace, reference -> tool_calls.result) and the model sees (image-feedback
// path, so "now make it bluer" works). The model is chosen per call via the `model` arg, resolved
// through the image registry (Gemini-native or Imagen). write-tier ⇒ approval-gated by default.
export function makeGenerateImageTool(): Tool {
  return {
    name: 'generate_image',
    description: 'Generate an image from a text prompt. The image is shown in the chat and you can see it too.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description of the image to generate' },
        model: { type: 'string', enum: IMAGE_MODEL_IDS, description: MODEL_ENUM_DESCRIPTION },
      },
      required: ['prompt'],
    },
    trustTier: 'write',
    async invoke(args: unknown, ctx?: ToolContext): Promise<unknown> {
      const { prompt: rawPrompt, model: rawModel } = (args ?? {}) as { prompt?: unknown; model?: unknown }
      const prompt = String(rawPrompt ?? '')
      if (!prompt) throw new Error('generate_image requires a non-empty prompt')
      const model = typeof rawModel === 'string' && rawModel ? rawModel : DEFAULT_IMAGE_MODEL

      const provider = resolveImageProvider(model)
      const startedAt = Date.now()
      const generated = await provider.generate(prompt)
      const latencyMs = Date.now() - startedAt

      const out: ImageToolResult = {
        // The summary is what the model sees as the tool result (the image bytes ride on a
        // sibling part it can also see). Frame it so the model knows it created the image and
        // the user can already view it — otherwise it tends to "thank you for providing the
        // image" as if the user supplied it.
        image: { mimeType: generated.mimeType, data: generated.data },
        summary: `Generated the image for "${prompt}" and displayed it to the user. They can see it now.`,
      }

      // Attribute this out-of-loop AI call to its tool_call so the cost reaches llm_calls /
      // agent_runs (never $0). usage.images drives cost for flat-per-image models (Imagen);
      // tokens drive it for Gemini-native. Summaries only — never the image base64.
      const usage = generated.usage
      await ctx?.recordLlmCall({
        model: usage?.model ?? model,
        images: usage?.images,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        cachedTokens: usage?.cachedTokens,
        // Record the prompt so the /debug llm_calls row is self-contained (it's otherwise
        // only recoverable from tool_calls.args). Never the image base64.
        requestSummary: prompt,
        responseSummary: 'generated image',
        latencyMs,
      })

      return out
    },
  }
}

// The per-conversation file tools (spec's minimal trio). Every path is resolved through
// resolveInWorkspace, which confines it under <WORKSPACE_ROOT>/<conversationId>/. list_files /
// read_file are read-tier; write_file is write-tier (approval-gated). Code execution and
// richer ops (move/delete/glob, binary write) come later on the same workspace.
export function makeFileTools(conversationId: string): Tool[] {
  return [
    {
      name: 'list_files',
      description: 'List the files in this conversation’s working directory.',
      inputSchema: { type: 'object', properties: {} },
      trustTier: 'read',
      async invoke(): Promise<unknown> {
        const dir = resolveInWorkspace(conversationId, '.')
        if (!fs.existsSync(dir)) return { files: [] }
        const files = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name)
        return { files }
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from this conversation’s working directory. Image files are returned as images.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative path to read' } },
        required: ['path'],
      },
      trustTier: 'read',
      async invoke(args: unknown): Promise<unknown> {
        const relPath = String((args as { path?: unknown } | null)?.path ?? '')
        const abs = resolveInWorkspace(conversationId, relPath)
        const mimeType = imageMimeForExt(path.extname(relPath))
        if (mimeType) {
          const data = fs.readFileSync(abs).toString('base64')
          const out: ImageToolResult = { image: { mimeType, data }, summary: relPath }
          return out
        }
        // Same 100k cap as the browser/python tools — run_python can now write arbitrarily
        // large files, and an uncapped read would flood the model context.
        return { path: relPath, content: capResult(fs.readFileSync(abs, 'utf8')) }
      },
    },
    {
      name: 'write_file',
      description: 'Write text content to a file in this conversation’s working directory (overwrites).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path to write' },
          content: { type: 'string', description: 'Text content to write' },
        },
        required: ['path', 'content'],
      },
      trustTier: 'write',
      async invoke(args: unknown): Promise<unknown> {
        const { path: relPath, content } = (args ?? {}) as { path?: unknown; content?: unknown }
        const rel = String(relPath ?? '')
        const abs = resolveInWorkspace(conversationId, rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, String(content ?? ''), 'utf8')
        return { ok: true, path: rel }
      },
    },
  ]
}

// schedule_self bounds (§16 blast radius): a prompt-injected agent must not be able to self-schedule
// an amplification loop. We keep the tool read-tier/no-approval (owner's deliberate choice) but bound
// it structurally — a minimum cadence (no sub-hourly cron) and a cap on the total enabled self/
// schedule triggers per owner. Past the cap, the tool returns a clear error instead of inserting.
export const MAX_SELF_SCHEDULE_TRIGGERS = 25

// A token in a single cron field: '*', a number, a step ('*/N' | 'a/N'), a range ('a-b'), or a
// comma list of those. Used by the validator below — pg-boss cron is the standard 5-field form.
const CRON_FIELD_TOKEN = /^(\*|\d+)(-\d+)?(\/\d+)?$/

// The decision schedule_self makes from its `when` arg, as a pure value so it's unit-testable
// without a db write. `kind:'schedule'` ⇒ a recurring cron trigger; `kind:'self'` ⇒ a one-shot
// trigger firing once at `nextFireAt`; `error` ⇒ a rejection (bad cron / unparseable timestamp /
// sub-hourly cadence) surfaced to the agent as a clear tool error.
export type WhenDecision =
  | { kind: 'schedule'; cron: string }
  | { kind: 'self'; nextFireAt: Date }
  | { error: string }

// Validate a standard 5-field cron expression AND enforce the minimum cadence. Returns an error
// string (not throwing) so callers can surface it verbatim. Rejecting 6-field expressions matters:
// pg-boss cron is 5-field, so a 6-field string would be silently misinterpreted. The cadence rule
// (≥ hourly) accepts only a single fixed minute value (0–59) in the minute field — '*', a step, a
// list, or a range there would fire multiple times per hour (sub-hourly), which we refuse.
function validateCron(expr: string): string | null {
  const fields = expr.split(/\s+/)
  if (fields.length !== 5) {
    return `"${expr}" is not a 5-field cron expression (minute hour day month weekday)`
  }
  for (const field of fields) {
    for (const part of field.split(',')) {
      if (!CRON_FIELD_TOKEN.test(part)) return `"${expr}" has an invalid cron field "${field}"`
    }
  }
  // Minimum cadence: the minute field must be a single fixed minute (0–59). Anything that can match
  // more than one minute-per-hour (wildcard, step, range, list) is sub-hourly and refused.
  const minute = fields[0]!
  if (!/^\d+$/.test(minute)) {
    return `"${expr}" schedules sub-hourly; the minute field must be a single fixed value (0–59) — minimum cadence is hourly`
  }
  const m = Number(minute)
  if (m < 0 || m > 59) return `"${expr}" has an out-of-range minute "${minute}"`
  return null
}

// Decide what kind of trigger a `when` string describes — a recurring 5-field cron ('schedule'), an
// absolute ISO-8601 timestamp ('self'), or an error. EXPORTED + pure so it's unit-testable without a
// db write. Heuristic: a multi-field whitespace-separated string is treated as cron (and validated);
// otherwise it's parsed as an absolute timestamp. Conservative: an unparseable single token is an
// error, never a silently never-firing trigger.
export function decideWhen(rawWhen: string): WhenDecision {
  const when = rawWhen.trim()
  if (!when) return { error: 'schedule_self requires a non-empty when' }
  // More than one whitespace-separated field ⇒ the agent meant a cron expression. Validate it
  // strictly (5 fields + cadence) rather than treating a malformed 5-token string as a valid cron
  // that never fires.
  if (/\s/.test(when)) {
    const err = validateCron(when)
    return err ? { error: `schedule_self: ${err}` } : { kind: 'schedule', cron: when }
  }
  // A single token: an absolute one-shot timestamp.
  const ms = Date.parse(when)
  if (Number.isNaN(ms)) {
    return { error: `schedule_self: "${when}" is neither a cron expression nor a parseable timestamp` }
  }
  return { kind: 'self', nextFireAt: new Date(ms) }
}

// schedule_self: the agent schedules a future autonomous run (autonomous-watchers spec, §7.7
// self-scheduling). Inserts ONE triggers row — a recurring cron ('schedule') or a one-shot future
// time ('self', carrying THIS conversation so the future run appends here, not an orphan thread).
// read-tier and NOT approval-gated (owner's decision): scheduling is low-risk because the future
// run gates every ACTION itself; the 'read' tier is a deliberate "no approval" choice, not a
// no-side-effects claim (it writes one triggers row). The owner can flip it to ask via the Tools
// page. group 'triggers'. source_run_id = the current run (provenance).
export function makeScheduleSelfTool(conversationId: string, runId?: string): Tool {
  return {
    name: 'schedule_self',
    description:
      'Schedule a future autonomous run for yourself — a reminder or a recurring check. Use a ' +
      'cron expression (e.g. "0 8 * * *" for 8am daily) for a recurring schedule, or an absolute ' +
      'ISO timestamp (e.g. "2026-06-20T09:00:00Z") for a one-time run. The scheduled run gates ' +
      'any real actions itself when it fires.',
    inputSchema: {
      type: 'object',
      properties: {
        when: {
          type: 'string',
          description:
            'A cron expression for a recurring schedule, or an absolute ISO-8601 timestamp for a one-time run.',
        },
        objective: {
          type: 'string',
          description: 'What the future run should do (its seed prompt).',
        },
        gate: {
          type: 'object',
          description:
            'Optional Tier-0 deterministic gate { tool, args, signal } — only escalate to a full ' +
            'run when a read-tier tool result changes. signal: "maxUid" for NEW arrivals (monotonic — ' +
            'use this for new-mail/new-item watchers; reading or removing items never re-fires), ' +
            '"count" only if a decrease should ALSO fire, "hash" for content changes. The first poll ' +
            'establishes a baseline silently (it never fires on what already exists). Omit to always run.',
        },
        notify_policy: {
          type: 'string',
          enum: ['always', 'on_change', 'on_threshold', 'digest'],
          description: 'When a finished run should push a notification (default on_change).',
        },
      },
      required: ['when', 'objective'],
    },
    trustTier: 'read',
    group: 'triggers',
    async invoke(args: unknown): Promise<unknown> {
      const {
        when: rawWhen,
        objective: rawObjective,
        gate,
        notify_policy: rawNotifyPolicy,
      } = (args ?? {}) as {
        when?: unknown
        objective?: unknown
        gate?: unknown
        notify_policy?: unknown
      }
      const objective = String(rawObjective ?? '').trim()
      if (!objective) throw new Error('schedule_self requires a non-empty objective')

      const notifyPolicy =
        rawNotifyPolicy === 'always' ||
        rawNotifyPolicy === 'on_change' ||
        rawNotifyPolicy === 'on_threshold' ||
        rawNotifyPolicy === 'digest'
          ? rawNotifyPolicy
          : 'on_change'

      // Decide cron vs one-shot timestamp + validate (5-field cron, ≥ hourly cadence). A rejection
      // is returned as a tool error the agent can read and correct — NOT a thrown exception, and
      // never a silently never-firing row. (Bare arrays are never returned — CHANGELOG 34.)
      const decision = decideWhen(String(rawWhen ?? ''))
      if ('error' in decision) return { ok: false, error: decision.error }

      // Cap the standing recurring/one-shot self-scheduled triggers per owner so a prompt-injected
      // agent can't fan out an amplification loop (§16). Count the owner's enabled self/schedule rows
      // and refuse past the cap with a clear error. Kept here (not as a write-tier gate) so the tool
      // stays read-tier/no-approval per the owner's decision.
      const db = getDb()
      const enabled = await listEnabledTriggers(db, OWNER_USER_ID)
      const standing = enabled.filter((t) => t.kind === 'self' || t.kind === 'schedule').length
      if (standing >= MAX_SELF_SCHEDULE_TRIGGERS) {
        return {
          ok: false,
          error:
            `schedule_self: already at the cap of ${MAX_SELF_SCHEDULE_TRIGGERS} scheduled triggers — ` +
            `disable an existing one before adding another.`,
        }
      }

      const isCron = decision.kind === 'schedule'
      const { id } = await insertTrigger(db, {
        userId: OWNER_USER_ID,
        // A short human label from the objective (the row's `name`).
        name: objective.slice(0, 80),
        kind: decision.kind,
        // A recurring 'schedule' lives in its own persistent trigger conversation (resolved by the
        // detect handler); a one-shot 'self' run appends to THIS conversation.
        conversationId: isCron ? null : conversationId,
        schedule: isCron ? decision.cron : null,
        gate: gate ?? null,
        objective,
        notifyPolicy,
        nextFireAt: isCron ? null : decision.nextFireAt,
        sourceRunId: runId ?? null,
      })
      return { ok: true, id }
    },
  }
}

// The management half of the `triggers` tool family (schedule_self is the create half). list is
// read-tier; disable + delete are write-tier so a prompt-injected agent can't silently kill the
// owner's watchers (approval is owner-overridable from the Tools page). All in group 'triggers'.
export const listTriggersTool: Tool = {
  name: 'list_triggers',
  description:
    'List your scheduled triggers / watchers (recurring schedules, inbox/page watchers, one-shot ' +
    'reminders) with their id, kind, schedule, enabled state, objective, and last/next fire time. ' +
    'Use an id with disable_trigger or delete_trigger.',
  inputSchema: { type: 'object', properties: {} },
  trustTier: 'read',
  group: 'triggers',
  async invoke(): Promise<unknown> {
    const rows = await listTriggers(getDb(), OWNER_USER_ID)
    return {
      triggers: rows.map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        enabled: t.enabled,
        schedule: t.schedule,
        objective: t.objective,
        notify_policy: t.notifyPolicy,
        detection_cost_usd: t.detectionCostUsd,
        last_fired_at: t.lastFiredAt,
        next_fire_at: t.nextFireAt,
      })),
    }
  },
}

export const disableTriggerTool: Tool = {
  name: 'disable_trigger',
  description:
    'Disable (pause) a scheduled trigger by id — it stops firing and frees a scheduling slot but ' +
    'is kept and can be re-enabled. To remove it permanently use delete_trigger. Find the id with list_triggers.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The trigger id from list_triggers.' } },
    required: ['id'],
  },
  trustTier: 'write',
  group: 'triggers',
  async invoke(args: unknown): Promise<unknown> {
    const id = String((args as { id?: unknown } | null)?.id ?? '').trim()
    if (!id) return { ok: false, error: 'disable_trigger requires a trigger id' }
    const { updated } = await setTriggerEnabled(getDb(), { userId: OWNER_USER_ID, id, enabled: false })
    return updated ? { ok: true, id } : { ok: false, error: 'no such trigger' }
  },
}

export const deleteTriggerTool: Tool = {
  name: 'delete_trigger',
  description:
    'Permanently delete a scheduled trigger by id (irreversible — also drops its watcher ' +
    'scratchpad). To just pause it, use disable_trigger. Find the id with list_triggers.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The trigger id from list_triggers.' } },
    required: ['id'],
  },
  trustTier: 'write',
  group: 'triggers',
  async invoke(args: unknown): Promise<unknown> {
    const id = String((args as { id?: unknown } | null)?.id ?? '').trim()
    if (!id) return { ok: false, error: 'delete_trigger requires a trigger id' }
    const { deleted } = await deleteTrigger(getDb(), { userId: OWNER_USER_ID, id })
    return deleted ? { ok: true, id } : { ok: false, error: 'no such trigger' }
  },
}

// Fire a trigger NOW (read-tier — testing convenience; it only fires an EXISTING owner trigger,
// and the spawned action run still gates write/destructive tools, so the blast radius is "run an
// already-defined objective now". Owner can flip it to ask via the Tools page).
export const runTriggerTool: Tool = {
  name: 'run_trigger',
  description:
    'Fire a scheduled trigger NOW instead of waiting for its schedule (useful for testing). mode ' +
    '"now" (default) skips the gate + triage and runs the watcher\'s objective immediately — best ' +
    'for testing the action + its notification; mode "detect" runs the full detection ladder ' +
    '(gate → triage) now, exactly as a real tick would. Find the id with list_triggers. The fired ' +
    'run still gates any write/destructive actions.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The trigger id from list_triggers.' },
      mode: {
        type: 'string',
        enum: ['now', 'detect'],
        description:
          '"now" (default) = skip detection, run the objective immediately; "detect" = run the gate + triage ladder now.',
      },
    },
    required: ['id'],
  },
  trustTier: 'read',
  group: 'triggers',
  async invoke(args: unknown): Promise<unknown> {
    const { id: rawId, mode } = (args ?? {}) as { id?: unknown; mode?: unknown }
    const id = String(rawId ?? '').trim()
    if (!id) return { ok: false, error: 'run_trigger requires a trigger id' }
    const trigger = await getTrigger(getDb(), id)
    if (!trigger) return { ok: false, error: 'no such trigger' }
    if (!trigger.enabled) return { ok: false, error: 'trigger is disabled — enable it first' }
    const force = mode !== 'detect' // default 'now' ⇒ skip detection, run the objective immediately
    await enqueueTriggerDetect(id, { force })
    return { ok: true, id, mode: force ? 'now' : 'detect' }
  },
}
