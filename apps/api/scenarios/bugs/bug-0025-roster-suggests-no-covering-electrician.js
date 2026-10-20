'use strict';

/**
 * BUG-0025 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestUser, createTestLocation, createTestWorker, createTestWorkerAssignment } = require('../factories');

module.exports = {
  id: 'BUG-0025',
  title: 'A new duty roster suggested no electrician when they covered the floor from its building',
  description: 'GET /api/duty-roster/suggested-workers counted only electricians assigned to that exact location. Electricians are usually assigned to a building with "cover children", and the roster picker lists floors and rooms, so the supervisor got no pre-selected electrician and the roster started empty. Everywhere else (the complaint ring, the electrician app) coverage includes an ancestor with coverChildren.',
  module: 'ele',
  category: 'supervisor-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Bug hunt 2026-10-20 (every button and form)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-20',
  rootCause: 'duty-roster.js queried workerAssignment by locationId only instead of using assignment-resolver getAssignedWorkerIds (direct + ancestors with coverChildren).',
  expectedBehavior: 'The suggestion lists the active electricians covering the location, directly or through an ancestor with coverChildren, and no one else.',
  brokenBehavior: 'An empty suggestion for a floor covered from its building.',
  reproductionSteps: [
    'Create a building and a floor in it; assign an electrician to the building with coverChildren.',
    'As a supervisor, GET /api/duty-roster/suggested-workers?locationId=<floor>.',
    'Broken: suggested is []. Fixed: it contains the electrician.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/admin-forms-api.test.js',

  async apply() {
    const org = await createTestOrg();
    const supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    const building = await createTestLocation(org.id, { type: 'BUILDING' });
    const floor = await createTestLocation(org.id, { type: 'FLOOR', parentId: building.id });
    const worker = await createTestWorker(org.id);
    await createTestWorkerAssignment(org.id, worker.id, building.id, { coverChildren: true });
    return { org, supervisor, floor, worker };
  },

  async validate(ctx) {
    const { supervisor, floor, worker } = ctx['BUG-0025'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.25' }, payload: { email: supervisor.email, password: supervisor.plaintextPassword } });
    if (login.statusCode !== 200) return { ok: false, detail: `supervisor login expected 200, got ${login.statusCode}` };
    const res = await ctx.app.inject({ method: 'GET', url: `/api/duty-roster/suggested-workers?locationId=${floor.id}`, headers: { authorization: `Bearer ${login.json().token}` } });
    if (res.statusCode !== 200) return { ok: false, detail: `expected 200, got ${res.statusCode}` };
    const ids = (res.json().suggested || []).map((w) => w.id);
    if (!ids.includes(worker.id)) return { ok: false, detail: 'the electrician covering the floor from its building is not suggested' };
    return { ok: true, detail: 'the covering electrician is suggested' };
  }
};
