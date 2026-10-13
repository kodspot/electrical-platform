'use strict';

/**
 * `npm run e2e` / `npm run e2e:ui` (repository root).
 *
 * Starts a disposable postgres:15-alpine container (`e2e-pg-<pid>`, 127.0.0.1:55433, database
 * `electrical_e2e`), runs Playwright against it, and removes the container when the run ends —
 * on success, failure or Ctrl+C (the Node equivalent of a shell `trap`). Extra arguments pass
 * through to `playwright test`, e.g. `npm run e2e -- --grep J2`.
 *
 * Never touches any other container and never uses docker compose.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const E2E_DIR = path.join(__dirname, '..');
const NAME = `e2e-pg-${process.pid}`;
const PORT = 55433;
const ui = process.argv.includes('--ui-mode');
const passthrough = process.argv.slice(2).filter((a) => a !== '--ui-mode');

const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  docker(['rm', '-f', NAME], { stdio: 'ignore' });
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

const started = docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_USER=e2e', '-e', 'POSTGRES_PASSWORD=e2e',
  '-e', 'POSTGRES_DB=electrical_e2e', '-p', `127.0.0.1:${PORT}:5432`, 'postgres:15-alpine']);
if (started.status !== 0) {
  console.error(`[e2e] could not start the database container: ${(started.stderr || '').trim()}`);
  process.exit(1);
}
let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  ready = docker(['exec', NAME, 'pg_isready', '-U', 'e2e', '-d', 'electrical_e2e']).status === 0;
  if (!ready) sleep(1000);
}
if (!ready) { console.error('[e2e] database did not become ready'); process.exit(1); }
// pg_isready can succeed during the image's init restart; one real query proves readiness.
for (let i = 0; i < 20; i++) {
  if (docker(['exec', NAME, 'psql', '-U', 'e2e', '-d', 'electrical_e2e', '-c', 'select 1']).status === 0) break;
  sleep(500);
}

const env = { ...process.env, DATABASE_URL: `postgresql://e2e:e2e@127.0.0.1:${PORT}/electrical_e2e` };
// Run Playwright's CLI with node directly — no shell — so pass-through arguments such as
// `--grep "J1|J2"` reach Playwright verbatim instead of being parsed by a shell.
const cli = path.join(E2E_DIR, 'node_modules', '@playwright', 'test', 'cli.js');
const args = [cli, 'test', ...(ui ? ['--ui'] : []), ...passthrough];
const res = spawnSync(process.execPath, args, { cwd: E2E_DIR, stdio: 'inherit', env });
cleanup();
process.exit(res.status === null ? 1 : res.status);
