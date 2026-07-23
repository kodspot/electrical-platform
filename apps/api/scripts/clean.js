'use strict';

/**
 * `npm run clean` — remove local, disposable developer artifacts. [platform-M2, DPS §2]
 *
 * Removes local uploaded images and local logs ONLY. Never touches the database,
 * .env, or anything tracked in git. Refuses to run outside local development.
 */

const fs = require('fs');
const path = require('path');
const { ROOT_DIR, loadRootEnv, assertLocalDevOnly } = require('./_platform');

assertLocalDevOnly(loadRootEnv());

// Paths are relative to the repo root; both are git-ignored (data/).
const TARGETS = [
  path.join(ROOT_DIR, 'data', 'uploads'),
  path.join(ROOT_DIR, 'data', 'logs')
];

let removed = 0;
for (const dir of TARGETS) {
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    removed++;
  }
  console.log(`  cleaned ${path.relative(ROOT_DIR, dir)}/`);
}
console.log(`clean: done (${removed} entr${removed === 1 ? 'y' : 'ies'} removed). Database and .env untouched.`);
