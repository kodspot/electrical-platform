'use strict';

/**
 * `npm test` (QA-1). Runs node:test with the safety preload in every test-file process,
 * the spec reporter on stdout, and the built-in JUnit reporter plus scripts/report-events.js
 * into a temp directory; then writes the scrubbed reports to apps/api/reports/ and deletes
 * the raw files. File arguments pass through (`node scripts/run-tests.js test/x.test.js`).
 *
 * Exit code is non-zero when the test process failed or was killed, when the report could
 * not be produced, or — with CI=true or QA_STRICT=1 — when any test was skipped, todo or
 * cancelled. See test/README.md.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateReport, decideExit, notExecuted, REPORT_FAILED } = require('./report-tests');

const API_DIR = path.join(__dirname, '..');
const REPORTS_DIR = path.join(API_DIR, 'reports');
const PRELOAD = path.join(API_DIR, 'test', 'setup', 'safety.js');
const BASELINE = path.join(API_DIR, 'test', 'baseline.json');

function main() {
  const ci = process.env.CI === 'true';
  const strict = process.env.QA_STRICT === '1';
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa1-test-run-'));
  const rawJunitPath = path.join(tmp, 'junit.raw.xml');
  const eventsPath = path.join(tmp, 'events.jsonl');

  let childStatus = null;
  let report = null;
  let reportError = null;
  try {
    // process.execPath, so the tests run on the same Node that runs this wrapper. The custom
    // reporter must be a relative specifier: an absolute Windows path is rejected by the
    // ESM loader (ERR_UNSUPPORTED_ESM_URL_SCHEME), hence cwd = apps/api.
    const child = spawnSync(process.execPath, [
      '--require', PRELOAD,
      '--test',
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=junit', `--test-reporter-destination=${rawJunitPath}`,
      '--test-reporter=./scripts/report-events.js', `--test-reporter-destination=${eventsPath}`,
      ...process.argv.slice(2)
    ], { cwd: API_DIR, env: { ...process.env, NODE_ENV: 'test' }, stdio: 'inherit' });
    childStatus = child.status;
    if (child.error) console.error(`[run-tests] could not start the test process: ${child.error.message}`);

    try {
      report = generateReport({ rawJunitPath, eventsPath, outDir: REPORTS_DIR, baselinePath: BASELINE, childStatus, ci, strict });
    } catch (err) {
      reportError = err;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const decision = report
    ? report.decision
    : decideExit({ childStatus, reportOk: false, counts: null, ci, strict });

  console.log('');
  if (report) {
    console.log(`[run-tests] Summary: ${path.relative(API_DIR, path.join(REPORTS_DIR, 'test-summary.md'))} · JUnit: ${path.relative(API_DIR, path.join(REPORTS_DIR, 'junit.xml'))}`);
    const ne = notExecuted(report.counts);
    if (ne > 0) console.log(`NOT EXECUTED: ${ne} tests — this is not a pass`);
  }
  for (const reason of decision.reasons) {
    if (!report && reason === REPORT_FAILED) {
      console.error(`[run-tests] ${reason}: ${reportError ? reportError.message : 'unknown error'}`);
    } else {
      console.log(`[run-tests] ${reason}`);
    }
  }
  console.log(`[run-tests] exit ${decision.code}`);
  process.exit(decision.code);
}

main();
