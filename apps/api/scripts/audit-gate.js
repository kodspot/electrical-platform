#!/usr/bin/env node
'use strict';

/**
 * Runtime dependency audit gate (CI, deploy.yml "Lint & Test").
 *
 * Runs `npm audit --omit=dev --json` (or reads --input <file>) and:
 *   - FAILS on any high or critical advisory that is not listed in
 *     .github/audit-exceptions.json (matched by GHSA id and package);
 *   - FAILS on any exception whose `expires` date (YYYY-MM-DD, UTC) has passed —
 *     an exception is a dated decision, not a permanent waiver;
 *   - warns about exceptions that no longer match any advisory (safe to delete);
 *   - on a registry, network or parse error, prints a warning and passes (exit 0):
 *     the gate must not turn a registry outage into a red build. That path is separate
 *     and tested (warnAndPass).
 *
 * Exception shape: { ghsa, package, severity, reason, owner, expires }.
 *
 * Usage: node scripts/audit-gate.js [--input audit.json] [--exceptions file] [--today YYYY-MM-DD]
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_EXCEPTIONS = path.join(__dirname, '..', '..', '..', '.github', 'audit-exceptions.json');
const BLOCKING = new Set(['high', 'critical']);
const REQUIRED_FIELDS = ['ghsa', 'package', 'severity', 'reason', 'owner', 'expires'];

const ghsaOf = (advisory) => {
  const m = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(advisory.url || advisory.github_advisory_id || '');
  return m ? m[0] : null;
};

/** The high/critical advisories in an `npm audit --json` report, one per GHSA + package. */
function blockingAdvisories(audit) {
  const out = new Map();
  for (const vuln of Object.values(audit.vulnerabilities || {})) {
    for (const via of vuln.via || []) {
      if (typeof via !== 'object' || !BLOCKING.has(via.severity)) continue;
      const ghsa = ghsaOf(via);
      const pkg = via.name || vuln.name;
      const key = `${ghsa}|${pkg}`;
      if (!out.has(key)) out.set(key, { ghsa, package: pkg, severity: via.severity, title: via.title || '' });
    }
  }
  return [...out.values()];
}

/**
 * Pure decision. Returns { ok, failures: [...], warnings: [...], allowed: [...] }.
 * `today` is a YYYY-MM-DD string; an exception expiring today is still valid.
 */
function evaluate(audit, exceptions, today) {
  if (!audit || typeof audit !== 'object' || audit.error || !audit.vulnerabilities) {
    throw new Error('not an npm audit report');
  }
  const failures = [];
  const warnings = [];
  const allowed = [];

  for (const e of exceptions) {
    const missing = REQUIRED_FIELDS.filter((f) => !e[f]);
    if (missing.length) failures.push(`exception ${e.ghsa || '?'} is missing ${missing.join(', ')}`);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) failures.push(`exception ${e.ghsa} has an invalid expires date "${e.expires}"`);
    else if (e.expires < today) failures.push(`exception ${e.ghsa} (${e.package}) expired on ${e.expires}: fix it or renew the decision`);
  }

  const advisories = blockingAdvisories(audit);
  for (const a of advisories) {
    const ex = exceptions.find((e) => e.ghsa === a.ghsa && e.package === a.package);
    if (!ex) failures.push(`${a.severity} ${a.ghsa} in ${a.package} (${a.title}) is not in .github/audit-exceptions.json`);
    else allowed.push(`${a.ghsa} ${a.package} until ${ex.expires}`);
  }
  for (const e of exceptions) {
    if (!advisories.some((a) => a.ghsa === e.ghsa && a.package === e.package)) {
      warnings.push(`exception ${e.ghsa} (${e.package}) no longer matches any advisory: it can be removed`);
    }
  }
  return { ok: failures.length === 0, failures, warnings, allowed };
}

function warnAndPass(reason) {
  console.log(`::warning::audit gate skipped: ${reason}`);
  console.log('audit-gate: SKIPPED (registry or network problem) — not failing the build');
  return 0;
}

function readAudit(input) {
  if (input) return fs.readFileSync(input, 'utf8');
  const res = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', shell: process.platform === 'win32', timeout: 120_000
  });
  if (res.error) throw res.error;
  return res.stdout;
}

function main(argv = process.argv.slice(2)) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const today = arg('--today') || new Date().toISOString().slice(0, 10);
  const exceptions = JSON.parse(fs.readFileSync(arg('--exceptions') || DEFAULT_EXCEPTIONS, 'utf8')).exceptions || [];

  let audit;
  try {
    audit = JSON.parse(readAudit(arg('--input')));
    if (!audit || audit.error || !audit.vulnerabilities) {
      return warnAndPass((audit && audit.error && (audit.error.code || audit.error.summary)) || 'no vulnerabilities section in the report');
    }
  } catch (err) {
    return warnAndPass(err.code || err.name || 'unreadable audit report');
  }

  const result = evaluate(audit, exceptions, today);
  for (const a of result.allowed) console.log(`audit-gate: allowed by exception: ${a}`);
  for (const w of result.warnings) console.log(`::warning::${w}`);
  for (const f of result.failures) console.log(`::error::${f}`);
  console.log(`audit-gate: ${result.ok ? 'PASS' : 'FAIL'} (${result.allowed.length} excepted, ${result.failures.length} blocking)`);
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { evaluate, blockingAdvisories, warnAndPass, main };
