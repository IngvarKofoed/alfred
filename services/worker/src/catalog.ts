import { echoTool, type Tool } from '@alfred/agent-core'
import { getDb, tools as toolsTable } from '@alfred/db'
import { sql } from 'drizzle-orm'
import { getBridge } from './browser/bridge.js'
import { makeBrowserTools } from './browser/tools.js'
import { makeSetTitleTool } from './tools.js'

// Browser tools are process-static (the bridge is a singleton; the tools carry no per-run
// state), so build them once at module load rather than per run.
const BROWSER_TOOLS = makeBrowserTools(getBridge())

// The full toolset for a run. Only set_conversation_title depends on the conversation, so
// it's the only piece rebuilt per call; echo and the browser tools are shared.
export function buildRunTools(conversationId: string): Tool[] {
  return [echoTool, makeSetTitleTool(conversationId), ...BROWSER_TOOLS]
}

// Metadata for every tool the worker can run, derived from the real Tool instances so the
// published catalog can't drift from what actually runs. set_conversation_title's metadata
// (name/group/tier/description) is independent of the conversation id it closes over, so a
// placeholder is fine here.
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
