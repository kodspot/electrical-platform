'use strict';

/**
 * Starts the API for Playwright's webServer: re-checks the database safety rule, applies
 * migrations (idempotent — global-setup does the same, so the order Playwright runs the two
 * in does not matter), then runs the real entry point `node index.js` as its own process,
 * forwarding stop signals and the exit code.
 */

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { assertE2eDatabase } = require('../support/safety');

assertE2eDatabase(process.env);

const API_DIR = path.join(__dirname, '..', '..', 'apps', 'api');
const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: API_DIR, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32', env: process.env
});
if (migrate.status !== 0) {
  console.error('[e2e] prisma migrate deploy failed');
  process.exit(1);
}

const app = spawn(process.execPath, ['index.js'], { cwd: API_DIR, stdio: 'inherit', env: process.env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.kill(sig));
app.on('exit', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
