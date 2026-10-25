'use strict';

/**
 * Test-run report (QA-1). Reads the raw JUnit XML written by Node's built-in junit
 * reporter plus the JSON lines from scripts/report-events.js, scrubs secret-looking text,
 * and writes reports/junit.xml and reports/test-summary.md (and appends the summary to
 * $GITHUB_STEP_SUMMARY when set). Called by scripts/run-tests.js; also exports its parts
 * for test/report-tests.test.js.
 *
 * Named report-tests.js, not test-report.js: node --test's default discovery executes any
 * file matching test-*.js as a test file.
 *
 * The parser is deliberately strict — it understands exactly the structure Node's junit
 * reporter emits and throws on anything else, so a format change fails the run loudly
 * instead of producing a silently wrong summary.
 */

const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, '..');
const DETAIL_MAX_CHARS = 400;
const REQUIRED_COUNTS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const KNOWN_COUNTS = new Set([...REQUIRED_COUNTS, 'suites', 'duration_ms']);
const ALLOWED_PARENTS = {
  testsuites: [null],
  testsuite: ['testsuites', 'testsuite'],
  testcase: ['testsuites', 'testsuite'],
  failure: ['testcase'],
  skipped: ['testcase']
};
const DB_SKIP_MESSAGE = /No database available/i;
const REPORT_FAILED = 'test report could not be produced';
const ENVIRONMENT_CAUSE = /ECONNREFUSED|P1001|Can't reach database server|database unreachable/i;

// ── Scrubbing ──
// Patterns never consume XML delimiters (< > " & ') so scrubbed XML stays well-formed;
// the result is re-parsed before it is written to prove that.
const SECRET_KEY = String.raw`[A-Za-z0-9_]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)`;
const QUOTE = String.raw`(?:&quot;|&apos;|["'])?`;
const SCRUB_RULES = [
  [new RegExp(String.raw`\b(authorization)(${QUOTE}\s*[:=]\s*${QUOTE})(?:(?:Bearer|Basic)\s+)?[^\s"'<>&,;]+`, 'gi'), '$1$2[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_JWT]'],
  [/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_JWT]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@"'<>&]+:[^\s/@"'<>&]+@/gi, '$1[REDACTED]@'],
  [new RegExp(String.raw`\b(${SECRET_KEY})(${QUOTE}\s*[:=]\s*${QUOTE})([^\s"'<>&,;)]+)`, 'gi'), '$1$2[REDACTED]'],
  [/\b[0-9a-fA-F]{32,}\b/g, '[REDACTED_HEX]']
];
const LONG_BASE64 = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g;

function scrub(text) {
  if (text == null) return text;
  let out = String(text);
  for (const [pattern, replacement] of SCRUB_RULES) out = out.replace(pattern, replacement);
  return out.replace(LONG_BASE64, (m) => (/\d/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m) ? '[REDACTED_B64]' : m));
}

// ── JUnit parsing ──
function decodeEntities(text) {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

function parseAttributes(raw, where) {
  const attrs = {};
  const re = /\s+([A-Za-z_][\w.-]*)="([^"]*)"/y;
  let i = 0;
  while (i < raw.length) {
    re.lastIndex = i;
    const m = re.exec(raw);
    if (!m) throw new Error(`junit: malformed attributes on <${where}>`);
    attrs[m[1]] = decodeEntities(m[2]);
    i = re.lastIndex;
  }
  return attrs;
}

/**
 * Parse Node's junit reporter output. Returns { counts, roots } where roots are the
 * top-level <testsuite>/<testcase> nodes: { tag, attrs, children, failure, skipped, text }.
 * Throws on any structure it does not recognise.
 */
function parseJUnit(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('junit: empty input');
  const token = /<\?xml[^>]*\?>|<!--([\s\S]*?)-->|<\/([A-Za-z]+)\s*>|<([A-Za-z]+)((?:\s+[A-Za-z_][\w.-]*="[^"]*")*)\s*(\/?)>|([^<]+)/y;
  const stack = [];
  const counts = {};
  let root = null;
  let sawDecl = false;
  let i = 0;

  while (i < xml.length) {
    token.lastIndex = i;
    const m = token.exec(xml);
    if (!m) throw new Error(`junit: unparseable content at offset ${i}`);
    i = token.lastIndex;
    const [whole, comment, closeTag, openTag, rawAttrs, selfClose, text] = m;
    const parent = stack[stack.length - 1] || null;

    if (whole.startsWith('<?xml')) {
      if (sawDecl || root) throw new Error('junit: misplaced XML declaration');
      sawDecl = true;
    } else if (comment !== undefined) {
      if (!parent || parent.tag !== 'testsuites') throw new Error('junit: comment outside <testsuites>');
      const c = /^\s*([a-z_]+)\s+([\d.]+)\s*$/.exec(comment);
      if (!c || !KNOWN_COUNTS.has(c[1])) throw new Error('junit: unrecognised summary comment');
      counts[c[1]] = Number(c[2]);
    } else if (closeTag) {
      if (!parent || parent.tag !== closeTag) throw new Error(`junit: unbalanced </${closeTag}>`);
      stack.pop();
    } else if (openTag) {
      if (!ALLOWED_PARENTS[openTag]) throw new Error(`junit: unknown element <${openTag}>`);
      if (!ALLOWED_PARENTS[openTag].includes(parent ? parent.tag : null)) {
        throw new Error(`junit: <${openTag}> not allowed inside <${parent ? parent.tag : 'document'}>`);
      }
      const node = { tag: openTag, attrs: parseAttributes(rawAttrs, openTag), children: [], text: '' };
      if (openTag === 'testsuites') {
        if (root) throw new Error('junit: more than one <testsuites>');
        root = node;
      } else if (openTag === 'failure' || openTag === 'skipped') {
        if (parent.failure || parent.skipped) throw new Error('junit: <testcase> with more than one outcome');
        parent[openTag] = node;
      } else {
        parent.children.push(node);
      }
      if (!selfClose) stack.push(node);
    } else if (text !== undefined) {
      if (parent && parent.tag === 'failure') parent.text += decodeEntities(text);
      else if (text.trim()) throw new Error('junit: unexpected text content');
    }
  }

  if (!sawDecl) throw new Error('junit: missing XML declaration');
  if (!root) throw new Error('junit: missing <testsuites>');
  if (stack.length) throw new Error(`junit: unclosed <${stack[stack.length - 1].tag}>`);
  for (const key of REQUIRED_COUNTS) {
    if (!(key in counts)) throw new Error(`junit: missing summary count "${key}"`);
  }
  return { counts, roots: root.children };
}

// ── Joining, tiering, classification ──
function parseEvents(text) {
  if (!text) return [];
  return text.split(/\r?\n/).filter((l) => l.trim()).map((line, n) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`events: line ${n + 1} is not JSON`);
    }
  });
}

function relFile(file) {
  if (!file) return null;
  const p = String(file).replace(/\\/g, '/');
  const i = p.lastIndexOf('/apps/api/');
  if (i !== -1) return p.slice(i + '/apps/api/'.length);
  const t = /(?:^|\/)(test\/.*)$/.exec(p);
  return t ? t[1] : p;
}

function tierOf(file) {
  if (!file) return 'UNKNOWN';
  const special = {
    'test/integration/app-smoke.test.js': 'app-smoke',
    'test/integration/observability.test.js': 'app-smoke',
    'test/integration/log-redaction.test.js': 'app-smoke',
    'test/integration/health-ready.test.js': 'env-aware',
    'test/integration/scenarios.test.js': 'scenario',
    'test/integration/bug-regressions.test.js': 'bug-regression'
  };
  if (special[file]) return special[file];
  if (/^test\/(helpers|setup)\//.test(file)) return 'support (no tests)';
  if (/^test\/integration\/[^/]+\.test\.js$/.test(file)) return 'DB-backed';
  if (/^test\/[^/]+\.test\.js$/.test(file)) return 'unit';
  return 'UNKNOWN';
}

function classify(text) {
  return ENVIRONMENT_CAUSE.test(text || '') ? 'ENVIRONMENT' : 'UNCLASSIFIED';
}

function truncate(text, max = DETAIL_MAX_CHARS) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Flatten the JUnit tree into leaf test results, attributing each to a file. */
function collectCases(parsed, events) {
  const topFiles = new Map();
  const hookFailures = new Map();
  for (const e of events) {
    const file = relFile(e.file);
    if (e.nesting === 0) {
      // The JUnit side was scrubbed before parsing; scrub here too so names still match.
      const name = scrub(e.name);
      if (!topFiles.has(name)) topFiles.set(name, new Set());
      topFiles.get(name).add(file);
    }
    if (e.failureType === 'hookFailed' && file) {
      if (!hookFailures.has(file)) hookFailures.set(file, []);
      hookFailures.get(file).push(e.cause || '');
    }
  }

  const cases = [];
  const walk = (node, trail, inheritedFile) => {
    const file = relFile(node.attrs.file) || inheritedFile;
    if (node.tag === 'testsuite') {
      for (const child of node.children) walk(child, [...trail, node.attrs.name], file);
      return;
    }
    let status = 'passed';
    let detail = '';
    if (node.failure) {
      status = node.failure.attrs.type === 'cancelledByParent' ? 'cancelled' : 'failed';
      detail = node.failure.attrs.message || node.failure.text;
    } else if (node.skipped) {
      status = node.skipped.attrs.type === 'todo' ? 'todo' : 'skipped';
      detail = node.skipped.attrs.message || '';
    }
    cases.push({ name: node.attrs.name, trail, file, status, detail });
  };

  for (const rootNode of parsed.roots) {
    let file = relFile(rootNode.attrs.file);
    if (!file) {
      const candidates = topFiles.get(rootNode.attrs.name);
      if (candidates && candidates.size === 1) file = [...candidates][0];
      else if (candidates && candidates.size > 1) file = 'AMBIGUOUS (duplicate top-level name)';
    }
    walk(rootNode, [], file);
  }

  for (const c of cases) {
    const hooks = (c.file && hookFailures.get(c.file)) || [];
    c.hookCause = c.status === 'cancelled' && hooks.length ? hooks.join(' | ') : null;
    c.classification = c.status === 'failed' || c.status === 'cancelled'
      ? classify(`${c.detail} ${c.hookCause || ''}`)
      : null;
  }
  return cases;
}

// ── Exit decision ──
/**
 * The wrapper's exit code. Non-zero when the test process failed or died (status null
 * means killed by a signal), when the report could not be produced, or — under CI=true
 * or QA_STRICT=1 — when any test was skipped, todo, or cancelled (not executed).
 */
function decideExit({ childStatus, reportOk, counts, ci, strict, uncounted = [] }) {
  const reasons = [];
  if (childStatus !== 0) reasons.push(childStatus === null ? 'test process was killed by a signal' : `test process exited ${childStatus}`);
  if (!reportOk) reasons.push(REPORT_FAILED);
  if (uncounted.length) reasons.push(`${uncounted.length} suite failure(s) the runner did not count — a describe() body or a suite hook threw: ${uncounted.join(', ')}`);
  if ((ci || strict) && counts) {
    for (const key of ['skipped', 'todo', 'cancelled']) {
      if (counts[key] > 0) reasons.push(`${counts[key]} test(s) ${key} under ${ci ? 'CI=true' : 'QA_STRICT=1'}`);
    }
  }
  const code = reasons.length === 0 ? 0 : (typeof childStatus === 'number' && childStatus !== 0 ? childStatus : 1);
  return { code, reasons };
}

function notExecuted(counts) {
  return counts.skipped + counts.todo + counts.cancelled;
}

/**
 * Failures the runner left out of its own counts. Node (24) reports these suites as failed
 * but exits 0 and counts "fail 0":
 *   - a describe() body that throws while its tests are collected (none of them run) — the
 *     JUnit XML itemises it as a failed testcase; events: kind suite, testCodeFailure [BUG-0029];
 *   - a suite hook that throws, e.g. an after() cleanup — only the events stream records it
 *     (kind suite, hookFailed); the XML shows a passing suite [BUG-0036].
 * A suite failing because a test inside it failed (subtestsFailed) is already counted.
 * Returns their names (scrubbed).
 */
function uncountedFailures(counts, cases, events) {
  const fromEvents = events
    .filter((e) => e.result === 'fail' && e.kind === 'suite' && (e.failureType === 'testCodeFailure' || e.failureType === 'hookFailed'))
    .map((e) => scrub(e.name));
  if (fromEvents.length) return fromEvents;
  const failed = cases.filter((c) => c.status === 'failed');
  const extra = failed.length - (counts.fail || 0);
  if (extra <= 0) return [];
  const roots = failed.filter((c) => c.trail.length === 0).map((c) => c.name);
  return roots.length >= extra ? roots.slice(0, extra) : Array(extra).fill('(unnamed)');
}

// ── Summary ──
function tally(list) {
  const t = { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
  for (const c of list) {
    t.tests++;
    t[c.status]++;
  }
  return t;
}

const row = (cells) => `| ${cells.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`;

/** Per-tier and per-file tallies plus the failure list — shared by the markdown and JSON reports. */
function groupCases(cases) {
  const byFile = new Map();
  for (const c of cases) {
    const key = c.file || '(file unknown)';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(c);
  }
  const byTier = new Map();
  for (const [file, list] of byFile) {
    const tier = tierOf(file);
    if (!byTier.has(tier)) byTier.set(tier, { files: 0, list: [] });
    byTier.get(tier).files++;
    byTier.get(tier).list.push(...list);
  }
  const tiers = [...byTier].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tier, { files, list }]) => ({ tier, files, ...tally(list) }));
  const files = [...byFile].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([file, list]) => ({ file, tier: tierOf(file), ...tally(list) }));
  const failures = cases.filter((c) => c.status === 'failed' || c.status === 'cancelled').map((c) => ({
    test: [...c.trail, c.name].join(' › '),
    file: c.file || '(file unknown)',
    status: c.status,
    classification: c.classification,
    // Scrub BEFORE truncating: a token cut mid-way would no longer match the patterns.
    detail: truncate(scrub(c.hookCause ? `cancelled because a suite hook failed: ${c.hookCause}` : c.detail))
  }));
  return { tiers, files, failures };
}

const JSON_SUMMARY_MAX_BYTES = 200 * 1024;

/**
 * Machine-readable twin of test-summary.md, for the super-admin Quality page (CI posts it to
 * POST /api/qa/runs). Every string is scrubbed. Capped at 200 KB: failures are trimmed first,
 * then the per-file table, and the number dropped is recorded in `truncated`. [WP-Q]
 */
function buildJsonSummary({ counts, cases, nodeVersion, ci, strict, decision }) {
  const ne = notExecuted(counts);
  const { tiers, files, failures } = groupCases(cases);
  const summary = {
    status: decision.code !== 0 ? 'failed' : ne > 0 ? 'passed_with_not_executed' : 'passed',
    counts: {
      tests: counts.tests, pass: counts.pass, fail: counts.fail, cancelled: counts.cancelled,
      skipped: counts.skipped, todo: counts.todo, notExecuted: ne
    },
    durationMs: typeof counts.duration_ms === 'number' ? Math.round(counts.duration_ms) : null,
    nodeVersion,
    ci: !!ci,
    strict: !!strict,
    exitCode: decision.code,
    reasons: decision.reasons,
    tiers,
    files,
    failures,
    truncated: { failures: 0, files: 0 }
  };
  // Scrub string values, never the serialized JSON (a pattern ending at an escaped quote
  // would otherwise unescape it and break the document).
  const deepScrub = (v) => (typeof v === 'string' ? scrub(v)
    : Array.isArray(v) ? v.map(deepScrub)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepScrub(x)]))
        : v);
  const scrubbed = () => deepScrub(summary);
  let out = scrubbed();
  while (Buffer.byteLength(JSON.stringify(out)) > JSON_SUMMARY_MAX_BYTES && (summary.failures.length || summary.files.length)) {
    if (summary.failures.length) { summary.failures.pop(); summary.truncated.failures++; }
    else { summary.files.pop(); summary.truncated.files++; }
    out = scrubbed();
  }
  return out;
}

function buildSummary({ counts, cases, baseline, nodeVersion, ci, strict, decision }) {
  const ne = notExecuted(counts);
  const status = decision.code !== 0 ? '❌ FAILED' : ne > 0 ? '⚠️ PASSED — BUT NOT EVERYTHING RAN' : '✅ PASSED';
  const lines = [];
  lines.push('# Test run summary', '');
  lines.push(`**Overall: ${status}**`, '');
  lines.push(`Node ${nodeVersion} · CI=${ci ? 'true' : 'false'} · QA_STRICT=${strict ? '1' : 'off'} · exit code ${decision.code}`, '');
  if (decision.reasons.length) {
    lines.push('Why the run did not pass:', '');
    for (const r of decision.reasons) lines.push(`- ${r}`);
    lines.push('');
  }
  if (ne > 0) {
    lines.push(`> **NOT EXECUTED: ${ne} tests — this is not a pass.** (${counts.skipped} skipped, ${counts.todo} todo, ${counts.cancelled} cancelled)`, '');
  }

  lines.push('## Counts', '');
  lines.push(row(['Total', 'Passed', 'Failed', 'Cancelled', 'Skipped', 'Todo', 'Not executed']));
  lines.push(row(['---', '---', '---', '---', '---', '---', '---']));
  lines.push(row([counts.tests, counts.pass, counts.fail, counts.cancelled, counts.skipped, counts.todo, ne]), '');

  const perCase = tally(cases);
  if (perCase.tests !== counts.tests) {
    lines.push(`> Note: ${perCase.tests} test results were itemised but the runner counted ${counts.tests}; the table above is the runner's count.`, '');
  }

  if (baseline) {
    lines.push('## Baseline vs current', '');
    lines.push(`Baseline: ${baseline.label}`, '');
    lines.push(row(['', 'Total', 'Passed', 'Failed', 'Cancelled', 'Skipped', 'Todo']));
    lines.push(row(['---', '---', '---', '---', '---', '---', '---']));
    lines.push(row(['Baseline', baseline.tests, baseline.pass, baseline.fail, baseline.cancelled, baseline.skipped, baseline.todo]));
    lines.push(row(['Current', counts.tests, counts.pass, counts.fail, counts.cancelled, counts.skipped, counts.todo]));
    lines.push(row(['Change', counts.tests - baseline.tests, counts.pass - baseline.pass, counts.fail - baseline.fail,
      counts.cancelled - baseline.cancelled, counts.skipped - baseline.skipped, counts.todo - baseline.todo]), '');
  }

  const { tiers, files, failures } = groupCases(cases);

  lines.push('## By tier', '');
  lines.push(row(['Tier', 'Files', 'Tests', 'Passed', 'Failed', 'Cancelled', 'Skipped', 'Todo']));
  lines.push(row(['---', '---', '---', '---', '---', '---', '---', '---']));
  for (const t of tiers) lines.push(row([t.tier, t.files, t.tests, t.passed, t.failed, t.cancelled, t.skipped, t.todo]));
  lines.push('');

  lines.push('## By file', '');
  lines.push(row(['File', 'Tier', 'Tests', 'Passed', 'Failed', 'Cancelled', 'Skipped', 'Todo']));
  lines.push(row(['---', '---', '---', '---', '---', '---', '---', '---']));
  for (const f of files) lines.push(row([`\`${f.file}\``, f.tier, f.tests, f.passed, f.failed, f.cancelled, f.skipped, f.todo]));
  lines.push('');

  lines.push(`## Failures and cancellations (${failures.length})`, '');
  if (failures.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push('Classification is automatic only for clearly mechanical causes (ENVIRONMENT); everything else is UNCLASSIFIED until a person marks it PRODUCT or TEST.', '');
    lines.push(row(['Test', 'File', 'Status', 'Classification', 'Expected vs actual / cause']));
    lines.push(row(['---', '---', '---', '---', '---']));
    for (const f of failures) lines.push(row([f.test, f.file, f.status, f.classification, f.detail]));
    lines.push('');
  }

  const notRun = cases.filter((c) => c.status === 'skipped' || c.status === 'todo');
  if (notRun.length) {
    lines.push(`## Not executed — skipped or todo (${notRun.length})`, '');
    const reasons = new Map();
    for (const c of notRun) {
      const reason = c.status === 'todo' ? `todo: ${c.detail}` : DB_SKIP_MESSAGE.test(c.detail) ? 'no database available' : c.detail || 'skipped';
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
    for (const [reason, n] of reasons) lines.push(`- ${n} × ${truncate(reason, 160)}`);
    lines.push('');
    for (const c of notRun.slice(0, 200)) lines.push(`- \`${c.file || '(file unknown)'}\` — ${[...c.trail, c.name].join(' › ')}`);
    if (notRun.length > 200) lines.push(`- … and ${notRun.length - 200} more`);
    lines.push('');
  }

  return scrub(lines.join('\n'));
}

/**
 * Produce the report. Throws if the input cannot be parsed or the output cannot be
 * written — the wrapper turns that into a non-zero exit.
 */
function generateReport({ rawJunitPath, eventsPath, outDir, baselinePath, childStatus, ci, strict, nodeVersion = process.version }) {
  const scrubbedXml = scrub(fs.readFileSync(rawJunitPath, 'utf8'));
  const parsed = parseJUnit(scrubbedXml);
  const events = parseEvents(eventsPath && fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8') : '');
  const cases = collectCases(parsed, events);
  const baseline = baselinePath && fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
  const uncounted = uncountedFailures(parsed.counts, cases, events);
  const decision = decideExit({ childStatus, reportOk: true, counts: parsed.counts, ci, strict, uncounted });
  const summary = buildSummary({ counts: parsed.counts, cases, baseline, nodeVersion, ci, strict, decision });
  const jsonSummary = buildJsonSummary({ counts: parsed.counts, cases, nodeVersion, ci, strict, decision });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'junit.xml'), scrubbedXml);
  fs.writeFileSync(path.join(outDir, 'test-summary.md'), summary);
  fs.writeFileSync(path.join(outDir, 'test-summary.json'), JSON.stringify(jsonSummary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  return { counts: parsed.counts, cases, summary, jsonSummary, decision };
}

module.exports = {
  API_DIR,
  scrub,
  parseJUnit,
  parseEvents,
  collectCases,
  relFile,
  tierOf,
  classify,
  decideExit,
  REPORT_FAILED,
  buildJsonSummary,
  JSON_SUMMARY_MAX_BYTES,
  notExecuted,
  buildSummary,
  generateReport
};
