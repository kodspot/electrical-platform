'use strict';

// Regression tests for the bug library (apps/api/scenarios/bugs). [platform-M4, DPS §6]
//
// One test per registered bug: reproduce its triggering state (reusing the M3 scenario
// system) and assert the FIXED behavior still holds. If a fix is ever reverted, the
// corresponding test fails here — permanent protection against recurrence.
//
// Validation logic lives in each bug's validate() (single source of truth); this file
// only drives it, so there is no duplicated assertion logic.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { isDatabaseAvailable, cleanupTestOrgs } = require('../helpers/db');
const registry = require('../../scenarios/bugs/registry');
const runner = require('../../scenarios/bugs/runner');

describe('platform-M4 — bug regression library', () => {
  let dbAvailable = false;
  const createdOrgIds = [];

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
  });

  after(async () => {
    if (dbAvailable) await cleanupTestOrgs(createdOrgIds);
  });

  for (const bug of registry.all()) {
    it(`${bug.id} — ${bug.title} (fixed behavior holds)`, async (t) => {
      if (!dbAvailable) return t.skip('No database available');
      const ctx = {};
      const result = await runner.validateBug(bug, ctx);
      if (ctx[bug.id] && ctx[bug.id].org) createdOrgIds.push(ctx[bug.id].org.id);
      assert.strictEqual(result.ok, true, `${bug.id} REGRESSED: ${result.detail}`);
    });
  }

  it('every bug carries the required metadata and a validate() function', () => {
    const required = ['id', 'title', 'description', 'origin', 'severity', 'status', 'module',
      'category', 'rootCause', 'dateIntroduced', 'dateFixed', 'expectedBehavior', 'brokenBehavior',
      'reproductionSteps', 'scenarioDependencies', 'regressionTest'];
    for (const b of registry.all()) {
      for (const f of required) assert.ok(b[f] !== undefined, `${b.id} is missing metadata: ${f}`);
      assert.strictEqual(typeof b.validate, 'function', `${b.id} must have a validate() function`);
      assert.ok(Array.isArray(b.reproductionSteps) && b.reproductionSteps.length > 0, `${b.id} needs reproduction steps`);
    }
  });
});
