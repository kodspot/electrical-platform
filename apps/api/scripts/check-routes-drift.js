'use strict';

/**
 * `npm run docs:routes:check` — fail if the committed route index is stale. [platform-M2]
 *
 * Part of `verify`. Regenerates docs/reference/routes.generated.md and fails if it
 * differs from what is committed, so a route added without regenerating is caught
 * before commit. Compares content with line endings normalized, so it is not fooled
 * by CRLF/LF differences across platforms (no git dependency).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { API_DIR, ROOT_DIR } = require('./_platform');

const OUT = path.join(ROOT_DIR, 'docs', 'reference', 'routes.generated.md');
const norm = (s) => s.replace(/\r\n/g, '\n');

const before = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
try {
  execFileSync('node', ['scripts/gen-route-index.js'], { cwd: API_DIR, stdio: 'pipe' });
} catch (e) {
  console.error('route-drift check: could not run the generator.');
  console.error(`${e.stderr || e.message || ''}`.slice(0, 400));
  process.exit(1);
}
const after = fs.readFileSync(OUT, 'utf8');

if (norm(before) !== norm(after)) {
  console.error('✗ route index is stale — routes changed without regenerating.');
  console.error('  Run `npm run docs:routes` and commit docs/reference/routes.generated.md.');
  process.exit(1);
}
console.log('✓ route index is up to date.');
