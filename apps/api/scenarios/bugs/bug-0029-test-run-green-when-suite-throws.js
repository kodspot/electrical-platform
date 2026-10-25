'use strict';

/**
 * BUG-0029 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'junit');

module.exports = {
  id: 'BUG-0029',
  title: '`npm test` passed when a test file\'s describe() threw while collecting its tests',
  description: 'On Node 24, when a describe() body throws (a broken require, a bad helper call), node --test prints the suite as failed but exits 0 and counts "fail 0": none of that suite\'s tests run. scripts/run-tests.js decided its exit code from the child\'s status and those counts, so CI was green with the tests silently missing. Found while writing the BUG-0028 test.',
  module: 'ele',
  category: 'qa-tooling',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'PAR-10 fixes 2026-10-25 (found while writing the BUG-0028 test)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'scripts/report-tests.js decideExit() trusted node:test\'s counts, which leave out a suite that fails during collection; the JUnit XML and the events stream both record it.',
  expectedBehavior: 'A suite that throws while collecting its tests makes the run exit 1, with the suite named in the reasons and in test-summary.md.',
  brokenBehavior: 'Exit 0; the summary said 0 failed.',
  reproductionSteps: [
    'Add a test file whose describe() callback throws before registering any test.',
    'Run node scripts/run-tests.js on it.',
    'Broken: "[run-tests] exit 0". Fixed: exit 1, "1 failure(s) the runner did not count …".'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/report-tests.test.js',

  async apply() {
    return {};
  },

  async validate() {
    const { generateReport } = require('../../scripts/report-tests');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bug0029-'));
    try {
      const { decision } = generateReport({
        rawJunitPath: path.join(FIXTURES, 'node24-suite-throws.xml'),
        eventsPath: path.join(FIXTURES, 'node24-suite-throws.events.jsonl'),
        outDir: out, baselinePath: null, childStatus: 0, ci: false, strict: false, nodeVersion: 'v24'
      });
      if (decision.code === 0) return { ok: false, detail: 'a run whose suite threw while collecting still exits 0' };
      return { ok: true, detail: 'the run fails and names the suite' };
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }
};
