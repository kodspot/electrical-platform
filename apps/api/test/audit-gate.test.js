'use strict';

// scripts/audit-gate.js — the runtime dependency audit gate in CI. Fixture reports only;
// nothing here calls the npm registry.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { evaluate, blockingAdvisories, warnAndPass } = require('../scripts/audit-gate');

const FIX = path.join(__dirname, 'fixtures', 'audit-gate');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'audit-gate.js');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const LISTED = load('exceptions-listed.json').exceptions;

function cli(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('audit gate — decision', () => {
  it('clean report: passes', () => {
    const r = evaluate(load('clean.json'), [], '2026-10-14');
    assert.deepStrictEqual([r.ok, r.failures, r.allowed], [true, [], []]);
  });

  it('collects only high/critical advisory objects, per GHSA and package (not the parent that only points at a child)', () => {
    const list = blockingAdvisories(load('high-and-moderate.json'));
    assert.deepStrictEqual(list.map((a) => `${a.ghsa} ${a.package} ${a.severity}`).sort(), [
      'GHSA-aaaa-bbbb-cccc examplepkg high',
      'GHSA-gggg-hhhh-iiii childpkg critical'
    ]);
  });

  it('an unlisted high or critical advisory fails; a moderate one never does', () => {
    const r = evaluate(load('high-and-moderate.json'), [], '2026-10-14');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failures.length, 2);
    assert.ok(r.failures.some((f) => f.includes('GHSA-aaaa-bbbb-cccc')));
    assert.ok(r.failures.some((f) => f.includes('GHSA-gggg-hhhh-iiii') && f.startsWith('critical')));
    assert.ok(!r.failures.some((f) => f.includes('GHSA-dddd-eeee-ffff')), 'moderate advisories are not blocking');
  });

  it('listed advisories pass while their exception is current (the expiry day itself still counts)', () => {
    const r = evaluate(load('high-and-moderate.json'), LISTED, '2026-11-13');
    assert.strictEqual(r.ok, true, r.failures.join('; '));
    assert.strictEqual(r.allowed.length, 2);
  });

  it('an expired exception fails the gate, even though the advisory is listed', () => {
    const r = evaluate(load('high-and-moderate.json'), LISTED, '2026-11-14');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failures.filter((f) => /expired on 2026-11-13/.test(f)).length, 2);
  });

  it('an exception matching nothing is a warning, not a failure', () => {
    const stale = [{ ghsa: 'GHSA-zzzz-zzzz-zzzz', package: 'gone', severity: 'high', reason: 'r', owner: 'kishan', expires: '2026-11-13' }];
    const r = evaluate(load('clean.json'), stale, '2026-10-14');
    assert.strictEqual(r.ok, true);
    assert.match(r.warnings[0], /no longer matches/);
  });

  it('an exception missing a field or with a malformed date fails', () => {
    const bad = [{ ghsa: 'GHSA-aaaa-bbbb-cccc', package: 'examplepkg', severity: 'high', reason: 'r', expires: '2026-11-13' },
      { ghsa: 'GHSA-gggg-hhhh-iiii', package: 'childpkg', severity: 'critical', reason: 'r', owner: 'kishan', expires: '13/11/2026' }];
    const r = evaluate(load('high-and-moderate.json'), bad, '2026-10-14');
    assert.ok(r.failures.some((f) => /missing owner/.test(f)));
    assert.ok(r.failures.some((f) => /invalid expires/.test(f)));
  });

  it('a registry error report is not treated as a result (evaluate refuses it)', () => {
    assert.throws(() => evaluate(load('registry-error.json'), [], '2026-10-14'), /not an npm audit report/);
  });

  it('warnAndPass returns 0', () => {
    assert.strictEqual(warnAndPass('ENOTFOUND'), 0);
  });
});

describe('audit gate — CLI exit codes', () => {
  const ex = path.join(FIX, 'exceptions-listed.json');
  const none = path.join(FIX, 'clean.json'); // has no "exceptions" key: an empty list

  it('clean → 0', () => {
    assert.strictEqual(cli('--input', path.join(FIX, 'clean.json'), '--exceptions', none, '--today', '2026-10-14').code, 0);
  });

  it('unlisted high → 1, with the advisory named', () => {
    const r = cli('--input', path.join(FIX, 'high-and-moderate.json'), '--exceptions', none, '--today', '2026-10-14');
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /GHSA-aaaa-bbbb-cccc/);
  });

  it('listed → 0; expired → 1', () => {
    assert.strictEqual(cli('--input', path.join(FIX, 'high-and-moderate.json'), '--exceptions', ex, '--today', '2026-10-14').code, 0);
    assert.strictEqual(cli('--input', path.join(FIX, 'high-and-moderate.json'), '--exceptions', ex, '--today', '2026-12-01').code, 1);
  });

  it('registry error → warning and 0; an unreadable report → warning and 0', () => {
    const r = cli('--input', path.join(FIX, 'registry-error.json'), '--exceptions', none, '--today', '2026-10-14');
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /::warning::audit gate skipped: ENOTFOUND/);
    const r2 = cli('--input', path.join(FIX, 'does-not-exist.json'), '--exceptions', none, '--today', '2026-10-14');
    assert.strictEqual(r2.code, 0);
    assert.match(r2.out, /audit gate skipped/);
  });

  it('the committed exceptions file is valid and every entry expires within its allowed window', () => {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'audit-exceptions.json'), 'utf8'));
    const fastifyChain = /^(fastify|find-my-way|@fastify\/.+)$/;
    for (const e of file.exceptions) {
      for (const k of ['ghsa', 'package', 'severity', 'reason', 'owner', 'expires']) assert.ok(e[k], `${e.ghsa} has ${k}`);
      assert.strictEqual(e.owner, 'kishan');
      assert.ok(e.expires <= (fastifyChain.test(e.package) ? '2026-12-13' : '2026-11-13'), `${e.ghsa} (${e.package}) expires too late: ${e.expires}`);
    }
  });
});
