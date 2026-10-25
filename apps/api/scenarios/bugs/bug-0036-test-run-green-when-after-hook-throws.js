'use strict';

/**
 * BUG-0036 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'junit');

module.exports = {
  id: 'BUG-0036',
  title: '`npm test` passed when a suite\'s after() hook threw — e.g. a cleanup that left test data behind',
  description: 'On Node 24 a suite hook that throws after its tests have passed (typically after() calling cleanupTestOrgs) is reported as a failed suite, but node --test exits 0 with "fail 0", and the JUnit XML shows a passing suite. BUG-0029\'s check covered only a describe() body that throws. Found when a new test\'s roster made the org cleanup fail (DutyRosterWorker RESTRICT) and the run stayed green.',
  module: 'ele',
  category: 'qa-tooling',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'PAR-10 fixes 2026-10-25 (found while writing the BUG-0035 test)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'scripts/report-tests.js counted only suite failures of type testCodeFailure as uncounted; hookFailed was ignored, and only the events stream records it.',
  expectedBehavior: 'A suite whose hook throws makes the run exit 1, with the suite named in the reasons.',
  brokenBehavior: 'Exit 0, "fail 0"; the cleanup failure and the leftover data went unnoticed.',
  reproductionSteps: [
    'Add a test file whose describe() has an after() that throws, and a passing test.',
    'Run node scripts/run-tests.js on it.',
    'Broken: "[run-tests] exit 0". Fixed: exit 1, "1 suite failure(s) the runner did not count …".'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/report-tests.test.js',

  async apply() {
    return {};
  },

  async validate() {
    const { generateReport } = require('../../scripts/report-tests');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bug0036-'));
    try {
      const { decision } = generateReport({
        rawJunitPath: path.join(FIXTURES, 'node24-after-throws.xml'),
        eventsPath: path.join(FIXTURES, 'node24-after-throws.events.jsonl'),
        outDir: out, baselinePath: null, childStatus: 0, ci: false, strict: false, nodeVersion: 'v24'
      });
      if (decision.code === 0) return { ok: false, detail: 'a run whose after() hook threw still exits 0' };
      return { ok: true, detail: 'the run fails and names the suite' };
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }
};
