// pm2 process definitions. Run from the repo root: `pm2 start ecosystem.config.cjs`.
// CommonJS (.cjs) because the repo is an ESM package ("type": "module").
module.exports = {
  apps: [
    {
      name: 'alfred-webserver',
      cwd: __dirname,
      script: 'services/webserver/dist/index.js',
      env: { NODE_ENV: 'production' },
      autorestart: true,
    },
    {
      name: 'alfred-worker',
      cwd: __dirname,
      script: 'services/worker/dist/index.js',
      env: { NODE_ENV: 'production' },
      autorestart: true,
    },
    {
      name: 'alfred-triggers',
      cwd: __dirname,
      script: 'services/triggers/dist/index.js',
      env: { NODE_ENV: 'production' },
      autorestart: true,
    },
    {
      name: 'alfred-updater',
      cwd: __dirname,
      script: 'services/updater/dist/index.js',
      // DEPLOY_ENABLED lives ONLY in env_deploy, never in the default env block:
      // pm2-injected env wins over .env (dotenv doesn't override already-set vars), so a
      // default DEPLOY_ENABLED:false would defeat the documented .env enable-path. Absent
      // from default env, a plain `pm2 start` lets .env (or the default false) decide, while
      // `pm2 start --env deploy` forces it true.
      env: { NODE_ENV: 'production' },
      env_deploy: { NODE_ENV: 'production', DEPLOY_ENABLED: 'true' },
      autorestart: true,
    },
  ],
}
