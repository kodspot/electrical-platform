'use strict';

// QA-1 canary: proves `node --require test/setup/safety.js --test` (scripts/run-tests.js)
// still propagates the preload into each test-file process on whatever Node version runs
// the suite. Deliberately imports no helper, so nothing else can load the preload for it.
// It fails under a bare `node --test` — that is the point: use `npm test`.

const { it } = require('node:test');
const assert = require('node:assert');

it('the safety preload ran in this test-file process', () => {
  assert.strictEqual(
    globalThis.__qaSafetyPreload,
    process.pid,
    'test/setup/safety.js was not preloaded into this process — run tests with `npm test` (scripts/run-tests.js), not bare `node --test`'
  );
});
