import fs from 'node:fs'
import path from 'node:path'
import { type ImageToolResult, type Tool, type ToolContext } from '@alfred/agent-core'
import {
  conversations,
  deleteTrigger,
  enqueueTriggerDetect,
  getAutomation,
  getDb,
  insertAutomation,
  listEnabledAutomations,
  listTriggers,
  OWNER_USER_ID,
  setTriggerEnabled,
  updateAutomation,
} from '@alfred/db'
import { imageMimeForExt, resolveInWorkspace } from '@alfred/shared'
import { eq } from 'drizzle-orm'
import { capResult } from './cap.js'
import { DEFAULT_IMAGE_MODEL, imageModelChoices, resolveImageProvider } from './images-registry.js'
import { lookupTrigger, triggerCatalog } from './triggers/registry.js'
import { validateParams } from './triggers/validate-params.js'

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

// create_automation bounds (§16 blast radius): a prompt-injected agent must not be able to schedule
// an amplification loop. We keep the tool read-tier/no-approval (owner's deliberate choice) but bound
// it structurally — a cap on the total enabled standing automations per owner. Past the cap, the tool
// returns a clear error instead of inserting. There is deliberately NO cadence floor: the owner is the
// decider and per-minute schedules are allowed (cron's finest granularity). A per-minute *poll* is
// cheap — Tier-0 detect on no change is free, only escalations cost — so the standing-automation cap,
// not a frequency limit, is the bound that matters.
export const MAX_SELF_SCHEDULE_TRIGGERS = 25

// A token in a single cron field: '*', a number, a step ('*/N' | 'a/N'), a range ('a-b'), or a
// comma list of those. Used by the validator below — pg-boss cron is the standard 5-field form.
const CRON_FIELD_TOKEN = /^(\*|\d+)(-\d+)?(\/\d+)?$/

// The decision create_automation / update_automation make from a `when` arg, as a pure value so it's
// unit-testable without a db write. `kind:'schedule'` ⇒ a recurring cron trigger; `kind:'self'` ⇒ a
// one-shot trigger firing once at `nextFireAt`; `error` ⇒ a rejection (bad cron / unparseable
// timestamp). The error is tool-agnostic (no tool-name prefix) so both callers can reuse it and add
// their own prefix.
export type WhenDecision =
  | { kind: 'schedule'; cron: string }
  | { kind: 'self'; nextFireAt: Date }
  | { error: string }

// Validate a standard 5-field cron expression. Returns an error string (not throwing) so callers can
// surface it verbatim. Rejecting 6-field expressions matters: pg-boss cron is 5-field, so a 6-field
// string would be silently misinterpreted. There is deliberately NO minimum-cadence floor — the owner
// is the decider, and cron's finest granularity is 1 minute, so '* * * * *' (every minute) and '*/5'
// (every 5 min) are allowed. The §16 self-scheduling bound is the standing-automation cap, not a
// frequency limit (a per-minute poll is cheap — see MAX_SELF_SCHEDULE_TRIGGERS).
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
  // A single fixed minute must still be in range (0–59); other forms (*, steps, ranges, lists) are
  // shape-checked above and bounded by cron semantics at schedule time.
  const minute = fields[0]!
  if (/^\d+$/.test(minute) && Number(minute) > 59) {
    return `"${expr}" has an out-of-range minute "${minute}"`
  }
  return null
}

// Decide what kind of trigger a `when` string describes — a recurring 5-field cron ('schedule'), an
// absolute ISO-8601 timestamp ('self'), or an error. EXPORTED + pure so it's unit-testable without a
// db write. Heuristic: a multi-field whitespace-separated string is treated as cron (and validated);
// otherwise it's parsed as an absolute timestamp. Conservative: an unparseable single token is an
// error, never a silently never-firing trigger.
export function decideWhen(rawWhen: string): WhenDecision {
  const when = rawWhen.trim()
  if (!when) return { error: 'a non-empty when is required (a cron expression or an ISO-8601 timestamp)' }
  // More than one whitespace-separated field ⇒ the agent meant a cron expression. Validate it
  // strictly (5 fields, valid tokens) rather than treating a malformed 5-token string as a valid cron
  // that never fires.
  if (/\s/.test(when)) {
    const err = validateCron(when)
    return err ? { error: err } : { kind: 'schedule', cron: when }
  }
  // A single token: an absolute one-shot timestamp.
  const ms = Date.parse(when)
  if (Number.isNaN(ms)) {
    return { error: `"${when}" is neither a cron expression nor a parseable timestamp` }
  }
  return { kind: 'self', nextFireAt: new Date(ms) }
}

// The agent-facing Trigger catalog, read once at module load (it can't drift from the registry).
// Surfaces each Trigger's name + params schema in the create_automation description so the agent
// picks a Trigger and fills valid params — the Trigger analogue of exposing the tool catalog.
const TRIGGER_CATALOG = triggerCatalog()
const TRIGGER_NAMES = TRIGGER_CATALOG.map((t) => t.name)
const TRIGGER_CATALOG_DESCRIPTION = TRIGGER_CATALOG.map(
  (t) => `${t.name} (${t.mode}): params ${JSON.stringify(t.paramsSchema)}`,
).join('; ')

// create_automation: the agent creates an autonomous automation (trigger-abstraction spec,
// "Creation"; supersedes schedule_self). An automation = a chosen Trigger (the pluggable firing
// mechanism — 'email'|'timer'|'webhook') + its schema-validated params + the action (objective) +
// notify policy. Inserts ONE automations row. `params` is validated against the chosen Trigger's
// paramsSchema at create time, so an invalid email automation is rejected up front, not silently
// degraded to fire-every-tick (the old freeform-gate footgun).
//
// `when` selects the cadence for a POLL Trigger: a cron expression → a recurring `schedule`, or an
// absolute ISO timestamp → a one-shot `next_fire_at` (carrying THIS conversation so the future run
// appends here). A PUSH Trigger ('webhook') is enqueued by an ingress and takes no `when`.
//
// read-tier and NOT approval-gated (owner's decision): scheduling is low-risk because the future run
// gates every ACTION itself; the 'read' tier is a deliberate "no approval" choice, not a
// no-side-effects claim (it writes one automations row). The owner can flip it to ask via the Tools
// page. group 'triggers'. source_run_id = the current run (provenance).
export function makeCreateAutomationTool(conversationId: string, runId?: string): Tool {
  return {
    name: 'create_automation',
    description:
      'Create an autonomous automation — a watcher or a scheduled/one-time run. Pick a trigger ' +
      '(the firing mechanism) and fill its params. Available triggers: ' +
      TRIGGER_CATALOG_DESCRIPTION +
      '. For a poll trigger (email/timer) give `when`: a cron expression (e.g. "0 8 * * *" for 8am ' +
      'daily) for a recurring schedule, or an absolute ISO-8601 timestamp (e.g. ' +
      '"2026-06-20T09:00:00Z") for a one-time run. A webhook trigger needs no `when`. The automation ' +
      'gates any real actions itself when it fires.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'A short human label for this automation (≤80 chars). It names the automation and titles ' +
            'each conversation the automation spawns when it fires, so prefer a clear noun phrase ' +
            '(e.g. "Morning inbox digest", "Rent reminder"). Defaults to the start of the objective if omitted.',
        },
        trigger: {
          type: 'string',
          enum: TRIGGER_NAMES,
          description: 'The firing mechanism. ' + TRIGGER_CATALOG_DESCRIPTION,
        },
        params: {
          type: 'object',
          description: "The chosen trigger's params (validated against its schema). Omit for triggers with no params.",
        },
        when: {
          type: 'string',
          description:
            'For a poll trigger: a cron expression for a recurring schedule, or an absolute ISO-8601 ' +
            'timestamp for a one-time run. Omit for a webhook (push) trigger.',
        },
        objective: {
          type: 'string',
          description: 'What the automation run should do when it fires (its seed prompt).',
        },
        notify_policy: {
          type: 'string',
          enum: ['always', 'on_change', 'on_threshold', 'digest'],
          description: 'When a finished run should push a notification (default on_change).',
        },
      },
      required: ['trigger', 'objective'],
    },
    trustTier: 'read',
    group: 'triggers',
    async invoke(args: unknown): Promise<unknown> {
      const {
        name: rawName,
        trigger: rawTrigger,
        params: rawParams,
        when: rawWhen,
        objective: rawObjective,
        notify_policy: rawNotifyPolicy,
      } = (args ?? {}) as {
        name?: unknown
        trigger?: unknown
        params?: unknown
        when?: unknown
        objective?: unknown
        notify_policy?: unknown
      }

      const objective = String(rawObjective ?? '').trim()
      if (!objective) throw new Error('create_automation requires a non-empty objective')

      // Resolve the chosen Trigger from the registry; an unknown name is a clear tool error (the
      // agent picked something not shipped) rather than a thrown crash.
      const triggerName = String(rawTrigger ?? '').trim()
      let trigger
      try {
        trigger = lookupTrigger(triggerName)
      } catch {
        return { ok: false, error: `create_automation: unknown trigger "${triggerName}" (available: ${TRIGGER_NAMES.join(', ')})` }
      }

      // Validate params against the Trigger's paramsSchema at create time — the whole point of the
      // abstraction (an invalid email automation is rejected here, not silently fire-every-tick).
      const params = rawParams ?? null
      const paramErr = validateParams(trigger.paramsSchema, params)
      if (paramErr) return { ok: false, error: `create_automation: invalid params for "${triggerName}" — ${paramErr}` }

      const notifyPolicy =
        rawNotifyPolicy === 'always' ||
        rawNotifyPolicy === 'on_change' ||
        rawNotifyPolicy === 'on_threshold' ||
        rawNotifyPolicy === 'digest'
          ? rawNotifyPolicy
          : 'on_change'

      // A push Trigger ('webhook') is enqueued by an ingress, never scheduled — it takes no `when`.
      // A poll Trigger needs a `when`: cron (recurring) or timestamp (one-shot). decideWhen validates
      // the 5-field cron syntax (no cadence floor — per-minute allowed); a rejection is returned as a
      // tool error, never a silently never-firing row. (Bare arrays are never returned — CHANGELOG 34.)
      const isPush = trigger.mode === 'push'
      let schedule: string | null = null
      let nextFireAt: Date | null = null
      if (!isPush) {
        const decision = decideWhen(String(rawWhen ?? ''))
        if ('error' in decision) return { ok: false, error: `create_automation: ${decision.error}` }
        if (decision.kind === 'schedule') schedule = decision.cron
        else nextFireAt = decision.nextFireAt
      }

      // Cap the standing automations per owner so a prompt-injected agent can't fan out an
      // amplification loop (§16). Count the owner's enabled rows and refuse past the cap. Kept here
      // (not as a write-tier gate) so the tool stays read-tier/no-approval per the owner's decision.
      const db = getDb()
      const enabled = await listEnabledAutomations(db, OWNER_USER_ID)
      if (enabled.length >= MAX_SELF_SCHEDULE_TRIGGERS) {
        return {
          ok: false,
          error:
            `create_automation: already at the cap of ${MAX_SELF_SCHEDULE_TRIGGERS} automations — ` +
            `disable an existing one before adding another.`,
        }
      }

      // A recurring (cron) or push automation lives in its own persistent conversation (resolved by
      // the detect handler); a one-shot run appends to THIS conversation.
      const isOneShot = !schedule && nextFireAt != null
      const { id } = await insertAutomation(db, {
        userId: OWNER_USER_ID,
        // The agent-supplied label (≤80 chars), else a short label derived from the objective. This
        // `name` is the automation's label AND the title of each per-fire conversation it spawns
        // (createAutomationRun passes automation.name as the conversation title).
        name: String(rawName ?? '').trim().slice(0, 80) || objective.slice(0, 80),
        trigger: triggerName,
        conversationId: isOneShot ? conversationId : null,
        schedule,
        params,
        objective,
        notifyPolicy,
        nextFireAt,
        sourceRunId: runId ?? null,
      })
      return { ok: true, id }
    },
  }
}

// The management half of the `triggers` tool family (create_automation is the create half). list is
// read-tier; disable + delete are write-tier so a prompt-injected agent can't silently kill the
// owner's automations (approval is owner-overridable from the Tools page). All in group 'triggers'.
export const listTriggersTool: Tool = {
  name: 'list_triggers',
  description:
    'List your automations / watchers (recurring schedules, inbox/page watchers, one-shot ' +
    'reminders) with their id, trigger, schedule, enabled state, objective, and last/next fire time. ' +
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
        trigger: t.trigger,
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

// Edit an existing automation's mutable definition fields (name / objective / params / when /
// notify_policy / enabled), keyed by id. write-tier like disable/delete: a prompt-injected agent must
// not be able to silently repurpose or reschedule the owner's standing automations (approval is
// owner-overridable from the Tools page). Only the supplied fields change; the rest are left as-is.
// The trigger MECHANISM itself isn't changeable here — to switch trigger type, delete and recreate
// (keeps the detection-cursor semantics simple). The scheduler picks up schedule/enabled changes on
// its next reconcile. group 'triggers'.
export const updateAutomationTool: Tool = {
  name: 'update_automation',
  description:
    'Edit an existing automation/watcher by id (from list_triggers). Supply only the fields to ' +
    'change — omitted fields are left as-is. Editable: name (its label + the title of each ' +
    'conversation it spawns), objective (what it does when it fires), params (the trigger\'s params, ' +
    're-validated against its schema; triggers: ' +
    TRIGGER_CATALOG_DESCRIPTION +
    '), when (reschedule — a cron expression for recurring or an ISO-8601 timestamp for one-time; ' +
    'poll triggers only), notify_policy, and enabled (false to pause, true to resume). To change the ' +
    'trigger MECHANISM itself, delete and recreate instead.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The automation id from list_triggers.' },
      name: {
        type: 'string',
        description: 'New human label (≤80 chars); also titles each per-fire conversation it spawns.',
      },
      objective: { type: 'string', description: 'New seed prompt — what the run does when it fires.' },
      params: {
        type: 'object',
        description:
          "Replace the trigger's params (re-validated against the trigger's schema). Changing params " +
          're-baselines detection — the automation will not fire on already-existing items, only on ' +
          'new ones after the change.',
      },
      when: {
        type: 'string',
        description:
          'Reschedule: a cron expression (recurring) or an absolute ISO-8601 timestamp (one-time). ' +
          'Only for poll triggers (email/timer); a webhook trigger has no schedule.',
      },
      notify_policy: {
        type: 'string',
        enum: ['always', 'on_change', 'on_threshold', 'digest'],
        description: 'When a finished run should push a notification.',
      },
      enabled: { type: 'boolean', description: 'false to pause (like disable_trigger), true to resume.' },
    },
    required: ['id'],
  },
  trustTier: 'write',
  group: 'triggers',
  async invoke(args: unknown): Promise<unknown> {
    const a = (args ?? {}) as Record<string, unknown>
    const id = String(a.id ?? '').trim()
    if (!id) return { ok: false, error: 'update_automation requires an automation id' }

    const db = getDb()
    const automation = await getAutomation(db, id)
    if (!automation || automation.userId !== OWNER_USER_ID) return { ok: false, error: 'no such automation' }

    // The trigger is fixed across an update; resolve it once (it was validated at create, but a
    // direct DB row could carry an unknown name — guard rather than throw).
    let trigger: ReturnType<typeof lookupTrigger>
    try {
      trigger = lookupTrigger(automation.trigger)
    } catch {
      return {
        ok: false,
        error: `update_automation: automation has an unknown trigger "${automation.trigger}" — delete and recreate it`,
      }
    }

    const fields: {
      name?: string
      objective?: string
      params?: unknown
      schedule?: string | null
      nextFireAt?: Date | null
      notifyPolicy?: string
      enabled?: boolean
      cursor?: unknown
      pendingCursor?: unknown
    } = {}

    // `!= null` (not `!== undefined`) so a JSON `null` is treated as "field omitted", never coerced
    // (String(null) would otherwise store the literal "null").
    if (a.name != null) {
      const name = String(a.name).trim()
      if (!name) return { ok: false, error: 'update_automation: name must be non-empty' }
      fields.name = name.slice(0, 80)
    }
    if (a.objective != null) {
      const objective = String(a.objective).trim()
      if (!objective) return { ok: false, error: 'update_automation: objective must be non-empty' }
      fields.objective = objective
    }
    if (a.params != null) {
      const paramErr = validateParams(trigger.paramsSchema, a.params)
      if (paramErr) return { ok: false, error: `update_automation: invalid params for "${automation.trigger}" — ${paramErr}` }
      fields.params = a.params
      // Re-baseline detection on a params change: the prior cursor may be incomparable under the new
      // params (e.g. an email `mailbox` switch — IMAP UIDs are per-mailbox), which would silently drop
      // or re-report items. Nulling both makes the next detect() establish a fresh baseline (it won't
      // fire on the pre-existing backlog). Trigger-agnostic, so no per-trigger special-casing here.
      fields.cursor = null
      fields.pendingCursor = null
    }
    if (a.when != null) {
      // A push Trigger (webhook) is ingress-enqueued, never scheduled — it has no `when` (mirrors create).
      if (trigger.mode === 'push') {
        return { ok: false, error: `update_automation: a "${automation.trigger}" (webhook) trigger has no schedule — omit when` }
      }
      const decision = decideWhen(String(a.when))
      if ('error' in decision) return { ok: false, error: `update_automation: ${decision.error}` }
      // Set exactly one cadence column and null the other, so a row never looks both recurring
      // (schedule) and one-shot (nextFireAt) to the scheduler.
      if (decision.kind === 'schedule') {
        fields.schedule = decision.cron
        fields.nextFireAt = null
      } else {
        fields.nextFireAt = decision.nextFireAt
        fields.schedule = null
      }
    }
    if (a.notify_policy != null) {
      const np = String(a.notify_policy)
      if (np !== 'always' && np !== 'on_change' && np !== 'on_threshold' && np !== 'digest') {
        return { ok: false, error: 'update_automation: notify_policy must be one of always | on_change | on_threshold | digest' }
      }
      fields.notifyPolicy = np
    }
    if (a.enabled != null) {
      // Accept a real boolean or a stringified one — Boolean('false') is truthy, so a model that
      // sends "false" must not be read as enable.
      const enabled = a.enabled === true || a.enabled === 'true'
      // Re-enabling a paused automation re-checks the standing-automation cap (§16) — the same bound
      // create_automation enforces, since a disabled row doesn't occupy a slot.
      if (enabled && !automation.enabled) {
        const enabledRows = await listEnabledAutomations(db, OWNER_USER_ID)
        if (enabledRows.length >= MAX_SELF_SCHEDULE_TRIGGERS) {
          return {
            ok: false,
            error: `update_automation: already at the cap of ${MAX_SELF_SCHEDULE_TRIGGERS} enabled automations — disable another before resuming this one.`,
          }
        }
      }
      fields.enabled = enabled
    }

    if (Object.keys(fields).length === 0) {
      return { ok: false, error: 'update_automation: nothing to update — supply at least one field besides id' }
    }

    const { updated } = await updateAutomation(db, { userId: OWNER_USER_ID, id, ...fields })
    return updated ? { ok: true, id } : { ok: false, error: 'no such automation' }
  },
}

// Fire an automation NOW (read-tier — testing convenience; it only fires an EXISTING owner
// automation, and the spawned action run still gates write/destructive tools, so the blast radius is
// "run an already-defined objective now". Owner can flip it to ask via the Tools page).
export const runAutomationTool: Tool = {
  name: 'run_automation',
  description:
    'Fire an automation NOW instead of waiting for its schedule (useful for testing). mode ' +
    '"now" (default) skips detection + triage and runs the automation\'s objective immediately — best ' +
    'for testing the action + its notification; mode "detect" runs the full detection ladder ' +
    '(the trigger\'s detect() → triage) now, exactly as a real tick would. Find the id with ' +
    'list_triggers. The fired run still gates any write/destructive actions.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The automation id from list_triggers.' },
      mode: {
        type: 'string',
        enum: ['now', 'detect'],
        description:
          '"now" (default) = skip detection, run the objective immediately; "detect" = run the detect() + triage ladder now.',
      },
    },
    required: ['id'],
  },
  trustTier: 'read',
  group: 'triggers',
  async invoke(args: unknown): Promise<unknown> {
    const { id: rawId, mode } = (args ?? {}) as { id?: unknown; mode?: unknown }
    const id = String(rawId ?? '').trim()
    if (!id) return { ok: false, error: 'run_automation requires an automation id' }
    const automation = await getAutomation(getDb(), id)
    if (!automation) return { ok: false, error: 'no such automation' }
    if (!automation.enabled) return { ok: false, error: 'automation is disabled — enable it first' }
    const force = mode !== 'detect' // default 'now' ⇒ skip detection, run the objective immediately
    await enqueueTriggerDetect(id, { force })
    return { ok: true, id, mode: force ? 'now' : 'detect' }
  },
}
