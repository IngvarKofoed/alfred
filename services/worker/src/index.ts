import { sweepOrphanedRuns, workAgentRuns } from '@alfred/db'
import { runJob } from './run.js'

// Fail-and-restart: on boot, any run left 'running' is orphaned -> mark it failed.
const swept = await sweepOrphanedRuns()
if (swept > 0) console.log(`alfred-worker: swept ${swept} orphaned run(s) to failed`)

await workAgentRuns(runJob)
console.log('alfred-worker: consuming agent-run jobs')
