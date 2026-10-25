'use strict';

// QA-1: scripts/report-tests.js. Fixtures under test/fixtures/junit/ are real output of
// Node's built-in junit reporter (v20.20.2 and v24.11.1) and of scripts/report-events.js,
// with machine paths sanitized — so the strict parser is pinned to what Node actually emits.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  scrub, parseJUnit, parseEvents, collectCases, tierOf, decideExit, generateReport,
  buildJsonSummary, JSON_SUMMARY_MAX_BYTES
} = require('../scripts/report-tests');

const FIXTURES = path.join(__dirname, 'fixtures', 'junit');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const SECRET_FRAGMENTS = ['eyJhbGci', 'S3cret', 'svc:', 'c2lnbmF0dXJl'];

function assertScrubbed(text) {
  for (const f of SECRET_FRAGMENTS) assert.ok(!text.includes(f), `secret-looking fragment survived: ${f}`);
}

describe('QA-1 report — strict JUnit parser on real Node output', () => {
  it('parses a passing run (Node 20)', () => {
    const { counts, roots } = parseJUnit(fixture('node20-pass.xml'));
    assert.deepStrictEqual([counts.tests, counts.pass, counts.fail, counts.skipped], [1, 1, 0, 0]);
    const cases = collectCases({ counts, roots }, []);
    assert.deepStrictEqual(cases.map((c) => c.status), ['passed']);
  });

  it('parses a skipped run (Node 20) and keeps the skip reason', () => {
    const parsed = parseJUnit(fixture('node20-skip.xml'));
    assert.strictEqual(parsed.counts.skipped, 1);
    const [c] = collectCases(parsed, []);
    assert.strictEqual(c.status, 'skipped');
    assert.match(c.detail, /No database available/);
  });

  it('reports a throwing before() as cancelled, not failed (Node 20 and 24)', () => {
    for (const name of ['node20-before-throws.xml', 'node24-before-throws.xml']) {
      const parsed = parseJUnit(fixture(name));
      assert.strictEqual(parsed.counts.cancelled, 2, name);
      assert.strictEqual(parsed.counts.fail, 0, name);
      assert.deepStrictEqual(collectCases(parsed, []).map((c) => c.status), ['cancelled', 'cancelled'], name);
    }
  });

  it('throws on malformed or unknown structure', () => {
    for (const name of ['malformed-truncated.xml', 'malformed-unknown-element.xml', 'malformed-missing-summary.xml']) {
      assert.throws(() => parseJUnit(fixture(name)), /junit:/, name);
    }
    assert.throws(() => parseJUnit(''), /junit: empty input/);
    assert.throws(() => parseJUnit('<?xml version="1.0"?><testsuites><testcase name="a"><bogus/></testcase></testsuites>'), /unknown element/);
    assert.throws(() => parseJUnit('not xml at all'), /junit:/);
    assert.throws(() => parseEvents('{"ok":true}\nnot json'), /events: line 2/);
  });
});

describe('QA-1 report — file attribution, tiers, classification', () => {
  it('attributes every Node 20 result to its file via the events stream, and classifies the hook failure', () => {
    const parsed = parseJUnit(scrub(fixture('node20-combined.xml')));
    assert.deepStrictEqual(
      ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((k) => parsed.counts[k]),
      [8, 3, 1, 2, 1, 1]
    );
    const cases = collectCases(parsed, parseEvents(fixture('node20-combined.events.jsonl')));
    assert.ok(cases.every((c) => c.file && c.file.startsWith('test/probe/')), JSON.stringify(cases.map((c) => c.file)));

    const cancelled = cases.filter((c) => c.status === 'cancelled');
    assert.strictEqual(cancelled.length, 2);
    for (const c of cancelled) {
      assert.match(c.hookCause, /database unreachable/);
      assert.strictEqual(c.classification, 'ENVIRONMENT');
    }
    const [failed] = cases.filter((c) => c.status === 'failed');
    assert.strictEqual(failed.classification, 'UNCLASSIFIED');
    assertScrubbed(failed.detail);
    assert.deepStrictEqual(cases.filter((c) => c.status === 'todo').map((c) => c.detail), ['not written yet']);
  });

  it('still attributes a Node 20 result whose name the scrubber rewrites', () => {
    const name = 'rejects Bearer abcdefgh12345678 tokens';
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n\t<testcase name="${name}" time="0.001" classname="test"/>\n` +
      ['tests 1', 'suites 0', 'pass 1', 'fail 0', 'cancelled 0', 'skipped 0', 'todo 0'].map((c) => `\t<!-- ${c} -->\n`).join('') + '</testsuites>\n';
    const events = [{ result: 'pass', name, nesting: 0, file: String.raw`C:\ci\electrical-platform\apps\api\test\integration\app-smoke.test.js` }];
    const [c] = collectCases(parseJUnit(scrub(xml)), events);
    assert.strictEqual(c.name, 'rejects Bearer [REDACTED] tokens');
    assert.strictEqual(c.file, 'test/integration/app-smoke.test.js');
  });

  it('does not redact ordinary prose such as "a garbage bearer token"', () => {
    const prose = 'a protected route rejects a garbage bearer token';
    assert.strictEqual(scrub(prose), prose);
  });

  it('uses the JUnit file attribute directly on Node 24', () => {
    const cases = collectCases(parseJUnit(fixture('node24-combined.xml')), []);
    assert.ok(cases.every((c) => c.file && c.file.startsWith('test/probe/')));
  });

  it('marks the file unknown rather than guessing when Node 20 runs without the events stream', () => {
    const cases = collectCases(parseJUnit(fixture('node20-combined.xml')), []);
    assert.ok(cases.every((c) => c.file === null));
  });

  it('maps real test files to tiers', () => {
    assert.strictEqual(tierOf('test/lib-crypto.test.js'), 'unit');
    assert.strictEqual(tierOf('test/integration/app-smoke.test.js'), 'app-smoke');
    assert.strictEqual(tierOf('test/integration/observability.test.js'), 'app-smoke');
    assert.strictEqual(tierOf('test/integration/log-redaction.test.js'), 'app-smoke');
    assert.strictEqual(tierOf('test/integration/health-ready.test.js'), 'env-aware');
    assert.strictEqual(tierOf('test/integration/scenarios.test.js'), 'scenario');
    assert.strictEqual(tierOf('test/integration/bug-regressions.test.js'), 'bug-regression');
    assert.strictEqual(tierOf('test/integration/ticket-lifecycle.test.js'), 'DB-backed');
    assert.strictEqual(tierOf('test/helpers/db.js'), 'support (no tests)');
    assert.strictEqual(tierOf(null), 'UNKNOWN');
  });
});

describe('QA-1 report — scrubbing', () => {
  it('redacts tokens, credentials and long secrets but leaves ordinary text', () => {
    const cases = [
      ['Authorization: Bearer abc.def.ghi', /Authorization: \[REDACTED\]/],
      ['headers: { authorization: "Basic dXNlcjpwYXNz" }', /authorization: "\[REDACTED\]"/],
      ['sent Bearer sk_live_123456 to api', /Bearer \[REDACTED\]/],
      ['token eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4In0.c2lnbmF0dXJlX3NpZ25hdHVyZQ end', /\[REDACTED_JWT\]/],
      ['postgresql://svc:S3cret@10.0.0.5/prod', /postgresql:\/\/\[REDACTED\]@10\.0\.0\.5\/prod/],
      ['JWT_SECRET=abc123 and resetToken: "zzz"', /JWT_SECRET=\[REDACTED\] and resetToken: "\[REDACTED\]"/],
      [`key ${'ab12'.repeat(10)}`, /\[REDACTED_HEX\]/],
      [`blob ${'Ab9+'.repeat(12)}`, /\[REDACTED_B64\]/]
    ];
    for (const [input, expected] of cases) assert.match(scrub(input), expected, input);
    const ordinary = 'expected 404 but got 403 at test/integration/tenant-isolation.test.js:42';
    assert.strictEqual(scrub(ordinary), ordinary);
  });

  it('keeps scrubbed JUnit well-formed', () => {
    const scrubbed = scrub(fixture('node20-combined.xml'));
    assertScrubbed(scrubbed);
    assert.doesNotThrow(() => parseJUnit(scrubbed));
  });
});

describe('WP-Q report — test-summary.json', () => {
  const realCases = () => collectCases(parseJUnit(scrub(fixture('node20-combined.xml'))), parseEvents(fixture('node20-combined.events.jsonl')));
  const realCounts = () => parseJUnit(fixture('node20-combined.xml')).counts;

  it('carries status, counts, duration, tiers, files and scrubbed failures', () => {
    const decision = decideExit({ childStatus: 1, reportOk: true, counts: realCounts(), ci: false, strict: false });
    const s = buildJsonSummary({ counts: realCounts(), cases: realCases(), nodeVersion: 'v20.20.2', ci: false, strict: false, decision });
    assert.strictEqual(s.status, 'failed');
    assert.deepStrictEqual(s.counts, { tests: 8, pass: 3, fail: 1, cancelled: 2, skipped: 1, todo: 1, notExecuted: 4 });
    assert.strictEqual(typeof s.durationMs, 'number');
    assert.strictEqual(s.nodeVersion, 'v20.20.2');
    assert.ok(s.tiers.length >= 1 && s.files.every((f) => f.file.startsWith('test/probe/')));
    assert.strictEqual(s.failures.length, 3);
    assertScrubbed(JSON.stringify(s));
  });

  it('is capped at 200 KB, trimming failures first and recording how many were dropped', () => {
    const big = Array.from({ length: 3000 }, (_, i) => ({
      name: `case ${i} ${'x'.repeat(300)}`, trail: [], file: `test/f${i}.test.js`, status: 'failed', detail: 'y'.repeat(380), classification: 'UNCLASSIFIED'
    }));
    const counts = { tests: 3000, pass: 0, fail: 3000, cancelled: 0, skipped: 0, todo: 0 };
    const decision = decideExit({ childStatus: 1, reportOk: true, counts, ci: false, strict: false });
    const s = buildJsonSummary({ counts, cases: big, nodeVersion: 'v24', ci: false, strict: false, decision });
    assert.ok(Buffer.byteLength(JSON.stringify(s)) <= JSON_SUMMARY_MAX_BYTES);
    assert.ok(s.truncated.failures > 0, 'failures must be trimmed first');
    assert.strictEqual(s.counts.fail, 3000, 'counts are never trimmed');
  });

  it('stays valid JSON when a scrubbed value sits next to an escaped quote', () => {
    const cases = [{ name: 'q', trail: [], file: 'test/q.test.js', status: 'failed', classification: 'UNCLASSIFIED', detail: 'got "token=abc\\" and more"' }];
    const counts = { tests: 1, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0 };
    const decision = decideExit({ childStatus: 1, reportOk: true, counts, ci: false, strict: false });
    const s = buildJsonSummary({ counts, cases, nodeVersion: 'v24', ci: false, strict: false, decision });
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(s)));
    assert.ok(!JSON.stringify(s).includes('abc'));
  });

  it('generateReport writes test-summary.json next to the markdown', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qa1-report-'));
    try {
      generateReport({ rawJunitPath: path.join(FIXTURES, 'node24-combined.xml'), eventsPath: null, outDir: out, baselinePath: null, childStatus: 1, ci: false, strict: false, nodeVersion: 'v24' });
      const s = JSON.parse(fs.readFileSync(path.join(out, 'test-summary.json'), 'utf8'));
      assert.strictEqual(s.counts.tests, 8);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('QA-1 report — exit decision', () => {
  const counts = (o = {}) => ({ skipped: 0, todo: 0, cancelled: 0, ...o });

  it('passes only a clean run with a produced report', () => {
    assert.strictEqual(decideExit({ childStatus: 0, reportOk: true, counts: counts(), ci: false, strict: false }).code, 0);
  });

  it('fails on a failing, signalled, or unreported run', () => {
    assert.strictEqual(decideExit({ childStatus: 1, reportOk: true, counts: counts(), ci: false, strict: false }).code, 1);
    assert.strictEqual(decideExit({ childStatus: null, reportOk: true, counts: counts(), ci: false, strict: false }).code, 1);
    assert.strictEqual(decideExit({ childStatus: 0, reportOk: false, counts: null, ci: false, strict: false }).code, 1);
  });

  it('treats skipped/todo/cancelled as failure under CI=true or QA_STRICT=1, not otherwise', () => {
    for (const key of ['skipped', 'todo', 'cancelled']) {
      const c = counts({ [key]: 2 });
      assert.strictEqual(decideExit({ childStatus: 0, reportOk: true, counts: c, ci: true, strict: false }).code, 1, `CI ${key}`);
      assert.strictEqual(decideExit({ childStatus: 0, reportOk: true, counts: c, ci: false, strict: true }).code, 1, `strict ${key}`);
      assert.strictEqual(decideExit({ childStatus: 0, reportOk: true, counts: c, ci: false, strict: false }).code, 0, `lenient ${key}`);
    }
  });

  // Node 24 exits 0 and counts "fail 0" when a describe() body throws while its tests are
  // collected: none of that suite's tests run, yet the run looked green. [BUG-0029]
  for (const withEvents of [true, false]) {
    it(`BUG-0029: fails a run whose suite threw while collecting its tests (Node 24${withEvents ? '' : ', no events stream'})`, () => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qa1-report-'));
      try {
        const { counts: c, decision } = generateReport({
          rawJunitPath: path.join(FIXTURES, 'node24-suite-throws.xml'),
          eventsPath: withEvents ? path.join(FIXTURES, 'node24-suite-throws.events.jsonl') : null,
          outDir: out, baselinePath: null, childStatus: 0, ci: false, strict: false, nodeVersion: 'v24'
        });
        assert.strictEqual(c.fail, 0, 'the runner itself counts no failure');
        assert.strictEqual(decision.code, 1, `the run must fail: ${decision.reasons.join('; ')}`);
        if (withEvents) assert.ok(decision.reasons.some((r) => r.includes('probe suite that throws while collecting')), decision.reasons.join('; '));
        assert.match(fs.readFileSync(path.join(out, 'test-summary.md'), 'utf8'), /probe suite that throws while collecting/);
      } finally {
        fs.rmSync(out, { recursive: true, force: true });
      }
    });
  }

  it('BUG-0029: a clean run with every failure counted still passes', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qa1-report-'));
    try {
      const { decision } = generateReport({ rawJunitPath: path.join(FIXTURES, 'node20-pass.xml'), eventsPath: null, outDir: out, baselinePath: null, childStatus: 0, ci: false, strict: false, nodeVersion: 'v20' });
      assert.strictEqual(decision.code, 0, decision.reasons.join('; '));
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('QA-1 report — generateReport end to end', () => {
  it('writes scrubbed junit.xml and test-summary.md, appends to GITHUB_STEP_SUMMARY, and flags not-executed tests', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qa1-report-'));
    const stepSummary = path.join(out, 'step-summary.md');
    const prev = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = stepSummary;
    try {
      const result = generateReport({
        rawJunitPath: path.join(FIXTURES, 'node20-combined.xml'),
        eventsPath: path.join(FIXTURES, 'node20-combined.events.jsonl'),
        outDir: out,
        baselinePath: null,
        childStatus: 1,
        ci: false,
        strict: false,
        nodeVersion: 'v20.20.2'
      });
      assert.strictEqual(result.decision.code, 1);
      const summary = fs.readFileSync(path.join(out, 'test-summary.md'), 'utf8');
      const junit = fs.readFileSync(path.join(out, 'junit.xml'), 'utf8');
      assertScrubbed(summary);
      assertScrubbed(junit);
      assert.match(summary, /Overall: ❌ FAILED/);
      assert.match(summary, /NOT EXECUTED: 4 tests — this is not a pass/);
      assert.match(summary, /ENVIRONMENT/);
      assert.match(summary, /`test\/probe\/before-throws\.test\.js`/);
      assert.strictEqual(fs.readFileSync(stepSummary, 'utf8').trim(), summary.trim());
    } finally {
      if (prev === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = prev;
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it('throws (so the wrapper exits non-zero) when the JUnit file is malformed', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qa1-report-'));
    try {
      assert.throws(() => generateReport({
        rawJunitPath: path.join(FIXTURES, 'malformed-truncated.xml'), eventsPath: null, outDir: out,
        baselinePath: null, childStatus: 0, ci: false, strict: false
      }), /junit:/);
      assert.ok(!fs.existsSync(path.join(out, 'test-summary.md')), 'no summary may be written from bad input');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
