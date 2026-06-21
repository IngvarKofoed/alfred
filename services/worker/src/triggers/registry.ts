import { type Trigger } from '@alfred/agent-core'
import { emailTrigger } from './email.js'
import { timerTrigger } from './timer.js'
import { webhookTrigger } from './webhook.js'

// The worker-side Trigger registry (spec docs/specs/2026-06-19-trigger-abstraction.md) — maps a
// Trigger name (automations.trigger) to its Trigger implementation, the way toolCatalog() maps
// tool names to Tools. detect.ts looks a Trigger up here by automation.trigger, exactly as gate.ts
// looked the gate tool up in the catalog. Living in the worker keeps detect() where the Tools +
// providers already are; the scheduler (services/triggers) never imports this (DEPLOYMENT §5: the
// scheduler owns timing only, never the tool/trigger layer).
export const triggerRegistry: Record<string, Trigger> = {
  [emailTrigger.name]: emailTrigger as Trigger,
  [timerTrigger.name]: timerTrigger as Trigger,
  [webhookTrigger.name]: webhookTrigger as Trigger,
}

// Look up a Trigger by name; throws on an unknown name (a stored automation referencing a Trigger
// the worker no longer ships is a config/version error, surfaced loudly rather than silently
// no-firing — mirrors gate.ts's unknown-tool refusal).
export function lookupTrigger(name: string): Trigger {
  const trigger = triggerRegistry[name]
  if (!trigger) throw new Error(`unknown trigger "${name}"`)
  return trigger
}

// The agent-facing catalog for create_automation: each Trigger's name + paramsSchema, so the
// agent can pick a Trigger and fill valid params (the Trigger analogue of exposing the tool
// catalog for tool-calling). Mode is included so the tool can reject a `when` on a push Trigger.
export function triggerCatalog(): { name: string; mode: 'poll' | 'push'; paramsSchema: object }[] {
  return Object.values(triggerRegistry).map((t) => ({
    name: t.name,
    mode: t.mode,
    paramsSchema: t.paramsSchema,
  }))
}
