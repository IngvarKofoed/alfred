import { echoTool, type Tool } from '@alfred/agent-core'
import { getDb, tools as toolsTable } from '@alfred/db'
import { sql } from 'drizzle-orm'
import { getBridge } from './browser/bridge.js'
import { makeBrowserTools } from './browser/tools.js'
import { makeEmailTools } from './email/tools.js'
import { makeMemoryTools } from './memory/tools.js'
import { makePythonTools } from './python/tools.js'
import {
  deleteTriggerTool,
  disableTriggerTool,
  listTriggersTool,
  makeAskUserTool,
  makeCreateAutomationTool,
  makeFileTools,
  makeGenerateImageTool,
  makeSetTitleTool,
  runAutomationTool,
  updateAutomationTool,
} from './tools.js'

// Browser tools are process-static (the bridge is a singleton; the tools carry no per-run
// state), so build them once at module load rather than per run.
const BROWSER_TOOLS = makeBrowserTools(getBridge())

// Email tools act on the mailbox, not a per-conversation workspace, so — like the browser
// tools — they carry no per-run state and are built once at module load.
const EMAIL_TOOLS = makeEmailTools()

// ask_user's pause is run-bound (it closes over db + run + toolCallRowIds). toolCatalog()
// only reads metadata, so it passes no pause — this stub stands in and is never invoked.
const askUserPauseStub = () => Promise.reject(new Error('ask_user pause not bound'))

// The full toolset for a run. The conversation-bound tools (title, file, python, ask_user) are
// rebuilt per call; the memory tools close over runId so a saved fact records its source_run_id
// (spec docs/specs/2026-06-15-long-term-memory.md) AND over the memory scope so a watcher run's
// remember/list/forget operate on its own scratchpad scope (`automation:<id>`, trigger-abstraction
// spec) rather than the owner's global memory; echo, generate_image, and the browser tools
// carry no per-conversation state. `memoryScope` defaults 'global' so an interactive run is
// byte-for-byte unchanged.
export function buildRunTools(
  conversationId: string,
  askUserPause?: (callId: string, prompt: unknown) => Promise<unknown>,
  runId?: string,
  memoryScope = 'global',
): Tool[] {
  return [
    echoTool,
    makeSetTitleTool(conversationId),
    makeGenerateImageTool(),
    makeAskUserTool(askUserPause ?? askUserPauseStub),
    makeCreateAutomationTool(conversationId, runId),
    listTriggersTool,
    updateAutomationTool,
    disableTriggerTool,
    deleteTriggerTool,
    runAutomationTool,
    ...makeFileTools(conversationId),
    ...makePythonTools(conversationId),
    ...makeMemoryTools(runId, memoryScope),
    ...EMAIL_TOOLS,
    ...BROWSER_TOOLS,
  ]
}

// Metadata for every tool the worker can run, derived from the real Tool instances so the
// published catalog can't drift from what actually runs. The conversation-bound tools'
// metadata (name/group/tier/description) is independent of the conversation id they close
// over, so a placeholder is fine here.
export function toolCatalog(): Tool[] {
  return buildRunTools('')
}

// Publish the catalog to the `tools` table at boot (ARCHITECTURE §8 boot, tools-page spec).
// Upserts the worker-owned catalog columns and refreshes last_seen_at; never touches
// require_approval, which is owner-owned (set from the web Tools page).
export async function publishToolCatalog(): Promise<void> {
  const now = new Date()
  const rows = toolCatalog().map((t) => ({
    name: t.name,
    toolGroup: t.group ?? null,
    trustTier: t.trustTier,
    description: t.description,
    lastSeenAt: now,
  }))
  // One multi-row upsert: refresh the worker-owned catalog columns from the incoming row
  // (excluded.*), leaving the owner-owned require_approval untouched.
  await getDb()
    .insert(toolsTable)
    .values(rows)
    .onConflictDoUpdate({
      target: toolsTable.name,
      set: {
        toolGroup: sql`excluded.tool_group`,
        trustTier: sql`excluded.trust_tier`,
        description: sql`excluded.description`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
    })
}
