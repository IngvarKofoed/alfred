import { spawnSync } from 'node:child_process'
import { loadConfig } from '@alfred/shared'

const config = loadConfig()
const BRANCH = config.DEPLOY_BRANCH

// The updater must never stop/restart itself, so its own pm2 name can never be a managed app:
// filter it out of DEPLOY_APPS defensively, even if it's misconfigured to include it (S3).
const SELF_NAME = 'alfred-updater'
const rawApps = config.DEPLOY_APPS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const APPS = rawApps.filter((a) => a !== SELF_NAME)
if (APPS.length !== rawApps.length) {
  console.warn(`alfred-updater: ignoring '${SELF_NAME}' in DEPLOY_APPS — the updater never restarts itself`)
}
// Comma-joined form for `pm2 --only`.
const APPS_ARG = APPS.join(',')

let deploying = false

// Run a command at the repo root (pm2 sets cwd there via ecosystem.config.cjs). shell:true
// so pnpm/pm2 .cmd shims resolve on the Windows deploy box. Throws on non-zero exit.
function run(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { cwd: process.cwd(), encoding: 'utf8', shell: true })
  const out = (res.stdout ?? '') + (res.stderr ?? '')
  if (res.status !== 0) {
    throw new Error(cmd + ' ' + args.join(' ') + ' exited ' + res.status + '\n' + out)
  }
  return out.trim()
}

// Always leave the box up. Start via the ecosystem file (--only the managed apps) so recovery
// is robust to a lost pm2 registry: `pm2 start <bareName>` only works if pm2 already knows the
// app, whereas the config file re-declares it (S2). Fall back to restart if they're already up.
function ensureAppsStarted(): void {
  if (!APPS_ARG) return
  try {
    run('pm2', ['start', 'ecosystem.config.cjs', '--only', APPS_ARG])
  } catch {
    try {
      run('pm2', ['restart', APPS_ARG])
    } catch (e) {
      console.error('alfred-updater: FAILED to bring apps back up', e)
    }
  }
}

function deploy(): void {
  if (deploying) return
  deploying = true
  console.log('alfred-updater: change detected, deploying...')
  try {
    // Stop is best-effort: a not-yet-known or already-stopped app must not abort the deploy (S2).
    if (APPS_ARG) {
      try {
        run('pm2', ['stop', ...APPS])
      } catch (e) {
        console.warn('alfred-updater: pm2 stop best-effort (some apps may not be running):', e)
      }
    }
    // Ensure we're ON the deploy branch before resetting, so a box left on another branch can't
    // have the wrong branch silently rewritten to origin/<branch> (S1). -f discards any local
    // working-tree changes during the switch, consistent with the hard-reset-to-origin policy.
    run('git', ['checkout', '-f', BRANCH])
    run('git', ['reset', '--hard', 'origin/' + BRANCH])
    run('pnpm', ['install', '--frozen-lockfile'])
    run('pnpm', ['-r', 'build'])
    // Migration failure must NOT keep the box down: log loudly, still start the apps.
    try {
      run('pnpm', ['db:migrate'])
    } catch (e) {
      console.error('alfred-updater: migration FAILED (starting apps anyway):', e)
    }
    ensureAppsStarted()
    console.log('alfred-updater: deploy complete')
  } catch (e) {
    console.error('alfred-updater: deploy FAILED:', e)
    ensureAppsStarted()
  } finally {
    deploying = false
  }
}

function tick(): void {
  if (deploying) return
  try {
    run('git', ['fetch', 'origin', BRANCH])
    const local = run('git', ['rev-parse', 'HEAD'])
    const remote = run('git', ['rev-parse', 'origin/' + BRANCH])
    if (local === remote) return
    deploy()
  } catch (e) {
    console.error('alfred-updater: tick failed:', e)
  }
}

if (!config.DEPLOY_ENABLED) {
  console.log('alfred-updater: deploy disabled (DEPLOY_ENABLED!=true) - idling')
  // Keep the process alive so pm2 shows it online instead of crash-looping.
  setInterval(() => {}, 1 << 30)
} else {
  console.log(
    'alfred-updater: enabled - polling origin/' +
      BRANCH +
      ' every ' +
      config.DEPLOY_POLL_INTERVAL_MS +
      'ms; apps: ' +
      APPS.join(', '),
  )
  tick()
  setInterval(tick, config.DEPLOY_POLL_INTERVAL_MS)
}
