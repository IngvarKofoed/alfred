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
  ],
}
